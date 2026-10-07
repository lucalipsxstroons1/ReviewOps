// Compares models on real pull requests: for every case in prs.json, the
// action reviews the pull request as it is on GitHub, once per run, and the
// figures and findings are written to the log. Nothing is posted to the pull
// request: GitHub is only read (see `createReadOnlyOctokit()`).
//
// The code of the action does the work. This program calls `run()` from
// src/main.js with its own stand-ins and adds nothing of its own to the way
// through the action: no filter, no mask, no limit, no selection.
//
//   OPENAI_API_KEY=... GITHUB_TOKEN=... COMPARE_MODEL=gpt-4.1 npm run compare
//
// COMPARE_RUNS sets the runs per case (1 to 5, 3 by default). COMPARE_CASES
// names another list of cases. It costs money, because it asks the model, and
// is not part of `npm test`.

import * as core from "@actions/core";
import { getOctokit } from "@actions/github";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAiClient } from "../../src/ai/client.js";
import { parseModel } from "../../src/ai/model.js";
import { PROMPT_VERSION } from "../../src/ai/prompt.js";
import { run } from "../../src/main.js";
import { loadCases, parseRuns, renderTable, runComparison } from "./lib.mjs";

const DEFAULT_CASES = fileURLToPath(new URL("./prs.json", import.meta.url));

await compare(process.env);

async function compare(env) {
  const apiKey = env.OPENAI_API_KEY ?? "";
  const token = env.GITHUB_TOKEN ?? "";
  if (apiKey === "") {
    core.setFailed(
      "OPENAI_API_KEY is not set. In a workflow, store the key as the repository secret OPENAI_API_KEY. On your machine, set the variable before you run `npm run compare`.",
    );
    return;
  }
  if (token === "") {
    core.setFailed(
      "GITHUB_TOKEN is not set. In a workflow, pass the token of the run in `env`. On your machine, set the variable to a token that can read pull requests.",
    );
    return;
  }
  // Mask both first: nothing below may write them to the log.
  core.setSecret(apiKey);
  core.setSecret(token);

  let model;
  let runs;
  let cases;
  try {
    if (!env.COMPARE_MODEL) {
      throw new Error(
        "COMPARE_MODEL is not set. Name the model that is compared.",
      );
    }
    model = parseModel(env.COMPARE_MODEL);
    runs = parseRuns(env.COMPARE_RUNS);
    cases = loadCases(env.COMPARE_CASES || DEFAULT_CASES);
  } catch (error) {
    core.setFailed(error.message);
    return;
  }

  core.info(
    `Comparing ${model} on ${cases.length} cases, ${runs} runs each (prompt version ${PROMPT_VERSION}). Nothing is posted to GitHub.`,
  );
  const rows = await runComparison({
    cases,
    runs,
    model,
    apiKey,
    token,
    deps: {
      run,
      getOctokit: (value) => getOctokit(value),
      createAiClient,
      core,
    },
  });

  const table = [
    `Prompt version: ${PROMPT_VERSION}`,
    "",
    renderTable({ model, rows }),
  ].join("\n");
  console.log(table);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${table}\n`);
  }

  // Every result is out before the step fails.
  const failed = rows.filter((row) => row.error).length;
  if (failed > 0) {
    core.setFailed(
      `${failed} of ${rows.length} runs ended with an error. The log above names them.`,
    );
  }
}
