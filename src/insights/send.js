import { createHmac } from "node:crypto";

/** Attempts to deliver one report, the first one included. */
export const MAX_ATTEMPTS = 3;

/** Time for one attempt, the answer included, in milliseconds. */
export const ATTEMPT_TIMEOUT_MS = 10_000;

/** The longest pause before another attempt, in seconds. */
export const MAX_PAUSE_SECONDS = 10;

/** The largest report that is sent: the limit of the contract. */
export const MAX_BODY_BYTES = 1024 * 1024;

// Only the start of an error answer is read: it names a code, nothing else.
const MAX_ANSWER_BYTES = 8 * 1024;

// A code from the answer reaches the log only when it looks like an identifier.
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,49}$/;

/**
 * Sends the report to ReviewOps Insights (docs/insights-payload.md). This is
 * the only place of the action that makes a request of its own: a test over
 * the sources keeps it that way.
 *
 * - `POST` with `Content-Type: application/json` and the header
 *   `X-ReviewOps-Signature: sha256=<hex>`, an HMAC-SHA256 over the bytes of
 *   the body. Every attempt sends exactly these bytes, so the `deliveryId` is
 *   the same and the receiver stores the report once.
 * - A redirect is never followed and never tried again. It would send the
 *   report, signed, to an address the workflow did not name.
 * - At most `MAX_ATTEMPTS` attempts of `timeoutMs` each. Another attempt
 *   follows after a network error, a timeout, `408`, `429` and `5xx`, after a
 *   pause (`Retry-After` in whole seconds, at most `MAX_PAUSE_SECONDS`,
 *   otherwise 1 second, then 2). Every other status ends the sending.
 *
 * Nothing is logged here. The result holds numbers and words of this module
 * only, never the address, the body, the signature or the text of an answer:
 * the error text of `fetch` names the address, and the answer of the server is
 * untrusted. A code from the answer is passed on only when it looks like an
 * identifier.
 *
 * @param {object} options
 * @param {string} options.url The address, from `parseInsightsConfig()`.
 * @param {string} options.secret The secret that signs the report.
 * @param {object} options.payload The report from `buildInsightsPayload()`.
 * @param {"review" | "status"} [options.kind] The report review answers `201`
 *   for a new one and `200` for one it knows; the status report is never
 *   stored, `200` is its normal answer and counts as `stored`.
 * @param {typeof fetch} [options.fetch] For tests.
 * @param {(ms: number) => Promise<void>} [options.sleep] For tests: the
 *   pauses between the attempts.
 * @param {number} [options.timeoutMs] For tests.
 * @returns {Promise<
 *   | { delivered: true, outcome: "created" | "duplicate" | "stored", httpStatus: number, attempts: number }
 *   | {
 *       delivered: false,
 *       reason: "http" | "redirect" | "timeout" | "network" | "too-large",
 *       httpStatus?: number,
 *       code?: string,
 *       detail?: string,
 *       attempts: number,
 *     }
 * >} `attempts` is 0 when nothing was sent.
 */
export async function sendInsightsReport({
  url,
  secret,
  payload,
  kind = "review",
  fetch = globalThis.fetch,
  sleep = defaultSleep,
  timeoutMs = ATTEMPT_TIMEOUT_MS,
}) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  if (body.length > MAX_BODY_BYTES) {
    return { delivered: false, reason: "too-large", attempts: 0 };
  }
  const headers = {
    "Content-Type": "application/json",
    "X-ReviewOps-Signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  };

  let attempts = 0;
  let last;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    last = await attemptOnce({
      fetch,
      url,
      headers,
      body,
      timeoutMs,
      final: attempts === MAX_ATTEMPTS,
      kind,
    });
    if (!last.retry) break;
    if (attempts < MAX_ATTEMPTS) {
      // 1 second before the second attempt, 2 before the third.
      await sleep((last.pauseSeconds ?? attempts) * 1000);
    }
  }
  return { ...last.result, attempts };
}

async function attemptOnce({
  fetch,
  url,
  headers,
  body,
  timeoutMs,
  final,
  kind,
}) {
  // The signal covers the whole attempt, reading the answer included.
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal,
    });
  } catch (error) {
    return { retry: true, result: failureOf(error) };
  }

  const { status } = response;
  if (status === 200 || (status === 201 && kind !== "status")) {
    await discard(response);
    return {
      retry: false,
      result: {
        delivered: true,
        outcome:
          kind === "status"
            ? "stored"
            : status === 201
              ? "created"
              : "duplicate",
        httpStatus: status,
      },
    };
  }
  if (status >= 300 && status < 400) {
    await discard(response);
    return {
      retry: false,
      result: { delivered: false, reason: "redirect", httpStatus: status },
    };
  }

  const temporary = status === 408 || status === 429 || status >= 500;
  if (temporary && !final) {
    const pauseSeconds = pauseOf(response.headers.get("retry-after"));
    await discard(response);
    return {
      retry: true,
      pauseSeconds,
      result: { delivered: false, reason: "http", httpStatus: status },
    };
  }

  const code = await readCode(response);
  return {
    retry: false,
    result: {
      delivered: false,
      reason: "http",
      httpStatus: status,
      ...(code && { code }),
    },
  };
}

/** What went wrong without an answer: a timeout, or the network. */
function failureOf(error) {
  const timeout =
    error?.name === "TimeoutError" || error?.name === "AbortError";
  const detail = [error?.cause?.code, error?.code, error?.name].find(
    (value) =>
      typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,49}$/.test(value),
  );
  return {
    delivered: false,
    reason: timeout ? "timeout" : "network",
    ...(detail && { detail }),
  };
}

/** `Retry-After` as whole seconds, at most `MAX_PAUSE_SECONDS`; else `null`. */
function pauseOf(header) {
  if (typeof header !== "string" || !/^\d+$/.test(header.trim())) return null;
  return Math.min(Number(header.trim()), MAX_PAUSE_SECONDS);
}

/** Frees the connection of an answer whose body is not needed. */
async function discard(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The answer is not needed, so a failure here changes nothing.
  }
}

/**
 * The `error.code` of an error answer, when it looks like an identifier. At
 * most 8 KiB are read, and every failure while reading means: no code.
 */
async function readCode(response) {
  try {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks = [];
    let size = 0;
    while (size < MAX_ANSWER_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    await reader.cancel().catch(() => {});
    const text = Buffer.concat(chunks).toString("utf8", 0, MAX_ANSWER_BYTES);
    const code = JSON.parse(text)?.error?.code;
    return typeof code === "string" && ERROR_CODE.test(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * How a report that was not delivered is named in the log and in the summary.
 * Fixed words and numbers, nothing from the answer except a code that looks
 * like an identifier.
 *
 * @param {{ reason: string, httpStatus?: number, code?: string }} result
 * @returns {string}
 */
export function describeFailure({ reason, httpStatus, code }) {
  switch (reason) {
    case "http":
      return code ? `HTTP ${httpStatus}, ${code}` : `HTTP ${httpStatus}`;
    case "redirect":
      return `redirect (HTTP ${httpStatus})`;
    case "timeout":
      return "timeout";
    case "too-large":
      return "report over 1 MiB";
    default:
      return "network error";
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
