import assert from "node:assert/strict";
import { test } from "node:test";

test("runtime dependencies load as ES modules", async () => {
  const core = await import("@actions/core");
  const github = await import("@actions/github");

  assert.equal(typeof core.getInput, "function");
  assert.equal(typeof github.getOctokit, "function");
});
