import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { fromRoot } from "./helpers/run-action.js";

const workflow = parse(
  readFileSync(fromRoot(".github/workflows/reviewops.yml"), "utf8"),
);
const steps = workflow.jobs.review.steps;

test("runs for new, updated and reopened pull requests only", () => {
  assert.deepEqual(workflow.on, {
    pull_request: { types: ["opened", "synchronize", "reopened"] },
  });
});

test("grants exactly the two permissions the action needs", () => {
  assert.deepEqual(workflow.permissions, {
    contents: "read",
    "pull-requests": "write",
  });
  assert.equal("permissions" in workflow.jobs.review, false);
});

test("cancels the older run of the same pull request", () => {
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  assert.match(
    workflow.concurrency.group,
    /\$\{\{ github\.event\.pull_request\.number \}\}/,
  );
});

test("pins every third-party action to a full commit SHA", () => {
  const thirdParty = steps
    .map((step) => step.uses)
    .filter((uses) => uses && !uses.startsWith("./"));

  assert.ok(thirdParty.length > 0);
  for (const uses of thirdParty) {
    assert.match(uses, /@[0-9a-f]{40}$/, `${uses} is not pinned to a commit`);
  }
});

test("loads the action from the checked-out repository", () => {
  const usesIndex = steps.findIndex((step) => step.uses === "./");
  const checkoutIndex = steps.findIndex((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );

  assert.ok(checkoutIndex >= 0 && checkoutIndex < usesIndex);
  assert.equal(steps[checkoutIndex].with["persist-credentials"], false);
});

test("passes the API key from the secret store and no token", () => {
  const action = steps.find((step) => step.uses === "./");

  assert.deepEqual(action.with, {
    "openai-api-key": "${{ secrets.OPENAI_API_KEY }}",
  });
});
