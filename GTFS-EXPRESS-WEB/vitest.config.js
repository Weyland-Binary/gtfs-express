import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.js";

// Unit tests live in src/__tests__/ (NOT in src/components/ or
// src/contexts/ — scripts/refresh-facts.sh derives the component and
// context counts from those directories).
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["src/setupTests.js"],
      include: ["src/__tests__/**/*.test.js"],
      // Room for several 5 s waits (src/setupTests.js) in one test on a loaded machine.
      testTimeout: 15000,
    },
  }),
);
