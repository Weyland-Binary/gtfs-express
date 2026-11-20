import fs from "node:fs";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import i18nSplit from "./vite.i18n.js";
import seo, { seoRulePages } from "./vite.seo.js";

// MUI and Emotion change at their own pace: a chunk of their own stays cached across releases of the app.
const vendorChunk = (id) => {
  if (/[\\/]node_modules[\\/]@(mui|emotion)[\\/]/.test(id)) return "mui";
  return undefined;
};

// The dev server's optimizer wraps MUI in lazy initialisers once a CommonJS module requires it, and a chunk can then
// run before its initialiser: "styled_default is not a function", a blank page. The icons' deep imports are the
// CommonJS ones; their esm/ twins are read instead. The build bundles through Rollup and Vitest loads the
// packages through Node: neither has the fault, both keep the package's own entry.
const iconsAsModulesInDev = () => ({
  name: "mui-icons-as-modules-in-dev",
  apply: (_config, env) => env.command === "serve" && !process.env.VITEST,
  config: () => ({
    resolve: { alias: [{ find: /^@mui\/icons-material\/(?!esm\/)([A-Za-z0-9]+)$/, replacement: "@mui/icons-material/esm/$1" }] },
  }),
});

// print.html: the page the API's browser makes a sheet's PDF on. Part of the hosted edition only: the community build
// has no such page.
const PRINT_PAGE = fileURLToPath(new URL("./print.html", import.meta.url));
const pages = !process.env.VITEST && fs.existsSync(PRINT_PAGE) ? { main: fileURLToPath(new URL("./index.html", import.meta.url)), print: PRINT_PAGE } : undefined;

export default defineConfig({
  plugins: [react(), i18nSplit(), seoRulePages(), seo(), iconsAsModulesInDev()],
  resolve: {
    dedupe: ["react", "react-dom", "@emotion/react", "@emotion/styled"],
  },
  optimizeDeps: {
    // Barrel and deep MUI imports otherwise let the optimizer find parts of
    // MUI in a later pass than Emotion and mismatch their interop.
    include: [
      "@emotion/react",
      "@emotion/styled",
      "@mui/material",
      "@mui/icons-material",
    ],
  },
  server: {
    port: 3000,
    open: false,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      ...(pages ? { input: pages } : {}),
      output: { manualChunks: vendorChunk },
    },
  },
});
