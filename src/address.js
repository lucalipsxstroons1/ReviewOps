/** The longest address that is accepted, in characters. */
export const MAX_URL_CHARS = 2048;

// Over plain http an address is accepted only for the machine of the runner
// itself: the tests of this repository use it, and a model or a report on the
// same machine. Nothing leaves the runner over an unencrypted connection.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

// Spaces and control characters, line breaks included.
const UNSAFE_URL_CHARS = /[\s\p{Cc}]/u;

/**
 * Checks an address that an input of the workflow names and that the action
 * sends something to: the report for ReviewOps Insights, and the API of the
 * model. Both take the same rules, so there is one check (#40).
 *
 * The code, the key or the report goes to this address. A wrong address would
 * hand it to a stranger, so everything that does not look like a plain address
 * is refused: only `https` (and `http` for the machine of the runner), no user
 * name or password in the address, no query, no fragment, no space or control
 * character.
 *
 * The messages name the input and the rule that was broken, never the address
 * and never a part of it: the address can hold credentials.
 *
 * @param {string} text The value of the input, without spaces around it.
 * @param {object} options
 * @param {string} options.input The name of the input, for the messages.
 * @param {string} options.example An address that would be accepted, for the
 *   message about an address that is not valid.
 * @param {string} options.secretInput The input that holds the secret that
 *   belongs to the address, for the message about credentials in the address.
 * @returns {URL}
 * @throws {Error} For an address that cannot be used.
 */
export function parseAddress(text, { input, example, secretInput }) {
  if (text.length > MAX_URL_CHARS) {
    throw new Error(
      `Input \`${input}\` is too long: at most ${MAX_URL_CHARS} characters.`,
    );
  }
  if (UNSAFE_URL_CHARS.test(text)) {
    throw new Error(
      `Input \`${input}\` contains a space or a control character.`,
    );
  }
  // Looked up in the text: an empty query (`https://host/path?`) is gone from
  // the parsed address.
  if (text.includes("?") || text.includes("#")) {
    throw new Error(
      `Input \`${input}\` must not contain a query (\`?\`) or a fragment (\`#\`).`,
    );
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(
      `Input \`${input}\` is not a valid address. Use the whole address, for example \`${example}\`.`,
    );
  }

  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error(
      `Input \`${input}\` must start with \`https://\`. \`http://\` is accepted only for \`localhost\` and \`127.0.0.1\`.`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(
      `Input \`${input}\` must not contain a user name or a password. Pass the secret in \`${secretInput}\`.`,
    );
  }
  return url;
}
