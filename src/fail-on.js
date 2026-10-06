import { SEVERITIES } from "./ai/schema.js";
import { printable } from "./printable.js";

// The same value is written into action.yml. A test keeps them equal.
export const DEFAULT_FAIL_ON = "none";

/**
 * The values of the input `fail-on` and the severities each one fails on.
 * A threshold includes every more serious severity.
 */
export const FAIL_ON = Object.freeze({
  none: Object.freeze([]),
  critical: Object.freeze(["critical"]),
  major: Object.freeze(["critical", "major"]),
});

/**
 * Reads the input `fail-on`. An empty value means the default: it is usually
 * a variable of the workflow that was not set.
 *
 * @param {string} [value] The value as the workflow passed it.
 * @returns {keyof typeof FAIL_ON}
 * @throws {Error} When the value is not one of {@link FAIL_ON}.
 */
export function parseFailOn(value = "") {
  const text = String(value).trim().toLowerCase();
  if (text === "") return DEFAULT_FAIL_ON;

  if (!Object.hasOwn(FAIL_ON, text)) {
    // The value is a setting of the workflow, which a pull request can change.
    throw new Error(
      `Input \`fail-on\` must be one of ${Object.keys(FAIL_ON).join(", ")}, but is "${printable(String(value).trim())}".`,
    );
  }
  return text;
}

/**
 * How many open findings reach the threshold.
 *
 * @param {Record<string, number>} bySeverity Open findings by severity.
 * @param {keyof typeof FAIL_ON} failOn
 * @returns {number}
 */
export function findingsAtThreshold(bySeverity, failOn) {
  return FAIL_ON[failOn]
    .filter((severity) => SEVERITIES.includes(severity))
    .reduce((sum, severity) => sum + (bySeverity[severity] ?? 0), 0);
}
