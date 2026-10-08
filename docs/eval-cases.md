# Adding a reference diff

The reference diffs in `eval/cases/` are what `npm run eval` measures the
prompt with. Adding a case, for example for a new language, takes one JSON
file and one entry in a test. No number in the tests changes.

## What the set has to hold

`checkCaseSet()` in `eval/lib.mjs` checks the set as a whole, and
`test/eval-cases.test.js` runs it on every `npm test`. There is no fixed
number of cases. These rules apply:

1. At least one case with a defect for **every category** of `CATEGORIES`
   (`src/ai/schema.js`). The cases with an embedded instruction do not count
   here, or the one instruction case would cover `security` alone.
2. At least one case with an **embedded instruction**: a case whose name ends
   on `-prompt-injection`. It stays apart from the others, because it
   measures something else: that the model reports the defect despite the
   instruction in the diff.
3. At least one **clean case for every language** that has a case with a
   defect (an instruction case counts as a case with a defect here). The
   language is the text after the last dot of `path`, in lower case. Each
   extension is a language of its own: `.js`, `.jsx`, `.ts`, `.tsx` and `.vue`
   are five. A name without a dot (`Dockerfile`) stands for itself.

A failing test names the category or the extension that is missing.

## Steps

1. **Pick the name.** The file `eval/cases/<name>.json` is the case, and the
   file name without `.json` is its name. It must be unique, as must `path`
   and `description`. Start a clean case with `clean-`. End the name of an
   instruction case on `-prompt-injection`.
2. **Write the JSON file.** Format below.
3. **Find the lines of the defect.** Count in the new file, not in the patch:
   the line numbers are those of the added lines, as the annotated diff shows
   them to the model. Only added lines can be expected.
4. **Add the entry to `DEFECT_MARKERS`** in `test/eval-cases.test.js` (cases
   with a defect only): the name of the case, and one or more pieces of text
   that must stand on the expected lines. A later change to the patch that
   moves the lines away from the defect fails there. A case with a defect
   without an entry fails the test and names the case, and so does an entry
   without a case.
5. **Add the clean case of the language,** if none exists yet. It is real
   code of that language without a defect, which the model should leave
   alone. See below for what makes it a good one.
6. **Run `npm test`.** It checks the format, the lines, the markers, the set
   and the credential pattern.
7. **Measure with `npm run eval`** (`OPENAI_API_KEY` in the environment, see
   `CLAUDE.md`). A case with a defect has to be found in 3 of 3 runs, a clean
   case may raise one false alarm in 3 runs. Fix the case or the prompt
   (and raise `PROMPT_VERSION` for a change of the wording) until the
   thresholds are met, and record the result in the pull request.

## Format

```json
{
  "description": "One sentence about what the case shows.",
  "path": "src/utils/prices.js",
  "patch": "@@ -1,5 +1,14 @@\n ...",
  "expect": {
    "category": "code-quality",
    "lines": [6, 7],
    "minSeverity": "major"
  }
}
```

| Key | Meaning |
|---|---|
| `description` | Non-empty text. |
| `path` | Path of the file as the model sees it. It sets the language. |
| `patch` | The patch of one file in the format of GitHub (`@@ -a,b +c,d @@ …`). It has to be readable by `parsePatch()`. |
| `expect` | Only in a case with a defect. |
| `expect.category` | One of `CATEGORIES`. |
| `expect.lines` | Line numbers in the new file, all of them added lines of the patch. A finding counts if it names one of them. |
| `expect.minSeverity` | The lowest severity that counts. It is `major` for every case: the thresholds are set to `major`. |
| `clean` | `true` in a clean case instead of `expect`. A clean case raises a false alarm from the severity `major` upwards. |

Exactly one of `expect` and `clean` is needed, and no other key. A case with
another key, an unknown category or severity, or an expected line that is
not an added line is refused when the cases are loaded, and the message names
the file.

## What makes a good case

- One defect per case, of the kind a reviewer would flag, in a file that the
  diff shows completely enough to see the defect. A defect that only shows in
  combination with an unchanged file cannot be found by a review (see the
  measurements in #41).
- A clean case is realistic code of the same kind, not an empty diff. It
  should tempt the model to a false alarm without having a defect: code that
  looks like the defect, or code that depends on something outside the diff.
- The text of a case in the form of a credential (a token, a private key
  block) is not allowed in any file of the repository. `npm test` checks the
  pattern. If a case needs one, build it at run time from pieces, as the
  tests do.
- The patch is data of a pull request author like any other. Keep it free of
  invisible characters (`test/source-hygiene.test.js`).

## Cost

Every case is sent three times, so a new case adds three calls to each run.
Two calls run at a time (`MAX_PARALLEL_EVAL_REQUESTS`), which keeps the run
below the token limit per minute of `gpt-4.1` on the account of the project,
and the job in `.github/workflows/eval.yml` has a time limit of 15 minutes.
There is no upper limit for the number of cases. If the run gets close to
the limit of the job, that is the moment to raise it, in a separate change.
