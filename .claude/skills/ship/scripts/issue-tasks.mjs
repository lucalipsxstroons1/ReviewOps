#!/usr/bin/env node
// Lists and ticks the task-list checkboxes of a GitHub issue.
//
// GitHub access goes through the gh CLI, so this script uses gh's login and never
// handles a token itself. Node does the UTF-8 round trip of the issue text; piping
// it through Windows PowerShell would mangle umlauts.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const USAGE = `Usage:
  issue-tasks.mjs list <issue>
  issue-tasks.mjs check <issue> <items>
  issue-tasks.mjs uncheck <issue> <items>

<items> are numbers from "list", ranges or "all", for example: 1 2 5-8
Pass --file <path> instead of <issue> to work on a local Markdown file.`;

// The "s" flag lets "." match a trailing "\r", so CRLF bodies keep their line endings.
const CHECKBOX = /^(\s*[-*+]\s+\[)([ xX])(\]\s.*)$/s;
const HEADING = /^#{1,6}\s+(.*?)\s*$/;

function parseItems(body) {
  const items = [];
  let section = "";
  body.split("\n").forEach((line, index) => {
    const heading = line.match(HEADING);
    if (heading) section = heading[1];
    const box = line.match(CHECKBOX);
    if (box) {
      items.push({
        number: items.length + 1,
        line: index,
        checked: box[2] !== " ",
        section,
        text: box[3].slice(1).trim(),
      });
    }
  });
  return items;
}

function selectNumbers(selectors, count) {
  const numbers = new Set();
  for (const selector of selectors) {
    if (selector === "all") {
      for (let n = 1; n <= count; n++) numbers.add(n);
      continue;
    }
    const range = selector.match(/^(\d+)(?:-(\d+))?$/);
    if (!range)
      throw new Error(`Not an item number, a range or "all": ${selector}`);
    const from = Number(range[1]);
    const to = Number(range[2] ?? range[1]);
    if (from < 1 || to > count || from > to) {
      throw new Error(
        `Out of range (this issue has items 1-${count}): ${selector}`,
      );
    }
    for (let n = from; n <= to; n++) numbers.add(n);
  }
  return numbers;
}

function setItems(body, numbers, checked) {
  const lines = body.split("\n");
  for (const item of parseItems(body)) {
    if (!numbers.has(item.number)) continue;
    lines[item.line] = lines[item.line].replace(
      CHECKBOX,
      (match, open, mark, rest) => open + (checked ? "x" : " ") + rest,
    );
  }
  return lines.join("\n");
}

function gh(args, input) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("GitHub CLI (gh) was not found on PATH.", {
        cause: error,
      });
    }
    throw new Error(String(error.stderr || error.message).trim(), {
      cause: error,
    });
  }
}

function print(title, state, items) {
  console.log(`${title} [${state}]`);
  let section = null;
  for (const item of items) {
    if (item.section !== section) {
      section = item.section;
      console.log(`\n${section || "(no heading)"}`);
    }
    console.log(
      `${String(item.number).padStart(3)} [${item.checked ? "x" : " "}] ${item.text}`,
    );
  }
  const done = items.filter((item) => item.checked).length;
  console.log(`\n${done} of ${items.length} checked`);
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!["list", "check", "uncheck"].includes(command)) return usage();

  let file = null;
  let issue = null;
  if (rest[0] === "--file") {
    file = rest[1];
    rest.splice(0, 2);
    if (!file) return usage();
  } else {
    issue = rest.shift();
    if (!/^\d+$/.test(issue ?? "")) return usage();
  }

  let title = file;
  let state = "FILE";
  let body;
  if (file) {
    body = readFileSync(file, "utf8");
  } else {
    const data = JSON.parse(
      gh(["issue", "view", issue, "--json", "title,state,body"]),
    );
    title = `#${issue} ${data.title}`;
    state = data.state;
    body = data.body ?? "";
  }

  if (command !== "list") {
    if (rest.length === 0) return usage();
    const numbers = selectNumbers(rest, parseItems(body).length);
    const updated = setItems(body, numbers, command === "check");
    if (updated !== body) {
      if (file) writeFileSync(file, updated);
      else gh(["issue", "edit", issue, "--body-file", "-"], updated);
    }
    body = updated;
  }

  print(title, state, parseItems(body));
  return 0;
}

function usage() {
  console.error(USAGE);
  return 2;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
