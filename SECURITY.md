# Security

ReviewOps sends the diff of a pull request to the OpenAI API and treats everything that comes back as untrusted. This page says what leaves GitHub, which rights the action needs, what it does with the answer of the model, and how to report a vulnerability. It describes what the action does today.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. The report is visible to the maintainers only.

Only the latest version on the default branch is supported.

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

## Rights of the workflow

The workflow that runs the action grants these permissions and no others:

- `contents: read`
- `pull-requests: write`

The action reads the changed files, the reviews and the review comments of the pull request and compares commits through the GitHub API. It does not read the working tree of the runner. With `pull-requests: write` it posts one review of the type `COMMENT` per run, with its inline comments at added lines of the diff, and only when there are findings. Without that right the step fails with a message that points at `permissions`.

## Repeated runs on one pull request

Every push to a pull request starts a new run. Without a countermeasure, the same comments would appear again and again. ReviewOps avoids that in two ways, and it reads from GitHub to do so:

- **Only what is new.** The action lists the reviews and the review comments of the pull request. A review or a comment counts as its own only if its text starts with `<!-- reviewops -->` **and** GitHub shows a bot as its author. The `commit_id` of its newest review is the last commit it reviewed. The action compares that commit with the head, and a file that has no new line since then is not sent to the model again. A line is new if it is added in the comparison and in the diff of the pull request, so lines that only came with a merge of the base branch do not count.
- **Fingerprints.** The second line of every inline comment is `<!-- reviewops-fingerprint: … -->` with the first 16 hex characters of a SHA-256 hash over the path and the text of the commented line (white space reduced to one space). The text comes from the masked diff, so the hash never depends on a secret. The text of the line before it is part of the hash, so equal lines such as a closing brace get different fingerprints as long as their surroundings differ. A finding at a line with a known fingerprint is not posted again, also when the thread was resolved. Findings that stand in the text of a review (a line outside of the added lines) carry their fingerprint in the head of that review text, right below the marker. Only the lines directly below the marker are read, never the text further down, which comes from the model.

When something does not fit, the action checks more, never less: with no earlier review, after a force-push or a rebase (the comparison fails or is not a plain continuation) and when GitHub does not list every file of the comparison, the whole pull request is reviewed again. Comments with a known fingerprint are still not repeated.

What the action reads is untrusted, like the diff. Nothing from it is written to the log except numbers and a commit SHA that was checked as 40 hex characters. A comment of a person or of another bot is never used and never changed, even if it holds the marker or a fingerprint. The action only reads and posts its own new review: it does not edit, hide, resolve or delete anything.

Limits you should know:

- A review of a run that left something out (a request that failed, files over a limit, files whose diff could not be read, findings over `max-comments`) is marked with `<!-- reviewops-incomplete -->` below the marker. A later run does not start at such a review but at the last complete one, so what was missed is looked at again. A run without findings posts no review, so it leaves the starting point where it was. A new finding at code that an earlier complete run checked without a finding can not come up in a later run.
- If the workflow uses a personal access token instead of `GITHUB_TOKEN`, GitHub shows the author as a user, not as a bot. The action does not recognise its own reviews and comments then. It reviews the whole pull request on every run, and its comments repeat.
- A finding for a line that the diff does not show has no fingerprint. A run that reviews only new lines drops it; a run that reviews the whole pull request can report it again.
- The action needs `contents: read` to compare commits, which the workflow already grants.

## Events, forks and Dependabot

ReviewOps runs on the `pull_request` event only. It ends with a notice on any other event, including `pull_request_target`. That event hands secrets and a write token to workflows of pull requests from forks. A workflow that uses it and checks out the code of the pull request lets the author of the pull request run code with those rights. Do not combine them.

GitHub passes no secrets to workflows of pull requests from forks, and runs started by Dependabot get only the Dependabot secrets. In both cases the API key is empty. ReviewOps then ends **green with a notice** and sends no request. The same pull request would end in an error if the key were missing for any other reason.

**A green run does not mean that the pull request was reviewed.** If you make this check required, pull requests from forks and from Dependabot pass without a review. To review Dependabot pull requests, store the key as a Dependabot secret as well. A fork gets a review only if the owner of the repository passes secrets to workflows of forks, which is a risk of its own.

## What happens with the answer of the model

The answer is untrusted input. It comes from a model that reads text written by the author of the pull request, which can contain instructions.

- The model has to answer in a fixed format (a JSON schema). An answer that does not fit, that was cut off, that was filtered or that was refused is an error. It is never read as "no findings".
- Every text of the answer is bounded and cleaned right after it is read. A title is cut at 150 characters, a comment and a suggestion at 1500, a summary at 1000. A cut text ends with `…`. Control characters, format characters (direction overrides, zero-width characters, tag characters) and the few characters that show as blank (such as the Braille blank and the Hangul fillers) are removed. A text that is empty after that is dropped with its finding. This also removes the joiners of emoji sequences and direction marks of right-to-left text; that is a cosmetic cost of the protection.
- A finding is only used if its file is one of the files that were sent in the same request. Whether it can carry an inline comment depends on the added lines of that file, which the action calculates itself. A line number of the model is never trusted.
- Nothing from the answer is executed, evaluated or loaded: no code, no URL, no file. The action makes no network request except to the GitHub API and the OpenAI API. A test over the sources keeps it that way.
- The texts of the model reach the review only as plain text and code. Before they are posted, code blocks and inline code are written again with fences of the action, and every punctuation character outside of code is escaped; addresses, e-mail addresses, mentions and references to issues are shown as code. A review therefore contains no link, image or HTML from the model, notifies nobody and cannot forge the marker `<!-- reviewops -->` that starts every comment of the action. Every comment and every review text says that it was written by an AI model.
- The action never approves a pull request and never requests changes.

## What is not in the log

The log never contains the prompt, the answer of the model, the content of a diff, the title of the pull request or a key. It contains file names (shown in a form that cannot break a line), numbers, the address of the posted review and the fixed messages of the action. Secrets are also masked by the runner. Debug logging adds the stack of an error, still without any of those values.
