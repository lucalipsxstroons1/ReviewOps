import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../src/main.js";
import { createFakeContext } from "./helpers/fake-context.js";
import { createFakeCore } from "./helpers/fake-core.js";
import { apiFile, createFakeOctokit } from "./helpers/github-api.js";

// The input `openai-base-url` (#40) in a whole run: the address reaches the
// client, the log names its host, and an address that cannot be used fails the
// run before the first request.

const INPUTS = { "github-token": "token-value", "openai-api-key": "key-value" };
const APP = apiFile("src/app.js", {
  additions: 1,
  deletions: 0,
  patch: "@@ -0,0 +1 @@\n+let a = 1;",
});

async function runWith(extra) {
  const core = createFakeCore({ ...INPUTS, ...extra });
  const octokit = createFakeOctokit([APP]);
  const clients = [];
  await run({
    core,
    context: createFakeContext({ runId: 1, runAttempt: 1 }),
    getOctokit: () => octokit,
    createAiClient: (options) => {
      clients.push(options);
      return {
        complete: async () => ({
          content: JSON.stringify({ summary: "A summary.", findings: [] }),
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          model: "m",
          requestId: "req_1",
        }),
      };
    },
  });
  return { core, octokit, clients };
}

test("passes the standard address to the client when the input is empty", async () => {
  for (const extra of [{}, { "openai-base-url": "" }]) {
    const { core, clients } = await runWith(extra);

    assert.equal(clients.length, 1);
    assert.equal(clients[0].baseUrl, "https://api.openai.com/v1");
    // Nothing to say about the standard address.
    assert.ok(
      !core.calls.some((call) => /not to OpenAI/.test(String(call.args))),
    );
  }
});

test("passes the address of the input to the client and names its host once", async () => {
  const { core, clients } = await runWith({
    "openai-base-url": "https://gateway.example.com:8443/openai/v1/",
  });

  assert.equal(
    clients[0].baseUrl,
    "https://gateway.example.com:8443/openai/v1",
  );
  const lines = core.calls
    .filter((call) => call.method === "info")
    .map((call) => String(call.args[0]))
    .filter((text) => /not to OpenAI/.test(text));
  assert.deepEqual(lines, [
    "The requests to the model go to gateway.example.com:8443, not to OpenAI.",
  ]);
  // The path stays out of the log.
  assert.ok(!JSON.stringify(core.calls).includes("/openai/v1"));
});

for (const value of [
  "http://example.com/v1",
  "https://user:SECRETWORD@example.com/v1",
  "https://example.com/v1?key=SECRETWORD",
  "not an address",
]) {
  test(`fails before the first request for the address ${value.slice(0, 20)}`, async () => {
    const core = createFakeCore({ ...INPUTS, "openai-base-url": value });
    const octokit = createFakeOctokit([APP]);
    let created = 0;

    await run({
      core,
      context: createFakeContext({ runId: 1, runAttempt: 1 }),
      getOctokit: () => octokit,
      createAiClient: () => {
        created += 1;
        throw new Error("must not be called");
      },
    });

    assert.equal(created, 0);
    assert.equal(octokit.calls.length, 0);
    const failed = core.calls.filter((call) => call.method === "setFailed");
    assert.equal(failed.length, 1);
    assert.match(String(failed[0].args[0]), /^Input `openai-base-url` /);
    assert.ok(!JSON.stringify(core.calls).includes("SECRETWORD"));
  });
}
