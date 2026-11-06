// Flat ESLint config — replaces the implicit eslint-config-react-app that
// disappeared with react-scripts. Deliberately minimal: the blocking rules
// are the ones that guard real invariants (rules-of-hooks: hooks before any
// early return; undefined variables); everything stylistic stays a warning so
// `npm run lint` surfaces debt without failing the build.
import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default [
  { ignores: ["build/**", "dist/**", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["src/**/*.{js,jsx}"],
    plugins: { react, "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.es2021 },
    },
    settings: { react: { version: "detect" } },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      // autoFocus on an MUI field of a dialog that just opened is where the keyboard user expects to be.
      "jsx-a11y/no-autofocus": ["error", { ignoreNonDOM: true }],
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
