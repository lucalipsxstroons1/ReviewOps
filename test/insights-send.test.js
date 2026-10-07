import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ATTEMPT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  MAX_BODY_BYTES,
  MAX_PAUSE_SECONDS,
  describeFailure,
  sendInsightsReport,
} from "../src/insights/send.js";
import {
  INSIGHTS_TEST_SECRET,
  NO_ANSWER,
  insightsError,
  insightsSignature,
  startInsightsApi,
} from "./helpers/insights-api.js";
import { fromRoot } from "./helpers/run-action.js";

// Sending the report (#76) against a local stand-in for Insights. The stand-in
// recomputes the signature over the bytes it receives, so these tests show that
// both sides agree byte by byte. Nothing leaves this machine.

const PAYLOAD = JSON.parse(
  readFileSync(fromRoot("test/fixtures/insights-review-v1.json"), "utf8"),
);

/** The pauses of a run, recorded instead of waited for. */
function recordPauses() {
  const pauses = [];
  return { pauses, sleep: async (ms) => void pauses.push(ms) };
}

async function send(api, options = {}) {
  const { pauses, sleep } = recordPauses();
  const result = await sendInsightsReport({
    url: api.url,
    secret: INSIGHTS_TEST_SECRET,
    payload: PAYLOAD,
    sleep,
    ...options,
  });
  return { result, pauses };
}

test("sends the report as JSON with a signature over its bytes", async (t) => {
  const api = await startInsightsApi(t);

  const { result } = await send(api);

  assert.deepEqual(result, {
    delivered: true,
    outcome: "created",
    httpStatus: 201,
    attempts: 1,
  });
  assert.equal(api.requests.length, 1);
  const [request] = api.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/api/v1/ingest/review");
  assert.equal(request.headers["content-type"], "application/json");
  assert.deepEqual(request.body, PAYLOAD);
  assert.equal(request.signatureValid, true);
  assert.equal(
    request.headers["x-reviewops-signature"],
    insightsSignature(INSIGHTS_TEST_SECRET, request.raw),
  );
  assert.match(
    request.headers["x-reviewops-signature"],
    /^sha256=[0-9a-f]{64}$/,
  );
});

test("sends exactly the bytes of the JSON text, in UTF-8", async (t) => {
  const api = await startInsightsApi(t);
  const payload = { ...PAYLOAD, repository: "octo-org/demo" };
  payload.findings = [{ ...PAYLOAD.findings[0], path: "src/Größe/ünï.cs" }];

  await send(api, { payload });

  assert.equal(api.requests[0].raw.toString("utf8"), JSON.stringify(payload));
  assert.equal(api.requests[0].signatureValid, true);
  assert.equal(api.requests[0].body.findings[0].path, "src/Größe/ünï.cs");
});

test("reports a known deliveryId as delivered, not as an error", async (t) => {
  const api = await startInsightsApi(t);

  await send(api);
  const { result } = await send(api);

  assert.deepEqual(result, {
    delivered: true,
    outcome: "duplicate",
    httpStatus: 200,
    attempts: 1,
  });
});

test("does not retry a wrong signature and passes on the code of the answer", async (t) => {
  const api = await startInsightsApi(t);

  const { result, pauses } = await send(api, { secret: "w".repeat(40) });

  assert.deepEqual(result, {
    delivered: false,
    reason: "http",
    httpStatus: 401,
    code: "UNAUTHORIZED",
    attempts: 1,
  });
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].signatureValid, false);
  assert.deepEqual(pauses, []);
});

test("delivers after two 503 answers, with the same deliveryId and the same bytes", async (t) => {
  const api = await startInsightsApi(t, {
    answer: [
      insightsError(503, "UNAVAILABLE"),
      insightsError(503, "UNAVAILABLE"),
      { status: 201, body: { id: PAYLOAD.deliveryId } },
    ],
  });

  const { result, pauses } = await send(api);

  assert.deepEqual(result, {
    delivered: true,
    outcome: "created",
    httpStatus: 201,
    attempts: 3,
  });
  assert.equal(api.requests.length, 3);
  const ids = api.requests.map((request) => request.body.deliveryId);
  assert.deepEqual(ids, [
    PAYLOAD.deliveryId,
    PAYLOAD.deliveryId,
    PAYLOAD.deliveryId,
  ]);
  const bytes = api.requests.map((request) => request.raw.toString("utf8"));
  assert.equal(new Set(bytes).size, 1);
  assert.ok(api.requests.every((request) => request.signatureValid));
  // 1 second before the second attempt, 2 before the third.
  assert.deepEqual(pauses, [1000, 2000]);
});

