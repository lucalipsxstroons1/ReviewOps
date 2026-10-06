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

The action reads the changed files of the pull request through the GitHub API. It does not read the working tree of the runner. The step that posts the review is not part of this version, so the action posts nothing yet.

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
- The action never approves a pull request and never requests changes.

## What is not in the log

The log never contains the prompt, the answer of the model, the content of a diff, the title of the pull request or a key. It contains file names (shown in a form that cannot break a line), numbers and the fixed messages of the action. Secrets are also masked by the runner. Debug logging adds the stack of an error, still without any of those values.
