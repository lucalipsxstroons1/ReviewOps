/** The longest address that is accepted, in characters. */
export const MAX_URL_CHARS = 2048;

/** The shortest secret, the same rule as `INGEST_SECRET` at Insights. */
export const MIN_SECRET_CHARS = 32;

// Over plain http the report goes only to the machine of the runner itself:
// the tests of this repository use it, and nothing else.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

// Spaces and control characters, line breaks included.
const UNSAFE_URL_CHARS = /[\s\p{Cc}]/u;

/**
 * Reads the two inputs for the report to ReviewOps Insights and checks them
 * before the first request.
 *
 * The report leaves the runner for the address in `insights-url`: repository
 * names, file paths and token counts. A wrong address would hand them to a
 * stranger, so everything that does not look like a plain address is refused
 * (docs/insights-payload.md).
 *
 * The messages name the rule that was broken, never the address and never the
 * secret: the address can hold credentials.
 *
 * @param {{ insightsUrl?: string, insightsSecret?: string }} inputs
 * @returns {{ url: string, host: string, secret: string | null } | null}
 *   `null` when `insights-url` is empty, which switches the report off, also
 *   when a secret is set. Otherwise the address in its normal form, its host
 *   (with the port) for the log and the secret, or `null` when it is empty:
 *   `run()` decides whether that is an error.
 * @throws {Error} For an address or a secret that cannot be used.
 */
export function parseInsightsConfig(inputs) {
  const text = (inputs.insightsUrl ?? "").trim();
  if (text === "") return null;

  const url = parseUrl(text);
  return {
    url: url.href,
    host: url.host,
    secret: parseSecret(inputs.insightsSecret ?? ""),
  };
}

function parseUrl(text) {
  if (text.length > MAX_URL_CHARS) {
    throw new Error(
      `Input \`insights-url\` is too long: at most ${MAX_URL_CHARS} characters.`,
    );
  }
  if (UNSAFE_URL_CHARS.test(text)) {
    throw new Error(
      "Input `insights-url` contains a space or a control character.",
    );
  }
  // Looked up in the text: an empty query (`https://host/path?`) is gone from
  // the parsed address.
  if (text.includes("?") || text.includes("#")) {
    throw new Error(
      "Input `insights-url` must not contain a query (`?`) or a fragment (`#`).",
    );
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(
      "Input `insights-url` is not a valid address. Use the whole address, for example `https://insights.example.com/api/v1/ingest/review`.",
    );
  }

  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error(
      "Input `insights-url` must start with `https://`. `http://` is accepted only for `localhost` and `127.0.0.1`.",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(
      "Input `insights-url` must not contain a user name or a password. Pass the secret in `insights-secret`.",
    );
  }
  return url;
}

function parseSecret(secret) {
  if (secret === "") return null;
  // Visible ASCII only: a space, a line break or a character from a copy
  // error would change the signature the receiver computes.
  if (/[^!-~]/.test(secret)) {
    throw new Error(
      "Input `insights-secret` contains a character that is not allowed: a space, a line break or a character outside of ASCII. Copy the secret again and store it as a repository secret.",
    );
  }
  if (secret.length < MIN_SECRET_CHARS) {
    throw new Error(
      `Input \`insights-secret\` is too short: at least ${MIN_SECRET_CHARS} characters, the same rule as \`INGEST_SECRET\` at ReviewOps Insights.`,
    );
  }
  return secret;
}

/**
 * The address for the status report (#77), derived from the address of the
 * review report: a path that ends on `/review` becomes `/status`. Any other
 * path gives `null`, and the action sends no status report.
 *
 * @param {string} url `url` of `parseInsightsConfig()`, in its normal form.
 * @returns {string | null}
 */
export function deriveStatusUrl(url) {
  const address = new URL(url);
  if (!address.pathname.endsWith("/review")) return null;
  address.pathname = `${address.pathname.slice(0, -"/review".length)}/status`;
  return address.href;
}
