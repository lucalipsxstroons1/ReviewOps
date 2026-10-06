// Throwaway diagnosis, only on a test branch: how large is the annotated diff
// of each file of pull request 37 when it is computed on the runner?
// The token goes to api.github.com only and is never printed.
import { annotateDiff } from "../src/diff/annotate.js";
import { parsePatch } from "../src/diff/parse.js";

const { GH_TOKEN, GITHUB_REPOSITORY } = process.env;
const response = await fetch(
  `https://api.github.com/repos/${GITHUB_REPOSITORY}/pulls/37/files?per_page=100`,
  {
    headers: {
      authorization: `Bearer ${GH_TOKEN}`,
      accept: "application/vnd.github.v3+json",
      "user-agent": "reviewops-diagnosis",
    },
  },
);
const entries = await response.json();
console.log(`node ${process.version}, platform ${process.platform}, status ${response.status}`);

let total = 0;
for (const entry of entries) {
  if (entry.filename.startsWith("dist/")) continue;
  const parsed = parsePatch(entry.patch);
  const size = annotateDiff(parsed.hunks).length;
  total += size;
  const nonAscii = [...entry.patch].filter((c) => c.codePointAt(0) > 0x7f).length;
  console.log(
    `SIZE ${String(size).padStart(6)} patch ${String(entry.patch.length).padStart(6)} nonascii ${String(nonAscii).padStart(2)} ${entry.filename}`,
  );
}
console.log(`SIZE total ${total}`);
