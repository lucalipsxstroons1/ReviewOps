export const id = 269;
export const ids = [269];
export const modules = {

/***/ 269:
/***/ ((__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) => {


// EXPORTS
__webpack_require__.d(__webpack_exports__, {
  run: () => (/* binding */ run)
});

// EXTERNAL MODULE: ./node_modules/@actions/core/lib/core.js + 18 modules
var lib_core = __webpack_require__(6257);
// EXTERNAL MODULE: ./node_modules/@actions/github/lib/github.js + 22 modules
var github = __webpack_require__(2413);
// EXTERNAL MODULE: ./node_modules/openai/index.mjs + 216 modules
var openai = __webpack_require__(9111);
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

;// CONCATENATED MODULE: ./src/ai/client.js



// Fixed on purpose. The SDK would take the address, the organisation and the
// project from variables of the environment if they were left out, and it
// would then send the key and the code to wherever the variable points.
const BASE_URL = "https://api.openai.com/v1";
const TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;

// Low, so that a second run over the same diff gives similar findings.
const TEMPERATURE = 0.1;

// Values that come from the answer of the API are shown only if they look
// like an identifier. Nothing else from the answer is ever written.
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,100}$/;
const safe = (value) =>
  typeof value === "string" && IDENTIFIER.test(value) ? value : "unknown";

/**
 * An error of the AI client. The message says what to do. It never contains
 * text from the answer of the API: OpenAI repeats the first and the last
 * characters of an invalid key in its own message.
 */
class AiError extends Error {
  name = "AiError";

  /**
   * @param {"auth" | "permission" | "model" | "quota" | "rate_limit" | "server" | "timeout" | "network" | "request" | "response"} kind
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

/**
 * Creates the client for the review model.
 *
 * Nothing in here writes the prompt or the answer anywhere: both contain code
 * from the pull request. The log gets numbers only.
 *
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} [options.model] Empty means the default model.
 * @param {Pick<typeof import("@actions/core"), "info" | "debug">} options.core
 * @param {typeof OpenAI} [options.OpenAIClass] Replacement for the SDK, used by tests.
 * @returns {{
 *   complete: (prompt: { system: string, user: string }) => Promise<{
 *     content: string,
 *     finishReason: string | null,
 *     usage: { inputTokens: number, outputTokens: number, totalTokens: number } | null,
 *     model: string,
 *     requestId: string | null,
 *   }>,
 * }}
 */
function createAiClient({ apiKey, model, core, OpenAIClass = openai/* default */.Ay }) {
  if (typeof apiKey !== "string" || apiKey === "") {
    throw new Error("The AI client needs an API key.");
  }
  const modelName = parseModel(model);

  const sdk = new OpenAIClass({
    apiKey,
    baseURL: BASE_URL,
    organization: null,
    project: null,
    logLevel: "off",
    timeout: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  });

  // Some models do not accept `temperature`. Once one has refused it, the
  // following requests leave it out right away.
  let sendTemperature = true;

  async function send(messages) {
    // Several requests can be on their way at once, and each of them is
    // refused on its own. So the refusal is matched to what this request
    // carried, not to what the flag says by now.
    const withTemperature = sendTemperature;
    try {
      return await sdk.chat.completions.create({
        model: modelName,
        messages,
        ...(withTemperature ? { temperature: TEMPERATURE } : {}),
      });
    } catch (error) {
      if (!(withTemperature && rejectsTemperature(error))) throw error;
      if (sendTemperature) {
        sendTemperature = false;
        core.info(
          "The model does not accept `temperature`. The request is repeated without it.",
        );
      }
      return sdk.chat.completions.create({ model: modelName, messages });
    }
  }

  return {
    async complete({ system, user }) {
      if (typeof system !== "string" || typeof user !== "string") {
        throw new TypeError("The prompt needs a system text and a user text.");
      }

      let response;
      try {
        response = await send([
          { role: "system", content: system },
          { role: "user", content: user },
        ]);
      } catch (error) {
        const translated = translate(error, modelName, core);
        // Anything else is a defect of this action, not a problem of the API.
        throw translated ?? error;
      }

      return read(response, modelName, core);
    },
  };
}

function rejectsTemperature(error) {
  return (
    error instanceof openai/* default.BadRequestError */.Ay.BadRequestError && error.param === "temperature"
  );
}

/** Checks the answer and turns it into the result of the client. */
function read(response, requestedModel, core) {
  const choice = response?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || content === "") {
    throw new AiError(
      "response",
      "OpenAI answered without any text. The model may have refused the request or the answer was cut off. Run the workflow again.",
    );
  }

  const model =
    safe(response.model) === "unknown" ? requestedModel : response.model;
  const requestId = IDENTIFIER.test(response._request_id ?? "")
    ? response._request_id
    : null;
  // The numbers end up in the log. They are taken only if all three are
  // whole numbers, so that nothing else from the answer gets there.
  const counts = [
    response.usage?.prompt_tokens,
    response.usage?.completion_tokens,
    response.usage?.total_tokens,
  ];
  const usage = counts.every(
    (count) => Number.isSafeInteger(count) && count >= 0,
  )
    ? {
        inputTokens: counts[0],
        outputTokens: counts[1],
        totalTokens: counts[2],
      }
    : null;

  const where = requestId ? ` (request ${requestId})` : "";
  core.info(
    usage
      ? `OpenAI answered with model ${model}: ${usage.inputTokens} input and ${usage.outputTokens} output tokens${where}.`
      : `OpenAI answered with model ${model}, without a token count${where}.`,
  );

  return {
    content,
    finishReason:
      typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    usage,
    model,
    requestId,
  };
}

/**
 * Turns an error of the SDK into an AiError with its own message. Returns
 * `null` for anything that is not a problem of the API.
 */
function translate(error, model, core) {
  if (error instanceof openai/* default.APIConnectionTimeoutError */.Ay.APIConnectionTimeoutError) {
    return new AiError(
      "timeout",
      `OpenAI did not answer within ${TIMEOUT_MS / 1000} seconds, also after ${MAX_RETRIES} retries. Run the workflow again later.`,
    );
  }
  if (error instanceof openai/* default.APIConnectionError */.Ay.APIConnectionError) {
    return new AiError(
      "network",
      "OpenAI could not be reached. Check the network of the runner and run the workflow again.",
    );
  }
  if (error instanceof openai/* default.APIError */.Ay.APIError && Number.isInteger(error.status)) {
    // Status, code, type and request ID tell what happened. The text of the
    // answer stays out: OpenAI repeats parts of the key in it.
    core.debug(
      `OpenAI error: status ${error.status}, code ${describe(error.code)}, type ${describe(error.type)}, request ${describe(error.requestID)}.`,
    );
    return byStatus(error, model);
  }
  if (error instanceof openai/* default.OpenAIError */.Ay.OpenAIError) {
    // Which kind of error it was, without anything it says.
    core.debug(`OpenAI error: ${describe(error.constructor?.name)}.`);
    return new AiError(
      "response",
      "OpenAI answered in a way that could not be read. Run the workflow again.",
    );
  }
  return null;
}

const describe = (value) =>
  value === null || value === undefined ? "none" : safe(value);

function byStatus(error, model) {
  const { status } = error;
  const http = `HTTP ${status}`;

  if (status === 401) {
    return new AiError(
      "auth",
      `OpenAI rejected the API key (${http}). Check that the repository secret \`OPENAI_API_KEY\` holds a valid key of an active project.`,
      status,
    );
  }
  if (status === 403) {
    return new AiError(
      "permission",
      `OpenAI denied the request (${http}). The key may not be allowed to use the model "${model}". Check the permissions of the key and of its project.`,
      status,
    );
  }
  if (status === 404) {
    return new AiError(
      "model",
      `OpenAI does not know the model "${model}", or the key has no access to it (${http}). Check the input \`openai-model\`.`,
      status,
    );
  }
  // A used-up quota is also an HTTP 429, but waiting does not help. OpenAI
  // names it in the type of the error. The code differs: an account without
  // credit answers with `credit_balance_exhausted`, a spending limit with
  // `insufficient_quota`. Either one counts.
  if (
    status === 429 &&
    (error.type === "insufficient_quota" || error.code === "insufficient_quota")
  ) {
    return new AiError(
      "quota",
      `The OpenAI account has no credit or quota left (${http}). Add credit, or check the billing and the spending limit of the project of the key. Running the workflow again does not help until then.`,
      status,
    );
  }
  if (status === 429) {
    return new AiError(
      "rate_limit",
      `The rate limit of OpenAI is reached (${http}), also after ${MAX_RETRIES} retries. Run the workflow again later.`,
      status,
    );
  }
  if (status >= 500) {
    return new AiError(
      "server",
      `OpenAI could not answer (${http}), also after ${MAX_RETRIES} retries. Run the workflow again later.`,
      status,
    );
  }
  return new AiError(
    "request",
    `OpenAI rejected the request (${http}). Turn on debug logging to see status and error code.`,
    status,
  );
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
  if (!isObject(pullRequest)) {
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

const isObject = (value) => typeof value === "object" && value !== null;

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
 *   exclude: string,
 *   maxFiles: string,
 *   maxDiffChars: string,
 * }} The model and the limits stay text here: `parseModel()` and
 *   `parseLimits()` check them.
 */
function readInputs(core) {
  const inputs = {
    githubToken: core.getInput("github-token"),
    openaiApiKey: core.getInput("openai-api-key"),
    openaiModel: core.getInput("openai-model"),
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
    // A pattern, a limit or a model name that cannot be used fails the run
    // here, before any request. The model is handed to the AI client later.
    const excludeReason = createExcludeFilter(inputs.exclude);
    const limits = parseLimits(inputs);
    parseModel(inputs.openaiModel);

    core.info("ReviewOps started.");

    // Only on this throwaway branch: one small request to the real API.
    if (process.env.REVIEWOPS_PROBE === "openai") {
      const ai = createAiClient({
        apiKey: inputs.openaiApiKey,
        model: parseModel(inputs.openaiModel),
        core,
      });
      const answer = await ai.complete({
        system: "Answer with the single word pong.",
        user: "ping",
      });
      core.info(
        `Probe: the model answered with ${answer.content.length} characters.`,
      );
      return;
    }

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
    core.setFailed(redact(main_describe(error)));

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
function main_describe(error) {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string" && error.trim()) return error;
  return "ReviewOps failed without an error message.";
}


/***/ })

};
