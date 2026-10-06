import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { explainMissingSecret } from "../src/github/context.js";
import { run } from "../src/main.js";
import { createFakeContext, loadEvent } from "./helpers/fake-context.js";
import { createFakeCore } from "./helpers/fake-core.js";
import {
  apiFiles,
  createFakeOctokit,
  startGitHubApi,
} from "./helpers/github-api.js";
import {
  PULL_REQUEST_EVENT,
  fromRoot,
  startAction,
  withInputs,
} from "./helpers/run-action.js";

const FORK_NOTICE =
  /^ReviewOps did not review this pull request: it comes from a fork, and GitHub does not pass secrets/;
const DEPENDABOT_NOTICE =
  /^ReviewOps did not review this pull request: the run was started by Dependabot.*Dependabot secret named `OPENAI_API_KEY`/;

/** The event of a pull request from a fork: the head lies in another repository. */
function forkEvent(headRepository = "someone/demo") {
  const payload = loadEvent();
  payload.pull_request.head.repo = { full_name: headRepository };
  return payload;
}

const fromFork = (overrides = {}) =>
  createFakeContext({ payload: forkEvent(), ...overrides });

// --- Why the secrets are missing ---------------------------------------------

test("explains a missing key for a pull request from a fork", () => {
  const notice = explainMissingSecret(fromFork());

  assert.match(notice, FORK_NOTICE);
  assert.match(notice, /does not mean that this pull request was reviewed/);
});

test("treats a pull request whose head repository was deleted as a fork", () => {
  const payload = loadEvent();
  payload.pull_request.head.repo = null;

  assert.match(
    explainMissingSecret(createFakeContext({ payload })),
    FORK_NOTICE,
  );
});

test("explains a missing key for a run that Dependabot started", () => {
  const notice = explainMissingSecret(
    createFakeContext({ actor: "dependabot[bot]" }),
  );

  assert.match(notice, DEPENDABOT_NOTICE);
  assert.match(notice, /does not mean that this pull request was reviewed/);
});

test("names the fork when a fork and Dependabot come together", () => {
  const notice = explainMissingSecret(fromFork({ actor: "dependabot[bot]" }));

  assert.match(notice, FORK_NOTICE);
});

test("gives no explanation for an ordinary pull request", () => {
  for (const actor of [
    undefined,
    "octocat",
    "",
    "dependabot",
    "Dependabot[bot]",
    "dependabot[bot]-fan",
    "not-dependabot[bot]",
  ]) {
    assert.equal(
      explainMissingSecret(createFakeContext({ actor })),
      null,
      `actor ${JSON.stringify(actor)}`,
    );
  }
});

test("does not take the same repository in another spelling for a fork", () => {
  const payload = forkEvent("OCTO-ORG/Demo");

  assert.equal(explainMissingSecret(createFakeContext({ payload })), null);
});

test("gives no explanation for an event it cannot read", () => {
  for (const payload of [{}, { pull_request: "text" }, undefined]) {
    assert.equal(explainMissingSecret(createFakeContext({ payload })), null);
  }
  // Dependabot alone still explains it.
  assert.match(
    explainMissingSecret(
      createFakeContext({ payload: {}, actor: "dependabot[bot]" }),
    ),
    DEPENDABOT_NOTICE,
  );
});

test("never puts a value of the event into the notice", () => {
  const payload = forkEvent("EVIL-OWNER/EVIL-REPO");
  payload.pull_request.title = "EVIL-TITLE";
  payload.pull_request.user = { login: "EVIL-AUTHOR" };

  const notice = explainMissingSecret(
    createFakeContext({ payload, actor: "EVIL-ACTOR" }),
  );

  assert.doesNotMatch(notice, /EVIL/);
});

// --- In the run --------------------------------------------------------------

function runWith(inputs, context) {
  const core = createFakeCore(inputs);
  const tokens = [];
  const clients = [];
  return run({
    core,
    context,
    getOctokit: (token) => {
      tokens.push(token);
      return createFakeOctokit(apiFiles(2));
    },
    createAiClient: (options) => {
      clients.push(options);
      return { complete: async () => assert.fail("the model was called") };
    },
  }).then(() => ({ core, tokens, clients }));
}

const NO_KEY = { "github-token": "token-value", "openai-api-key": "" };
const WITH_KEY = {
  "github-token": "token-value",
  "openai-api-key": "key-value",
};

test("ends a fork pull request without a key green, with a notice and no request", async () => {
  const { core, tokens, clients } = await runWith(NO_KEY, fromFork());

  assert.equal(core.messages("notice").length, 1);
  assert.match(core.messages("notice")[0], FORK_NOTICE);
  assert.deepEqual(core.messages("setFailed"), []);
  assert.deepEqual(core.messages("info"), []);
  assert.deepEqual(core.messages("warning"), []);
  assert.deepEqual(tokens, [], "no client for GitHub may be created");
  assert.deepEqual(clients, [], "no client for the model may be created");
});