test("gives up after three attempts and names the last status", async (t) => {
  const api = await startInsightsApi(t, {
    answer: insightsError(500, "INTERNAL_ERROR"),
  });

  const { result, pauses } = await send(api);

  assert.equal(MAX_ATTEMPTS, 3);
  assert.deepEqual(result, {
    delivered: false,
    reason: "http",
    httpStatus: 500,
    code: "INTERNAL_ERROR",
    attempts: 3,
  });
  assert.equal(api.requests.length, 3);
  assert.deepEqual(pauses, [1000, 2000]);
});

for (const status of [408, 429, 500, 502, 503, 504]) {
  test(`tries again after ${status}`, async (t) => {
    const api = await startInsightsApi(t, {
      answer: [insightsError(status, "TEMPORARY"), { status: 201, body: {} }],
    });

    const { result } = await send(api);

    assert.equal(result.delivered, true);
    assert.equal(result.attempts, 2);
  });
}

for (const status of [400, 401, 403, 404, 413, 415, 422]) {
  test(`does not try again after ${status}`, async (t) => {
    const api = await startInsightsApi(t, {
      answer: insightsError(status, "REFUSED"),
    });

    const { result } = await send(api);

    assert.equal(result.delivered, false);
    assert.equal(result.httpStatus, status);
    assert.equal(result.attempts, 1);
    assert.equal(api.requests.length, 1);
  });
}

test("ends the sending at a 2xx status that is neither 200 nor 201", async (t) => {
  const api = await startInsightsApi(t, { answer: { status: 202, body: {} } });

  const { result } = await send(api);

  assert.deepEqual(result, {
    delivered: false,
    reason: "http",
    httpStatus: 202,
    attempts: 1,
  });
});

test("waits as long as Retry-After says, but never more than ten seconds", async (t) => {
  for (const [header, expected] of [
    ["3", 3000],
    ["0", 0],
    ["10", 10000],
    ["11", 10000],
    ["99999", 10000],
    ["9".repeat(400), 10000],
    // Not whole seconds: the default pause applies.
    ["Wed, 21 Oct 2026 07:28:00 GMT", 1000],
    ["1.5", 1000],
    ["-1", 1000],
    ["", 1000],
  ]) {
    const api = await startInsightsApi(t, {
      answer: [
        { status: 429, headers: { "retry-after": header }, body: {} },
        { status: 201, body: {} },
      ],
    });

    const { result, pauses } = await send(api);

    assert.equal(result.delivered, true, header);
    assert.deepEqual(pauses, [expected], `Retry-After: ${header}`);
  }
  assert.equal(MAX_PAUSE_SECONDS, 10);
});

test("follows a redirect nowhere and does not try again", async (t) => {
  const elsewhere = await startInsightsApi(t);
  const api = await startInsightsApi(t, {
    answer: {
      status: 301,
      headers: { location: elsewhere.url },
      body: {},
    },
  });

  const { result, pauses } = await send(api);

  assert.deepEqual(result, {
    delivered: false,
    reason: "redirect",
    httpStatus: 301,
    attempts: 1,
  });
  assert.equal(api.requests.length, 1);
  assert.equal(elsewhere.requests.length, 0, "the redirect was followed");
  assert.deepEqual(pauses, []);
});

for (const status of [302, 303, 307, 308]) {
  test(`treats ${status} as a redirect as well`, async (t) => {
    const api = await startInsightsApi(t, {
      answer: {
        status,
        headers: { location: "http://127.0.0.1:1/" },
        body: {},
      },
    });

    const { result } = await send(api);

    assert.equal(result.reason, "redirect");
    assert.equal(result.httpStatus, status);
    assert.equal(result.attempts, 1);
  });
}

test("stops waiting for a server that never answers and tries three times", async (t) => {
  const api = await startInsightsApi(t, { answer: NO_ANSWER });

  const { result, pauses } = await send(api, { timeoutMs: 100 });

  assert.deepEqual(result, {
    delivered: false,
    reason: "timeout",
    detail: "TimeoutError",
    attempts: 3,
  });
  assert.equal(api.requests.length, 3);
  assert.deepEqual(pauses, [1000, 2000]);
  assert.equal(ATTEMPT_TIMEOUT_MS, 10_000);
});

test("names a network error without its text", async () => {
  const error = new TypeError(
    "fetch failed: https://insights.example.com/x with secret hunter22",
    {
      cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
        code: "ECONNREFUSED",
      }),
    },
  );
  const { pauses, sleep } = recordPauses();

  const result = await sendInsightsReport({
    url: "https://insights.example.com/x",
    secret: INSIGHTS_TEST_SECRET,
    payload: PAYLOAD,
    fetch: async () => {
      throw error;
    },
    sleep,
  });

  assert.deepEqual(result, {
    delivered: false,
    reason: "network",
    detail: "ECONNREFUSED",
    attempts: 3,
  });
  assert.deepEqual(pauses, [1000, 2000]);
  const text = JSON.stringify(result);
  for (const secret of ["insights.example.com", "hunter22", "10.0.0.1"]) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test("passes on no detail that does not look like an identifier", async () => {
  const { sleep } = recordPauses();
  const error = Object.assign(new Error("x"), {
    name: "Bad name!",
    code: "not a code",
  });

  const result = await sendInsightsReport({
    url: "https://insights.example.com/x",
    secret: INSIGHTS_TEST_SECRET,
    payload: PAYLOAD,
    fetch: async () => {
      throw error;
    },
    sleep,
  });

  assert.equal(result.reason, "network");
  assert.equal("detail" in result, false);
});

