import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// findBy* and waitFor give up after asyncUtilTimeout (1 s by default). A heavy
// component (the Change Studio, MUI dialogs) can take longer than that to
// render on a loaded machine — the whole suite in one run, or alongside the
// API's Jest — and a wait that would have succeeded then fails, which is not
// what any test measures. 5 s leaves room; a wait that can never succeed
// still fails, only later. The per-test budget follows (vitest.config.js).
configure({ asyncUtilTimeout: 5000 });
