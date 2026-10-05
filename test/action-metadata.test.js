import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const source = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
const action = parse(source);

// Shapes of real credentials: GitHub tokens, OpenAI keys, private key blocks.
const SECRET_PATTERN =
  /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY/;

test("action metadata is complete", () => {
  assert.equal(action.name, "ReviewOps");
  assert.equal(action.author, "lucalipsxstroons1");
  assert.equal(typeof action.description, "string");
  // The GitHub Marketplace rejects descriptions longer than 125 characters.
  assert.ok(action.description.length > 0 && action.description.length <= 125);
  assert.equal(typeof action.branding.icon, "string");
  assert.equal(typeof action.branding.color, "string");
});

test("github-token is optional and defaults to the workflow token", () => {
  const input = action.inputs["github-token"];

  assert.equal(input.required, false);
  assert.equal(input.default, "${{ github.token }}");
});

test("openai-api-key is required and has no default", () => {
  const input = action.inputs["openai-api-key"];

  assert.equal(input.required, true);
  assert.equal("default" in input, false);
});

test("every input has a description", () => {
  for (const [name, input] of Object.entries(action.inputs)) {
    assert.equal(typeof input.description, "string", `${name} lacks one`);
    assert.ok(input.description.trim().length > 0, `${name} has an empty one`);
  }
});

test("no credential is written into the file", () => {
  for (const [name, input] of Object.entries(action.inputs)) {
    if (!/token|key|secret/.test(name) || !("default" in input)) continue;
    // A credential input may only default to a workflow expression.
    assert.match(input.default, /^\$\{\{ .+ \}\}$/, `${name} has a literal`);
  }
  assert.doesNotMatch(source, SECRET_PATTERN);
});

test("action runs the bundled entry point on Node 24", () => {
  assert.deepEqual(action.runs, { using: "node24", main: "dist/index.js" });
});
