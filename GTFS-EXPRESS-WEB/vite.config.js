import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import i18nSplit from "./vite.i18n.js";
import seo, { seoRulePages } from "./vite.seo.js";

// MUI and Emotion change at their own pace: a chunk of their own stays cached across releases of the app.
const vendorChunk = (id) => {
  if (/[\\/]node_modules[\\/]@(mui|emotion)[\\/]/.test(id)) return "mui";
  return undefined;
};

export default defineConfig({
  plugins: [react(), i18nSplit(), seoRulePages(), seo()],
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
      output: { manualChunks: vendorChunk },
    },
  },
});
