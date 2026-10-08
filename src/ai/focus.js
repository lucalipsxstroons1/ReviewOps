import { CATEGORIES } from "./schema.js";

// Areas that every file gets, whatever its name.
export const ALWAYS_AREAS = Object.freeze(["code-quality", "security"]);

// Which focus area belongs to which file extension. The table is fixed: a
// path from the pull request author only looks up a key here, and what goes
// into the prompt is the name of an area, never a part of the path.
// An extension that is not in the table adds nothing.
const AREA_BY_EXTENSION = new Map([
  ["jsx", "react"],
  ["tsx", "react"],
  // React code often lives in plain script files.
  ["js", "react"],
  ["ts", "react"],
  ["mjs", "react"],
  ["cjs", "react"],
  ["mts", "react"],
  ["cts", "react"],
  ["vue", "vue"],
  ["cs", "efcore"],
]);

/**
 * The extension of a path: the text after the last dot of the file name, in
 * lower case. A name without a dot has none.
 *
 * @param {string} path
 * @returns {string} Empty if there is none.
 */
export function extensionOf(path) {
  const file = String(path).split(/[\\/]/).pop();
  const dot = file.lastIndexOf(".");
  return dot === -1 ? "" : file.slice(dot + 1).toLowerCase();
}

/**
 * The focus areas for the files of one request: `code-quality` and
 * `security` always, plus the area of each known extension. The result is
 * the union over all paths, in the order of `CATEGORIES`.
 *
 * @param {string[]} paths The paths of the files in the request.
 * @returns {import("./schema.js").Finding["category"][]}
 */
export function areasFor(paths) {
  const wanted = new Set(ALWAYS_AREAS);
  for (const path of paths) {
    const area = AREA_BY_EXTENSION.get(extensionOf(path));
    if (area !== undefined) wanted.add(area);
  }
  return CATEGORIES.filter((category) => wanted.has(category));
}
