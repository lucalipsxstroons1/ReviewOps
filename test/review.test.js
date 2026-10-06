import assert from "node:assert/strict";
import { test } from "node:test";
import { AiError } from "../src/ai/error.js";
import { MAX_OUTPUT_TOKENS, REVIEW_FORMAT } from "../src/ai/schema.js";
import { MAX_PARALLEL_REQUESTS, reviewInBatches } from "../src/review.js";

/** A finding as the model returns it. */
const finding = (path, line, severity = "major") => ({
  path,
  line,
  severity,
  category: "code-quality",
  title: `Problem in ${path}`,
  comment: "What is wrong.",
  suggestion: "What to change.",
});

/** The result of `complete()` for an answer with these findings. */
const answer = (summary, findings = []) => ({
  content: JSON.stringify({ summary, findings }),
  finishReason: "stop",
  usage: null,
  model: "gpt-4o-mini",
  requestId: null,
});

/** One batch per name, each with one file of that name. */
const batchesOf = (...names) =>
  names.map((name) => ({
    files: [{ path: `${name}.js` }],
    user: `user ${name}`,
  }));

/**
 * A client that answers with `respond(request, index)`: a value is the
 * result, an error is thrown. `delays` hold answers back, so they can arrive
 * out of order.
 */
function createFakeClient(respond, delays = []) {
  const requests = [];
  let running = 0;
  const state = { requests, highest: 0 };
  state.complete = async (request) => {
    const index = requests.length;
    requests.push(request);
    running += 1;
    state.highest = Math.max(state.highest, running);
    try {
      await new Promise((resolve) => setTimeout(resolve, delays[index] ?? 0));
      const result = respond(request, index);
      if (result instanceof Error) throw result;
      return result;
    } finally {
      running -= 1;
    }
  };
  return state;
}

/** Answers every request with one finding in the file of its batch. */
const findingPerBatch = (request) => {
  const name = request.user.replace("user ", "");
  return answer(`summary ${name}`, [finding(`${name}.js`, 1)]);
};

test("sends every batch with the system prompt and the review format", async () => {
  const client = createFakeClient(findingPerBatch);
  const batches = batchesOf("a", "b");

  await reviewInBatches({ client, system: "the system", batches });

  assert.deepEqual(client.requests.map((request) => request.user).sort(), [
    "user a",
    "user b",
  ]);
  for (const request of client.requests) {
    assert.equal(request.system, "the system");
    assert.equal(request.responseFormat, REVIEW_FORMAT);
    assert.equal(request.maxOutputTokens, MAX_OUTPUT_TOKENS);
  }
});

test("merges the findings of all batches in the order of the batches", async () => {
  // The first answer arrives last.
  const client = createFakeClient(findingPerBatch, [30, 0, 10]);

  const result = await reviewInBatches({
    client,
    system: "s",
    batches: batchesOf("a", "b", "c"),
  });

  assert.deepEqual(
    result.reviews.map((review) => review.summary),
    ["summary a", "summary b", "summary c"],
  );
  assert.deepEqual(
    result.reviews.flatMap((review) => review.findings.map((f) => f.path)),
    ["a.js", "b.js", "c.js"],
  );
  assert.equal(result.succeeded, 3);
  assert.deepEqual(result.failed, []);
});

test("keeps every finding of a batch, also several and empty ones", async () => {
  const client = createFakeClient((request, index) =>
    index === 0
      ? answer("two", [finding("a.js", 1), finding("a.js", 2, "minor")])
      : answer("none"),
  );

  const result = await reviewInBatches({
    client,
    system: "s",
    batches: batchesOf("a", "b"),
    concurrency: 1,
  });

  assert.equal(result.reviews[0].findings.length, 2);
  assert.deepEqual(result.reviews[1].findings, []);
  assert.deepEqual(
    result.reviews.map((review) => review.summary),
    ["two", "none"],
  );
});

test("keeps the files of its request with every review", async () => {
  const batches = [
    { files: [{ path: "a.js", commentableLines: [1] }], user: "user a" },
    {
      files: [
        { path: "b.js", commentableLines: [2] },
        { path: "c.js", commentableLines: [3] },
      ],
      user: "user b",
    },
  ];
  const client = createFakeClient(findingPerBatch);

  const result = await reviewInBatches({ client, system: "s", batches });

  assert.equal(result.reviews[0].files, batches[0].files);
  assert.equal(result.reviews[1].files, batches[1].files);
});

test("has at most four requests on their way at once", async () => {
  assert.equal(MAX_PARALLEL_REQUESTS, 4);
  const client = createFakeClient(findingPerBatch, Array(10).fill(5));

  const result = await reviewInBatches({
    client,
    system: "s",
    batches: batchesOf(..."abcdefghij"),
  });

  assert.equal(client.highest, 4);
  assert.equal(client.requests.length, 10);
  assert.equal(result.succeeded, 10);
});

