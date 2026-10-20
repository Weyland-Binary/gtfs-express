import React from "react";
import { Alert, AlertTitle, Button, Box } from "@mui/material";
import { useOptionalT } from "../contexts/LanguageContext";
import { isChunkLoadError, reloadPage } from "../utils/chunkErrors";

/**
 * Generic error boundary for autonomous UI zones.
 *
 * Usage:
 *   <ErrorBoundary fallback={<Alert severity="error">Something broke</Alert>}>
 *     <MyComponent />
 *   </ErrorBoundary>
 *
 * Or with a render prop (the error and the two ways out):
 *   <ErrorBoundary fallback={({ error, retry, reload, chunkError }) => …}>
 *
 * Or with default fallback (said in the reader's language):
 *   <ErrorBoundary>
 *     <MyComponent />
 *   </ErrorBoundary>
 *
 * Two ways out of a crash:
 *   • retry  — REMOUNTS the children (a new key): their state starts over,
 *              an effect that failed runs again.
 *   • reload — for a lazy chunk that could not be loaded (a deploy renamed
 *              it, utils/chunkErrors): React.lazy keeps the rejected promise,
 *              so a retry would fail the same way; only a reload reads the
 *              new build. The default fallback offers the reload instead of
 *              the retry then.
 */

/**
 * The default fallback — a function component so it can read the language
 * (useOptionalT: the root boundary sits above the LanguageProvider).
 */
export function BoundaryFallback({ error, chunkError, onRetry, onReload }) {
  const t = useOptionalT();
  return (
    <Box sx={{ p: 2 }}>
      <Alert
        severity={chunkError ? "warning" : "error"}
        action={
          chunkError ? (
            <Button color="inherit" size="small" onClick={onReload}>
              {t("errorBoundary.reload")}
            </Button>
          ) : (
            <Button color="inherit" size="small" onClick={onRetry}>
              {t("app.retry")}
            </Button>
          )
        }
      >
        <AlertTitle>{chunkError ? t("errorBoundary.chunkTitle") : t("errorBoundary.title")}</AlertTitle>
        {/* A stale chunk is said in a sentence (the browser's message means nothing to the reader); any other
            crash keeps its message, the only lead a support request has. */}
        {chunkError ? t("errorBoundary.chunkBody") : error?.message || t("errorBoundary.unknown")}
      </Alert>
    </Box>
  );
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    // `generation` keys the children: bumped by retry, so they remount.
    this.state = { hasError: false, error: null, generation: 0 };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  handleRetry = () => {
    this.setState((s) => ({ hasError: false, error: null, generation: s.generation + 1 }));
  };

  render() {
    if (this.state.hasError) {
      const { error } = this.state;
      const chunkError = isChunkLoadError(error);
      const { fallback } = this.props;
      if (typeof fallback === "function") {
        return fallback({ error, chunkError, retry: this.handleRetry, reload: reloadPage });
      }
      if (fallback) {
        return fallback;
      }

      return <BoundaryFallback error={error} chunkError={chunkError} onRetry={this.handleRetry} onReload={reloadPage} />;
    }

    return <React.Fragment key={this.state.generation}>{this.props.children}</React.Fragment>;
  }
}

export default ErrorBoundary;