test("ends a run of Dependabot without a key green, with a notice and no request", async () => {
  const { core, tokens, clients } = await runWith(
    NO_KEY,
    createFakeContext({ actor: "dependabot[bot]" }),
  );

  assert.equal(core.messages("notice").length, 1);
  assert.match(core.messages("notice")[0], DEPENDABOT_NOTICE);
  assert.deepEqual(core.messages("setFailed"), []);
  assert.deepEqual(core.messages("info"), []);
  assert.deepEqual(tokens, []);
  assert.deepEqual(clients, []);
});

test("stops at the notice, before the other inputs are checked", async () => {
  const { core } = await runWith(
    { ...NO_KEY, "max-files": "not a number", exclude: "!bad" },
    fromFork(),
  );

  assert.deepEqual(core.messages("setFailed"), []);
  assert.equal(core.messages("notice").length, 1);
});

test("keeps a missing key an error for an ordinary pull request", async () => {
  for (const context of [
    createFakeContext(),
    createFakeContext({ actor: "octocat" }),
  ]) {
    const { core, tokens } = await runWith(NO_KEY, context);

    assert.equal(core.messages("setFailed").length, 1);
    assert.match(core.messages("setFailed")[0], /`openai-api-key` is missing/);
    assert.deepEqual(core.messages("notice"), []);
    assert.deepEqual(tokens, []);
  }
});

test("keeps a missing key an error when the event cannot be read", async () => {
  const { core } = await runWith(NO_KEY, createFakeContext({ payload: {} }));

  assert.match(core.messages("setFailed")[0], /`openai-api-key` is missing/);
});

test("reviews a fork pull request when the key is there", async () => {
  // The owner of a repository can pass secrets to workflows of forks.
  const { core, tokens, clients } = await runWith(WITH_KEY, fromFork());

  assert.deepEqual(core.messages("notice"), []);
  assert.equal(core.messages("info")[0], "ReviewOps started.");
  assert.deepEqual(tokens, ["token-value"]);
  assert.equal(clients.length, 1);
});

test("reviews a run of Dependabot when the key is there", async () => {
  const { core, clients } = await runWith(
    WITH_KEY,
    createFakeContext({ actor: "dependabot[bot]" }),
  );

  assert.deepEqual(core.messages("notice"), []);
  assert.equal(clients.length, 1);
});

test("still rejects a key that is wrong, also for a fork", async () => {
  const { core } = await runWith(
    { ...WITH_KEY, "openai-api-key": "has a space" },
    fromFork(),
  );

  assert.match(
    core.messages("setFailed")[0],
    /contains a character that is not allowed/,
  );
});

// --- As its own process, with the event of a fork ------------------------------

function eventFile(t, payload) {
  const directory = mkdtempSync(join(tmpdir(), "reviewops-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "event.json");
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

const ENTRY_POINTS = [
  ["the sources", "src/index.js"],
  ["the bundle", "dist/index.js"],
];

for (const [name, entryPoint] of ENTRY_POINTS) {
  const start = (env) => startAction(fromRoot(entryPoint), env);

  test(`${name}: a fork pull request without a key ends green with a notice`, async (t) => {
    const api = await startGitHubApi(t, { files: apiFiles(1) });

    const result = await start(
      withInputs({
        ...PULL_REQUEST_EVENT,
        GITHUB_EVENT_PATH: eventFile(t, forkEvent()),
        GITHUB_API_URL: api.url,
        "INPUT_OPENAI-API-KEY": "",
      }),
    );

    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /^::notice::ReviewOps did not review this pull request: it comes from a fork/m,
    );
    assert.doesNotMatch(result.stdout, /::error::|ReviewOps started\./);
    assert.deepEqual(api.requests, [], "GitHub must not be asked anything");
    assert.equal(result.stderr, "");
  });

  test(`${name}: a run of Dependabot without a key ends green with a notice`, async (t) => {
    const api = await startGitHubApi(t, { files: apiFiles(1) });

    const result = await start(
      withInputs({
        ...PULL_REQUEST_EVENT,
        GITHUB_ACTOR: "dependabot[bot]",
        GITHUB_API_URL: api.url,
        "INPUT_OPENAI-API-KEY": "",
      }),
    );

    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /^::notice::ReviewOps did not review this pull request: the run was started by Dependabot/m,
    );
    assert.doesNotMatch(result.stdout, /::error::/);
    assert.deepEqual(api.requests, []);
  });

  test(`${name}: an ordinary pull request without a key still fails`, async (t) => {
    const api = await startGitHubApi(t, { files: apiFiles(1) });

    const result = await start(
      withInputs({
        ...PULL_REQUEST_EVENT,
        GITHUB_ACTOR: "octocat",
        GITHUB_API_URL: api.url,
        "INPUT_OPENAI-API-KEY": "",
      }),
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout, /^::error::Input `openai-api-key` is missing/m);
    assert.doesNotMatch(result.stdout, /::notice::/);
    assert.deepEqual(api.requests, []);
  });
}
