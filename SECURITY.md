# Security

ReviewOps sends the diff of a pull request to the OpenAI API and treats everything that comes back as untrusted. If the workflow switches it on, it also sends a report with key figures, never code, to ReviewOps Insights. This page says what leaves GitHub, which rights the action needs, what it does with the answer of the model, and how to report a vulnerability. It describes what the action does today.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. The report is visible to the maintainers only.

Only the latest release of the current major version (v1) is supported.

## What is sent to OpenAI

Every run sends, for the files it reviews:

- the path of each file and its diff, annotated with line numbers (the changed lines and a few lines around them, not the whole file),
- a fixed system prompt and the format of the answer,
- the API key, as an `Authorization` header, to `https://api.openai.com/v1` and nowhere else. The address cannot be changed, and variables of the environment such as `OPENAI_BASE_URL` have no effect.

What is **not** sent: the title, the description and the author of the pull request, files that were deleted, binary files, files that are left out by the built-in list (lockfiles, build output, generated code) or by the input `exclude`, files over the limits `max-files` and `max-diff-chars`, and the files below.

### Files that are never sent

These file names are never sent to the model, under their new and under their old name, whatever the inputs say. The input `exclude` can only add to the list of files that are left out. It cannot remove anything from this list.

`.env*`, `*.pem`, `*.key`, `*.pfx`, `*.p12`, `*.jks`, `*.keystore`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `credentials.json`, `secrets.*`

The log names such a file and says why it was left out.

### Strings that look like secrets

Before anything is sent, strings in the diff that look like a secret are replaced with `[REDACTED SECRET]`. The action recognises GitHub tokens, OpenAI keys, AWS access key IDs, Slack tokens, Stripe live keys, Google API keys and private key blocks (also a part of one that a diff shows without its begin and end lines). The log counts the replacements and names the files, never the strings.

This is a safety net, not a guarantee. Generic patterns such as `password = "…"` are not replaced, because they would change the code that is meant to be reviewed. A secret in another format reaches the model. If a pull request contains a real secret, treat it as leaked.

### What OpenAI does with it

ReviewOps makes no statement about how OpenAI stores or uses the data. That depends on the terms of your OpenAI account and the data controls of the project of your key. Read them before you use the action on code that must not leave your organisation.

## What is sent to ReviewOps Insights

**Only if the workflow sets the input `insights-url`.** By default the action sends nothing to anyone but GitHub and OpenAI. ReviewOps Insights is a dashboard for the cost and quality of reviews across many repositories; the report is the contract in [docs/insights-payload.md](docs/insights-payload.md).

The report holds metadata and nothing else. These are all of its fields:

- the run: `schemaVersion`, `deliveryId` (a random UUID made once per run), `repository` (`owner/name`), `prNumber`, `commitSha`, `runId`, `runAttempt`, `model`, `durationMs`, `mode`, `actionVersion`, `promptVersion` and `githubReviewId`,
- the token usage as `tokens` with `input`, `output` and `total`,
- the findings the review shows as `findings`, and for each one `severity`, `category`, `path` (the name of the file), `line`, `fingerprint` (a hash of the line, never the line itself) and `placement`.

What is **never** sent: code, the diff, any text of the model (summary, title, comment, suggestion), the title, the description, the author and the branch of the pull request, names of people, the API keys and `insights-secret`.

How it is sent:

- **Where.** To the address in `insights-url`, and nowhere else. A wrong address would hand repository names, file paths and token counts to a stranger, so the address is checked before the first request: `https` only (`http` only for `localhost` and `127.0.0.1`, for tests), at most 2048 characters, no user name or password, no query and no fragment. A message about a bad address names the rule, never the address. The log names the host once. Set the address from a variable that only you can change.
- **Signed.** The body is signed with HMAC-SHA256 over its bytes. The signature is in the header `X-ReviewOps-Signature`, and the secret in `insights-secret` (at least 32 visible ASCII characters, the same value as `INGEST_SECRET` at Insights) is never sent. The runner masks it, and the action replaces it in every message.
- **When.** At the end of a run that asked the model, after the review is posted and after `fail-on` has decided about the step. A run that leaves out the review, finds nothing new, or ends with an error sends nothing.
- **Never in the way.** A report that does not arrive changes nothing about the result of the step, also with `fail-on`: the log shows a warning. There are at most three attempts of ten seconds each, with the same body and the same `deliveryId`. A redirect is never followed and never repeated, because it would send the signed report to an address the workflow did not name.
- **The answer is untrusted.** Only its status and an error code that looks like an identifier (capital letters, digits and underscores) reach the log. The body of the answer is never logged.
- **Forks and Dependabot.** GitHub passes them no repository secrets. Without `insights-secret` the review goes on, the action sends no report and says so in a notice. Anywhere else, an address without a secret is an error before the first request.

