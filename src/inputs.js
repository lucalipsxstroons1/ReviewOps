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
export function readInputs(core) {
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
export function secretsOf(inputs) {
  return [inputs.githubToken, inputs.openaiApiKey];
}

/**
 * Rejects missing inputs with a message that says what to do.
 *
 * @param {{ githubToken: string, openaiApiKey: string }} inputs
 */
export function assertInputs(inputs) {
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
