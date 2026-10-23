import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";
import { preloadLanguage } from "./contexts/LanguageContext";

// Heavy components can take more than the default 1 s to render on a loaded machine; the per-test budget in
// vitest.config.js follows this value.
configure({ asyncUtilTimeout: 5000 });

// The app preloads its first language before the first render (src/index.jsx); the tests open in French.
await preloadLanguage("fr");
