/**
 * Reads the action inputs and masks the credentials right away.
 *
 * Nothing is validated here on purpose: the values must be masked before
 * any check can fail and produce a message.
 *
 * @param {typeof import("@actions/core")} core
 * @returns {{ githubToken: string, openaiApiKey: string }}
 */
export function readInputs(core) {
  const inputs = {
    githubToken: core.getInput("github-token"),
    openaiApiKey: core.getInput("openai-api-key"),
  };

  for (const secret of Object.values(inputs)) {
    if (secret) core.setSecret(secret);
  }

  return inputs;
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
  if (!inputs.githubToken) {
    throw new Error(
      "Input `github-token` is empty. Remove it from the workflow to use the token of the workflow run, or pass a valid token.",
    );
  }
}