test("sends one after the other with a concurrency of one", async () => {
  const client = createFakeClient(findingPerBatch, [5, 5, 5]);

  await reviewInBatches({
    client,
    system: "s",
    batches: batchesOf("a", "b", "c"),
    concurrency: 1,
  });

  assert.equal(client.highest, 1);
});

test("keeps the other findings when one batch fails", async () => {
  const failure = new AiError("server", "OpenAI could not answer.", 500);
  const client = createFakeClient((request) =>
    request.user === "user b" ? failure : findingPerBatch(request),
  );

  const result = await reviewInBatches({
    client,
    system: "s",
    batches: batchesOf("a", "b", "c"),
  });

  assert.deepEqual(
    result.reviews.flatMap((review) => review.findings.map((f) => f.path)),
    ["a.js", "c.js"],
  );
  assert.equal(result.succeeded, 2);
  assert.deepEqual(result.failed, [{ paths: ["b.js"], error: failure }]);
});

test("names every file of a failed batch", async () => {
  const client = createFakeClient(
    () => new AiError("timeout", "OpenAI did not answer."),
  );
  const batches = [
    { files: [{ path: "a.js" }, { path: "b.js" }], user: "user ab" },
  ];

  const result = await reviewInBatches({ client, system: "s", batches });

  assert.deepEqual(result.failed[0].paths, ["a.js", "b.js"]);
  assert.equal(result.succeeded, 0);
  assert.deepEqual(result.reviews, []);
});

test("counts a cut-off, filtered or broken answer as a failed batch", async () => {
  const answers = [
    { ...answer("x"), finishReason: "length" },
    { ...answer("x"), finishReason: "content_filter" },
    { ...answer("x"), content: "not json" },
    { ...answer("x"), content: JSON.stringify({ summary: "x" }) },
  ];
  const client = createFakeClient((request, index) => answers[index]);

  const result = await reviewInBatches({
    client,
    system: "s",
    batches: batchesOf("a", "b", "c", "d"),
    concurrency: 1,
  });

  assert.deepEqual(
    result.failed.map(({ error }) => error.kind),
    ["truncated", "filtered", "response", "response"],
  );
  for (const { error } of result.failed) assert.ok(error instanceof AiError);
});

for (const kind of ["auth", "permission", "model", "quota"]) {
  test(`starts no new request after an error of the kind ${kind}`, async () => {
    const fatal = new AiError(kind, `A ${kind} problem.`, 400);
    const client = createFakeClient((request, index) =>
      index === 1 ? fatal : findingPerBatch(request),
    );

    const result = await reviewInBatches({
      client,
      system: "s",
      batches: batchesOf("a", "b", "c", "d"),
      concurrency: 1,
    });

    assert.equal(client.requests.length, 2);
    assert.equal(result.succeeded, 1);
    assert.deepEqual(result.failed, [
      { paths: ["b.js"], error: fatal },
      { paths: ["c.js"], error: fatal },
      { paths: ["d.js"], error: fatal },
    ]);
  });
}

test("lets the requests on their way finish after a fatal error", async () => {
  const fatal = new AiError("auth", "The key was rejected.", 401);
  // The second request fails at once, the others take longer.
  const client = createFakeClient(
    (request, index) => (index === 1 ? fatal : findingPerBatch(request)),
    [20, 0, 20, 20, 0, 0],
  );

  const result = await reviewInBatches({
    client,
    system: "s",
    batches: batchesOf("a", "b", "c", "d", "e", "f"),
  });

  // a, b, c and d were on their way. e and f were never sent.
  assert.equal(client.requests.length, 4);
  assert.equal(result.succeeded, 3);
  assert.deepEqual(
    result.failed.map(({ paths }) => paths[0]),
    ["b.js", "e.js", "f.js"],
  );
});

test("goes on after an error that only hit one request", async () => {
  for (const kind of [
    "rate_limit",
    "server",
    "timeout",
    "network",
    "refusal",
  ]) {
    const client = createFakeClient((request, index) =>
      index === 0 ? new AiError(kind, "x") : findingPerBatch(request),
    );

    const result = await reviewInBatches({
      client,
      system: "s",
      batches: batchesOf("a", "b", "c"),
      concurrency: 1,
    });

    assert.equal(client.requests.length, 3, kind);
    assert.equal(result.succeeded, 2, kind);
  }
});

test("passes on an error that is not an AiError and sends nothing more", async () => {
  const defect = new TypeError("a defect");
  const client = createFakeClient((request, index) =>
    index === 0 ? defect : findingPerBatch(request),
  );

  await assert.rejects(
    reviewInBatches({
      client,
      system: "s",
      batches: batchesOf("a", "b", "c"),
      concurrency: 1,
    }),
    (error) => error === defect,
  );
  assert.equal(client.requests.length, 1);
});

test("sends nothing for no batches", async () => {
  const client = createFakeClient(findingPerBatch);

  const result = await reviewInBatches({ client, system: "s", batches: [] });

  assert.deepEqual(result, {
    reviews: [],
    succeeded: 0,
    failed: [],
  });
  assert.equal(client.requests.length, 0);
});
