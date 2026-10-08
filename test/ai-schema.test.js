import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AiError } from "../src/ai/error.js";
import { assertSchema } from "../src/ai/json-schema.js";
import {
  CATEGORIES,
  MAX_OUTPUT_TOKENS,
  REVIEW_FORMAT,
  REVIEW_SCHEMA,
  SEVERITIES,
  parseReview,
} from "../src/ai/schema.js";
import { fromRoot } from "./helpers/run-action.js";

const FINDING = {
  path: "src/app.js",
  line: 7,
  severity: "major",
  category: "security",
  title: "A title",
  comment: "A comment",
  suggestion: "A suggestion",
};
const REVIEW = { summary: "A summary", findings: [FINDING] };

const answer = (value, finishReason = "stop") => ({
  content: typeof value === "string" ? value : JSON.stringify(value),
  finishReason,
});

function failure(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return assert.fail("expected an error");
}

// --- The schema itself -------------------------------------------------------

test("defines the values of severity and category", () => {
  assert.deepEqual(SEVERITIES, ["critical", "major", "minor", "info"]);
  assert.deepEqual(CATEGORIES, [
    "code-quality",
    "react",
    "vue",
    "efcore",
    "security",
  ]);
  const finding = REVIEW_SCHEMA.properties.findings.items.properties;
  assert.deepEqual(finding.severity.enum, SEVERITIES);
  assert.deepEqual(finding.category.enum, CATEGORIES);
});

test("follows the rules of the strict mode and the checker", () => {
  assert.doesNotThrow(() => assertSchema(REVIEW_SCHEMA));
});

test("lists all fields of the review and of a finding as required", () => {
  assert.deepEqual(REVIEW_SCHEMA.required, ["summary", "findings"]);
  assert.deepEqual(
    REVIEW_SCHEMA.required,
    Object.keys(REVIEW_SCHEMA.properties),
  );
  const finding = REVIEW_SCHEMA.properties.findings.items;
  assert.deepEqual(finding.required, [
    "path",
    "line",
    "severity",
    "category",
    "title",
    "comment",
    "suggestion",
  ]);
  assert.deepEqual(finding.required, Object.keys(finding.properties));
});

test("uses no keyword that the strict mode does not support", () => {
  const unsupported = new Set([
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
    "default",
    "allOf",
    "not",
    "if",
    "then",
    "else",
    "$ref",
  ]);
  const found = [];
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      // A property may have any name, so its schema is looked at, not its name.
      if (key === "properties") Object.values(value).forEach(walk);
      else {
        if (unsupported.has(key)) found.push(key);
        walk(value);
      }
    }
  })(REVIEW_SCHEMA);
  assert.deepEqual(found, []);
});

test("every property and every object carries a description for the model", () => {
  (function walk(node, path) {
    assert.equal(typeof node.description, "string", path);
    assert.notEqual(node.description, "", path);
    if (node.type === "object") {
      for (const [name, child] of Object.entries(node.properties)) {
        walk(child, `${path}.${name}`);
      }
    }
    if (node.type === "array") walk(node.items, `${path}[]`);
  })(REVIEW_SCHEMA, "$");
});

test("cannot be changed after the module is loaded", () => {
  const finding = REVIEW_SCHEMA.properties.findings.items;
  for (const frozen of [
    REVIEW_SCHEMA,
    REVIEW_SCHEMA.properties,
    finding,
    finding.properties.severity,
    REVIEW_FORMAT,
    REVIEW_FORMAT.json_schema,
    SEVERITIES,
    CATEGORIES,
  ]) {
    assert.ok(Object.isFrozen(frozen));
  }
  assert.throws(() => SEVERITIES.push("blocker"), TypeError);
  assert.throws(() => {
    finding.properties.category.enum[0] = "other";
  }, TypeError);
  assert.throws(() => {
    REVIEW_FORMAT.json_schema.strict = false;
  }, TypeError);
});

