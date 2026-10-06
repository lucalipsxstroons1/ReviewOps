export const id = 309;
export const ids = [309];
export const modules = {

/***/ 3309:
/***/ ((__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) => {


// EXPORTS
__webpack_require__.d(__webpack_exports__, {
  run: () => (/* binding */ run)
});

// EXTERNAL MODULE: ./node_modules/@actions/core/lib/core.js + 18 modules
var lib_core = __webpack_require__(6257);
// EXTERNAL MODULE: ./node_modules/@actions/github/lib/github.js + 22 modules
var github = __webpack_require__(2413);
;// CONCATENATED MODULE: ./src/printable.js
const MAX_LENGTH = 200;

// \p{Cc}: control characters, including line breaks.
// \p{Cf}: invisible format characters, which can reorder what a reader sees.
// \p{Zl}, \p{Zp}: the Unicode line and paragraph separators.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Makes text from outside safe to write into the log on one line.
 *
 * File names and similar values come from the author of the pull request.
 * A line break in such a value could start a new log line with a workflow
 * command such as `::error::`. Unsafe characters are therefore shown by
 * their code point, a line feed for example as backslash-u-000a, instead of
 * being written out.
 *
 * @param {unknown} text
 * @returns {string}
 */
function printable(text) {
  const visible = String(text).replace(
    UNSAFE,
    (character) =>
      `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`,
  );
  return visible.length > MAX_LENGTH
    ? `${visible.slice(0, MAX_LENGTH)}…`
    : visible;
}

;// CONCATENATED MODULE: ./src/ai/model.js


// The same value is written into action.yml. A test keeps them equal.
const DEFAULT_MODEL = "gpt-4o-mini";

// Letters, digits and the characters that model names use, such as
// "gpt-4.1", "o3-mini" or the fine-tuning name "ft:gpt-4o-mini:org::id".
// The name ends up in a request and in messages, so nothing else is allowed.
const MODEL_NAME = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * Reads the `openai-model` input. An empty value means the default: it is
 * usually a variable of the workflow that was not set.
 *
 * @param {string} [value] The value as the workflow passed it.
 * @returns {string}
 * @throws {Error} When the value is not the name of a model.
 */
function parseModel(value = "") {
  const name = String(value).trim();
  if (name === "") return DEFAULT_MODEL;

  if (!MODEL_NAME.test(name)) {
    // The value is a setting of the workflow, which a pull request can change.
    throw new Error(
      `Input \`openai-model\` must be the name of an OpenAI model (letters, digits, ".", "-", "_" and ":", at most 100 characters), but is "${printable(name)}".`,
    );
  }
  return name;
}

;// CONCATENATED MODULE: ./src/ai/error.js
/**
 * An error of the AI client. The message says what to do. It never contains
 * text from the answer of the API: OpenAI repeats the first and the last
 * characters of an invalid key in its own message, and the model may repeat
 * code from the pull request.
 *
 * This file does not import the SDK. Modules that only need the error, such
 * as the parser of the review format, must not pull the SDK into the bundle
 * before `run()` needs it.
 */
class error_AiError extends Error {
  name = "AiError";

  /**
   * @param {"auth" | "permission" | "model" | "quota" | "rate_limit" | "server" | "timeout" | "network" | "request" | "response" | "refusal" | "truncated" | "filtered"} kind
   *   Tells a caller whether other requests are still worth a try: after
   *   `auth`, `permission`, `model` and `quota`, they are not.
   * @param {string} message
   * @param {number | null} [status] HTTP status, if there was an answer.
   */
  constructor(kind, message, status = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

;// CONCATENATED MODULE: ./src/ai/json-schema.js
// A small check for the part of JSON Schema that the review format uses. It
// takes the place of a library: the format is ours, and the check has to read
// the very same schema object that goes into the request.
//
// The check does not know more than the strict mode of OpenAI allows. A
// keyword it does not know is an error of the schema, never skipped: a
// constraint that is silently ignored would let invalid answers pass.

const TYPES = (/* unused pure expression or super */ null && ([
  "object",
  "array",
  "string",
  "integer",
  "number",
  "boolean",
  "null",
]));

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
function assertSchema(schema, path = "$") {
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
function json_schema_validate(schema, value) {
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

;// CONCATENATED MODULE: ./src/ai/schema.js



// The one place where the format of the review is defined. The request sends
// this schema to the model, and `parseReview()` checks the answer against the
// very same object. The descriptions go to the model as well, and a test keeps
// them equal to the table in docs/response-format.md.

const schema_SEVERITIES = ["critical", "major", "minor", "info"];
const schema_CATEGORIES = ["code-quality", "react", "efcore", "security"];

// The schema is shared by the request and the check. Nothing may change it.
function deepFreeze(value) {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// About 30 findings fit in this. It also keeps one attempt below the timeout
// of the client.
const MAX_OUTPUT_TOKENS = 4096;

/** The schema of the answer. Strict mode: every property is required. */
const REVIEW_SCHEMA = deepFreeze({
  type: "object",
  description: "The review of one pull request.",
  properties: {
    summary: {
      type: "string",
      description:
        "Short conclusion about the reviewed files, in the language the prompt asks for.",
    },
    findings: {
      type: "array",
      description: "The findings. An empty list if nothing stands out.",
      items: {
        type: "object",
        description: "One finding at one line of the new file.",
        properties: {
          path: {
            type: "string",
            description: "Path of the file, exactly as in the request.",
          },
          line: {
            type: "integer",
            description:
              "Line number in the new file, one of the numbers shown in the annotated diff.",
          },
          severity: {
            type: "string",
            enum: schema_SEVERITIES,
            description: "How serious the problem is.",
          },
          category: {
            type: "string",
            enum: schema_CATEGORIES,
            description:
              "Focus area of the finding. If more than one fits, security wins.",
          },
          title: {
            type: "string",
            description: "Headline of the finding in one sentence.",
          },
          comment: {
            type: "string",
            description: "What the problem is and why it matters.",
          },
          suggestion: {
            type: "string",
            description: "What to change, with a short code example if needed.",
          },
        },
        required: [
          "path",
          "line",
          "severity",
          "category",
          "title",
          "comment",
          "suggestion",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "findings"],
  additionalProperties: false,
});

/** The `response_format` of the request: a Structured Output in strict mode. */
const REVIEW_FORMAT = deepFreeze({
  type: "json_schema",
  json_schema: { name: "review", strict: true, schema: REVIEW_SCHEMA },
});

/**
 * @typedef {object} Finding
 * @property {string} path
 * @property {number} line
 * @property {"critical" | "major" | "minor" | "info"} severity
 * @property {"code-quality" | "react" | "efcore" | "security"} category
 * @property {string} title
 * @property {string} comment
 * @property {string} suggestion
 */

/**
 * Reads the answer of the model. A cut-off or filtered answer and one that
 * does not fit the schema are errors. None of them counts as "no findings".
 *
 * The strict mode is not trusted: the answer is always checked here. Error
 * messages name the place (`findings[2].severity`), never the content, which
 * comes from the model and may hold code from the pull request.
 *
 * @param {{ content: string, finishReason: string | null }} answer
 *   The result of `complete()`.
 * @returns {{ summary: string, findings: Finding[] }}
 * @throws {AiError} With the kind `truncated`, `filtered` or `response`.
 */
function parseReview({ content, finishReason }) {
  // Checked first: a cut-off answer is usually not JSON any more.
  if (finishReason === "length") {
    throw new AiError(
      "truncated",
      `The answer of the model was cut off at the limit of ${MAX_OUTPUT_TOKENS} tokens, so the review is incomplete. Reduce \`max-files\` or \`max-diff-chars\`, or run the workflow again.`,
    );
  }
  if (finishReason === "content_filter") {
    throw new AiError(
      "filtered",
      "The content filter of OpenAI stopped the answer, so the review is incomplete. Run the workflow again; if it keeps happening, exclude the files that trigger it with the input `exclude`.",
    );
  }

  let data;
  try {
    data = JSON.parse(content);
  } catch {
    throw new AiError(
      "response",
      "The answer of the model is not valid JSON. Run the workflow again.",
    );
  }

  const problem = validate(REVIEW_SCHEMA, data);
  if (problem) {
    throw new AiError(
      "response",
      `The answer of the model does not match the review format (${problem.replace(/\.$/, "")}). Run the workflow again.`,
    );
  }
  return data;
}

;// CONCATENATED MODULE: ./src/ai/prompt.js



// The prompt is versioned so that a measurement of the model can be matched
// to one state of the text. Raise it with every change of the wording.
const PROMPT_VERSION = 2;

// The same value is written into action.yml. A test keeps them equal.
const DEFAULT_LANGUAGE = "en";

// Language codes and the English names that go into the prompt. The value of
// the workflow never reaches the prompt: only a name from this table does.
const LANGUAGES = Object.freeze({
  en: "English",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  pl: "Polish",
  tr: "Turkish",
  ja: "Japanese",
  zh: "Chinese",
  ko: "Korean",
});

/**
 * Reads the `language` input. An empty value means the default: it is
 * usually a variable of the workflow that was not set.
 *
 * @param {string} [value] The value as the workflow passed it.
 * @returns {keyof typeof LANGUAGES}
 * @throws {Error} When the value is not one of the language codes.
 */
function parseLanguage(value = "") {
  const code = String(value).trim().toLowerCase();
  if (code === "") return DEFAULT_LANGUAGE;

  if (!Object.hasOwn(LANGUAGES, code)) {
    // The value is a setting of the workflow, which a pull request can change.
    throw new Error(
      `Input \`language\` must be one of ${Object.keys(LANGUAGES).join(", ")}, but is "${printable(String(value).trim())}".`,
    );
  }
  return code;
}

// What the model checks, per focus area. The area names are the values of
// the schema, so that the prompt and the answer use the same words.
const FOCUS_AREAS = {
  "code-quality": {
    title: "General code quality",
    checks: [
      "logic errors, such as wrong conditions, off-by-one errors and inverted checks",
      "missing error handling: ignored errors, swallowed exceptions, unhandled promise rejections",
      "null or undefined access that can happen with real input",
      "race conditions and unsafe shared state",
      "needless complexity that hides a bug or makes one likely",
    ],
  },
  react: {
    title: "React",
    checks: [
      "Rules of Hooks: hooks called conditionally, in loops or after an early return",
      "dependency arrays of useEffect, useMemo and useCallback that miss a value used inside (a prop, a state value or a variable of the component), also when the array is empty, or that are missing altogether",
      "state mutation: changing state or props in place instead of creating a new value",
      "lists rendered without a stable `key`, or with the array index as key where the list changes",
      "effects that start a subscription, timer or request without cleanup",
      "`dangerouslySetInnerHTML` with content that is not sanitized",
    ],
  },
  efcore: {
    title: "C# and Entity Framework Core",
    checks: [
      "N+1 queries: a query inside a loop, or navigation properties loaded one by one",
      "read-only queries without `AsNoTracking()`",
      "`FromSqlRaw` or `ExecuteSqlRaw` with string interpolation or concatenation instead of parameters",
      "sync-over-async: `.Result`, `.Wait()` or `.GetAwaiter().GetResult()` on a task",
      "a missing `await` on an async call, so that the task is never observed",
    ],
  },
  security: {
    title: "Security (zero trust)",
    checks: [
      "missing authentication or authorization on an endpoint or an action",
      "input that is used without validation, for example in paths, queries, commands or redirects",
      "injection: SQL, command, template, path traversal, cross-site scripting",
      "secrets in code: keys, tokens, passwords, connection strings",
      "permissions that are wider than needed",
      "sensitive data in logs or error messages",
    ],
  },
};

// What the severities mean. The values themselves come from the schema.
const SEVERITY_MEANING = {
  critical:
    "can be exploited, loses or corrupts data, or breaks a common path. It must be fixed before the merge.",
  major:
    "a defect that will probably cause wrong behaviour, a crash or a serious slowdown under realistic conditions.",
  minor:
    "a real but small problem, or a weakness with a concrete risk that is unlikely to hit soon.",
  info: "a remark that needs no change, for example a hint about a better way.",
};

/**
 * Builds the system prompt of the review.
 *
 * The text is fixed. The only thing that varies is the name of the language,
 * taken from a table.
 *
 * @param {object} options
 * @param {keyof typeof LANGUAGES} [options.language] A code that
 *   `parseLanguage()` returned.
 * @returns {string}
 * @throws {Error} When the language is not in the table.
 */
function buildSystemPrompt({ language = DEFAULT_LANGUAGE } = {}) {
  if (typeof language !== "string" || !Object.hasOwn(LANGUAGES, language)) {
    throw new Error(
      "The language of the prompt is not one of the known codes.",
    );
  }
  const languageName = LANGUAGES[language];

  const focus = CATEGORIES.map((category) => {
    const { title, checks } = FOCUS_AREAS[category];
    return [
      `${title} (category "${category}"):`,
      ...checks.map((check) => `- ${check}`),
    ].join("\n");
  }).join("\n\n");

  const severities = SEVERITIES.map(
    (severity) => `- ${severity}: ${SEVERITY_MEANING[severity]}`,
  ).join("\n");

  const categories = CATEGORIES.map((category) => `"${category}"`).join(", ");

  return [
    "You are an experienced software engineer who reviews the diff of a pull request. Be factual and concrete. Give no praise and no general remarks. Do not comment on style that a linter or a formatter covers, such as indentation, quotes, semicolons, import order, line length or naming conventions.",
    "",
    "## The input",
    "",
    "The user message holds the changed files. Each file starts with a line `File: <path>`, followed by its diff. A diff line looks like this:",
    "",
    "```",
    "  12 | +  const sum = items.reduce(add, 0);",
    "     | -  return items.length;",
    "     |    const tax = 0.19;",
    "```",
    "",
    "The marker after the bar is `+` for an added line, `-` for a removed line and a space for an unchanged line. Only added lines carry a line number, and it is the line number in the new file. Removed and unchanged lines are there to help you understand the change.",
    "",
    "## What to look for",
    "",
    "Look for real problems in these areas, and only in them:",
    "",
    focus,
    "",
    `Every finding has exactly one category: ${categories}. If more than one fits, use "security".`,
    "",
    "## Rules",
    "",
    "- Comment only on added lines. Take the line number from the diff exactly as it is shown. Never calculate a number and never use the line of a removed or unchanged line.",
    "- Use the path exactly as it is written after `File:`.",
    "- When in doubt, report nothing. Report a problem only if you can point at it in the code you see. Do not guess what code outside the diff does.",
    "- One finding per problem. Do not repeat the same problem on several lines; report it once, at the line of the code that causes it, for example the call inside a loop. Do not report it at the signature of the method or the class that contains it.",
    "- Do not ask for tests, documentation or comments, and do not remark on what the change does.",
    "- Before you answer, go through the checkpoints of the areas above for every file, one by one. A short diff can hold one of them.",
    "- An empty list of findings is a good answer when nothing is wrong. Say so in the summary.",
    '- Every finding needs a concrete suggestion: what to change, with a short code example if that helps. Never write only "consider" or "check".',
    "",
    "## Severity",
    "",
    "Choose the severity by what happens if the problem stays in:",
    "",
    severities,
    "",
    '"critical" and "major" are for problems that you can show from the code in the diff. Do not use them for doubts.',
    "",
    "## Language",
    "",
    `Write the summary, the title, the comment and the suggestion in ${languageName}. Do not write any of them in another language. Keep code, identifiers, file paths and the values of severity and category as they are: in English, as in the code.`,
  ].join("\n");
}

;// CONCATENATED MODULE: ./src/diff/parse.js
// `@@ -a,b +c,d @@ section`. A missing length means one line. Line numbers
// with more than nine digits do not occur and would lose precision.
const HUNK_HEADER =
  /^@@ -(\d{1,9})(?:,(\d{1,9}))? \+(\d{1,9})(?:,(\d{1,9}))? @@(.*)$/s;

// A row such as "\ No newline at end of file" describes the row before it.
// It is not a line of the file.
const NOTE_MARKER = "\\";

/**
 * Thrown when a patch does not have the shape of a unified diff. The message
 * names positions only, never the content of the patch.
 */
class PatchFormatError extends Error {
  name = "PatchFormatError";
}

/**
 * Parses the patch of one file, as GitHub returns it for a pull request: one
 * or more hunks, without the file header of a full diff.
 *
 * The lines of a hunk are counted against the lengths in its header, the way
 * `git apply` does it. A line of code that looks like a header is therefore
 * read as code.
 *
 * This is a pure function: it uses nothing but its argument.
 *
 * @param {string} patch
 * @returns {{
 *   hunks: {
 *     section: string,
 *     lines: { type: "added" | "removed" | "context", line: number | null, content: string }[],
 *   }[],
 *   commentableLines: number[],
 * }} `line` is the line number in the new file, `null` for removed lines.
 *   `commentableLines` holds the numbers of all added lines in ascending order.
 * @throws {PatchFormatError} When the patch cannot be read.
 */
function parse_parsePatch(patch) {
  if (typeof patch !== "string" || patch === "") {
    throw new PatchFormatError("The diff is empty.");
  }

  const rows = patch.split("\n");
  const hunks = [];
  const commentableLines = [];
  let index = 0;
  let nextFreeLine = 1;

  while (index < rows.length) {
    // A patch that ends with a line break leaves one empty row behind.
    if (rows[index] === "" && index === rows.length - 1) break;

    const header = HUNK_HEADER.exec(rows[index]);
    if (!header) {
      throw new PatchFormatError(
        `Row ${index + 1} of the diff is not a hunk header.`,
      );
    }
    index++;

    const number = hunks.length + 1;
    let oldLeft = Number(header[2] ?? 1);
    let newLeft = Number(header[4] ?? 1);
    let line = Number(header[3]);

    // Line numbers start at 1 and only go up from hunk to hunk.
    if (newLeft > 0 && line < nextFreeLine) {
      throw new PatchFormatError(
        `Hunk ${number} of the diff starts at a line that is not possible.`,
      );
    }

    const lines = [];
    while (oldLeft > 0 || newLeft > 0) {
      if (index >= rows.length) {
        throw new PatchFormatError(
          `Hunk ${number} of the diff ends before all its lines were read.`,
        );
      }
      const row = rows[index++];
      const marker = row[0];
      if (marker === NOTE_MARKER) continue;

      // Like `git apply`, an empty row counts as an empty context line.
      const type =
        marker === "+"
          ? "added"
          : marker === "-"
            ? "removed"
            : marker === " " || row === ""
              ? "context"
              : null;
      const inOldFile = type !== "added";
      const inNewFile = type !== "removed";

      if (
        type === null ||
        (inOldFile && oldLeft === 0) ||
        (inNewFile && newLeft === 0)
      ) {
        throw new PatchFormatError(
          `Row ${index} of the diff does not fit into hunk ${number}.`,
        );
      }

      lines.push({
        type,
        line: inNewFile ? line : null,
        content: row.slice(1),
      });
      if (type === "added") commentableLines.push(line);
      if (inOldFile) oldLeft--;
      if (inNewFile) {
        newLeft--;
        line++;
      }
    }

    // The note can follow the last line of a hunk.
    while (index < rows.length && rows[index][0] === NOTE_MARKER) index++;

    nextFreeLine = Math.max(nextFreeLine, line);
    hunks.push({ section: header[5].trim(), lines });
  }

  return { hunks, commentableLines };
}

// EXTERNAL MODULE: ./node_modules/picomatch/index.js
var picomatch = __webpack_require__(4006);
;// CONCATENATED MODULE: ./src/exclude.js



// Fixed, so a pattern means the same on every machine: without
// `windows: false`, picomatch reads a backslash as a separator on Windows.
// Braces and extended globs would allow very slow patterns. Own patterns
// that use them are rejected below; switching them off here is the second
// line of defence.
const MATCH_OPTIONS = Object.freeze({
  dot: true,
  nocase: true,
  windows: false,
  nobrace: true,
  noextglob: true,
});

// File names come from the author of the pull request. A name built for it
// makes a pattern with many wildcards run for seconds or longer. The stars
// are counted over the whole pattern: two in each of several directories
// multiply. Within these limits, names of 4000 characters were matched in a
// few milliseconds.
const MAX_STARS = 2;
const MAX_GLOBSTARS = 2;

// The wildcards of picomatch stop at a line break, which is a legal
// character of a file name. It is replaced before a path is matched.
const LINE_BREAKS = /[\n\r\p{Zl}\p{Zp}]/gu;
const MAX_PATTERNS = 50;
const MAX_PATTERN_LENGTH = 200;

const BINARY_EXTENSIONS = [
  // Images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "ico",
  "webp",
  "avif",
  "svg",
  // Fonts
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  // Documents and archives
  "pdf",
  "zip",
  "tar",
  "gz",
  "tgz",
  "7z",
  "rar",
];

/**
 * Files that are never worth a review. `bin/` is left out on purpose: Node.js
 * projects keep hand-written scripts there.
 */
const DEFAULT_EXCLUDES = Object.freeze([
  // Lockfiles
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "packages.lock.json",
  // Build output, in any directory
  "**/dist/**",
  "**/build/**",
  "**/obj/**",
  "*.min.js",
  "*.map",
  // Generated code
  "*.g.cs",
  "*.Designer.cs",
  "*ModelSnapshot.cs",
  "*.snap",
  // Images, fonts, documents and archives
  ...BINARY_EXTENSIONS.map((extension) => `*.${extension}`),
]);

/**
 * Builds the filter for files that are left out of the review.
 *
 * A pattern without a slash applies in every directory (`*.min.js`). A
 * pattern with a slash applies from the root of the repository (`docs/**`);
 * `docs/` means the same. A leading slash ties a file name to the root
 * (`/README.md`). Upper and lower case make no difference.
 *
 * @param {string} [excludeInput] The `exclude` input: one pattern per line.
 *   Empty lines and lines that start with `#` are ignored.
 * @returns {(path: string) => string | null} For a path, the reason why the
 *   file is left out, or `null` when it stays.
 * @throws {Error} When a pattern of the input cannot be used.
 */
function createExcludeFilter(excludeInput = "") {
  const rules = [
    ...DEFAULT_EXCLUDES.map((pattern) => ({
      matches: compile(pattern),
      reason: `matches the default exclude pattern "${pattern}"`,
    })),
    ...readPatterns(excludeInput).map(({ pattern, line }) => ({
      matches: compileOwn(pattern, line),
      // The workflow file of a pull request can come from its author.
      reason: `matches the exclude pattern "${printable(pattern)}"`,
    })),
  ];

  return (path) => {
    const name = path.replace(LINE_BREAKS, "_");
    return rules.find((rule) => rule.matches(name))?.reason ?? null;
  };
}

/** The patterns of the input with the number of the line they stand on. */
function readPatterns(excludeInput) {
  const patterns = String(excludeInput)
    .split("\n")
    .map((text, index) => ({ pattern: text.trim(), line: index + 1 }))
    .filter(({ pattern }) => pattern !== "" && !pattern.startsWith("#"));

  if (patterns.length > MAX_PATTERNS) {
    throw new Error(
      `Input \`exclude\` has ${patterns.length} patterns. At most ${MAX_PATTERNS} are allowed.`,
    );
  }
  return patterns;
}

function compileOwn(pattern, line) {
  const reject = (problem) =>
    new Error(
      `Input \`exclude\`, line ${line}: the pattern "${printable(pattern)}" cannot be used. ${problem}`,
    );

  const problem = problemWith(pattern);
  if (problem) throw reject(problem);
  try {
    return compile(pattern);
  } catch {
    throw reject("It is not a valid glob pattern.");
  }
}

/** Says what is wrong with a pattern, or returns `null`. */
function problemWith(pattern) {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return `It is longer than ${MAX_PATTERN_LENGTH} characters.`;
  }
  if (pattern.startsWith("!")) {
    return 'Negation with "!" is not supported. List only the files to leave out.';
  }
  // Read literally, such a pattern would silently match nothing.
  if (/[{}()]/.test(pattern)) {
    return "Braces and parentheses are not supported. Write one pattern per line.";
  }
  if (pattern.includes("\\")) {
    return 'A backslash is not supported. Separate directories with "/".';
  }

  if (/^[./]*$/.test(pattern)) {
    return "It names no file.";
  }

  const segments = exclude_anchor(pattern).split("/");
  if (segments.filter((segment) => segment === "**").length > MAX_GLOBSTARS) {
    return `It contains "**" more than ${MAX_GLOBSTARS} times.`;
  }
  const stars = segments
    .filter((segment) => segment !== "**")
    .reduce((sum, segment) => sum + (segment.match(/\*+/g)?.length ?? 0), 0);
  if (stars > MAX_STARS) {
    return `It contains more than ${MAX_STARS} "*" wildcards. "**" for any directories is counted separately.`;
  }
  return null;
}

/** Turns a pattern as written into the glob that is matched against a path. */
function compile(pattern) {
  // "dist/**" alone would also match a file that is named "dist". Asking
  // for a name below the directory leaves such a file in the review.
  const glob = exclude_anchor(pattern).replace(/\/\*\*$/, "/**/*");
  return picomatch(glob, MATCH_OPTIONS);
}

/** Decides where a pattern applies: from the root or in every directory. */
function exclude_anchor(pattern) {
  let glob = pattern;
  while (glob.startsWith("./")) glob = glob.slice(2);
  const fromRoot = glob.startsWith("/");
  if (fromRoot) glob = glob.slice(1);
  if (glob.endsWith("/")) glob = `${glob}**`;
  return fromRoot || glob.includes("/") ? glob : `**/${glob}`;
}

;// CONCATENATED MODULE: ./src/github/context.js
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;

/**
 * Extracts what the action needs to know about the pull request that
 * triggered the run.
 *
 * Everything in the event payload is checked before it is used. Error
 * messages never repeat a value from the payload: parts of it are written by
 * the author of the pull request.
 *
 * @param {{ repo: { owner: string, repo: string }, payload: object }} context
 *   The context of the run, as provided by `@actions/github`.
 * @returns {{
 *   owner: string, repo: string, pullNumber: number,
 *   headSha: string, baseSha: string, title: string,
 *   isFork: boolean, isDraft: boolean,
 * }}
 */
function readPullRequest(context) {
  const pullRequest = context.payload?.pull_request;
  if (!context_isObject(pullRequest)) {
    throw new Error(
      "The event carries no pull request. ReviewOps has to run on the `pull_request` event.",
    );
  }

  const { owner, repo } = readRepository(context);

  const pullNumber = pullRequest.number;
  if (!Number.isInteger(pullNumber) || pullNumber < 1) {
    throw new Error("The event has no valid pull request number.");
  }

  // The base repository is the one the workflow runs in. A head repository
  // that differs, or that was deleted, makes the pull request a fork.
  const headRepository = pullRequest.head?.repo?.full_name;
  const isFork =
    typeof headRepository !== "string" ||
    headRepository.toLowerCase() !== `${owner}/${repo}`.toLowerCase();

  return {
    owner,
    repo,
    pullNumber,
    // The last commit of the pull request branch. GITHUB_SHA would be the
    // temporary merge commit, which GitHub does not accept for review comments.
    headSha: readSha(pullRequest.head?.sha, "head"),
    baseSha: readSha(pullRequest.base?.sha, "base"),
    title: typeof pullRequest.title === "string" ? pullRequest.title : "",
    isFork,
    isDraft: pullRequest.draft === true,
  };
}

function readRepository(context) {
  const { owner, repo } = context.repo ?? {};
  if (!isRepositoryPart(owner) || !isRepositoryPart(repo)) {
    throw new Error(
      "The repository of this run could not be determined from GITHUB_REPOSITORY.",
    );
  }
  return { owner, repo };
}

function readSha(value, side) {
  if (typeof value !== "string" || !COMMIT_SHA.test(value)) {
    throw new Error(`The event has no valid ${side} commit SHA.`);
  }
  return value;
}

const context_isObject = (value) => typeof value === "object" && value !== null;

const isRepositoryPart = (value) =>
  typeof value === "string" && REPOSITORY_PART.test(value);

;// CONCATENATED MODULE: ./src/github/files.js
// GitHub lists at most this many files for one pull request.
const API_FILE_LIMIT = 3000;

const SKIP_REASONS = Object.freeze({
  removed: "the file was deleted",
  unchanged: "no content change (rename or mode change only)",
  noPatch: "no text diff (binary file or diff too large)",
});

// Statuses where a missing patch means the content is the same as before.
const STATUSES_WITHOUT_CONTENT_CHANGE = new Set([
  "renamed",
  "copied",
  "changed",
  "unchanged",
]);

/**
 * Loads the changed files of a pull request from the GitHub API.
 *
 * The diff comes from the API only. Nothing here reads the working tree, so
 * the action does not need a checkout of the repository it reviews.
 *
 * @param {ReturnType<typeof import("@actions/github").getOctokit>} octokit
 * @param {{ owner: string, repo: string, pullNumber: number }} pullRequest
 * @returns {Promise<{
 *   files: { path: string, status: string, additions: number, deletions: number, patch: string }[],
 *   skipped: { path: string, reason: string }[],
 *   truncated: boolean,
 * }>} `truncated` is true when GitHub's limit was reached and files are missing.
 */
async function listChangedFiles(octokit, { owner, repo, pullNumber }) {
  let entries;
  try {
    entries = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
  } catch (error) {
    throw describeApiError(error);
  }

  const files = [];
  const skipped = [];
  for (const entry of entries) {
    if (typeof entry?.filename !== "string" || entry.filename === "") {
      throw new Error("GitHub returned a changed file without a name.");
    }

    const reason = skipReason(entry);
    if (reason) {
      skipped.push({ path: entry.filename, reason });
    } else {
      files.push({
        path: entry.filename,
        status: entry.status,
        additions: Number(entry.additions) || 0,
        deletions: Number(entry.deletions) || 0,
        patch: entry.patch,
      });
    }
  }

  return { files, skipped, truncated: entries.length >= API_FILE_LIMIT };
}

function skipReason(entry) {
  if (entry.status === "removed") return SKIP_REASONS.removed;
  if (typeof entry.patch === "string" && entry.patch !== "") return null;

  const contentIsUnchanged =
    STATUSES_WITHOUT_CONTENT_CHANGE.has(entry.status) && !entry.changes;
  return contentIsUnchanged ? SKIP_REASONS.unchanged : SKIP_REASONS.noPatch;
}

/**
 * Turns a failed API request into an error that names the HTTP status and
 * says what to do. The original error stays attached as `cause`.
 */
function describeApiError(error) {
  const status = error?.status;
  if (!Number.isInteger(status)) return error;

  // Octokit reports a failed connection as status 500 without a response.
  // Naming an HTTP status would claim an answer that never came.
  if (!error.response) {
    return new Error(
      "GitHub could not be reached. Check the network of the runner and run the workflow again.",
      { cause: error },
    );
  }

  return new Error(
    `GitHub API request failed (HTTP ${status}). ${hintFor(status, error)}`,
    { cause: error },
  );
}

function hintFor(status, error) {
  if (status === 401) {
    return "The token was rejected. Check the `github-token` input.";
  }
  if (status === 429 || (status === 403 && isRateLimited(error))) {
    return "The rate limit of the token is used up. Run the workflow again later.";
  }
  if (status === 403) {
    return "The token may not read this pull request. The workflow needs the `pull-requests` permission.";
  }
  if (status === 404) {
    return "The pull request was not found, or the token has no access to the repository.";
  }
  if (status >= 500) {
    return "GitHub could not answer the request. Run the workflow again later.";
  }
  return "Turn on debug logging to see the answer from GitHub.";
}

function isRateLimited(error) {
  const headers = error.response?.headers ?? {};
  return (
    headers["x-ratelimit-remaining"] === "0" ||
    "retry-after" in headers ||
    /rate limit/i.test(String(error.message))
  );
}

;// CONCATENATED MODULE: ./src/inputs.js
/**
 * Reads the action inputs and masks the credentials right away.
 *
 * Nothing is validated here on purpose: the values must be masked before
 * any check can fail and produce a message.
 *
 * @param {typeof import("@actions/core")} core
 * @returns {{
 *   githubToken: string,
 *   openaiApiKey: string,
 *   openaiModel: string,
 *   language: string,
 *   exclude: string,
 *   maxFiles: string,
 *   maxDiffChars: string,
 * }} The model, the language and the limits stay text here: `parseModel()`,
 *   `parseLanguage()` and `parseLimits()` check them.
 */
function readInputs(core) {
  const inputs = {
    githubToken: core.getInput("github-token"),
    openaiApiKey: core.getInput("openai-api-key"),
    openaiModel: core.getInput("openai-model"),
    language: core.getInput("language"),
    exclude: core.getInput("exclude"),
    maxFiles: core.getInput("max-files"),
    maxDiffChars: core.getInput("max-diff-chars"),
  };

  for (const secret of secretsOf(inputs)) {
    if (secret) core.setSecret(secret);
  }

  return inputs;
}

/**
 * The inputs that are credentials. Settings such as `exclude` are not: they
 * appear in the log, and masking them would hide ordinary text.
 *
 * @param {{ githubToken: string, openaiApiKey: string }} inputs
 * @returns {string[]}
 */
function secretsOf(inputs) {
  return [inputs.githubToken, inputs.openaiApiKey];
}

/**
 * Rejects missing inputs with a message that says what to do.
 *
 * @param {{ githubToken: string, openaiApiKey: string }} inputs
 */
function assertInputs(inputs) {
  if (!inputs.openaiApiKey) {
    throw new Error(
      "Input `openai-api-key` is missing. Store the key as a repository secret and pass it to the action, for example `openai-api-key: ${{ secrets.OPENAI_API_KEY }}`.",
    );
  }
  // A real key is made of visible ASCII characters. Anything else, such as a
  // space, a line break or the ellipsis of a shortened display, is a copy
  // error. Without this check the SDK fails with a message about a header.
  if (/[^!-~]/.test(inputs.openaiApiKey)) {
    throw new Error(
      "Input `openai-api-key` contains a character that is not allowed: a space, a line break or a character outside of ASCII. Copy the key from OpenAI again and store it as the repository secret `OPENAI_API_KEY`.",
    );
  }
  if (!inputs.githubToken) {
    throw new Error(
      "Input `github-token` is empty. Remove it from the workflow to use the token of the workflow run, or pass a valid token.",
    );
  }
}

;// CONCATENATED MODULE: ./src/diff/annotate.js
const MARKERS = { added: "+", removed: "-", context: " " };

// The number column is at least this wide, so short files look the same.
const MIN_NUMBER_WIDTH = 4;

/**
 * Renders the hunks of one file as text for the model.
 *
 * Only added lines carry a line number: every number the model can see is a
 * line it may comment on. Context and removed lines are there to understand
 * the change. The numbers of the hunk header are left out, so there is
 * nothing to calculate with.
 *
 * ```
 * @@ function total(items) {
 *      |    const tax = 0.19;
 *      | -  return items.length;
 *   12 | +  const sum = items.reduce(add, 0);
 *      |  }
 * ```
 *
 * The result contains code written by the author of the pull request. It is
 * meant for the prompt and must not be logged.
 *
 * @param {{
 *   section: string,
 *   lines: { type: "added" | "removed" | "context", line: number | null, content: string }[],
 * }[]} hunks The hunks of one file, as `parsePatch()` returns them.
 * @returns {string}
 */
function annotateDiff(hunks) {
  let highest = 0;
  for (const hunk of hunks) {
    for (const { type, line } of hunk.lines) {
      if (type === "added" && line > highest) highest = line;
    }
  }
  const width = Math.max(MIN_NUMBER_WIDTH, String(highest).length);

  const rows = [];
  for (const hunk of hunks) {
    rows.push(hunk.section ? `@@ ${hunk.section}` : "@@");
    for (const { type, line, content } of hunk.lines) {
      const number = type === "added" ? String(line) : "";
      // Files with Windows line endings carry a carriage return on each line.
      const code = content.endsWith("\r") ? content.slice(0, -1) : content;
      rows.push(`${number.padStart(width)} | ${MARKERS[type]}${code}`);
    }
  }
  return rows.join("\n");
}

;// CONCATENATED MODULE: ./src/limits.js



// The same values are written into action.yml. A test keeps them equal.
const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_DIFF_CHARS = 200000;

// Nine digits are far above any useful limit and stay exact as a number.
const MAX_DIGITS = 9;
const MAX_VALUE = 10 ** MAX_DIGITS - 1;

const OVER_LIMIT_REASONS = Object.freeze({
  files: (maxFiles) => `over the limit of ${maxFiles} files (max-files)`,
  chars: (maxDiffChars) =>
    `does not fit into the budget of ${maxDiffChars} characters (max-diff-chars)`,
});

/**
 * Reads the two limits of the action. An empty value means the default: it
 * is usually a variable of the workflow that was not set.
 *
 * @param {{ maxFiles?: string, maxDiffChars?: string }} inputs Values as the
 *   workflow passed them.
 * @returns {{ maxFiles: number, maxDiffChars: number }}
 * @throws {Error} When a value is not a whole number from 1 to 999999999.
 */
function parseLimits({ maxFiles = "", maxDiffChars = "" } = {}) {
  return {
    maxFiles: parseLimit("max-files", maxFiles, DEFAULT_MAX_FILES),
    maxDiffChars: parseLimit(
      "max-diff-chars",
      maxDiffChars,
      DEFAULT_MAX_DIFF_CHARS,
    ),
  };
}

function parseLimit(name, value, fallback) {
  const text = String(value).trim();
  if (text === "") return fallback;

  // Only digits: "1e3", "2.5", "-1" and "0x10" are not whole numbers a
  // person meant to write.
  const valid = /^\d+$/.test(text) && text.length <= MAX_DIGITS;
  const number = valid ? Number(text) : 0;
  if (number < 1) {
    // The value is a setting of the workflow, which a pull request can change.
    throw new Error(
      `Input \`${name}\` must be a whole number from 1 to ${MAX_VALUE}, but is "${printable(text)}".`,
    );
  }
  return number;
}

/**
 * Chooses the files that go into the review, in the order GitHub lists them.
 *
 * A file that no longer fits into the remaining budget is left out, but later
 * and smaller files can still follow: one huge file must not keep the rest
 * from being reviewed. Once `maxFiles` files are chosen, all others are left
 * out without being looked at.
 *
 * The size is the length of the annotated diff, the text that is later sent
 * to the model. It is created here once and kept as `annotated`.
 *
 * This is a pure function: it uses nothing but its arguments and does not
 * change them.
 *
 * @template {{ path: string, hunks: Parameters<typeof annotateDiff>[0] }} T
 * @param {T[]} diffs Parsed files, as `parsePatch()` returns them plus `path`.
 * @param {{ maxFiles: number, maxDiffChars: number }} limits
 * @returns {{
 *   selected: (T & { annotated: string })[],
 *   overLimit: { path: string, reason: string }[],
 *   usedChars: number,
 * }}
 */
function applyLimits(diffs, { maxFiles, maxDiffChars }) {
  const selected = [];
  const overLimit = [];
  let usedChars = 0;

  for (const diff of diffs) {
    if (selected.length >= maxFiles) {
      overLimit.push({
        path: diff.path,
        reason: OVER_LIMIT_REASONS.files(maxFiles),
      });
      continue;
    }

    const annotated = annotateDiff(diff.hunks);
    if (usedChars + annotated.length > maxDiffChars) {
      overLimit.push({
        path: diff.path,
        reason: OVER_LIMIT_REASONS.chars(maxDiffChars),
      });
      continue;
    }

    usedChars += annotated.length;
    selected.push({ ...diff, annotated });
  }

  return { selected, overLimit, usedChars };
}

;// CONCATENATED MODULE: ./src/redact.js
const PLACEHOLDER = "***";

// Real tokens and API keys are far longer. A shorter value cannot be a
// credential, and replacing it would tear ordinary words apart.
const MIN_SECRET_LENGTH = 8;

/**
 * Builds a function that replaces every known secret in a text.
 *
 * The runner masks secrets in the log, but only there. Redacting the text
 * itself also protects places the mask never sees, such as review comments.
 *
 * @param {unknown[]} secrets Values to hide. Non-string values and values
 *   shorter than eight characters are ignored.
 * @returns {(text: unknown) => string}
 */
function createRedactor(secrets) {
  const known = secrets
    .filter(
      (secret) =>
        typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH,
    )
    // Longest first, so a secret that contains another one is replaced as a whole.
    .sort((a, b) => b.length - a.length);

  return (text) =>
    known.reduce(
      (result, secret) => result.replaceAll(secret, PLACEHOLDER),
      String(text),
    );
}

;// CONCATENATED MODULE: ./src/main.js













// `pull_request_target` is left out on purpose: it hands secrets and a write
// token to pull requests from forks.
const SUPPORTED_EVENT = "pull_request";

// A pull request can skip thousands of files, for example when it deletes a
// directory. The log names the first ones and counts the rest.
const MAX_SKIPPED_LINES = 50;

const UNREADABLE_DIFF = "the diff could not be read";

/**
 * Runs the action. Every failure inside ends in `core.setFailed()`.
 *
 * Loading this module can fail as well: `@actions/github` parses the event
 * file while it loads. `src/index.js` catches that case.
 *
 * @param {object} [deps] Replacements for the runner modules, used by tests.
 * @param {typeof import("@actions/core")} [deps.core]
 * @param {typeof import("@actions/github").context} [deps.context]
 * @param {typeof import("@actions/github").getOctokit} [deps.getOctokit]
 * @param {typeof import("./diff/parse.js").parsePatch} [deps.parsePatch]
 */
async function run({
  core = lib_core,
  context = github/* context */._,
  getOctokit = github/* getOctokit */.Q,
  parsePatch = parse_parsePatch,
} = {}) {
  let redact = String;

  try {
    if (context.eventName !== SUPPORTED_EVENT) {
      core.notice(
        `ReviewOps runs only on the "${SUPPORTED_EVENT}" event. This run was triggered by "${context.eventName ?? "unknown"}" and was skipped.`,
      );
      return;
    }

    const inputs = readInputs(core);
    redact = createRedactor(secretsOf(inputs));
    assertInputs(inputs);
    // A pattern, a limit, a model name or a language that cannot be used
    // fails the run here, before any request. The model and the language are
    // handed to the AI client and the prompt later.
    const excludeReason = createExcludeFilter(inputs.exclude);
    const limits = parseLimits(inputs);
    parseModel(inputs.openaiModel);
    parseLanguage(inputs.language);

    core.info("ReviewOps started.");

    // Only checked values reach the log: the title of the pull request is
    // written by its author and stays out.
    const pullRequest = readPullRequest(context);
    core.info(
      `Reviewing ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.pullNumber} at commit ${pullRequest.headSha}.`,
    );

    const octokit = getOctokit(inputs.githubToken);
    const listing = await listChangedFiles(octokit, pullRequest);

    // Generated and irrelevant files are left out before anything is parsed.
    const relevant = [];
    const excluded = [];
    for (const file of listing.files) {
      const reason = excludeReason(file.path);
      if (reason) excluded.push({ path: file.path, reason });
      else relevant.push(file);
    }

    // Line numbers are calculated here and never taken from the model.
    const { diffs, unreadable } = parseDiffs(relevant, parsePatch);

    // Large pull requests are cut to the limits, in the order of GitHub.
    const { selected, overLimit, usedChars } = applyLimits(diffs, limits);

    // The list below is cut off, so the order matters: unreadable diffs and
    // files that the limits left out are the ones someone has to look at,
    // excluded files are a decision of this action, the rest could not be
    // reviewed anyway.
    const skipped = [
      ...unreadable.map(({ path }) => ({ path, reason: UNREADABLE_DIFF })),
      ...overLimit,
      ...excluded,
      ...listing.skipped,
    ];
    core.info(
      `Found ${selected.length + skipped.length} changed files: ${selected.length} to review, ${skipped.length} skipped.`,
    );
    // File names are chosen by the author of the pull request.
    for (const { path, reason } of skipped.slice(0, MAX_SKIPPED_LINES)) {
      core.info(`Skipped ${printable(path)}: ${reason}.`);
    }
    if (skipped.length > MAX_SKIPPED_LINES) {
      core.info(
        `${skipped.length - MAX_SKIPPED_LINES} more skipped files are not listed.`,
      );
    }
    if (unreadable.length > 0) {
      core.warning(
        `Diffs that could not be read: ${unreadable.length}. These files are not reviewed.`,
      );
      for (const { path, detail } of unreadable) {
        core.debug(`${printable(path)}: ${detail}`);
      }
    }
    if (overLimit.length > 0) {
      core.warning(
        `Files left out because of the limits: ${overLimit.length}. They are not reviewed. The limits are max-files: ${limits.maxFiles} and max-diff-chars: ${limits.maxDiffChars}.`,
      );
    }
    if (listing.truncated) {
      core.warning(
        "GitHub lists at most 3000 files per pull request. Files beyond that were not loaded.",
      );
    }

    // Everything that costs money or posts something comes after this
    // point: a pull request without reviewable files ends here.
    if (selected.length === 0) {
      core.notice(
        "ReviewOps found no files to review in this pull request. The log lists the skipped files.",
      );
      return;
    }

    const addedLines = selected.reduce(
      (sum, diff) => sum + diff.commentableLines.length,
      0,
    );
    core.info(
      `Parsed the diffs of ${selected.length} files: ${addedLines} added lines can receive comments.`,
    );
    core.info(`Diff size: ${usedChars} of ${limits.maxDiffChars} characters.`);
  } catch (error) {
    // Mark the step as failed first: nothing below may prevent that.
    core.setFailed(redact(describe(error)));

    try {
      if (error instanceof Error && error.stack) {
        core.debug(redact(error.stack));
      }
      if (error?.cause instanceof Error) {
        core.debug(redact(`Caused by: ${error.cause.message}`));
      }
    } catch {
      // A broken debug log must not hide the failure reported above.
    }
  }
}

/**
 * Parses the patch of every file. A file whose patch cannot be read is set
 * aside instead of failing the run: one odd file must not prevent the review
 * of all others. Any other error is a defect and is passed on.
 */
function parseDiffs(files, parsePatch) {
  const diffs = [];
  const unreadable = [];
  for (const file of files) {
    try {
      diffs.push({ ...file, ...parsePatch(file.patch) });
    } catch (error) {
      if (!(error instanceof PatchFormatError)) throw error;
      // The message names positions in the patch, never its content.
      unreadable.push({ path: file.path, detail: error.message });
    }
  }
  return { diffs, unreadable };
}

/** Turns anything that was thrown into a message a person can act on. */
function describe(error) {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string" && error.trim()) return error;
  return "ReviewOps failed without an error message.";
}


/***/ })

};
