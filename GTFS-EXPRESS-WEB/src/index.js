import React, { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, CssBaseline } from "@mui/material";
import { lightTheme, darkTheme } from "./Theme";
import { ThemeModeProvider, useThemeMode } from "./contexts/ThemeContext";
import { DetailPanelProvider } from "./contexts/DetailPanelContext";
import { LanguageProvider } from "./contexts/LanguageContext";
import { EditModeProvider } from "./contexts/EditModeContext";
import { DestructiveGuardProvider } from "./contexts/DestructiveGuardContext";
import { ShortcutsProvider } from "./contexts/ShortcutsContext";
import GTFSApp from "./components/GTFSApp";
import MobileBanner from "./components/MobileBanner";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";

// Legacy cleanup (CRA → Vite migration): earlier builds of this app — and
// any other project ever served on this origin — may have registered a
// service worker. Service workers OUTLIVE deployments; a stale one keeps
// intercepting every request and typically breaks streaming POSTs (the AI
// chat SSE) with an opaque "Failed to fetch", while plain GETs still work.
// The current app uses no service worker: unregister anything found. Takes
// effect on the next page load; harmless no-op when none is registered.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((regs) => {
      if (regs.length > 0) {
        console.warn(
          `Unregistering ${regs.length} stale service worker(s) — reload the page if requests were failing.`,
        );
        regs.forEach((r) => r.unregister());
      }
    })
    .catch(() => {});
}

// Lazy: keeps the PrimeReact theme CSS that AdminDashboard imports out of
// the user app's global stylesheet. Only loaded when '#admin' is navigated.
const AdminApp = React.lazy(() => import("./components/admin/AdminApp"));

// Hash-based admin route. Bypasses the full GTFS app shell so the dashboard
// works without an uploaded feed and without dragging the edit-mode/session
// contexts that don't apply to an operator view.
const isAdminRoute = () =>
  typeof window !== "undefined" && window.location.hash === "#admin";

const ThemedApp = () => {
  const { mode } = useThemeMode();
  const theme = mode === "dark" ? darkTheme : lightTheme;

  if (isAdminRoute()) {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Suspense fallback={null}>
          <AdminApp />
        </Suspense>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <LanguageProvider>
        <ShortcutsProvider>
          <EditModeProvider>
            <DestructiveGuardProvider>
              <DetailPanelProvider>
                <MobileBanner />
                <GTFSApp />
              </DetailPanelProvider>
            </DestructiveGuardProvider>
          </EditModeProvider>
        </ShortcutsProvider>
      </LanguageProvider>
    </ThemeProvider>
  );
};

const container = document.getElementById("root");
const root = createRoot(container);

// Top-level ErrorBoundary catches any render crash that escapes the
// nested boundaries. Without it, a render exception in any component
// (validation viewer, SQL Console, map, ...) would unmount the entire
// app and leave the user staring at a blank white page with no path
// to recovery beyond a manual reload.
root.render(
  <React.StrictMode>
    <ThemeModeProvider>
      <ErrorBoundary>
        <ThemedApp />
      </ErrorBoundary>
    </ThemeModeProvider>
  </React.StrictMode>,
);