test("sends the schema as a strict Structured Output", () => {
  assert.deepEqual(REVIEW_FORMAT, {
    type: "json_schema",
    json_schema: { name: "review", strict: true, schema: REVIEW_SCHEMA },
  });
  assert.equal(REVIEW_FORMAT.json_schema.schema, REVIEW_SCHEMA);
  assert.match(REVIEW_FORMAT.json_schema.name, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(MAX_OUTPUT_TOKENS, 4096);
});

// --- The documentation -------------------------------------------------------

/** The rows of the table in docs/response-format.md, built from the schema. */
function expectedRows() {
  const rows = [];
  const typeOf = (node) => {
    if (node.enum) {
      return `string: ${node.enum.map((value) => `\`${value}\``).join(", ")}`;
    }
    return node.type === "array" ? "array of objects" : node.type;
  };
  const add = (name, node) =>
    rows.push(`| \`${name}\` | ${typeOf(node)} | ${node.description} |`);

  for (const [name, node] of Object.entries(REVIEW_SCHEMA.properties)) {
    add(name, node);
    if (node.type === "array") {
      for (const [field, child] of Object.entries(node.items.properties)) {
        add(`${name}[].${field}`, child);
      }
    }
  }
  return rows;
}

test("documents every field with its type and meaning", () => {
  const lines = readFileSync(fromRoot("docs/response-format.md"), "utf8").split(
    "\n",
  );
  const start = lines.findIndex((line) => line.startsWith("| Field |"));
  assert.notEqual(start, -1, "the table of fields is missing");
  const table = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    table.push(line);
  }
  assert.deepEqual(table, expectedRows());
});

test("documents the limit of the answer and every kind of error", () => {
  const text = readFileSync(fromRoot("docs/response-format.md"), "utf8");
  assert.ok(text.includes(String(MAX_OUTPUT_TOKENS)));
  for (const kind of [
    "refusal",
    "truncated",
    "filtered",
    "response",
    "model",
  ]) {
    assert.ok(text.includes(`| \`${kind}\` |`), kind);
  }
});

test("the example in the documentation is a valid review", () => {
  const text = readFileSync(fromRoot("docs/response-format.md"), "utf8");
  const example = /```json\n([\s\S]*?)\n```/.exec(text)?.[1];
  assert.ok(example);
  assert.deepEqual(
    parseReview({ content: example, finishReason: "stop" }),
    JSON.parse(example),
  );
});

// --- parseReview() -----------------------------------------------------------

test("returns a valid review as it is", () => {
  assert.deepEqual(parseReview(answer(REVIEW)), REVIEW);
});

test("returns an empty list of findings as a valid review", () => {
  const review = { summary: "Nothing stands out.", findings: [] };
  assert.deepEqual(parseReview(answer(review)), review);
});

test("accepts every defined severity and category", () => {
  for (const severity of SEVERITIES) {
    for (const category of CATEGORIES) {
      const review = {
        summary: "s",
        findings: [{ ...FINDING, severity, category }],
      };
      assert.deepEqual(parseReview(answer(review)), review);
    }
  }
});

const INVALID = [
  [
    "a severity that is not defined",
    { ...REVIEW, findings: [{ ...FINDING, severity: "blocker" }] },
    "findings[0].severity",
  ],
  [
    "a category that is not defined",
    {
      ...REVIEW,
      findings: [FINDING, { ...FINDING, category: "no-such-category" }],
    },
    "findings[1].category",
  ],
  [
    "a severity in capitals",
    { ...REVIEW, findings: [{ ...FINDING, severity: "Major" }] },
    "findings[0].severity",
  ],
  [
    "a line that is a text",
    { ...REVIEW, findings: [{ ...FINDING, line: "7" }] },
    "findings[0].line",
  ],
  [
    "a line that is a fraction",
    { ...REVIEW, findings: [{ ...FINDING, line: 7.5 }] },
    "findings[0].line",
  ],
  [
    "a finding without a suggestion",
    {
      ...REVIEW,
      findings: [FINDING, FINDING, { ...FINDING, suggestion: undefined }],
    },
    "findings[2].suggestion",
  ],
  [
    "a suggestion that is null",
    { ...REVIEW, findings: [{ ...FINDING, suggestion: null }] },
    "findings[0].suggestion",
  ],
  [
    "an additional field in a finding",
    { ...REVIEW, findings: [{ ...FINDING, confidence: 1 }] },
    "findings[0]",
  ],
  ["no summary", { findings: [] }, "summary"],
  ["no findings", { summary: "s" }, "findings"],
  [
    "findings that are no list",
    { summary: "s", findings: FINDING },
    "findings",
  ],
  ["an additional field at the top", { ...REVIEW, note: "x" }, "the answer"],
  [
    "a finding that is a text",
    { summary: "s", findings: ["a"] },
    "findings[0]",
  ],
];

