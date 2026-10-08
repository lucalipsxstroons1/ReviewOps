import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { fromRoot } from "./helpers/run-action.js";
import {
  assertCheckoutWithoutCredentials,
  assertReviewConcurrency,
  assertReviewTriggers,
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

test("reviewops.yml: runs for the events that start a review", () => {
  assertReviewTriggers(reviewops);
});

test("reviewops.yml: grants exactly the two permissions the action needs", () => {
  assert.deepEqual(reviewops.permissions, {
    contents: "read",
    "pull-requests": "write",
  });
});

test("reviewops.yml: cancels the older run of the same pull request, but not for a label", () => {
  assertReviewConcurrency(reviewops);
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
    // The comparison of models (compare.yml) does not touch the prompt, and a
    // change to it would only use up the token limit of the reference model.
    "!eval/compare/**",
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
  assert.equal(evalStep.env.EVAL_AREAS, "${{ inputs.areas }}");
  assert.deepEqual(
    Object.keys(evaluation.config.on.workflow_dispatch.inputs).sort(),
    ["areas", "language", "model"],
  );
  for (const step of evalSteps) {
    assert.doesNotMatch(step.run ?? "", /\$\{\{/);
  }
});

test("eval.yml: installs exactly what the lock file says before it evaluates", () => {
  const commands = evalSteps.map((step) => step.run).filter(Boolean);

  assert.deepEqual(commands, ["npm ci", "npm run eval"]);
});

// --- compare.yml: the action on real pull requests, one model at a time ------

const comparison = workflows["compare.yml"];
const compareSteps = comparison.config.jobs.compare.steps;
const compareStep = compareSteps.find((step) => step.run === "npm run compare");

test("compare.yml: runs by hand only", () => {
  assert.deepEqual(Object.keys(comparison.config.on), ["workflow_dispatch"]);
});

test("compare.yml: asks for the model, the number of runs (3 by default) and the list of cases (prs by default)", () => {
  const { inputs } = comparison.config.on.workflow_dispatch;

  assert.deepEqual(Object.keys(inputs).sort(), ["cases", "model", "runs"]);
  assert.equal(inputs.model.required, true);
  assert.equal(inputs.runs.default, "3");
  assert.equal(inputs.cases.default, "prs");
});

test("compare.yml: offers only the lists of cases that exist, each as a file of the repository", () => {
  const { cases } = comparison.config.on.workflow_dispatch.inputs;

  assert.equal(cases.type, "choice");
  assert.deepEqual(cases.options, ["prs", "false-alarms"]);
  for (const name of cases.options) {
    assert.ok(existsSync(fromRoot(`eval/compare/${name}.json`)), name);
  }
});

test("compare.yml: may only read the code and the pull requests", () => {
  assert.deepEqual(comparison.config.permissions, {
    contents: "read",
    "pull-requests": "read",
  });
});

test("compare.yml: lets a second run wait, because a cancelled one has cost money", () => {
  assert.equal(comparison.config.concurrency["cancel-in-progress"], false);
});

test("compare.yml: has a time limit that fits the cases", () => {
  assert.equal(comparison.config.jobs.compare["timeout-minutes"], 90);
});

test("compare.yml: passes the key only to the step that needs it", () => {
  const withSecret = compareSteps.filter((step) =>
    JSON.stringify(step).includes("secrets."),
  );

  assert.deepEqual(withSecret, [compareStep]);
  assert.equal(compareStep.env.OPENAI_API_KEY, "${{ secrets.OPENAI_API_KEY }}");
  assert.equal(compareStep.env.GITHUB_TOKEN, "${{ github.token }}");
  assert.doesNotMatch(
    JSON.stringify(comparison.config.jobs.compare.env ?? {}),
    /secrets\./,
  );
  assert.equal("env" in comparison.config, false);
});

test("compare.yml: hands the model and the runs to the program through the environment, not the command", () => {
  assert.equal(compareStep.env.COMPARE_MODEL, "${{ inputs.model }}");
  assert.equal(compareStep.env.COMPARE_RUNS, "${{ inputs.runs }}");
  assert.equal(
    compareStep.env.COMPARE_CASES,
    "eval/compare/${{ inputs.cases }}.json",
  );
  for (const step of compareSteps) {
    assert.doesNotMatch(step.run ?? "", /\$\{\{/);
  }
});

test("compare.yml: installs exactly what the lock file says before it compares", () => {
  const commands = compareSteps.map((step) => step.run).filter(Boolean);

  assert.deepEqual(commands, ["npm ci", "npm run compare"]);
});

// --- release.yml: the release and the tags, started by the maintainer --------

const release = workflows["release.yml"];
const releaseJob = release.config.jobs.release;
const releaseSteps = releaseJob.steps;
const stepNamed = (name) => releaseSteps.find((step) => step.name === name);
const indexOfStep = (name) =>
  releaseSteps.findIndex((step) => step.name === name);

test("release.yml: runs by hand only, without inputs", () => {
  assert.deepEqual(Object.keys(release.config.on), ["workflow_dispatch"]);
  assert.equal(release.config.on.workflow_dispatch, null);
});

test("release.yml: has the one write right it needs and nothing else", () => {
  assert.deepEqual(release.config.permissions, { contents: "write" });
});

test("release.yml: releases the default branch only, and fails on another branch", () => {
  // A condition on the job would skip it, and a skipped run looks green.
  assert.equal("if" in releaseJob, false);
  const [first] = releaseSteps;

  assert.equal(first.name, "Check the branch");
  assert.match(first.run, /refs\/heads\/main/);
  assert.match(first.run, /::error::/);
  assert.match(first.run, /exit 1/);
});

test("release.yml: never cancels a release that is running, and has a time limit", () => {
  assert.equal(release.config.concurrency.group, "release");
  assert.equal(release.config.concurrency["cancel-in-progress"], false);
  assert.equal(releaseJob["timeout-minutes"], 15);
});

test("release.yml: checks and builds before it makes anything", () => {
  const order = [
    "Check the branch",
    "Check the version",
    "Install dependencies",
    "Lint",
    "Test",
    "Build",
    "Check that dist/ matches the sources",
    "Create the release",
    "Move the major tag",
    "Check that both tags point at the release commit",
  ].map(indexOfStep);

  assert.ok(
    order.every((index) => index >= 0),
    "a step is missing",
  );
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
  assert.equal(stepNamed("Install dependencies").run, "npm ci");
  assert.equal(stepNamed("Lint").run, "npm run lint");
  assert.equal(stepNamed("Test").run, "npm test");
  assert.equal(stepNamed("Build").run, "npm run build");
});

test("release.yml: stops when the build changes dist/", () => {
  const { run } = stepNamed("Check that dist/ matches the sources");

  assert.match(run, /git status --porcelain dist\//);
  assert.match(run, /::error::/);
  assert.match(run, /exit 1/);
});

test("release.yml: checks the version before it makes anything", () => {
  const { run } = stepNamed("Check the version");

  assert.match(run, /\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.match(run, /ACTION_VERSION/);
  assert.match(run, /docs\/releases\/v\$version\.md/);
  assert.match(run, /git\/ref\/tags\/v\$version/);
});

test("release.yml: the release and the major tag are made on the commit of the run", () => {
  const create = stepNamed("Create the release").run;
  const move = stepNamed("Move the major tag").run;

  assert.match(create, /gh release create "v\$VERSION"/);
  assert.match(create, /--target "\$GITHUB_SHA"/);
  assert.match(create, /--notes-file "docs\/releases\/v\$VERSION\.md"/);
  assert.doesNotMatch(create, /generate-notes/);
  assert.equal((move.match(/sha="\$GITHUB_SHA"/g) ?? []).length, 2);
});

test("release.yml: gives the token only to the steps that call GitHub", () => {
  const withToken = releaseSteps
    .filter((step) => step.env?.GH_TOKEN !== undefined)
    .map((step) => step.name);

  assert.deepEqual(withToken, [
    "Check the version",
    "Create the release",
    "Move the major tag",
    "Check that both tags point at the release commit",
  ]);
  for (const step of releaseSteps) {
    if (step.env?.GH_TOKEN !== undefined) {
      assert.equal(step.env.GH_TOKEN, "${{ github.token }}");
    }
  }
});

test("release.yml: uses no secret and no expression inside a command", () => {
  assert.doesNotMatch(release.source, /secrets\./);
  for (const step of releaseSteps) {
    assert.doesNotMatch(step.run ?? "", /\$\{\{/);
  }
});

test("release.yml: hands the version to the steps through the environment", () => {
  assert.equal(
    stepNamed("Create the release").env.VERSION,
    "${{ steps.version.outputs.version }}",
  );
  assert.equal(
    stepNamed("Move the major tag").env.MAJOR,
    "${{ steps.version.outputs.major }}",
  );
  assert.equal(stepNamed("Check the version").id, "version");
});
