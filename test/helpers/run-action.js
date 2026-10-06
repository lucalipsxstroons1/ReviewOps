import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROXY_VARIABLE } from "./no-proxy.js";

// Recognisable stand-ins. They must not look like real credentials.
export const TOKEN = "TESTTOKEN-not-a-real-token-123456";
export const API_KEY = "TESTKEY-not-a-real-key-654321";

// Nothing listens on the discard port. A test that forgets to start the local
// API server fails here instead of reaching GitHub.
const UNREACHABLE_API = "http://127.0.0.1:9";

// Sends the requests to OpenAI to TEST_OPENAI_URL, or nowhere without it.
const REDIRECT_OPENAI = pathToFileURL(
  fileURLToPath(new URL("./redirect-openai.js", import.meta.url)),
).href;

/** Absolute path of a file given relative to the repository root. */
export const fromRoot = (path) =>
  fileURLToPath(new URL(`../../${path}`, import.meta.url));

/**
 * Starts the action the way the runner does: as its own process, configured
 * only through environment variables.
 *
 * Variables the runner itself sets and proxy settings of the machine are
 * removed first, so the result does not depend on where the tests run. The
 * process is started without blocking, so a test can serve its API requests.
 *
 * Requests to OpenAI go to the local server in `TEST_OPENAI_URL`, or to an
 * address where nothing listens: see `redirect-openai.js`.
 *
 * Like the runner, it hands the action a file for the job summary
 * (`GITHUB_STEP_SUMMARY`) and one for the outputs (`GITHUB_OUTPUT`), unless
 * `env` sets them. Their content is returned as `summary` and `outputs`.
 *
 * @param {string} entryPoint Absolute path of the file to start.
 * @param {Record<string, string>} env Variables for this run.
 * @returns {Promise<{
 *   status: number | null,
 *   stdout: string,
 *   stderr: string,
 *   output: string,
 *   summary: string,
 *   outputs: Record<string, string>,
 * }>}
 */
export function startAction(entryPoint, env) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(GITHUB_|INPUT_|RUNNER_)/.test(name) && !PROXY_VARIABLE.test(name),
    ),
  );
  const folder = mkdtempSync(join(tmpdir(), "reviewops-run-"));
  const files = {
    GITHUB_STEP_SUMMARY: join(folder, "summary.md"),
    GITHUB_OUTPUT: join(folder, "output.txt"),
  };
  for (const file of Object.values(files)) writeFileSync(file, "");
  const collect = () => {
    const summaryFile = env.GITHUB_STEP_SUMMARY ?? files.GITHUB_STEP_SUMMARY;
    const outputFile = env.GITHUB_OUTPUT ?? files.GITHUB_OUTPUT;
    const read = (file) => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return "";
      }
    };
    const result = {
      summary: read(summaryFile),
      outputs: readOutputs(read(outputFile)),
    };
    rmSync(folder, { recursive: true, force: true });
    return result;
  };

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", REDIRECT_OPENAI, entryPoint],
      {
        env: {
          ...inherited,
          GITHUB_API_URL: UNREACHABLE_API,
          TEST_OPENAI_URL: "",
          ...files,
          ...env,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) =>
      resolve({
        status,
        stdout,
        stderr,
        output: stdout + stderr,
        ...collect(),
      }),
    );
  });
}

/**
 * Reads the file the runner hands out as `GITHUB_OUTPUT`: `@actions/core`
 * writes every output as `name<<delimiter`, the value and the delimiter.
 */
function readOutputs(text) {
  const outputs = {};
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([^<]+)<<(.+)$/.exec(lines[index]);
    if (!match) continue;
    const end = lines.indexOf(match[2], index + 1);
    if (end === -1) break;
    outputs[match[1]] = lines.slice(index + 1, end).join("\n");
    index = end;
  }
  return outputs;
}

/** What the runner sets for a pull_request event, with the example payload. */
export const PULL_REQUEST_EVENT = {
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_EVENT_PATH: fromRoot("test/fixtures/pull-request-event.json"),
  GITHUB_REPOSITORY: "octo-org/demo",
};

/** The log line the example payload must produce. */
export const REVIEWING_LINE =
  "Reviewing octo-org/demo#42 at commit 1111111111111111111111111111111111111111.";

/** Adds both inputs the way a workflow passes them. */
export const withInputs = (env) => ({
  "INPUT_GITHUB-TOKEN": TOKEN,
  "INPUT_OPENAI-API-KEY": API_KEY,
  ...env,
});

/** Output as it reaches the log: mask commands are consumed by the runner. */
export const withoutMaskCommands = (output) =>
  output
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("::add-mask::"))
    .join("\n");
