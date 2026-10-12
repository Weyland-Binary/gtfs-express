import React from "react";
import { Alert, AlertTitle, Button, Box } from "@mui/material";

/**
 * Generic error boundary for autonomous UI zones.
 *
 * Usage:
 *   <ErrorBoundary fallback={<Alert severity="error">Something broke</Alert>}>
 *     <MyComponent />
 *   </ErrorBoundary>
 *
 * Or with default fallback:
 *   <ErrorBoundary>
 *     <MyComponent />
 *   </ErrorBoundary>
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <Box sx={{ p: 2 }}>
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={this.handleRetry}>
                Retry
              </Button>
            }
          >
            <AlertTitle>Something went wrong</AlertTitle>
            {this.state.error?.message || "An unexpected error occurred."}
          </Alert>
        </Box>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
