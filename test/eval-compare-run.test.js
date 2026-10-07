import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { apiFile, startGitHubApi } from "./helpers/github-api.js";
import {
  apiError,
  reviewCompletion,
  startOpenAiApi,
} from "./helpers/openai-api.js";
import { fromRoot, startAction } from "./helpers/run-action.js";

// Process tests of the model comparison (#80). The program runs as its own
// process, the way the workflow starts it. GitHub and OpenAI are local
// stand-ins, and the test counts every request.

// Recognisable stand-ins that do not look like real credentials.
const TOKEN = "TESTTOKEN-not-a-real-token-123456";
const KEY = "TESTKEY-not-a-real-key-654321";

const FILES = [
  apiFile("src/app.js", {
    additions: 2,
    deletions: 0,
    patch: "@@ -0,0 +1,2 @@\n+let a = 1;\n+let b = 2;",
  }),
];

const finding = {
  path: "src/app.js",
  line: 2,
  severity: "major",
  category: "security",
  title: "A problem",
  comment: "It breaks.",
  suggestion: "Fix it.",
};

// The folders of the lists of cases, removed when all tests are done.
const folders = [];
after(() => {
  for (const folder of folders)
    rmSync(folder, { recursive: true, force: true });
});

/** A list of cases in a file of its own: the tests do not depend on prs.json. */
function casesFile(count = 1) {
  const folder = mkdtempSync(join(tmpdir(), "reviewops-cases-"));
  folders.push(folder);
  const file = join(folder, "prs.json");
  writeFileSync(
    file,
    JSON.stringify({
      cases: Array.from({ length: count }, (_, index) => ({
        id: `case-${index + 1}`,
        pr: `octo-org/demo#${40 + index + 1}`,
        focus: "security",
        defects: [
          {
            path: "src/app.js",
            description: "A documented defect.",
            evidence: "https://example.com/evidence",
          },
        ],
      })),
    }),
  );
  return file;
}

async function start(
  t,
  { github = {}, openai = reviewCompletion([finding]) } = {},
) {
  const api = await startGitHubApi(t, { files: FILES, ...github });
  const model = await startOpenAiApi(t, openai);
  return { api, model };
}

// The runner on Windows ends lines with a carriage return, which `$` of a
// regular expression does not match: the output is compared without it.
const withoutCarriageReturns = (text) => text.replace(/\r/g, "");

async function compare(servers, env = {}) {
  const result = await startAction(fromRoot("eval/compare/compare.mjs"), {
    GITHUB_API_URL: servers.api.url,
    TEST_OPENAI_URL: servers.model.url,
    OPENAI_API_KEY: KEY,
    GITHUB_TOKEN: TOKEN,
    COMPARE_MODEL: "gpt-4.1",
    COMPARE_CASES: casesFile(),
    COMPARE_RUNS: "1",
    ...env,
  });
  return {
    ...result,
    stdout: withoutCarriageReturns(result.stdout),
    output: withoutCarriageReturns(result.output),
    summary: withoutCarriageReturns(result.summary),
  };
}

test("reviews a pull request and writes nothing to GitHub", async (t) => {
  const servers = await start(t);

  const result = await compare(servers);

  assert.equal(result.status, 0, result.output);
  assert.equal(result.stderr, "");
  // Only reads reached GitHub. The review that the action wanted to post was
  // recorded and never sent.
  assert.ok(servers.api.requests.length > 0);
  assert.deepEqual(
    [...new Set(servers.api.requests.map((request) => request.method))],
    ["GET"],
  );
  assert.deepEqual(servers.api.reviews, []);
  assert.equal(servers.model.requests.length, 1);
});

