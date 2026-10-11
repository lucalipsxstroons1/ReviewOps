import assert from "node:assert/strict";
import { test } from "node:test";
import { apiFile, startGitHubApi } from "./helpers/github-api.js";
import { API_KEY } from "./helpers/run-action.js";
import { reviewCompletion, startOpenAiApi } from "./helpers/openai-api.js";
import {
  PULL_REQUEST_EVENT,
  fromRoot,
  startAction,
  withInputs,
} from "./helpers/run-action.js";

// Process tests for the input `openai-base-url` (#40): the action runs as its
// own process, the way the runner starts it. `http` is accepted for 127.0.0.1,
// so the stand-in of OpenAI can be named in the input itself.

const FILES = [
  apiFile("src/app.js", {
    additions: 1,
    deletions: 0,
    patch: "@@ -0,0 +1 @@\n+let a = 1;",
  }),
];

const run = (github, env) =>
  startAction(
    fromRoot("src/index.js"),
    withInputs({
      ...PULL_REQUEST_EVENT,
      GITHUB_API_URL: github.url,
      "INPUT_SKIP-LABEL": "no-ai-review",
      ...env,
    }),
  );

test("sends the request to the address of the input, with the key", async (t) => {
  const github = await startGitHubApi(t, { files: FILES });
  // The standard address is dead: only the input can lead to the stand-in.
  const openai = await startOpenAiApi(t, reviewCompletion([]));

  const result = await run(github, { "INPUT_OPENAI-BASE-URL": openai.url });

  assert.equal(result.status, 0, result.output);
  assert.equal(openai.requests.length, 1);
  assert.equal(openai.requests[0].path, "/v1/chat/completions");
  assert.equal(openai.requests[0].authorization, `Bearer ${API_KEY}`);
  assert.match(
    result.stdout,
    /The requests to the model go to 127\.0\.0\.1:\d+, not to OpenAI\./,
  );
});

test("an address in the environment does not take the place of the input", async (t) => {
  const github = await startGitHubApi(t, { files: FILES });
  const trap = await startOpenAiApi(t, reviewCompletion([]));
  const openai = await startOpenAiApi(t, reviewCompletion([]));

  const result = await run(github, {
    "INPUT_OPENAI-BASE-URL": openai.url,
    OPENAI_BASE_URL: trap.url,
  });

  assert.equal(result.status, 0, result.output);
  assert.equal(openai.requests.length, 1);
  assert.equal(trap.requests.length, 0);
});

test("a wrong address fails the run before any request, and the log names no part of it", async (t) => {
  const github = await startGitHubApi(t, { files: FILES });
  const openai = await startOpenAiApi(t, reviewCompletion([]));

  const result = await run(github, {
    "INPUT_OPENAI-BASE-URL": "https://user:SECRETWORD@example.com/v1",
    TEST_OPENAI_URL: openai.url,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.output, /Input `openai-base-url` must not contain/);
  assert.doesNotMatch(result.output, /SECRETWORD|example\.com/);
  assert.equal(github.requests.length, 0);
  assert.equal(openai.requests.length, 0);
});
