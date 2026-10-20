import fs from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import i18nSplit from "./vite.i18n.js";

// Vite replaces Create React App. The codebase keeps JSX inside plain .js
// files (renaming 100+ files to .jsx would pollute git blame and the tools
// that count src/**/*.js), hence the two JSX accommodations below.
// Pinned to Vite 7 (esbuild pipeline): Vite 8's rolldown/oxc native
// transform hard-codes lang-by-extension and cannot parse JSX in .js.
// Moving to Vite 8 implies the .jsx rename — tracked in the roadmap.
export default defineConfig({
  // i18nSplit: one chunk per language (virtual:i18n/<code>), French in the app itself (vite.i18n.js).
  plugins: [react(), i18nSplit()],
  // Source transforms: parse our .js as JSX.
  esbuild: {
    loader: "jsx",
    include: /src\/.*\.js$/,
    exclude: [],
  },
  resolve: {
    // One copy of the React/Emotion runtime across all pre-bundled chunks.
    dedupe: ["react", "react-dom", "@emotion/react", "@emotion/styled"],
  },
  optimizeDeps: {
    // Pre-bundle Emotion and MUI together in the first optimization pass.
    // The app mixes barrel imports (@mui/material) with deep ones
    // (@mui/material/Tooltip), which otherwise lets the optimizer discover
    // parts of MUI in a later pass than Emotion and mismatch their interop.
    include: [
      "@emotion/react",
      "@emotion/styled",
      "@mui/material",
      "@mui/icons-material",
    ],
    esbuildOptions: {
      // JSX-in-.js applies to OUR sources only (the dependency scanner
      // walks them from index.html). A global `loader: { ".js": "jsx" }`
      // would reparse every node_modules file as JSX during pre-bundling —
      // that perturbs esbuild's CJS default-export interop for dual-format
      // packages (@emotion/styled) and produced the intermittent
      // "styled_default is not a function" blank page on cold starts.
      plugins: [
        {
          name: "jsx-in-js-src-only",
          setup(build) {
            build.onLoad({ filter: /\/src\/.*\.js$/ }, async (args) => ({
              loader: "jsx",
              contents: await fs.promises.readFile(args.path, "utf8"),
            }));
          },
        },
      ],
    },
  },
  server: {
    port: 3000,
    open: false,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