for (const [name, value, place] of INVALID) {
  test(`reports ${name} with its place`, () => {
    const error = failure(() => parseReview(answer(value)));

    assert.ok(error instanceof AiError);
    assert.equal(error.kind, "response");
    assert.ok(error.message.includes(`(${place}:`), error.message);
  });
}

test("reports an answer that is not a review", () => {
  for (const content of ["[]", "null", "42", '"text"', "true"]) {
    const error = failure(() => parseReview(answer(content)));
    assert.equal(error.kind, "response", content);
    assert.match(
      error.message,
      /does not match the review format \(the answer:/,
    );
  }
});

test("reports text that is not JSON, also when the model wraps it in a code block", () => {
  for (const content of [
    "",
    "The code looks fine.",
    "```json\n{}\n```",
    '{"summary": "s", ',
  ]) {
    const error = failure(() => parseReview(answer(content)));
    assert.ok(error instanceof AiError);
    assert.equal(error.kind, "response", content);
    assert.match(error.message, /not valid JSON/);
  }
});

test("reports an answer without text as an error, not as no findings", () => {
  for (const content of [undefined, null]) {
    const error = failure(() => parseReview({ content, finishReason: "stop" }));
    assert.equal(error.kind, "response");
  }
});

test("reports a cut-off answer as truncated, also when the part so far is valid", () => {
  for (const content of [
    '{"summary": "s", "find',
    JSON.stringify(REVIEW),
    "",
  ]) {
    const error = failure(() => parseReview(answer(content, "length")));

    assert.ok(error instanceof AiError);
    assert.equal(error.kind, "truncated");
    assert.match(error.message, /cut off at the limit of 4096 tokens/);
    // One request is at most MAX_REQUEST_CHARS large, whatever the limits of
    // the whole pull request are: they are no remedy.
    assert.doesNotMatch(error.message, /max-files|max-diff-chars/);
    assert.match(error.message, /input `exclude`/);
  }
});

test("reports an answer stopped by the content filter as filtered", () => {
  for (const content of ["", JSON.stringify(REVIEW)]) {
    const error = failure(() => parseReview(answer(content, "content_filter")));

    assert.ok(error instanceof AiError);
    assert.equal(error.kind, "filtered");
    assert.match(error.message, /content filter/);
  }
});

test("never puts content of the answer into an error", () => {
  const secret = "SECRET-CODE-FROM-THE-DIFF";
  const cases = [
    answer({ ...REVIEW, findings: [{ ...FINDING, severity: secret }] }),
    answer({ ...REVIEW, findings: [{ ...FINDING, [secret]: 1 }] }),
    answer({ ...REVIEW, [secret]: 1 }),
    answer({ ...REVIEW, findings: [{ ...FINDING, line: secret }] }),
    answer(`not json ${secret}`),
    answer(`{"a": "${secret}`, "length"),
    answer(`{"a": "${secret}"}`, "content_filter"),
  ];
  for (const given of cases) {
    const error = failure(() => parseReview(given));
    assert.equal(
      [error.message, error.stack, JSON.stringify(error), String(error.cause)]
        .join("\n")
        .includes(secret),
      false,
    );
  }
});
