import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { fromRoot } from "./helpers/run-action.js";
import {
  assertCheckoutWithoutCredentials,
  assertPermissionsAtTop,
  assertPinnedToCommits,
  assertTimeoutForRequests,
} from "./helpers/workflow-rules.js";

const WORKFLOW_DIR = ".github/workflows";

/** Every workflow file, keyed by file name, as source text and parsed YAML. */
const workflows = Object.fromEntries(
  readdirSync(fromRoot(WORKFLOW_DIR))
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => {
      const source = readFileSync(fromRoot(`${WORKFLOW_DIR}/${file}`), "utf8");
      return [file, { source, config: parse(source) }];
    }),
);

// --- Rules for every workflow ---------------------------------------------

for (const [file, { config }] of Object.entries(workflows)) {
  test(`${file}: pins every third-party action to a full commit SHA`, () => {
    assertPinnedToCommits(config);
  });

  test(`${file}: sets its permissions once, at the top`, () => {
    assertPermissionsAtTop(config);
  });

  test(`${file}: checks out the code without keeping credentials`, () => {
    assertCheckoutWithoutCredentials(config);
  });
}

// --- reviewops.yml: the action reviewing pull requests ----------------------

const reviewops = workflows["reviewops.yml"].config;
const reviewSteps = reviewops.jobs.review.steps;

test("reviewops.yml: runs for new, updated and reopened pull requests only", () => {
  assert.deepEqual(reviewops.on, {
    pull_request: { types: ["opened", "synchronize", "reopened"] },
  });
});

test("reviewops.yml: grants exactly the two permissions the action needs", () => {
  assert.deepEqual(reviewops.permissions, {
    contents: "read",
    "pull-requests": "write",
  });
});

test("reviewops.yml: cancels the older run of the same pull request", () => {
  assert.equal(reviewops.concurrency["cancel-in-progress"], true);
  assert.match(
    reviewops.concurrency.group,
    /\$\{\{ github\.event\.pull_request\.number \}\}/,
  );
});

test("reviewops.yml: gives the requests to the model enough time", () => {
  assertTimeoutForRequests(reviewops.jobs.review);
});

test("reviewops.yml: loads the action from the checked-out repository", () => {
  const usesIndex = reviewSteps.findIndex((step) => step.uses === "./");
  const checkoutIndex = reviewSteps.findIndex((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );

  assert.ok(checkoutIndex >= 0 && checkoutIndex < usesIndex);
});

test("reviewops.yml: passes the API key from the secret store and no token", () => {
  const action = reviewSteps.find((step) => step.uses === "./");

  assert.deepEqual(action.with, {
    "openai-api-key": "${{ secrets.OPENAI_API_KEY }}",
  });
});

test("reviewops.yml: hands the outputs to a later step through the environment", () => {
  const action = reviewSteps.find((step) => step.uses === "./");
  const show = reviewSteps[reviewSteps.indexOf(action) + 1];

  assert.equal(action.id, "review");
  assert.deepEqual(show.env, {
    FINDINGS_COUNT: "${{ steps.review.outputs.findings-count }}",
    CRITICAL_COUNT: "${{ steps.review.outputs.critical-count }}",
    REVIEW_URL: "${{ steps.review.outputs.review-url }}",
  });
  // No expression inside the command: a value can never become shell code.
  assert.doesNotMatch(show.run, /\$\{\{/);
});

// --- ci.yml: lint, test and build -------------------------------------------

const ci = workflows["ci.yml"];
const ciSteps = ci.config.jobs.check.steps;

test("ci.yml: runs for every pull request and every push to main", () => {
  assert.deepEqual(Object.keys(ci.config.on).sort(), ["pull_request", "push"]);
  // No `types` filter: the default covers opened, synchronize and reopened.
  assert.equal(ci.config.on.pull_request, null);
  assert.deepEqual(ci.config.on.push, { branches: ["main"] });
});

test("ci.yml: may only read the code", () => {
  assert.deepEqual(ci.config.permissions, { contents: "read" });
});

test("ci.yml: uses no secret", () => {
  assert.doesNotMatch(ci.source, /secrets\./);
});

test("ci.yml: installs, lints, tests and builds in that order", () => {
  const commands = ciSteps.map((step) => step.run).filter(Boolean);

  assert.deepEqual(commands.slice(0, 4), [
    "npm ci",
    "npm run lint",
    "npm test",
    "npm run build",
  ]);
});

test("ci.yml: fails when the build changes dist/", () => {
  const buildIndex = ciSteps.findIndex((step) => step.run === "npm run build");
  const check = ciSteps[buildIndex + 1];

  assert.match(check.run, /git status --porcelain dist\//);
  assert.match(check.run, /::error::/);
  assert.match(check.run, /exit 1/);
});

test("ci.yml: takes the Node.js version from .node-version", () => {
  const setup = ciSteps.find((step) =>
    step.uses?.startsWith("actions/setup-node@"),
  );

  assert.equal(setup.with["node-version-file"], ".node-version");
});

// --- eval.yml: the prompt measured against the real API ---------------------

const evaluation = workflows["eval.yml"];
const evalSteps = evaluation.config.jobs.eval.steps;
const evalStep = evalSteps.find((step) => step.run === "npm run eval");

test("eval.yml: runs for changes of the prompt, the format and the cases, and by hand", () => {
  assert.deepEqual(Object.keys(evaluation.config.on).sort(), [
    "pull_request",
    "workflow_dispatch",
  ]);
  assert.deepEqual(evaluation.config.on.pull_request.paths, [
    "src/ai/**",
    "eval/**",
    ".github/workflows/eval.yml",
  ]);
});

test("eval.yml: never runs on pull_request_target, which hands secrets to forks", () => {
  assert.equal("pull_request_target" in evaluation.config.on, false);
});

test("eval.yml: may only read the code", () => {
  assert.deepEqual(evaluation.config.permissions, { contents: "read" });
});

test("eval.yml: has a time limit and cancels the older run", () => {
  assert.equal(typeof evaluation.config.jobs.eval["timeout-minutes"], "number");
  assert.ok(evaluation.config.jobs.eval["timeout-minutes"] <= 30);
  assert.equal(evaluation.config.concurrency["cancel-in-progress"], true);
});

test("eval.yml: passes the key only to the step that needs it", () => {
  const withSecret = evalSteps.filter((step) =>
    JSON.stringify(step).includes("secrets."),
  );

  assert.deepEqual(withSecret, [evalStep]);
  assert.equal(evalStep.env.OPENAI_API_KEY, "${{ secrets.OPENAI_API_KEY }}");
  assert.doesNotMatch(
    JSON.stringify(evaluation.config.jobs.eval.env ?? {}),
    /secrets\./,
  );
  assert.equal("env" in evaluation.config, false);
});

test("eval.yml: hands the model and the language to the program through the environment, not the command", () => {
  assert.equal(evalStep.env.EVAL_MODEL, "${{ inputs.model }}");
  assert.equal(evalStep.env.EVAL_LANGUAGE, "${{ inputs.language }}");
  assert.deepEqual(
    Object.keys(evaluation.config.on.workflow_dispatch.inputs).sort(),
    ["language", "model"],
  );
  for (const step of evalSteps) {
    assert.doesNotMatch(step.run ?? "", /\$\{\{/);
  }
});

test("eval.yml: installs exactly what the lock file says before it evaluates", () => {
  const commands = evalSteps.map((step) => step.run).filter(Boolean);

  assert.deepEqual(commands, ["npm ci", "npm run eval"]);
});
