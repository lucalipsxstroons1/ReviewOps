import assert from "node:assert/strict";
import { MAX_REQUEST_CHARS } from "../../src/ai/batch.js";
import {
  ATTEMPT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  MAX_PAUSE_SECONDS,
} from "../../src/insights/send.js";
import { DEFAULT_MAX_DIFF_CHARS } from "../../src/limits.js";
import { MAX_PARALLEL_REQUESTS } from "../../src/review.js";

// The rules every workflow of this project follows, and every example
// workflow in the README. They live here once, so a rule that is added later
// applies to both.

/** The steps of all jobs of a parsed workflow. */
export const stepsOf = (config) =>
  Object.values(config.jobs).flatMap((job) => job.steps ?? []);

/**
 * Every third-party action is pinned to a full commit SHA: a tag can be moved
 * to other code. A local action (`./`) needs no pin.
 *
 * @param {object} config The parsed workflow.
 * @param {{ allow?: RegExp }} [options] `allow` names the one kind of action
 *   that may use another reference, for example ReviewOps itself by major tag.
 */
export function assertPinnedToCommits(config, { allow } = {}) {
  const thirdParty = stepsOf(config)
    .map((step) => step.uses)
    .filter((uses) => uses && !uses.startsWith("./"));

  for (const uses of thirdParty) {
    if (allow?.test(uses)) continue;
    assert.match(uses, /@[0-9a-f]{40}$/, `${uses} is not pinned to a commit`);
  }
}

/** The permissions are set once at the top, no job overrides them. */
export function assertPermissionsAtTop(config) {
  assert.equal(typeof config.permissions, "object");
  for (const [name, job] of Object.entries(config.jobs)) {
    assert.equal("permissions" in job, false, `job ${name} overrides them`);
  }
}

/**
 * A checkout does not keep the credentials. A workflow without a checkout is
 * fine; this only covers the ones it has.
 */
export function assertCheckoutWithoutCredentials(config) {
  const checkouts = stepsOf(config).filter((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );

  for (const step of checkouts) {
    assert.equal(step.with?.["persist-credentials"], false);
  }
}

/** The time limit of a job that runs the action with the default limits. */
export const REVIEW_TIMEOUT_MINUTES = 15;

/**
 * The job has enough time for the requests to the model.
 *
 * Requests are filled in the order of GitHub, so two neighbouring requests
 * always hold more than one budget: a pull request of the default size needs
 * about eight requests at most. The report for Insights (#76) comes on top
 * in the worst case: every attempt runs into its time limit, and the pauses
 * between the attempts are as long as they may be.
 */
export function assertTimeoutForRequests(job) {
  const requests = 2 * Math.ceil(DEFAULT_MAX_DIFF_CHARS / MAX_REQUEST_CHARS);
  const rounds = Math.ceil(requests / MAX_PARALLEL_REQUESTS);
  // Three attempts of 120 seconds and the waits of the SDK between them.
  const minutesPerRequest = (3 * 120 + 30) / 60;
  const insightsMinutes =
    (MAX_ATTEMPTS * (ATTEMPT_TIMEOUT_MS / 1000) +
      (MAX_ATTEMPTS - 1) * MAX_PAUSE_SECONDS) /
    60;

  assert.equal(job["timeout-minutes"], REVIEW_TIMEOUT_MINUTES);
  assert.ok(
    rounds * minutesPerRequest + insightsMinutes <= REVIEW_TIMEOUT_MINUTES,
  );
}

/**
 * The events that start a review (#23): new, updated and reopened pull
 * requests, a draft that is marked ready, and a label that is taken off (the
 * skip label starts the review again when it goes). Every other event type
 * would review as before, so nothing else is listed.
 */
export function assertReviewTriggers(config) {
  assert.deepEqual(config.on, {
    pull_request: {
      types: [
        "opened",
        "synchronize",
        "reopened",
        "ready_for_review",
        "unlabeled",
      ],
    },
  });
}

/**
 * A newer push cancels the older run of the same pull request. A change of
 * labels does not: its run leaves out the review, and it must not cancel a
 * review that is running.
 */
export function assertReviewConcurrency(config) {
  assert.equal(
    config.concurrency["cancel-in-progress"],
    "${{ github.event.action != 'unlabeled' }}",
  );
  assert.match(
    config.concurrency.group,
    /\$\{\{ github\.event\.pull_request\.number \}\}/,
  );
}
