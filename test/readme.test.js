import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { DEFAULT_MODEL } from "../src/ai/model.js";
import { MAX_REQUEST_CHARS } from "../src/ai/batch.js";
import { MAX_PARALLEL_REQUESTS } from "../src/review.js";
import { fromRoot } from "./helpers/run-action.js";
import {
  assertCheckoutWithoutCredentials,
  assertReviewConcurrency,
  assertReviewTriggers,
  assertPermissionsAtTop,
  assertPinnedToCommits,
  assertTimeoutForRequests,
  stepsOf,
} from "./helpers/workflow-rules.js";

const readme = readFileSync(fromRoot("README.md"), "utf8");
const action = parse(readFileSync(fromRoot("action.yml"), "utf8"));

/** The text of one `## ` section, without its heading. */
function section(heading) {
  const match = readme.match(
    new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m"),
  );
  assert.ok(match, `the README has no section "${heading}"`);
  return match[1];
}

/** The rows of the first table of a section, as lists of cells. */
function tableRows(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2) // header and separator
    .map((line) =>
      line
        .replace(/^\||\|$/g, "")
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim()),
    );
}

const unquote = (cell) => cell.replace(/^`([\s\S]*)`$/, "$1");

// --- The example workflows ---------------------------------------------------

/** Every yaml block of the README that is a whole workflow. */
const workflows = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)]
  .map((match) => parse(match[1]))
  .filter((config) => config && "on" in config && "jobs" in config);

// ReviewOps itself is used by its major tag in the README, so that the example
// can be copied and does not age with every release. Every other action needs
// a full commit SHA, like in the workflows of this repository.
const REVIEWOPS_BY_MAJOR_TAG = /^lucalipsxstroons1\/ReviewOps@v[0-9]+$/;

const reviewSteps = (config) =>
  stepsOf(config).filter((step) =>
    REVIEWOPS_BY_MAJOR_TAG.test(step.uses ?? ""),
  );

test("the README shows at least a plain and an extended workflow", () => {
  assert.ok(workflows.length >= 2);
});

workflows.forEach((config, index) => {
  const name = `example workflow ${index + 1}`;

  test(`${name}: follows the rules of every workflow`, () => {
    assertPinnedToCommits(config, { allow: REVIEWOPS_BY_MAJOR_TAG });
    assertPermissionsAtTop(config);
    assertCheckoutWithoutCredentials(config);
    for (const job of Object.values(config.jobs)) {
      assertTimeoutForRequests(job);
    }
  });

  test(`${name}: runs for the events that start a review`, () => {
    assertReviewTriggers(config);
  });

  test(`${name}: grants exactly the two permissions the action needs`, () => {
    assert.deepEqual(config.permissions, {
      contents: "read",
      "pull-requests": "write",
    });
  });

  test(`${name}: cancels the older run of the same pull request, but not for a label`, () => {
    assertReviewConcurrency(config);
  });

  test(`${name}: needs no checkout`, () => {
    for (const step of stepsOf(config)) {
      assert.doesNotMatch(step.uses ?? "", /^actions\/checkout@/);
    }
  });

  test(`${name}: uses the action with known inputs and the key from a secret`, () => {
    const steps = reviewSteps(config);
    assert.equal(steps.length, 1);
    const { with: inputs } = steps[0];

    for (const input of Object.keys(inputs)) {
      assert.ok(input in action.inputs, `${input} is not an input`);
    }
    for (const [input, { required }] of Object.entries(action.inputs)) {
      if (required) assert.ok(input in inputs, `${input} is required`);
    }
    assert.equal(inputs["openai-api-key"], "${{ secrets.OPENAI_API_KEY }}");
    assert.equal("github-token" in inputs, false);
  });

  test(`${name}: reads the outputs only through the environment`, () => {
    const steps = stepsOf(config);
    const known = Object.keys(action.outputs);
    for (const step of steps) {
      for (const value of Object.values(step.env ?? {})) {
        for (const [, output] of String(value).matchAll(
          /steps\.review\.outputs\.([\w-]+)/g,
        )) {
          assert.ok(known.includes(output), `${output} is not an output`);
        }
      }
      // No expression inside the command: a value can never become shell code.
      assert.doesNotMatch(step.run ?? "", /\$\{\{/);
    }
  });
});

test("an example workflow that reads the outputs gives the step an id", () => {
  const reading = workflows.filter((config) =>
    JSON.stringify(config).includes("steps.review.outputs."),
  );

  assert.ok(reading.length >= 1);
  for (const config of reading) {
    assert.equal(reviewSteps(config)[0].id, "review");
  }
});

// --- The tables --------------------------------------------------------------

test("the table of inputs equals the inputs of action.yml", () => {
  const rows = tableRows(section("Inputs"));

  assert.deepEqual(
    rows.map(([name]) => unquote(name)).sort(),
    Object.keys(action.inputs).sort(),
  );
  for (const [name, required, standard] of rows) {
    const input = action.inputs[unquote(name)];
    assert.equal(required, input.required ? "yes" : "no", `${name}: required`);
    const documented = standard === "empty" ? "" : unquote(standard);
    assert.equal(documented, input.default ?? "", `${name}: default`);
  }
});

test("the table of outputs equals the outputs of action.yml", () => {
  const rows = tableRows(section("Outputs"));

  assert.deepEqual(
    rows.map(([name]) => unquote(name)).sort(),
    Object.keys(action.outputs).sort(),
  );
});

test("the default model in the table is the default model of the code", () => {
  const row = tableRows(section("Inputs")).find(
    ([name]) => unquote(name) === "openai-model",
  );

  assert.equal(unquote(row[2]), DEFAULT_MODEL);
});

test("the limits of one request are the ones of the code", () => {
  const text = readme.replace(/\s+/g, " ");

  assert.ok(text.includes(`at most ${MAX_REQUEST_CHARS} characters`));
  // The README says "four" and "4": both name the constant.
  assert.equal(MAX_PARALLEL_REQUESTS, 4);
  assert.ok(text.includes("Up to four requests"));
  assert.ok(text.includes("| Requests at the same time | 4 |"));
});

// --- What the README has to say ----------------------------------------------

test("the README says that the diff goes to OpenAI, at the top and in Security", () => {
  const claim =
    /sends? the diff of your pull request, with the path of each file, to the OpenAI API/;

  assert.match(readme.split("\n## ")[0], claim);
  assert.match(section("Security & privacy"), claim);
});

test("the README links the screenshot and the file exists", () => {
  const image = readme.match(/!\[([^\]]+)\]\((docs\/images\/[^)]+)\)/);

  assert.ok(image, "no screenshot in the README");
  assert.ok(image[1].length > 10, "the screenshot has no alt text");
  assert.ok(existsSync(fromRoot(image[2])), `${image[2]} is missing`);
});

test("the README has every section the issue asks for", () => {
  for (const heading of [
    "Quick start",
    "Inputs",
    "Outputs",
    "Security & privacy",
    "Costs & limits",
    "Known limitations",
  ]) {
    section(heading);
  }
});

// --- License -----------------------------------------------------------------

test("the license is MIT, in LICENSE and in package.json", () => {
  const license = readFileSync(fromRoot("LICENSE"), "utf8");
  const pkg = JSON.parse(readFileSync(fromRoot("package.json"), "utf8"));

  assert.match(license, /^MIT License\n/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.ok(license.includes(`Copyright (c) 2026 ${action.author}`));
  assert.equal(pkg.license, "MIT");
});
