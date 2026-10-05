import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Recognisable stand-ins. They must not look like real credentials.
export const TOKEN = "TESTTOKEN-not-a-real-token-123456";
export const API_KEY = "TESTKEY-not-a-real-key-654321";

/** Absolute path of a file given relative to the repository root. */
export const fromRoot = (path) =>
  fileURLToPath(new URL(`../../${path}`, import.meta.url));

/**
 * Starts the action the way the runner does: as its own process, configured
 * only through environment variables.
 *
 * Variables the runner itself sets are removed first, so the result does not
 * depend on whether the tests run locally or inside a workflow.
 *
 * @param {string} entryPoint Absolute path of the file to start.
 * @param {Record<string, string>} env Variables for this run.
 */
export function startAction(entryPoint, env) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(GITHUB_|INPUT_|RUNNER_)/.test(name),
    ),
  );
  const result = spawnSync(process.execPath, [entryPoint], {
    env: { ...inherited, ...env },
    encoding: "utf8",
  });
  return { ...result, output: result.stdout + result.stderr };
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