The only code that makes a request of its own is `src/insights/send.js`. A test over the sources keeps it that way.

## Rights of the workflow

The workflow that runs the action grants these permissions and no others:

- `contents: read`
- `pull-requests: write`

The action reads the changed files, the reviews and the review comments of the pull request and compares commits through the GitHub API. When an earlier finding is still open, it also asks the GraphQL API which review threads are resolved; REST does not say that. It does not read the working tree of the runner. With `pull-requests: write` it posts one review of the type `COMMENT` per run, with its inline comments at added lines of the diff, and only when there are findings. Without that right the step fails with a message that points at `permissions`.

## Repeated runs on one pull request

Every push to a pull request starts a new run. Without a countermeasure, the same comments would appear again and again. ReviewOps avoids that in two ways, and it reads from GitHub to do so:

- **Only what is new.** The action lists the reviews and the review comments of the pull request. A review or a comment counts as its own only if its text starts with `<!-- reviewops -->` **and** GitHub shows a bot as its author. The `commit_id` of its newest review is the last commit it reviewed. The action compares that commit with the head, and a file that has no new line since then is not sent to the model again. A line is new if it is added in the comparison and in the diff of the pull request, so lines that only came with a merge of the base branch do not count.
- **Fingerprints.** The second line of every inline comment is `<!-- reviewops-fingerprint: … -->` with the first 16 hex characters of a SHA-256 hash over the path and the text of the commented line (white space reduced to one space). The text comes from the masked diff, so the hash never depends on a secret. The text of the line before it is part of the hash, so equal lines such as a closing brace get different fingerprints as long as their surroundings differ. An inline comment adds the severity of its finding to that line (`severity: critical`), so a later run can count the open findings without reading the text of the model. A finding at a line with a known fingerprint is not posted again, also when the thread was resolved. Findings that stand in the text of a review (a line outside of the added lines) carry their fingerprint in the head of that review text, right below the marker. Only the lines directly below the marker are read, never the text further down, which comes from the model.

When something does not fit, the action checks more, never less: with no earlier review, after a force-push or a rebase (the comparison fails or is not a plain continuation) and when GitHub does not list every file of the comparison, the whole pull request is reviewed again. Comments with a known fingerprint are still not repeated.

What the action reads is untrusted, like the diff. Nothing from it is written to the log except numbers and a commit SHA that was checked as 40 hex characters. A comment of a person or of another bot is never used and never changed, even if it holds the marker or a fingerprint. The action only reads and posts its own new review: it does not edit, hide, resolve or delete anything.

Limits you should know:

- A review of a run that left something out (a request that failed, findings over `max-comments`) is marked with `<!-- reviewops-incomplete -->` below the marker. A later run does not start at such a review but at the last complete one, so what was missed is looked at again. Files over a limit or with an unreadable diff do not make a review incomplete: a run over the whole pull request would leave them out again. A run without findings posts no review, so it leaves the starting point where it was. A new finding at code that an earlier complete run checked without a finding can not come up in a later run.
- If the workflow uses a personal access token instead of `GITHUB_TOKEN`, GitHub shows the author as a user, not as a bot. The action does not recognise its own reviews and comments then. It reviews the whole pull request on every run, and its comments repeat.
- A finding for a line that the diff does not show has no fingerprint. A run that reviews only new lines drops it; a run that reviews the whole pull request can report it again.
- The action needs `contents: read` to compare commits, which the workflow already grants.

## Job summary, outputs and fail-on

Every run writes a job summary on the page of the workflow run. It shows how the run ended, the reviewed and the skipped files, the open findings by severity, the tokens of the requests and a link to the review. It holds no text of the model: no summary, no title, no comment. File names come from the pull request and stand as code; reasons and messages are escaped like the texts of a review, so the summary shows no link except the one to the review and no HTML. A failed run names its error, after the same redaction as the log. If the summary cannot be written, the step ends with a warning, not with an error.

The step sets three outputs: `findings-count`, `critical-count` and `review-url`. They are numbers and the address of the review, built from checked values. A run that fails with an error sets none of them.

**Open findings** are the findings of this run and the earlier inline comments of ReviewOps whose line is still an added line of the pull request, unchanged (same fingerprint). The counts are taken before `max-comments` cuts the review, so the limit for the review never hides a finding from them. With `fail-on: critical` or `fail-on: major`, the step fails when open findings reach that severity, and only after the review is posted. A run that has nothing new, such as a second run on the same commit, counts the earlier findings as well and stays red. The default is `none`: no finding fails the workflow.

