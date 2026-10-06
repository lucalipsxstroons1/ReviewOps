/**
 * An error of the AI client. The message says what to do. It never contains
 * text from the answer of the API: OpenAI repeats the first and the last
 * characters of an invalid key in its own message, and the model may repeat
 * code from the pull request.
 *
 * This file does not import the SDK. Modules that only need the error, such
 * as the parser of the review format, must not pull the SDK into the bundle
 * before `run()` needs it.
 */
export class AiError extends Error {
  name = "AiError";

  /**
   * @param {"auth" | "permission" | "model" | "quota" | "rate_limit" | "server" | "timeout" | "network" | "request" | "response" | "refusal" | "truncated" | "filtered"} kind
   *   Tells a caller whether other requests are still worth a try: after
   *   `auth`, `permission`, `model` and `quota`, they are not.
   * @param {string} message
   * @param {number | null} [status] HTTP status, if there was an answer.
   */
  constructor(kind, message, status = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}
