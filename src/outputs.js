/**
 * Sets the outputs of the step. The names are declared in action.yml; a test
 * keeps both equal.
 *
 * Only numbers and the address of the review are set: the address is built
 * from checked values only (`reviewUrl()`).
 *
 * @param {Pick<typeof import("@actions/core"), "setOutput">} core
 * @param {{ findingsCount: number, criticalCount: number, reviewUrl: string | null }} result
 */
export function setOutputs(core, { findingsCount, criticalCount, reviewUrl }) {
  core.setOutput("findings-count", String(findingsCount));
  core.setOutput("critical-count", String(criticalCount));
  core.setOutput("review-url", reviewUrl ?? "");
}
