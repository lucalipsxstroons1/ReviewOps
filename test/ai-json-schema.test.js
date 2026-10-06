import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSchema, validate } from "../src/ai/json-schema.js";

const SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    level: { type: "string", enum: ["low", "high"] },
    count: { type: "integer" },
    ratio: { type: "number" },
    done: { type: "boolean" },
    nothing: { type: "null" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  required: ["name", "level", "count", "ratio", "done", "nothing", "items"],
  additionalProperties: false,
};

const VALID = {
  name: "x",
  level: "low",
  count: 3,
  ratio: 0.5,
  done: false,
  nothing: null,
  items: [{ id: 1 }, { id: 2 }],
};

test("accepts a value that fits the schema", () => {
  assert.equal(validate(SCHEMA, VALID), null);
  assert.equal(validate(SCHEMA, { ...VALID, items: [] }), null);
});

// JSON has no `undefined`, so a missing property is a property that is not there.
const without = (object, name) => {
  const copy = { ...object };
  delete copy[name];
  return copy;
};

const INVALID = [
  [
    "a value of the wrong type at the top",
    [],
    "the answer: must be of type object.",
  ],
  ["null instead of an object", null, "the answer: must be of type object."],
  [
    "a text instead of a number",
    { ...VALID, count: "3" },
    "count: must be of type integer.",
  ],
  [
    "a fraction instead of an integer",
    { ...VALID, count: 1.5 },
    "count: must be of type integer.",
  ],
  [
    "a number that is too big to be exact",
    { ...VALID, count: 2 ** 60 },
    "count: must be of type integer.",
  ],
  [
    "an infinite number",
    { ...VALID, ratio: Infinity },
    "ratio: must be of type number.",
  ],
  [
    "a number as a boolean",
    { ...VALID, done: 0 },
    "done: must be of type boolean.",
  ],
  ["undefined as null", without(VALID, "nothing"), "nothing: is missing."],
  [
    "a value outside the enum",
    { ...VALID, level: "medium" },
    "level: is not one of the allowed values.",
  ],
  [
    "another case of an enum value",
    { ...VALID, level: "Low" },
    "level: is not one of the allowed values.",
  ],
  ["a missing property", without(VALID, "name"), "name: is missing."],
  ["an inherited property", Object.create(VALID), "name: is missing."],
  [
    "an additional property",
    { ...VALID, extra: 1 },
    "the answer: has a property that the schema does not allow.",
  ],
  [
    "an object instead of a list",
    { ...VALID, items: {} },
    "items: must be of type array.",
  ],
  [
    "a wrong item",
    { ...VALID, items: [{ id: 1 }, { id: "2" }] },
    "items[1].id: must be of type integer.",
  ],
  [
    "an additional property in an item",
    { ...VALID, items: [{ id: 1, extra: 1 }] },
    "items[0]: has a property that the schema does not allow.",
  ],
];

for (const [name, value, expected] of INVALID) {
  test(`rejects ${name}`, () => {
    assert.equal(validate(SCHEMA, value), expected);
  });
}

test("rejects an own property called __proto__", () => {
  const value = JSON.parse(`{"__proto__": 1}`);
  assert.equal(
    validate(
      {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      value,
    ),
    "the answer: has a property that the schema does not allow.",
  );
});

test("names the place and the rule, never the value or an unknown property", () => {
  const secret = "SECRET-CODE-FROM-THE-DIFF";
  const messages = [
    validate(SCHEMA, { ...VALID, count: secret }),
    validate(SCHEMA, { ...VALID, level: secret }),
    validate(SCHEMA, { ...VALID, [secret]: 1 }),
    validate(SCHEMA, { ...VALID, items: [{ id: secret }] }),
  ];
  for (const message of messages) {
    assert.ok(message);
    assert.equal(message.includes(secret), false);
  }
});

test("accepts a schema in the shape of the strict mode", () => {
  assert.doesNotThrow(() => assertSchema(SCHEMA));
});

const BAD_SCHEMAS = [
  [
    "a keyword it does not know",
    { type: "string", minLength: 1 },
    /"minLength" is not supported/,
  ],
  [
    "a pattern",
    { type: "string", pattern: "^a" },
    /"pattern" is not supported/,
  ],
  [
    "a combination",
    { anyOf: [{ type: "string" }] },
    /"anyOf" is not supported/,
  ],
  ["a reference", { $ref: "#/x" }, /"\$ref" is not supported/],
  ["an unknown type", { type: "date" }, /"type" must be one of/],
  ["no type", { enum: ["a"] }, /"type" must be one of/],
  ["something that is no schema", "string", /must be an object/],
  ["an empty enum", { type: "string", enum: [] }, /non-empty list/],
  [
    "an object without properties",
    { type: "object", additionalProperties: false, required: [] },
    /needs "properties"/,
  ],
  [
    "an object that allows additional properties",
    { type: "object", properties: {}, required: [] },
    /additionalProperties": false/,
  ],
  [
    "a property that is not required",
    {
      type: "object",
      properties: { a: { type: "string" } },
      required: [],
      additionalProperties: false,
    },
    /every property must be listed in "required"/,
  ],
  [
    "a required name without a property",
    {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "b"],
      additionalProperties: false,
    },
    /every property must be listed in "required"/,
  ],
  ["an array without items", { type: "array" }, /needs "items"/],
  [
    "items on a string",
    { type: "string", items: { type: "string" } },
    /"items" on a string/,
  ],
  [
    "properties on a string",
    { type: "string", properties: {} },
    /object keywords on a string/,
  ],
  [
    "a bad schema deep inside",
    {
      type: "object",
      properties: {
        list: { type: "array", items: { type: "string", maxLength: 3 } },
      },
      required: ["list"],
      additionalProperties: false,
    },
    /\$\.list\[\]: the keyword "maxLength"/,
  ],
];

for (const [name, schema, expected] of BAD_SCHEMAS) {
  test(`refuses a schema with ${name}`, () => {
    assert.throws(() => assertSchema(schema), expected);
  });
}

test("validate() refuses a schema it cannot check instead of skipping the keyword", () => {
  const schema = { type: "string", minLength: 5 };

  assert.throws(() => validate(schema, "x"), /"minLength" is not supported/);
  // Still an error on the second call: it is not remembered as checked.
  assert.throws(() => validate(schema, "x"), /"minLength" is not supported/);
});

test("validate() refuses a schema that is not in the shape of the strict mode", () => {
  const schema = {
    type: "object",
    properties: { a: { type: "string" } },
    required: [],
    additionalProperties: false,
  };

  assert.throws(
    () => validate(schema, { a: "x" }),
    /must be listed in "required"/,
  );
});
