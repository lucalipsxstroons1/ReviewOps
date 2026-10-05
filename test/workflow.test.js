import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { fromRoot } from "./helpers/run-action.js";

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

const stepsOf = (config) =>
  Object.values(config.jobs).flatMap((job) => job.steps ?? []);

// --- Rules for every workflow ---------------------------------------------

for (const [file, { config }] of Object.entries(workflows)) {
  test(`${file}: pins every third-party action to a full commit SHA`, () => {
    const thirdParty = stepsOf(config)
      .map((step) => step.uses)
      .filter((uses) => uses && !uses.startsWith("./"));

    for (const uses of thirdParty) {
      assert.match(uses, /@[0-9a-f]{40}$/, `${uses} is not pinned to a commit`);
    }
  });

  test(`${file}: sets its permissions once, at the top`, () => {
    assert.equal(typeof config.permissions, "object");
    for (const [name, job] of Object.entries(config.jobs)) {
      assert.equal("permissions" in job, false, `job ${name} overrides them`);
    }
  });

  test(`${file}: checks out the code without keeping credentials`, () => {
    // A workflow without a checkout is fine; this only covers the ones it has.
    const checkouts = stepsOf(config).filter((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );

    for (const step of checkouts) {
      assert.equal(step.with?.["persist-credentials"], false);
    }
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
