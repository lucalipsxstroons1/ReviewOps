import { readFileSync } from "node:fs";
import { fromRoot } from "./run-action.js";

export const EVENT_FIXTURE = fromRoot("test/fixtures/pull-request-event.json");

/** A fresh copy of the example payload, safe to modify in a test. */
export const loadEvent = () => JSON.parse(readFileSync(EVENT_FIXTURE, "utf8"));

/**
 * Stand-in for the context object of `@actions/github`: a pull_request event
 * with the example payload, unless a test overrides a field.
 *
 * Overrides are spread instead of taken as default parameters, so a test can
 * pass `undefined` on purpose, for example for a missing event name.
 *
 * @param {{ eventName?: string, payload?: object, repo?: object }} [overrides]
 */
export function createFakeContext(overrides = {}) {
  return {
    eventName: "pull_request",
    payload: loadEvent(),
    repo: { owner: "octo-org", repo: "demo" },
    ...overrides,
  };
}
