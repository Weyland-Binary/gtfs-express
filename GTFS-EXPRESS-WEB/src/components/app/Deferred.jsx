/**
 * A lazy screen with its own error boundary: a screen that crashes (or whose chunk a deploy renamed) shows its message
 * in place and the rest of the app stays up. The boundary sits OUTSIDE the Suspense so a rejected lazy import is
 * caught here too.
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
