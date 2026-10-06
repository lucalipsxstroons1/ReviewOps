// Evaluates the prompt against the real API: every reference diff in
// eval/cases goes to the model three times, and the answers are judged. The
// command fails when a threshold of the issue is missed. It costs a few cents
// at most and is not part of `npm test`.
//
//   OPENAI_API_KEY=... npm run eval                       (reference model)
//   EVAL_MODEL=gpt-4o-mini OPENAI_API_KEY=... npm run eval  (another model)

import * as core from "@actions/core";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAiClient } from "../src/ai/client.js";
import { parseModel } from "../src/ai/model.js";
import { PROMPT_VERSION } from "../src/ai/prompt.js";
import {
  evalModelName,
  failureLines,
  loadCases,
  missingKeyOutcome,
  renderExamples,
  renderTable,
  runEvaluation,
  verdict,
} from "./lib.mjs";

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (apiKey === "") {
  if (missingKeyOutcome(process.env) === "skip") {
    // A pull request from a fork gets no secrets. That is no failure.
    core.notice(
      "The evaluation was skipped: OPENAI_API_KEY is not set. Pull requests from forks get no secrets.",
    );
  } else {
    core.setFailed(
      "OPENAI_API_KEY is not set. In a workflow, store the key as the repository secret OPENAI_API_KEY. On your machine, set the variable before you run `npm run eval`.",
    );
  }
} else {
  core.setSecret(apiKey);
  await evaluate(apiKey);
}

async function evaluate(apiKey) {
  let model;
  try {
    model = parseModel(evalModelName(process.env));
  } catch (error) {
    core.setFailed(error.message);
    return;
  }
  const cases = loadCases(fileURLToPath(new URL("./cases", import.meta.url)));

  const ai = createAiClient({ apiKey, model, core });
  const { rows, failures, examples } = await runEvaluation({ cases, ai });
  const result = verdict(rows);

  for (const { name, errors } of rows) {
    if (errors.length > 0) {
      core.info(
        `${name}: ${errors.length} runs failed with: ${[...new Set(errors)].join(", ")}.`,
      );
    }
  }
  for (const line of failureLines(failures)) core.info(line);

  const table = renderTable({
    model,
    promptVersion: PROMPT_VERSION,
    rows,
    result,
  });
  const text = [table, renderExamples(examples)].filter(Boolean).join("\n\n");
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  }
  if (!result.ok) process.exitCode = 1;
}
