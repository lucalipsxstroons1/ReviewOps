import assert from "node:assert/strict";
import { maxRequestsFor } from "../../src/ai/batch.js";
import { MAX_RETRIES, TIMEOUT_MS } from "../../src/ai/client.js";
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
export const REVIEW_TIMEOUT_MINUTES = 25;

/**
 * The longest the SDK of OpenAI waits between two attempts when the answer
 * asks for it (`Retry-After`). It takes a longer value as an error and
 * works out its own wait, which is shorter. `test/workflow.test.js` checks
 * the installed SDK for this rule, so an update cannot change it unseen.
 */
export const SDK_MAX_WAIT_SECONDS = 60;

/** Minutes for everything that is not a request to the model or a report. */
export const REST_OF_THE_JOB_MINUTES = 5;

/**
 * The job has enough time for the requests to the model.
 *
 * The number of requests is the limit of `maxRequestsFor()` (#108), the one
 * `run()` checks before the first request: 7 with the default budget, so two
 * rounds of at most four at once. In the worst case, every attempt of a
 * request runs into its time limit and the SDK waits as long as it may
 * between the attempts: 3 * 120 + 2 * 60 = 480 seconds. The default model
 * refuses `temperature`, so the first request of a run is sent twice. The
 * assumption is that the refusal comes at once, after one attempt that ran
 * into its limit: 120 seconds more. (If OpenAI hangs twice and refuses only
 * in the third attempt, the first round takes 16 minutes and the job runs out
 * of time; a refusal is an answer of the API that comes at once in practice.)
 * The two reports for Insights (#76, #77) come on top, with every attempt at
 * its time limit and the pauses as long as they may be, and 5 minutes for the
 * rest: checkout, loading the action, reading from GitHub.
 */
export function assertTimeoutForRequests(job) {
  const requests = maxRequestsFor(DEFAULT_MAX_DIFF_CHARS);
  const rounds = Math.ceil(requests / MAX_PARALLEL_REQUESTS);
  const attempts = MAX_RETRIES + 1;
  // The attempts of one request and the waits of the SDK between them.
  const minutesPerRequest =
    (attempts * (TIMEOUT_MS / 1000) + MAX_RETRIES * SDK_MAX_WAIT_SECONDS) / 60;
  // The refused first attempt of the first request of the run.
  const refusalMinutes = TIMEOUT_MS / 1000 / 60;
  const reports = 2;
  const insightsMinutes =
    (reports *
      (MAX_ATTEMPTS * (ATTEMPT_TIMEOUT_MS / 1000) +
        (MAX_ATTEMPTS - 1) * MAX_PAUSE_SECONDS)) /
    60;

  assert.equal(job["timeout-minutes"], REVIEW_TIMEOUT_MINUTES);
  const worstCase =
    rounds * minutesPerRequest +
    refusalMinutes +
    insightsMinutes +
    REST_OF_THE_JOB_MINUTES;
  assert.ok(
    worstCase <= REVIEW_TIMEOUT_MINUTES,
    `the worst case takes ${worstCase} minutes`,
  );
}

/**
 * The events that start a review (#23): new, updated and reopened pull
 * requests, a draft that is marked ready, and a label that is taken off (the
 * skip label starts the review again when it goes). Every other event type
 * would review as before, so nothing else is listed.
 *
 * The one named variant (#77) is the workflow that reports to ReviewOps
 * Insights: it also runs on `closed`, because the final state of the
 * findings (merged or not) can only be sent then. Such a run reviews nothing.
 * The workflow of this repository and the plain example have no `closed`.
 *
 * @param {object} config
 * @param {object} [options]
 * @param {boolean} [options.closed] The variant with `closed`.
 */
export function assertReviewTriggers(config, { closed = false } = {}) {
  assert.deepEqual(config.on, {
    pull_request: {
      types: [
        "opened",
        "synchronize",
        "reopened",
        "ready_for_review",
        "unlabeled",
        ...(closed ? ["closed"] : []),
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
