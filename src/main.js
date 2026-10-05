import * as actionsCore from "@actions/core";
import { assertInputs, readInputs } from "./inputs.js";
import { createRedactor } from "./redact.js";

// `pull_request_target` is left out on purpose: it hands secrets and a write
// token to pull requests from forks.
const SUPPORTED_EVENT = "pull_request";

/**
 * Entry point of the action. Every failure ends in `core.setFailed()`.
 *
 * The event name comes straight from the environment. Importing
 * `@actions/github` here would parse the event file while the module loads,
 * and a failure at that point happens before this function can catch it.
 *
 * @param {object} [deps] Replacements for the runner, used by tests.
 * @param {typeof import("@actions/core")} [deps.core]
 * @param {string} [deps.eventName] Name of the event that triggered the run.
 */
export async function run({
  core = actionsCore,
  eventName = process.env.GITHUB_EVENT_NAME,
} = {}) {
  let redact = String;

  try {
    if (eventName !== SUPPORTED_EVENT) {
      core.notice(
        `ReviewOps runs only on the "${SUPPORTED_EVENT}" event. This run was triggered by "${eventName ?? "unknown"}" and was skipped.`,
      );
      return;
    }

    const inputs = readInputs(core);
    redact = createRedactor(Object.values(inputs));
    assertInputs(inputs);

    core.info("ReviewOps started.");
  } catch (error) {
    // Mark the step as failed first: nothing below may prevent that.
    core.setFailed(redact(describe(error)));

    try {
      if (error instanceof Error && error.stack) {
        core.debug(redact(error.stack));
      }
    } catch {
      // A broken debug log must not hide the failure reported above.
    }
  }
}

/** Turns anything that was thrown into a message a person can act on. */
function describe(error) {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string" && error.trim()) return error;
  return "ReviewOps failed without an error message.";
}
