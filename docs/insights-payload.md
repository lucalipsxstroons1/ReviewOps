# Insights report

ReviewOps Insights is a dashboard for the cost and quality of reviews across
many repositories (`lucalipsxstroons1/ReviewOps-Insights`). At the end of a
run, ReviewOps can build a report with key figures for it: token usage,
duration and the findings the review shows, with severity and category. This
file is the contract, version 1. Both sides follow it, and this repository is
its source, because it defines what leaves the runner.

`buildInsightsPayload()` in `src/insights/payload.js` builds the report, and
`sendInsightsReport()` in `src/insights/send.js` sends it (#76). The action sends
it only if the workflow sets the input `insights-url`; without it, nothing is
sent.

## Transport

- `POST` to the address from the input `insights-url`. At Insights this is
  `https://<host>/api/v1/ingest/review`.
- Body: JSON in UTF-8, at most 1 MiB, `Content-Type: application/json`.
- Header `X-ReviewOps-Signature: sha256=<hex>`: HMAC-SHA256 over the bytes of
  the body with the shared secret, 64 lower case hex characters. The secret is
  called `insights-secret` in the action and `INGEST_SECRET` at Insights. It has
  at least 32 characters, all of them visible ASCII, on both sides.
- `https` only. The action accepts `http` only for the host names `localhost`
  and `127.0.0.1`, for tests. The address has no user name or password, no
  query and no fragment.
- Redirects are not followed and not repeated: the status is the answer.
- At most three attempts of ten seconds each, every one with the same body and
  so the same `deliveryId`.

## Fields

All fields are required. Integers are safe integers (at most 2^53 − 1). The
receiver ignores unknown fields. A test keeps this table equal to the fields of
a built report.

| Field | Type | Rule | Meaning |
|---|---|---|---|
| `schemaVersion` | integer | `1` | Version of this contract |
| `deliveryId` | string | UUID version 4, lower case | Made once per run, the same for every attempt to send. The receiver stores each `deliveryId` at most once |
| `repository` | string | `owner/name`, each part `[A-Za-z0-9_.-]+`, at most 140 characters | Repository of the pull request |
| `prNumber` | integer | from 1 | Number of the pull request |
| `commitSha` | string | 40 lower case hex characters | Head commit that was reviewed |
| `runId` | integer | from 1 | `GITHUB_RUN_ID` of the workflow run |
| `runAttempt` | integer | from 1 | `GITHUB_RUN_ATTEMPT`, grows with every re-run |
| `model` | string | `[A-Za-z0-9._:-]{1,100}` | Model name from the input `openai-model` |
| `tokens` | object | | Token usage of the run |
| `tokens.input` | integer | from 0 | Input tokens, summed over the answered requests of the run |
| `tokens.output` | integer | from 0 | Output tokens, likewise |
| `tokens.total` | integer | from 0 | Total as OpenAI reports it |
| `durationMs` | integer | from 0 | Time of the action from its start to the finished report, without sending |
| `mode` | string | `full` or `incremental` | The whole pull request, or only the changes since the last review |
| `actionVersion` | string | `[0-9A-Za-z.+-]{1,40}` | Version of the action |
| `promptVersion` | integer | from 1 | `PROMPT_VERSION` of the system prompt |
| `githubReviewId` | integer or `null` | from 1 | ID of the review that was posted at GitHub; `null` if no review was posted |
| `findings` | array of objects | 0 to 500 entries | The findings the review of this run shows |
| `findings[].severity` | string | `critical`, `major`, `minor` or `info` | Severity |
| `findings[].category` | string | `[a-z][a-z0-9-]{0,39}`; today `code-quality`, `react`, `vue`, `efcore`, `security` | Focus area |
| `findings[].path` | string | 1 to 1024 characters | Path of the file, as GitHub names it |
| `findings[].line` | integer or `null` | from 1 | Line in the new file; `null` if the diff does not show the line |
| `findings[].fingerprint` | string or `null` | 16 lower case hex characters | Fingerprint of the line from `lineFingerprint()`; `null` exactly when `line` is `null` |
| `findings[].placement` | string | `inline` or `body` | Inline comment at the line, or entry in the text of the review |

The length of a path is counted in UTF-16 code units (`String.length`). That is
never less than the number of Unicode code points, so a path that fits here also
fits the limit of 1024 code points. A receiver may count in code points: that is
never stricter, so every path of the action passes.

## Meaning

- There is one report per run of the action that asked the model and ended
  regularly: with a posted review, or without new findings. Skipped runs (other
  event, fork or Dependabot without a key, no files to review, nothing new since
  the last review) and runs that end with an error send nothing.
- `findings` are the findings the review of this run shows, after all checks and
  after `max-comments`. Every finding is reported once, in the run that shows
  it: a line with a known fingerprint is not commented again and not reported
  again.
- A finding with a path over 1024 characters is left out, and so is everything
  after the first 500 findings. The numbers are not part of the report.
- Two findings at the same line carry the same fingerprint. Inside one report it
  is not unique.
- `tokens` count only requests that were answered with a token count. After
  failed requests the numbers are a lower bound.
- If GitHub rejected the inline comments (HTTP 422) and all findings are in the
  text of the review, `placement` is `body` everywhere. Line and fingerprint
  stay. Such findings are in no status report either (see "Status report (v1)",
  "Meaning").

## What is never sent

Code and diff, texts of the model (summary, title, comment, suggestion), title,
description, author and branch of the pull request, names of people, credentials.

## Answers of the receiver

| Status | Meaning | Reaction of the action |
|---|---|---|
| `201` | Stored, body `{ "id": "…" }` | Done |
| `200` | `deliveryId` already known, body `{ "id": "…", "duplicate": true }` | Done |
| `400` | The report does not fit the contract. Body `{ "error": { "code", "message", "details" } }` with the code `VALIDATION_ERROR` or `UNSUPPORTED_SCHEMA_VERSION` | No retry, warning |
| `401` | Signature missing or wrong | No retry, warning that names `insights-secret` |
| `413` | Body too large | No retry, warning |
| `415` | `Content-Type` is not `application/json` | No retry, warning |
| `408`, `429` | Request timeout, too many requests, `Retry-After` in seconds | Retry after the pause: `Retry-After` as whole seconds, at most 10, otherwise 1 second, then 2 |
| `5xx`, network error, timeout | Temporary | Retry after the pause |
| `3xx` | Redirect | Not followed, no retry, warning with the status |
| any other status | Not part of this contract | No retry, warning |

After the third attempt a report that did not arrive ends in a warning, and the
run ends as it would have ended without Insights. A report over 1 MiB is not
sent at all.

A report that did not arrive is never made up for. It is made once, in the run
that asked the model. A later run, and a re-run of the same job, find the head
already reviewed or the fingerprints already known, and report nothing for them.
The same holds if the run ends after the review was posted and before the report
was sent: `cancel-in-progress` after a new push (with the `closed` trigger of the
example workflow also a closed pull request), or the time limit of the job. The
findings of that run are missing at the receiver for good. Later status reports
still name their fingerprints; the receiver does not know them and counts them as
`unknown` in its answer, which the action does not read. What `unknown` means is
described in `docs/payload.md` of ReviewOps Insights.

The status report below is different: each one names the state of every finding
it contains, so the next one replaces a lost one for those findings. It does not
contain findings over the limit of 1000 (the oldest 1000 are reported) and
findings whose state cannot be determined; see "Status report (v1)", "Meaning".
Only the final state when the pull request closes has no successor; a re-run of
that job (higher `runAttempt`) sends it again.

## Versioning

- New fields and new categories come without a new version: the receiver
  ignores fields it does not know and stores categories as they come.
- Removing or renaming a field, changing a type or a meaning, or adding a
  severity raises `schemaVersion`. The receiver accepts every version it knows.

## Example

The same file is `test/fixtures/insights-review-v1.json`; a test builds this
report from a prepared run. ReviewOps Insights compares its copy of the example
with the fixture on `main` of this repository. `promptVersion` is left out of
that comparison, because it follows `PROMPT_VERSION` and changes with every
prompt; every other change to the fixture needs the copy there updated.

```json
{
  "schemaVersion": 1,
  "deliveryId": "3f2b8c1e-5d47-4a9b-8e21-7c6f0d9a4b12",
  "repository": "octo-org/shop-api",
  "prNumber": 42,
  "commitSha": "9f3c1a7b2d4e6f8091a2b3c4d5e6f708192a3b4c",
  "runId": 18234567890,
  "runAttempt": 1,
  "model": "gpt-4o-mini",
  "tokens": { "input": 18250, "output": 1140, "total": 19390 },
  "durationMs": 48211,
  "mode": "full",
  "actionVersion": "0.1.0",
  "promptVersion": 11,
  "githubReviewId": 2817345012,
  "findings": [
    {
      "severity": "critical",
      "category": "security",
      "path": "src/Orders/OrderRepository.cs",
      "line": 42,
      "fingerprint": "5a1f0c9e3b7d2a46",
      "placement": "inline"
    },
    {
      "severity": "major",
      "category": "efcore",
      "path": "src/Orders/OrderService.cs",
      "line": 118,
      "fingerprint": "c04e7a91d2b85f36",
      "placement": "inline"
    },
    {
      "severity": "minor",
      "category": "code-quality",
      "path": "src/Orders/OrderMapper.cs",
      "line": null,
      "fingerprint": null,
      "placement": "body"
    }
  ]
}
```

## Status report (v1)

The report above says what a run found. The status report says what became of
the findings of earlier runs, so that Insights can show whether they were
acted on. The action reports facts; Insights derives the state of a finding
(`open`, `addressed`, `dismissed`, `ignored`, `false_positive`, `abandoned`)
from them. Insights has no access to the code and cannot tell whether a
commented line was changed.

`buildStatusPayload()` in `src/insights/status.js` builds the report and
`sendInsightsReport()` sends it (#77). It goes to the same Insights instance as
the report above, if the workflow sets `insights-url`; without it, nothing is
sent and the action makes no additional request to GitHub.

### Transport

- `POST` to the address derived from `insights-url`: a path that ends on
  `/review` becomes `/status`, so `…/api/v1/ingest/review` becomes
  `…/api/v1/ingest/status`. For any other path the action sends no status
  report and says so in a notice. There is no extra input.
- Body, header, signature, `https` rule, redirects and attempts are those of
  the report above. The status report has no `deliveryId`. Insights answers
  `200` with the counters `matched`, `unknown` and `changed`; the action does
  not read them. `200` is the normal answer, not a duplicate.

### Fields

All fields are required. Integers are safe integers. Insights removes unknown
fields. A test keeps this table equal to the fields of a built report.

| Field | Type | Rule | Meaning |
|---|---|---|---|
| `schemaVersion` | integer | `1` | Version of this contract |
| `repository` | string | `owner/name`, at most 140 characters | Repository of the pull request |
| `prNumber` | integer | from 1 | Number of the pull request |
| `runId` | integer | from 1 | `GITHUB_RUN_ID` of the workflow run |
| `runAttempt` | integer | from 1 | `GITHUB_RUN_ATTEMPT`. Insights applies the report with the larger `(runId, runAttempt)` |
| `pullRequestState` | string | `open`, `merged` or `closed` | State of the pull request at the run; `closed` means closed without a merge |
| `findings` | array of objects | 1 to 1000 entries | One entry per fingerprint |
| `findings[].fingerprint` | string | 16 lower case hex characters, at most once per report | Fingerprint of the line, as in the second line of the inline comment |
| `findings[].lineUnchanged` | boolean | | The fingerprint is still among the added lines of the pull request |
| `findings[].threadResolved` | boolean or `null` | | `true` if every thread with this fingerprint is resolved. The action never sends `null`: findings in the text of a review have no thread and are not reported |
| `findings[].thumbsDown` | boolean | | At least one comment with this fingerprint carries a 👎 |

### Meaning

- A finding is an inline comment of this action with a fingerprint, from any
  earlier run, including old and resolved ones. Several comments with one
  fingerprint make one entry.
- **Findings in the text of a review are never reported.** The builder reads
  inline comments only. That covers a finding without a line, a finding at a
  line that the diff shows only as context (it has a fingerprint, but no
  comment), and every finding of a review after the fallback for HTTP 422.
  Insights keeps such a finding as `open` and counts it as `untracked` in the
  acceptance rate, with or without a fingerprint; it never counts toward
  `states.open` or the rate. See "Grenzen" in `docs/payload.md` and ADR 0001
  (`docs/adr/0001-feedback-loop.md`) of ReviewOps Insights.
- **A finding whose state cannot be determined is another case.** It is an
  inline comment that the action leaves out of this report (see below). Insights
  shows it as `open` and counts it under `states.open`, until a later run or the
  closing of the pull request reports it.
- `lineUnchanged` uses the same calculation as the count of open findings: the
  fingerprint of the commented line is looked up among the fingerprints of all
  added lines of the pull request.
- A finding whose state cannot be determined safely is left out instead of
  being reported with a wrong value: its file is part of the pull request but
  its diff is not available (no text diff, unreadable, excluded, possible
  secrets, or the list of files was cut off at 3000), or the thread of its
  comment was not read. The log names the number of findings left out. More
  than 1000 findings: the oldest 1000 are reported.
- The report is sent at every regular end of a run that has at least one
  finding to report: after posting a review, without findings, with nothing
  new to review, and when the review is skipped. A run that fails sends none.
  It goes after the outputs and after the report above.
- A run on a pull request that is **merged or closed** asks no model, posts
  nothing, needs no OpenAI key and sets no outputs besides `0`, `0` and empty.
  It reads the files, the earlier comments and the threads, and sends the final
  state. For this the workflow must run on `closed` (see the README). A failure
  to read is a warning there, and the run stays green.
- Forks and Dependabot get no repository secrets: without `insights-secret`,
  nothing is sent and a notice says so.

### What never leaves the runner

Who resolved a thread or set a 👎, the number of reactions, other reactions,
texts of comments, code, the diff and names of people. The thread query reads
the reaction groups of the first comment of each thread and returns two truth
values per comment, nothing else. Anyone who may react on the pull request can
set a 👎; in a public repository that is every GitHub user, so Insights should
treat it as a signal and not as proof.

### Example

The same file is `test/fixtures/insights-status-v1.json`, and it is the example
file of the contract at Insights (`docs/examples/status-v1.json`). Insights
compares its copy with the fixture on `main` of this repository; every change to
the fixture needs the copy there updated.

```json
{
  "schemaVersion": 1,
  "repository": "octo-org/shop-api",
  "prNumber": 42,
  "runId": 18234599012,
  "runAttempt": 1,
  "pullRequestState": "merged",
  "findings": [
    {
      "fingerprint": "5a1f0c9e3b7d2a46",
      "lineUnchanged": false,
      "threadResolved": true,
      "thumbsDown": false
    },
    {
      "fingerprint": "c04e7a91d2b85f36",
      "lineUnchanged": true,
      "threadResolved": false,
      "thumbsDown": false
    },
    {
      "fingerprint": "7e22b1d09a4c5f83",
      "lineUnchanged": true,
      "threadResolved": null,
      "thumbsDown": true
    }
  ]
}
```
