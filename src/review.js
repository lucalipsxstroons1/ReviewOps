import { AiError, isFatal } from "./ai/error.js";
import { MAX_OUTPUT_TOKENS, REVIEW_FORMAT, parseReview } from "./ai/schema.js";

// Requests on their way at the same time. One request can take up to three
// attempts of 120 seconds, so a pull request of eight requests needs two
// rounds of about six minutes in the worst case. The job limit in
// reviewops.yml is set for that.
export const MAX_PARALLEL_REQUESTS = 4;

/**
 * Sends every batch to the model and merges the answers.
 *
 * A batch that fails does not take the others with it: their findings are
 * kept, and the failed batch is returned with its error. After an error that
 * every request would hit (`auth`, `permission`, `model`, `quota`), no new
 * request is started, and the batches that were not sent fail with it.
 *
 * Nothing in here writes to the log: the answers hold code from the pull
 * request. The findings are not checked against the diff yet.
 *
 * @param {object} options
 * @param {{ complete: ReturnType<typeof import("./ai/client.js").createAiClient>["complete"] }} options.client
 * @param {string} options.system The system prompt.
 * @param {{ files: { path: string }[], user: string }[]} options.batches
 *   The requests, as `planBatches()` returns them.
 * @param {number} [options.concurrency] Requests at the same time.
 * @returns {Promise<{
 *   summaries: string[],
 *   findings: import("./ai/schema.js").Finding[],
 *   succeeded: number,
 *   failed: { paths: string[], error: AiError }[],
 * }>} Summaries and findings in the order of the batches.
 * @throws Anything that is not an `AiError`: that is a defect, not an
 *   answer of the API.
 */
export async function reviewInBatches({
  client,
  system,
  batches,
  concurrency = MAX_PARALLEL_REQUESTS,
}) {
  const results = new Array(batches.length);
  let next = 0;
  let fatal = null;
  let defect = null;

  async function worker() {
    while (next < batches.length && defect === null) {
      const index = next;
      next += 1;
      if (fatal) {
        results[index] = { error: fatal };
        continue;
      }
      try {
        const answer = await client.complete({
          system,
          user: batches[index].user,
          responseFormat: REVIEW_FORMAT,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        });
        results[index] = { review: parseReview(answer) };
      } catch (error) {
        if (!(error instanceof AiError)) {
          defect ??= { error };
          return;
        }
        if (isFatal(error)) fatal ??= error;
        results[index] = { error };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), batches.length) },
      worker,
    ),
  );
  if (defect) throw defect.error;

  const merged = { summaries: [], findings: [], succeeded: 0, failed: [] };
  batches.forEach((batch, index) => {
    const result = results[index];
    if (result.review) {
      merged.succeeded += 1;
      merged.summaries.push(result.review.summary);
      merged.findings.push(...result.review.findings);
    } else {
      merged.failed.push({
        paths: batch.files.map((file) => file.path),
        error: result.error,
      });
    }
  });
  return merged;
}
