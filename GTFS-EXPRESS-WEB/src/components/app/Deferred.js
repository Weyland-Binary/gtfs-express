/**
 * Deferred — a screen loaded on demand: a thin progress bar (named by the theme's default) while its code arrives.
 * Shared by the app's shell and the reader's views, which lazy-load the heavy screens (the grid, the maps, the
 * consoles, the pages) so Home draws without reading the whole bundle.
 *
 * Each one is also an error zone of its own: a screen that crashes (or whose chunk a deploy renamed) shows its
 * message in place — retry remounts it, a stale chunk offers the reload — and the rest of the app stays up, instead
 * of the root boundary replacing the whole page. The boundary sits OUTSIDE the Suspense so a lazy import that
 * rejects is caught here too.
 */
import React, { Suspense } from "react";
import LinearProgress from "@mui/material/LinearProgress";
import ErrorBoundary from "../ErrorBoundary";

const Deferred = ({ children }) => (
  <ErrorBoundary>
    <Suspense fallback={<LinearProgress sx={{ flexShrink: 0 }} />}>{children}</Suspense>
  </ErrorBoundary>
);

export default Deferred;
