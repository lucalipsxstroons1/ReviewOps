import { printable } from "./printable.js";

// The same values are written into action.yml. A test keeps them equal.
export const DEFAULT_REVIEW_DRAFTS = "false";
export const DEFAULT_SKIP_LABEL = "no-ai-review";
export const DEFAULT_REVIEW_BOTS = "false";

// GitHub allows 50 characters in the name of a label.
export const MAX_LABEL_LENGTH = 50;

// More labels or longer names than GitHub allows come from a payload that is
// not what it claims to be. They are not looked at.
const MAX_LABELS = 100;
const MAX_LABEL_NAME = 100;

/**
 * Reads the inputs that say which pull requests are reviewed. An empty value
 * of `review-drafts` and `review-bots` means the default, which is `false`.
 * An empty `skip-label` switches the label off.
 *
 * @param {{ reviewDrafts?: string, skipLabel?: string, reviewBots?: string }} inputs
 *   The values as the workflow passed them.
 * @returns {{ reviewDrafts: boolean, skipLabel: string | null, reviewBots: boolean }}
 * @throws {Error} For a value that cannot be used. The values are settings of
 *   the workflow, which a pull request can change, so they go through
 *   `printable()`.
 */
export function parseSkipOptions({
  reviewDrafts = "",
  skipLabel = "",
  reviewBots = "",
} = {}) {
  const label = String(skipLabel).trim();
  if ([...label].length > MAX_LABEL_LENGTH) {
    throw new Error(
      `Input \`skip-label\` is longer than ${MAX_LABEL_LENGTH} characters, the longest name GitHub allows for a label.`,
    );
  }
  return {
    reviewDrafts: parseBoolean(reviewDrafts, "review-drafts"),
    skipLabel: label === "" ? null : label,
    reviewBots: parseBoolean(reviewBots, "review-bots"),
  };
}

function parseBoolean(value, name) {
  const text = String(value).trim().toLowerCase();
  if (text === "") return false;
  if (text === "true") return true;
  if (text === "false") return false;
  throw new Error(
    `Input \`${name}\` must be true or false, but is "${printable(String(value).trim())}".`,
  );
}

/**
 * What the event says about the pull request, as far as skipping needs it.
 * Everything in the event comes from the author of the pull request or from
 * whoever set a label, so it is only read here, with limits, and never
 * written to the log.
 *
 * @param {{ payload?: object }} context
 * @returns {{
 *   action: string | null,
 *   isDraft: boolean,
 *   authorIsBot: boolean,
 *   labels: string[],
 *   removedLabel: string | null,
 * }} `labels` holds the names in lower case.
 */
export function readSkipFacts(context) {
  const payload = isObject(context?.payload) ? context.payload : {};
  const pullRequest = isObject(payload.pull_request)
    ? payload.pull_request
    : {};

  const labels = (Array.isArray(pullRequest.labels) ? pullRequest.labels : [])
    .slice(0, MAX_LABELS)
    .map((label) => labelName(label?.name))
    .filter((name) => name !== null);

  return {
    action: typeof payload.action === "string" ? payload.action : null,
    isDraft: pullRequest.draft === true,
    authorIsBot: pullRequest.user?.type === "Bot",
    labels,
    removedLabel: labelName(payload.label?.name),
  };
}

function labelName(value) {
  return typeof value === "string" && value.length <= MAX_LABEL_NAME
    ? value.toLowerCase()
    : null;
}

const isObject = (value) => typeof value === "object" && value !== null;

/**
 * Says whether this run leaves out the review, and why. The first reason that
 * applies counts: the skip label, then a draft, then a bot, then the removal
 * of another label.
 *
 * A run that does not review still reads the files and the earlier findings
 * and applies `fail-on`: a label can be set by anyone with the role Triage,
 * and it must not turn a red check green.
 *
 * Nothing in the texts comes from the event, only from the inputs.
 *
 * @param {ReturnType<typeof readSkipFacts>} facts
 * @param {ReturnType<typeof parseSkipOptions>} options
 * @returns {{ code: "label" | "draft" | "bot" | "label-change", text: string } | null}
 */
export function skipReason(facts, options) {
  const skipLabel = options.skipLabel?.toLowerCase() ?? null;

  if (skipLabel !== null && facts.labels.includes(skipLabel)) {
    return {
      code: "label",
      text: `the pull request has the label "${printable(options.skipLabel)}" (input skip-label)`,
    };
  }
  if (facts.isDraft && !options.reviewDrafts) {
    return {
      code: "draft",
      text: "the pull request is a draft (input review-drafts is false)",
    };
  }
  if (facts.authorIsBot && !options.reviewBots) {
    return {
      code: "bot",
      text: "the pull request was opened by a bot (input review-bots is false)",
    };
  }
  // Taking off the skip label starts the review. Taking off any other label
  // changes nothing about the code, and a label the event does not name is
  // treated the same way.
  if (
    facts.action === "unlabeled" &&
    (facts.removedLabel === null || facts.removedLabel !== skipLabel)
  ) {
    return {
      code: "label-change",
      text: "a label was removed that is not the skip label",
    };
  }
  return null;
}
