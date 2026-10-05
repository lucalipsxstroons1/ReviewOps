import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";

export default defineConfig([
  globalIgnores(["dist/", "coverage/"]),
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
  },
  {
    // Action code logs through @actions/core only, so the runner can mask secrets.
    files: ["src/**/*.js"],
    rules: { "no-console": "error" },
  },
]);
