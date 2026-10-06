// A small check for the part of JSON Schema that the review format uses. It
// takes the place of a library: the format is ours, and the check has to read
// the very same schema object that goes into the request.
//
// The check does not know more than the strict mode of OpenAI allows. A
// keyword it does not know is an error of the schema, never skipped: a
// constraint that is silently ignored would let invalid answers pass.

const TYPES = [
  "object",
  "array",
  "string",
  "integer",
  "number",
  "boolean",
  "null",
];

// `description` and `title` only explain. All others are checked.
const KEYWORDS = new Set([
  "type",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "description",
  "title",
]);

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks that a schema only uses what this module can check, and that it
 * follows the rules of the strict mode: every property is required and every
 * object forbids additional properties.
 *
 * @param {object} schema
 * @param {string} [path] Where the schema sits, for the message.
 * @throws {Error} With the place and the reason.
 */
export function assertSchema(schema, path = "$") {
  if (!isObject(schema))
    throw new Error(`${path}: a schema must be an object.`);

  for (const keyword of Object.keys(schema)) {
    if (!KEYWORDS.has(keyword)) {
      throw new Error(`${path}: the keyword "${keyword}" is not supported.`);
    }
  }
  if (!TYPES.includes(schema.type)) {
    throw new Error(`${path}: "type" must be one of ${TYPES.join(", ")}.`);
  }

  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      throw new Error(`${path}: "enum" must be a non-empty list.`);
    }
  }

  if (schema.type === "object") {
    if (!isObject(schema.properties)) {
      throw new Error(`${path}: an object needs "properties".`);
    }
    if (schema.additionalProperties !== false) {
      throw new Error(
        `${path}: an object needs "additionalProperties": false.`,
      );
    }
    const names = Object.keys(schema.properties);
    const required = schema.required;
    if (
      !Array.isArray(required) ||
      required.length !== names.length ||
      !names.every((name) => required.includes(name))
    ) {
      throw new Error(`${path}: every property must be listed in "required".`);
    }
    for (const name of names) {
      assertSchema(schema.properties[name], `${path}.${name}`);
    }
  } else if (
    schema.properties !== undefined ||
    schema.required !== undefined ||
    schema.additionalProperties !== undefined
  ) {
    throw new Error(`${path}: object keywords on a ${schema.type}.`);
  }

  if (schema.type === "array") {
    if (schema.items === undefined) {
      throw new Error(`${path}: an array needs "items".`);
    }
    assertSchema(schema.items, `${path}[]`);
  } else if (schema.items !== undefined) {
    throw new Error(`${path}: "items" on a ${schema.type}.`);
  }
}

function matchesType(type, value) {
  switch (type) {
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isSafeInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      return value === null;
  }
}

const checkedSchemas = new WeakSet();

const at = (path) => (path === "" ? "the answer" : path);
const join = (path, name) => (path === "" ? name : `${path}.${name}`);

/**
 * Checks a value against a schema.
 *
 * The result names the place and the rule, never the value: the value comes
 * from the model and may hold code from the pull request. The same goes for
 * the names of properties the schema does not know.
 *
 * @param {object} schema Checked with `assertSchema()` on first use.
 * @param {unknown} value
 * @returns {string | null} The first problem, or `null` if the value fits.
 * @throws {Error} When the schema itself is not supported.
 */
export function validate(schema, value) {
  // Once per schema: a keyword that cannot be checked must not be skipped.
  if (!checkedSchemas.has(schema)) {
    assertSchema(schema);
    checkedSchemas.add(schema);
  }
  return check(schema, value, "");
}

function check(schema, value, path) {
  if (!matchesType(schema.type, value)) {
    return `${at(path)}: must be of type ${schema.type}.`;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    return `${at(path)}: is not one of the allowed values.`;
  }

  if (schema.type === "object") {
    for (const name of schema.required) {
      if (!Object.hasOwn(value, name)) {
        return `${join(path, name)}: is missing.`;
      }
    }
    for (const name of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, name)) {
        return `${at(path)}: has a property that the schema does not allow.`;
      }
    }
    for (const name of schema.required) {
      const problem = check(
        schema.properties[name],
        value[name],
        join(path, name),
      );
      if (problem) return problem;
    }
  }

  if (schema.type === "array") {
    for (let index = 0; index < value.length; index += 1) {
      const problem = check(schema.items, value[index], `${path}[${index}]`);
      if (problem) return problem;
    }
  }

  return null;
}
