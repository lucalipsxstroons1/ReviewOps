import { AiError } from "./error.js";
import { validate } from "./json-schema.js";

// The one place where the format of the review is defined. The request sends
// this schema to the model, and `parseReview()` checks the answer against the
// very same object. The descriptions go to the model as well, and a test keeps
// them equal to the table in docs/response-format.md.

export const SEVERITIES = ["critical", "major", "minor", "info"];
export const CATEGORIES = [
  "code-quality",
  "react",
  "vue",
  "efcore",
  "security",
];

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
export const MAX_OUTPUT_TOKENS = 4096;

/** The schema of the answer. Strict mode: every property is required. */
export const REVIEW_SCHEMA = deepFreeze({
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
            enum: SEVERITIES,
            description: "How serious the problem is.",
          },
          category: {
            type: "string",
            enum: CATEGORIES,
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
export const REVIEW_FORMAT = deepFreeze({
  type: "json_schema",
  json_schema: { name: "review", strict: true, schema: REVIEW_SCHEMA },
});

/**
 * @typedef {object} Finding
 * @property {string} path
 * @property {number} line
 * @property {"critical" | "major" | "minor" | "info"} severity
 * @property {"code-quality" | "react" | "vue" | "efcore" | "security"} category
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
export function parseReview({ content, finishReason }) {
  // Checked first: a cut-off answer is usually not JSON any more.
  if (finishReason === "length") {
    throw new AiError(
      "truncated",
      `The answer of the model was cut off at the limit of ${MAX_OUTPUT_TOKENS} tokens, so the review is incomplete. Run the workflow again; if it keeps happening, leave the largest files out with the input \`exclude\`.`,
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
