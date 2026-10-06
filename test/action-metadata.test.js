import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { DEFAULT_MODEL } from "../src/ai/model.js";
import { DEFAULT_LANGUAGE, LANGUAGES } from "../src/ai/prompt.js";
import { DEFAULT_MAX_DIFF_CHARS, DEFAULT_MAX_FILES } from "../src/limits.js";

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

test("exclude is optional and empty by default", () => {
  const input = action.inputs.exclude;

  assert.equal(input.required, false);
  assert.equal(input.default, "");
});

test("the limits are optional and default to the values in the code", () => {
  // The defaults are written down twice: here for the workflow, in
  // src/limits.js for the code. They must not drift apart.
  const files = action.inputs["max-files"];
  const chars = action.inputs["max-diff-chars"];

  assert.equal(files.required, false);
  assert.equal(chars.required, false);
  assert.equal(files.default, String(DEFAULT_MAX_FILES));
  assert.equal(chars.default, String(DEFAULT_MAX_DIFF_CHARS));
});

test("the model is optional and defaults to the model in the code", () => {
  const input = action.inputs["openai-model"];

  assert.equal(input.required, false);
  assert.equal(input.default, DEFAULT_MODEL);
  assert.match(input.description, /default is gpt-4o-mini\./);
});

test("the language is optional and defaults to the language in the code", () => {
  const input = action.inputs.language;

  assert.equal(input.required, false);
  assert.equal(input.default, DEFAULT_LANGUAGE);
  assert.match(input.description, /default is en\./);
});

test("the description of the language names every code", () => {
  const description = action.inputs.language.description;
  const listed = /one of the codes ([^.]+)\./.exec(description)?.[1];

  assert.ok(listed, "the codes are not listed");
  assert.deepEqual(listed.split(/, | and /), Object.keys(LANGUAGES));
});

test("the descriptions of the limits name their default", () => {
  assert.match(action.inputs["max-files"].description, /default is 50\./);
  assert.match(
    action.inputs["max-diff-chars"].description,
    /default is 200000,/,
  );
});

test("the action declares exactly the inputs the code reads", () => {
  const read = [
    ...readFileSync(
      new URL("../src/inputs.js", import.meta.url),
      "utf8",
    ).matchAll(/getInput\("([^"]+)"\)/g),
  ].map((match) => match[1]);

  assert.deepEqual(Object.keys(action.inputs).sort(), read.sort());
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
