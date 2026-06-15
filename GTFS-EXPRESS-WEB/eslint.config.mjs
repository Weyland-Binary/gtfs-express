// Flat ESLint config — replaces the implicit eslint-config-react-app that
// disappeared with react-scripts. Deliberately minimal: the blocking rules
// are the ones that guard real invariants (rules-of-hooks per CLAUDE.md
// rule #18, undefined variables); everything stylistic stays a warning so
// `npm run lint` surfaces debt without failing the build.
import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["build/**", "dist/**", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    plugins: { react, "react-hooks": reactHooks },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.es2021 },
    },
    settings: { react: { version: "detect" } },
    rules: {
      // Real invariants — errors.
      "react-hooks/rules-of-hooks": "error",
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "off",
      // Debt surfacing — warnings.
      "react-hooks/exhaustive-deps": "warn",
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^React$" },
      ],
      // Intentional pattern: best-effort sessionStorage/localStorage writes
      // swallow quota errors.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