- If GitHub does not answer the query for the resolved threads, a run without `fail-on` goes on with a warning and counts every earlier finding as open. With `fail-on` the count decides about the step, so the run fails before any request to the model.
- A person who resolves the thread of an earlier comment takes its finding out of the count. Everyone who may resolve threads can do that, including the author of the pull request. The resolved thread stays visible in the pull request. The finding is still not posted again.
- Findings in the text of a review (a line outside of the added lines, or all findings after GitHub rejected the inline comments) have no thread and are counted only in the run that found them.
- Comments from before the severity was written, and comments posted with a personal access token, are not counted later.

## Events, forks and Dependabot

ReviewOps runs on the `pull_request` event only. It ends with a notice on any other event, including `pull_request_target`. That event hands secrets and a write token to workflows of pull requests from forks. A workflow that uses it and checks out the code of the pull request lets the author of the pull request run code with those rights. Do not combine them.

GitHub passes no secrets to workflows of pull requests from forks, and runs started by Dependabot get only the Dependabot secrets. In both cases the API key is empty. ReviewOps then ends **green with a notice** and sends no request. The same pull request would end in an error if the key were missing for any other reason.

**A green run does not mean that the pull request was reviewed.** If you make this check required, pull requests from forks and from Dependabot pass without a review. To review Dependabot pull requests, set the input `review-bots` to `true` (pull requests of bots are left out by default) and store the key as a Dependabot secret as well. A fork gets a review only if the owner of the repository passes secrets to workflows of forks, which is a risk of its own.

### Pull requests that are left out on purpose

Three inputs choose which pull requests are reviewed: `review-drafts` (drafts are left out by default), `skip-label` (default `no-ai-review`) and `review-bots` (bots are left out by default). Whether a run leaves out the review is decided from the event alone: the draft flag, the type of the author (`Bot`), the names of the labels and, for the event `unlabeled`, the label that was removed. These values come from the author of the pull request or from whoever set a label. They are compared, never written to the log, and limited in number and length. The log names only the reason and the name of the skip label from the input.

A run that leaves out the review sends nothing to OpenAI, posts nothing and needs no OpenAI key. It does read the files and the earlier reviews, counts the open findings, sets the outputs and applies `fail-on`, as a run with nothing new does. So a label is **no bypass** for `fail-on` used as a required check: a label can be set by anyone with the role Triage, who cannot write to the repository, and the check stays red while an open finding reaches the threshold. Only a resolved thread or changed code takes a finding out of the count.

The example workflow does not cancel a running review when a label changes, so a change of labels cannot stop a review that is under way.

## What happens with the answer of the model

The answer is untrusted input. It comes from a model that reads text written by the author of the pull request, which can contain instructions.

- The model has to answer in a fixed format (a JSON schema). An answer that does not fit, that was cut off, that was filtered or that was refused is an error. It is never read as "no findings".
- Every text of the answer is bounded and cleaned right after it is read. A title is cut at 150 characters, a comment and a suggestion at 1500, a summary at 1000. A cut text ends with `…`. Control characters, format characters (direction overrides, zero-width characters, tag characters) and the few characters that show as blank (such as the Braille blank and the Hangul fillers) are removed. A text that is empty after that is dropped with its finding. This also removes the joiners of emoji sequences and direction marks of right-to-left text; that is a cosmetic cost of the protection.
- A finding is only used if its file is one of the files that were sent in the same request. Whether it can carry an inline comment depends on the added lines of that file, which the action calculates itself. A line number of the model is never trusted.
- Nothing from the answer is executed, evaluated or loaded: no code, no URL, no file. The action makes no network request except to the GitHub API, the OpenAI API and, only if the workflow sets `insights-url`, the address of ReviewOps Insights (see above). A test over the sources keeps it that way.
- The texts of the model reach the review only as plain text and code. Before they are posted, code blocks and inline code are written again with fences of the action, and every punctuation character outside of code is escaped; addresses, e-mail addresses, mentions and references to issues are shown as code. A review therefore contains no link, image or HTML from the model, notifies nobody and cannot forge the marker `<!-- reviewops -->` that starts every comment of the action. Every comment and every review text says that it was written by an AI model.
- The action never approves a pull request and never requests changes.

## What is not in the log

The log and the job summary never contain the prompt, the answer of the model, the content of a diff, the title of the pull request or a key. Nor do they contain the report for ReviewOps Insights, its signature, `insights-secret` or the answer of the Insights server. The log names the host of `insights-url`, never the whole address. It contains file names (shown in a form that cannot break a line), numbers, the address of the posted review and the fixed messages of the action. Secrets are also masked by the runner. Debug logging adds the stack of an error, still without any of those values.
