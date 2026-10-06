import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_FAIL_ON,
  FAIL_ON,
  findingsAtThreshold,
  parseFailOn,
} from "../src/fail-on.js";
import { setOutputs } from "../src/outputs.js";
import { createFakeCore } from "./helpers/fake-core.js";

const COUNTS = { critical: 2, major: 3, minor: 4, info: 5 };

test("the default is none", () => {
  assert.equal(DEFAULT_FAIL_ON, "none");
  assert.equal(parseFailOn(), "none");
  assert.equal(parseFailOn(""), "none");
  assert.equal(parseFailOn("  "), "none");
});

test("reads every value, without case and outer white space", () => {
  assert.equal(parseFailOn("none"), "none");
  assert.equal(parseFailOn("critical"), "critical");
  assert.equal(parseFailOn(" Major "), "major");
  assert.equal(parseFailOn("CRITICAL"), "critical");
});

test("rejects any other value with a message that names the choices", () => {
  for (const value of ["minor", "info", "all", "critical,major", "1", "true"]) {
    assert.throws(
      () => parseFailOn(value),
      (error) =>
        error.message.startsWith(
          "Input `fail-on` must be one of none, critical, major",
        ) && error.message.includes(`"${value}"`),
    );
  }
});

test("shows invisible characters of a wrong value", () => {
  const value = `critical${String.fromCodePoint(0x202e)}`;
  assert.throws(
    () => parseFailOn(value),
    (error) => !error.message.includes(String.fromCodePoint(0x202e)),
  );
});

test("does not fail on anything with none", () => {
  assert.equal(findingsAtThreshold(COUNTS, "none"), 0);
});

test("counts only critical findings with critical", () => {
  assert.equal(findingsAtThreshold(COUNTS, "critical"), 2);
});

test("counts critical and major findings with major", () => {
  assert.equal(findingsAtThreshold(COUNTS, "major"), 5);
});

test("counts nothing when there are no findings", () => {
  for (const failOn of Object.keys(FAIL_ON)) {
    assert.equal(
      findingsAtThreshold({ critical: 0, major: 0, minor: 0, info: 0 }, failOn),
      0,
    );
  }
});

test("sets the three outputs as text", () => {
  const core = createFakeCore();
  setOutputs(core, {
    findingsCount: 3,
    criticalCount: 1,
    reviewUrl: "https://github.com/o/r/pull/1#pullrequestreview-5",
  });

  assert.deepEqual(core.outputs, {
    "findings-count": "3",
    "critical-count": "1",
    "review-url": "https://github.com/o/r/pull/1#pullrequestreview-5",
  });
});

test("sets an empty review-url when no review was posted", () => {
  const core = createFakeCore();
  setOutputs(core, { findingsCount: 0, criticalCount: 0, reviewUrl: null });

  assert.equal(core.outputs["review-url"], "");
});