test("sends a report over the limit of the contract nowhere", async (t) => {
  const api = await startInsightsApi(t);
  const payload = { ...PAYLOAD, padding: "x".repeat(MAX_BODY_BYTES) };

  const { result } = await send(api, { payload });

  assert.deepEqual(result, {
    delivered: false,
    reason: "too-large",
    attempts: 0,
  });
  assert.equal(api.requests.length, 0);
});

test("counts the limit in bytes, not in characters", async (t) => {
  const api = await startInsightsApi(t);
  // Each "ä" is two bytes in UTF-8: under the limit as text, over it as bytes.
  const payload = { ...PAYLOAD, padding: "ä".repeat(MAX_BODY_BYTES / 2) };
  assert.ok(JSON.stringify(payload).length < MAX_BODY_BYTES + 200);

  const { result } = await send(api, { payload });

  assert.equal(result.reason, "too-large");
});

test("takes a code from the answer only when it looks like an identifier", async (t) => {
  for (const [code, expected] of [
    ["VALIDATION_ERROR", "VALIDATION_ERROR"],
    ["UNSUPPORTED_SCHEMA_VERSION", "UNSUPPORTED_SCHEMA_VERSION"],
    ["lower_case", undefined],
    ["HAS SPACE", undefined],
    ["A".repeat(51), undefined],
    ["WITH-DASH", undefined],
    ["<script>alert(1)</script>", undefined],
    [42, undefined],
  ]) {
    const api = await startInsightsApi(t, {
      answer: { status: 400, body: { error: { code } } },
    });

    const { result } = await send(api);

    assert.equal(result.code, expected, String(code));
  }
});

test("reads no code from an answer that is not JSON, empty or the wrong shape", async (t) => {
  const answers = [
    {
      text: "<html>Bad gateway</html>",
      headers: { "content-type": "text/html" },
    },
    { text: "" },
    { text: "not json at all" },
    { body: null },
    { body: [] },
    { body: { error: "x" } },
    { body: { error: null } },
    { body: "text" },
    { body: 7 },
  ];
  for (const answer of answers) {
    const api = await startInsightsApi(t, {
      answer: { status: 400, ...answer },
    });

    const { result } = await send(api);

    assert.equal(result.delivered, false);
    assert.equal(result.httpStatus, 400);
    assert.equal("code" in result, false, JSON.stringify(answer));
  }
});

test("reads at most the start of a long answer", async (t) => {
  const api = await startInsightsApi(t, {
    answer: {
      status: 400,
      body: {
        error: { code: "VALIDATION_ERROR", message: "m".repeat(200000) },
      },
    },
  });

  const { result } = await send(api);

  // The answer is cut after 8 KiB, so it is no complete JSON: no code.
  assert.equal(result.reason, "http");
  assert.equal(result.httpStatus, 400);
  assert.equal("code" in result, false);
});

test("the result holds neither the address, the secret, the signature nor the body", async (t) => {
  const api = await startInsightsApi(t, {
    answer: insightsError(401, "UNAUTHORIZED"),
  });

  const { result } = await send(api);

  const text = JSON.stringify(result);
  assert.equal(text.includes(api.url), false);
  assert.equal(text.includes("127.0.0.1"), false);
  assert.equal(text.includes(INSIGHTS_TEST_SECRET), false);
  assert.equal(text.includes("sha256"), false);
  assert.equal(text.includes(PAYLOAD.deliveryId), false);
  assert.equal(text.includes(PAYLOAD.repository), false);
});

test("names a failure in fixed words", () => {
  assert.equal(
    describeFailure({ reason: "http", httpStatus: 401 }),
    "HTTP 401",
  );
  assert.equal(
    describeFailure({
      reason: "http",
      httpStatus: 400,
      code: "VALIDATION_ERROR",
    }),
    "HTTP 400, VALIDATION_ERROR",
  );
  assert.equal(
    describeFailure({ reason: "redirect", httpStatus: 301 }),
    "redirect (HTTP 301)",
  );
  assert.equal(describeFailure({ reason: "timeout" }), "timeout");
  assert.equal(describeFailure({ reason: "network" }), "network error");
  assert.equal(describeFailure({ reason: "too-large" }), "report over 1 MiB");
});
