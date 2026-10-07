import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ACTION_VERSION } from "../src/version.js";
import { fromRoot } from "./helpers/run-action.js";

test("ACTION_VERSION equals the version in package.json", () => {
  const { version } = JSON.parse(
    readFileSync(fromRoot("package.json"), "utf8"),
  );
  assert.equal(ACTION_VERSION, version);
});

test("ACTION_VERSION fits the pattern of the insights contract", () => {
  assert.match(ACTION_VERSION, /^[0-9A-Za-z.+-]{1,40}$/);
});
