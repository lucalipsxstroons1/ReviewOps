// Evaluates the prompt against the real API: every reference diff in
// eval/cases goes to the model three times, and the answers are judged. The
// command fails when a threshold of the issue is missed. It costs a few cents
// at most and is not part of `npm test`.
//
//   OPENAI_API_KEY=... npm run eval
//   EVAL_MODEL=gpt-4.1 OPENAI_API_KEY=... npm run eval

import * as core from "@actions/core";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAiClient } from "../src/ai/client.js";
import { parseModel } from "../src/ai/model.js";
import { PROMPT_VERSION } from "../src/ai/prompt.js";
import { loadCases, renderTable, runEvaluation, verdict } from "./lib.mjs";

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (apiKey === "") {
  // A pull request from a fork gets no secrets. That is no failure.
  core.notice(
    "The evaluation was skipped: OPENAI_API_KEY is not set. Pull requests from forks get no secrets.",
  );
} else {
  core.setSecret(apiKey);
  const model = parseModel(process.env.EVAL_MODEL);
  const cases = loadCases(fileURLToPath(new URL("./cases", import.meta.url)));

  const ai = createAiClient({ apiKey, model, core });
  const { rows, german, failures } = await runEvaluation({ cases, ai });
  const result = verdict(rows, german);

  for (const { name, errors } of rows) {
    if (errors.length > 0) {
      core.info(
        `${name}: ${errors.length} runs failed with: ${[...new Set(errors)].join(", ")}.`,
      );
    }
  }
  for (const { name, lines } of failures) {
    core.info(`${name}: a run missed its expectation. Findings:`);
    for (const line of lines) core.info(`  ${line}`);
  }

  const table = renderTable({
    model,
    promptVersion: PROMPT_VERSION,
    rows,
    german,
    result,
  });
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
  }
  if (!result.ok) process.exitCode = 1;
}
