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
export function createRedactor(secrets) {
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

// Probe for the CI: this line changes the sources but not the checked-in bundle.
