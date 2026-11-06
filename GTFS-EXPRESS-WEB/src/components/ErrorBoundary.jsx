import React from "react";
import { Alert, AlertTitle, Button, Box } from "@mui/material";
import { useOptionalT } from "../contexts/LanguageContext";
import { isChunkLoadError, reloadPage } from "../utils/chunkErrors";

/**
 * `fallback` is a node or a render prop ({ error, retry, reload, chunkError }).
 * retry remounts the children; a lazy chunk that failed to load (a deploy renamed it) needs a
 * reload, since React.lazy keeps the rejected promise and a retry would fail the same way.
 */

// useOptionalT: the root boundary sits above the LanguageProvider.
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
        {/* A stale chunk gets a sentence (the browser's message means nothing to the reader); any other
            crash keeps its message, the only lead a support request has. */}
        {chunkError ? t("errorBoundary.chunkBody") : error?.message || t("errorBoundary.unknown")}
      </Alert>
    </Box>
  );
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    // `generation` keys the children: retry bumps it so they remount.
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
