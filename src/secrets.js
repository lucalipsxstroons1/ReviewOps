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
  // Anthropic: the kind of key with a version of two digits (`api03`,
  // `admin01`, …) after `sk-ant-`. Without the version, a CSS class such as
  // `sk-ant-design-table-wrapper-large` would match.
  /\bsk-ant-[a-z]{2,12}\d{2}-[A-Za-z0-9_-]{20,}/g,
  // GitLab: the prefixes of its token table. A routable token has dots; the
  // part before the first dot is masked, which is the secret part.
  /\b(?:glpat|gldt|glrt|glrtr|glcbt|glptt|glft|gloas|glsoat|glimt|glagent|glffct|glwt)-[A-Za-z0-9_-]{20,}/g,
  // npm: `npm_` and 36 characters (30 of random, 6 of checksum). The
  // underscores of names such as `npm_config_registry` do not match.
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  // PyPI: `pypi-` and a serialized macaroon, which always starts with the
  // same characters (the version and `pypi.org` as its location).
  /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/g,
  // Docker Hub: personal and organization access tokens.
  /\bdckr_(?:pat|oat)_[A-Za-z0-9_-]{20,}/g,
  // Hugging Face: `hf_` and at least 34 characters. A name such as
  // `hf_hub_download` has underscores and does not match.
  /\bhf_[A-Za-z0-9]{34,}\b/g,
];

const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;

// A line of a key body: Base64 only, perhaps indented, in quotes, with an
// escaped line break or a comma at the end, as in YAML, JSON or source code.
const BASE64_LINE =
  /^\s*["'`]?([A-Za-z0-9+/]+={0,2})(?:\\n)?["'`]?\s*(?:[,;+]\s*)?$/;

/** The Base64 text of a line, or `null` if the line is something else. */
function base64Of(content) {
  return BASE64_LINE.exec(content)?.[1] ?? null;
}

// The full lines of a PEM body are 64 characters long, some formats use 76.
// Two or more of them in a row are masked even without BEGIN and END: a
// pull request that changes a line in the middle of a key shows only body
// lines. Other Base64 blocks, such as a public certificate, are masked as
// well; the model does not need them.
const isBodyLine = (content) => {
  const text = base64Of(content);
  return text !== null && text.length >= 60 && text.length <= 76;
};

// After a hunk that ended inside a key, the next hunk may still be inside
// it. A line counts as part of the key if it is Base64 and does not look
// like a word, so that ordinary code ends the key right away.
const isKeyRest = (content) => {
  const text = base64Of(content);
  return (
    text !== null &&
    text.length <= 76 &&
    (text.length >= 20 || /[0-9+/=]/.test(text))
  );
};

/**
 * Replaces strings that look like secrets in the hunks of one file.
 *
 * The number of lines and their numbers stay the same, so the lines the
 * model may comment on do not move. A private key block is replaced line by
 * line, from its BEGIN line to its END line, and up to the end of the hunk
 * if the END line is missing. The next hunk continues the key as long as its
 * lines look like the rest of a key. Runs of two or more lines that look
 * like a key body are replaced as well, with or without BEGIN and END. Every
 * kind of line is masked, also removed and unchanged ones: they are sent to
 * the model as well.
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

  // Set when a hunk ends inside a key, checked at the start of the next one.
  let openKey = false;

  const result = hunks.map((hunk) => {
    let inKey = false;
    let continuing = openKey;
    const contents = hunk.lines.map((line) => {
      let content = line.content;
      if (continuing) {
        const end = KEY_END.exec(content);
        if (end) {
          continuing = false;
          return SECRET_PLACEHOLDER + content.slice(end.index + end[0].length);
        }
        if (isKeyRest(content)) return SECRET_PLACEHOLDER;
        continuing = false;
      }
      if (inKey) {
        const end = KEY_END.exec(content);
        if (!end) return SECRET_PLACEHOLDER;
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
      return content;
    });
    openKey = inKey || continuing;

    // Runs of key body lines that no BEGIN line announced.
    for (let start = 0; start < contents.length;) {
      let end = start;
      while (end < contents.length && isBodyLine(contents[end])) end += 1;
      if (end - start >= 2) {
        masked += 1;
        contents.fill(SECRET_PLACEHOLDER, start, end);
      }
      start = Math.max(end, start + 1);
    }

    const lines = hunk.lines.map((line, index) => ({
      ...line,
      content: maskTokens(contents[index]),
    }));
    return { ...hunk, section: maskTokens(hunk.section), lines };
  });

  return { hunks: result, masked };
}
