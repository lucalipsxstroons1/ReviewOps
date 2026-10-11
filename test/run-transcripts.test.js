import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { run } from "../src/main.js";
import { SCENARIOS } from "./helpers/run-scenarios.js";
import { recordRun } from "./helpers/transcript.js";
import { fromRoot } from "./helpers/run-action.js";

// One transcript for each way a run ends and for each place where it can fail
// (#114). A transcript holds everything the run does to the outside, in order:
// the lines of the log, the requests to GitHub, to the model and to Insights,
// the outputs and the job summary (see `test/helpers/transcript.js`). The
// runs are in `test/helpers/run-scenarios.js`. The files in
// `test/fixtures/transcripts/` were written against the code before `run()`
// was taken apart and must stay as they are: they are the proof that the
// rebuild changed nothing.
//
// If a log line or the order of the steps is changed on purpose, write the
// files again with `UPDATE_TRANSCRIPTS=1 npm test` and read the difference
// before it is committed. The CI never sets the variable.

const DIRECTORY = fromRoot("test/fixtures/transcripts");
const UPDATE = process.env.UPDATE_TRANSCRIPTS === "1";

// --- The comparison with the files -----------------------------------------------

for (const [name, scenario] of Object.entries(SCENARIOS)) {
  test(`the transcript of ${name} is the one on file`, async () => {
    const { transcript } = await recordRun(run, scenario());
    const file = join(DIRECTORY, `${name}.txt`);

    if (UPDATE) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, transcript);
      return;
    }
    // Git may change the line ends of a text file on Windows.
    const expected = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    assert.equal(transcript, expected);
  });
}

test("every run is deterministic: the same run twice gives the same transcript", async () => {
  for (const name of [
    "end-posted-with-both-reports",
    "error-one-of-two-requests-failed",
  ]) {
    const first = await recordRun(run, SCENARIOS[name]());
    const second = await recordRun(run, SCENARIOS[name]());
    assert.equal(first.transcript, second.transcript, name);
  }
});

test("a transcript holds no credential of the stand-ins", async () => {
  for (const scenario of Object.values(SCENARIOS)) {
    const { transcript } = await recordRun(run, scenario());
    assert.doesNotMatch(transcript, /token-value|key-value|ssssssssss/);
  }
});
