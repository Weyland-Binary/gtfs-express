// Flat ESLint config for the API — deliberately minimal, as the web's (the
// review of 2026-10-08: about 110 000 lines, the billing included, had no lint
// at all). The blocking rules are ESLint's recommended set, which guards real
// defects (an undefined variable, an unreachable statement, a constant
// reassigned, a duplicate key, a typeof against a typo…): the code has none
// today and CI keeps it so. What surfaces debt stays a warning (unused
// variables, needless escapes, stale disable directives); what the code does
// on purpose is allowed: a catch left empty (best-effort clean-ups), regexes
// that match control characters to strip them, non-breaking spaces in strings
// and regexes (French typography), an assignment in a parenthesised test.
const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  { ignores: ["node_modules/**", "uploads/**", "coverage/**"] },
  { linterOptions: { reportUnusedDisableDirectives: "warn" } },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "commonjs", globals: { ...globals.node } },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node } },
  },
  {
    files: ["**/__tests__/**/*.js", "**/*.test.js"],
    languageOptions: { globals: { ...globals.jest } },
  },
  {
    rules: {
      // Debt surfacing — warnings.
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-useless-escape": "warn",
      // Intentional patterns.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-control-regex": "off",
      "no-irregular-whitespace": ["error", { skipStrings: true, skipRegExps: true, skipTemplates: true, skipComments: true }],
      "no-cond-assign": ["error", "except-parens"],
    },
  },
];