test("prints the figures and the findings of a run", async (t) => {
  const servers = await start(t);

  const result = await compare(servers);

  assert.match(
    result.stdout,
    /Case case-1: octo-org\/demo#41, focus security, model gpt-4\.1, 1 runs\./,
  );
  assert.match(
    result.stdout,
    /Documented defect: src\/app\.js: A documented defect\./,
  );
  assert.match(
    result.stdout,
    /case-1 run 1: 120 input \/ 30 output tokens, 1 requests, failed requests 0 \(none\), files left out by limits 0, findings over max-comments 0, findings 0 critical, 1 major, 0 minor, 0 info\./,
  );
  // The finding as a reader would have seen it, every line behind a fixed `> `.
  assert.match(result.stdout, /^.*> src\/app\.js:2$/m);
  assert.match(result.stdout, /^> \*\*A problem\*\*$/m);
  for (const line of result.stdout.split("\n")) {
    if (/Major|A problem|It breaks/.test(line)) {
      assert.match(line, /> /, line);
    }
  }
  assert.match(result.summary, /### Model comparison: gpt-4\.1/);
  assert.match(
    result.summary,
    /\| case-1 \| 1 \| 120 \/ 30 \| 1 \| 0 \(none\) \|/,
  );
  // Figures only: no text of a finding in the summary.
  assert.doesNotMatch(result.summary, /A problem|It breaks/);
});

test("runs every case as often as asked", async (t) => {
  const servers = await start(t);

  const result = await compare(servers, {
    COMPARE_CASES: casesFile(2),
    COMPARE_RUNS: "2",
  });

  assert.equal(result.status, 0, result.output);
  assert.equal(servers.model.requests.length, 4);
  assert.deepEqual(servers.api.reviews, []);
  assert.match(result.stdout, /case-2 run 2:/);
});

test("keeps the key and the token out of the output", async (t) => {
  const servers = await start(t);

  const result = await compare(servers);

  // The only place for them is the command that makes the runner mask them.
  for (const line of result.output.split("\n")) {
    for (const secret of [KEY, TOKEN]) {
      if (line.includes(secret)) {
        assert.ok(line.startsWith("::add-mask::"), line);
      }
    }
  }
  assert.match(result.stdout, new RegExp(`^::add-mask::${KEY}$`, "m"));
  assert.match(result.stdout, new RegExp(`^::add-mask::${TOKEN}$`, "m"));
  assert.ok(!result.summary.includes(KEY) && !result.summary.includes(TOKEN));
});

test("a run that fails is reported with the others and fails the step at the end", async (t) => {
  const servers = await start(t, {
    openai: apiError(500, { message: "internal detail with sk-hidden" }),
  });

  const result = await compare(servers);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /case-1 run 1: .*failed requests 1 \(server 1\)/);
  assert.match(result.stdout, /^::error::1 of 1 runs ended with an error\./m);
  // The text of OpenAI never reaches the log.
  assert.doesNotMatch(result.output, /sk-hidden|internal detail/);
  assert.match(result.summary, /\| error \|/);
  assert.deepEqual(servers.api.reviews, []);
});

test("a pull request that cannot be read fails after the others are out", async (t) => {
  const servers = await start(t, { github: { status: 404 } });

  const result = await compare(servers);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /could not be read \(HTTP status 404\)/);
  assert.equal(servers.model.requests.length, 0);
});

for (const [name, env, expected] of [
  ["no key", { OPENAI_API_KEY: "" }, /^::error::OPENAI_API_KEY is not set\./m],
  ["no token", { GITHUB_TOKEN: "" }, /^::error::GITHUB_TOKEN is not set\./m],
  ["no model", { COMPARE_MODEL: "" }, /^::error::COMPARE_MODEL is not set\./m],
  [
    "a model name that cannot be one",
    { COMPARE_MODEL: "../x" },
    /^::error::Input `openai-model` must be the name of an OpenAI model/m,
  ],
  [
    "a number of runs outside of 1 to 5",
    { COMPARE_RUNS: "6" },
    /^::error::The number of runs must be a whole number from 1 to 5\./m,
  ],
]) {
  test(`fails before any request with ${name}`, async (t) => {
    const servers = await start(t);

    const result = await compare(servers, env);

    assert.equal(result.status, 1);
    assert.match(result.stdout, expected);
    assert.deepEqual(servers.api.requests, []);
    assert.deepEqual(servers.model.requests, []);
  });
}

test("the list of cases of the repository is the default", async (t) => {
  const servers = await start(t);

  const result = await compare(servers, { COMPARE_CASES: "" });

  assert.equal(result.status, 0, result.output);
  assert.match(
    result.stdout,
    /Case react-hook-demo: lucalipsxstroons1\/ReviewOps#62/,
  );
  assert.deepEqual(servers.api.reviews, []);
});
