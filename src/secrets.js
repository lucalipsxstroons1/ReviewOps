// What the model sees instead of a secret. The system prompt explains it.
export const SECRET_PLACEHOLDER = "[REDACTED SECRET]";

// Formats that look like nothing else. Generic patterns such as
// `password = "…"` are left out on purpose: they hit tests and examples and
// would change code the model is meant to review. Every quantifier stands
// alone, so a long line cannot make a pattern slow.
const TOKEN_PATTERNS = [
  // GitHub: personal, OAuth, user-to-server, server-to-server and refresh
  // tokens, and fine-grained personal access tokens.
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
  // OpenAI: project, service account and admin keys, and the older keys
  // without a hyphen after the prefix.
  /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9]{32,}\b/g,
  // AWS access key IDs, long-lived and temporary.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Slack tokens.
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  // Stripe live keys, secret and restricted.
  /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
];

const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;

/**
 * Replaces strings that look like secrets in the hunks of one file.
 *
 * The number of lines and their numbers stay the same, so the lines the
 * model may comment on do not move. A private key block is replaced line by
 * line, from its BEGIN line to its END line, and up to the end of the hunk
 * if the END line is missing. Every kind of line is masked, also removed and
 * unchanged ones: they are sent to the model as well.
 *
 * This is a pure function: it does not change the hunks it is given.
 *
 * @template {{ section: string, lines: { content: string }[] }} H
 * @param {H[]} hunks The hunks of one file, as `parsePatch()` returns them.
 * @returns {{ hunks: H[], masked: number }} The hunks with the secrets
 *   replaced, and how many were found. A key block counts once.
 */
export function maskSecrets(hunks) {
  let masked = 0;
  const maskTokens = (text) => {
    let result = text;
    for (const pattern of TOKEN_PATTERNS) {
      result = result.replace(pattern, () => {
        masked += 1;
        return SECRET_PLACEHOLDER;
      });
    }
    return result;
  };

  const result = hunks.map((hunk) => {
    let inKey = false;
    const lines = hunk.lines.map((line) => {
      let content = line.content;
      if (inKey) {
        const end = KEY_END.exec(content);
        if (!end) return { ...line, content: SECRET_PLACEHOLDER };
        inKey = false;
        content = SECRET_PLACEHOLDER + content.slice(end.index + end[0].length);
      } else {
        const begin = KEY_BEGIN.exec(content);
        if (begin) {
          masked += 1;
          const rest = content.slice(begin.index);
          const end = KEY_END.exec(rest);
          if (end) {
            // The whole key on one line, for example in a JSON string.
            content =
              content.slice(0, begin.index) +
              SECRET_PLACEHOLDER +
              rest.slice(end.index + end[0].length);
          } else {
            inKey = true;
            content = content.slice(0, begin.index) + SECRET_PLACEHOLDER;
          }
        }
      }
      return { ...line, content: maskTokens(content) };
    });
    return { ...hunk, section: maskTokens(hunk.section), lines };
  });

  return { hunks: result, masked };
}
