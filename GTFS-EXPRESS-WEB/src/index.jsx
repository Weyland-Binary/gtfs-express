import React, { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, CssBaseline } from "@mui/material";
import { themeFor } from "./Theme";
import { ThemeModeProvider, useThemeMode, LocalizedThemeDefaults } from "./contexts/ThemeContext";
import { DetailPanelProvider } from "./contexts/DetailPanelContext";
import { LanguageProvider, getInitialLanguage, preloadLanguage } from "./contexts/LanguageContext";
import { EditModeProvider } from "./contexts/EditModeContext";
import { AccountProvider } from "./contexts/AccountContext";
import { DestructiveGuardProvider } from "./contexts/DestructiveGuardContext";
import { ShortcutsProvider } from "./contexts/ShortcutsContext";
import GTFSApp from "./components/GTFSApp";
import ErrorBoundary from "./components/ErrorBoundary";
import { RouterProvider, useRoute, legacyRedirect, getNetworkId, documentTitle, history } from "./utils/routes";
import { reloadOnceForStaleChunk } from "./utils/chunkErrors";
import "./index.css";

// The app uses no service worker, but one registered on this origin by anything else outlives deployments and
// breaks streaming POSTs (the assistants' SSE) with an opaque "Failed to fetch".
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

// A tab opened before a deploy asks for chunk names the new build no longer serves: reload once per window (never
// a loop); otherwise the error throws and the screen's error boundary offers the reload.
window.addEventListener("vite:preloadError", (event) => {
  if (reloadOnceForStaleChunk()) event.preventDefault();
});

// Old links rewritten before the first render, so every screen reads the routed URL only.
const followLegacyLink = () => {
  try {
    const target = legacyRedirect(window.location.href, { networkId: getNetworkId() });
    if (target) history.replace(target, window.history.state || {});
  } catch {
    /* no history API: the old URL stays, and the app opens Home */
  }
};
followLegacyLink();
// `#admin` typed on an open page changes the hash only (no reload).
window.addEventListener("hashchange", followLegacyLink);

// Lazy, so the PrimeReact theme CSS it imports stays out of the app's global stylesheet.
const AdminApp = React.lazy(() => import("./components/admin/AdminApp"));

const AdminTitle = () => {
  React.useEffect(() => {
    document.title = documentTitle("Admin");
  }, []);
  return null;
};

const ThemedApp = () => {
  const { mode, reducedMotion } = useThemeMode();
  const theme = React.useMemo(() => themeFor(mode, { reducedMotion }), [mode, reducedMotion]);
  const route = useRoute();

  // The operator's console skips the app's shell: it needs no feed and none of the edit-mode or session contexts.
  if (route.name === "admin") {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <AdminTitle />
        <Suspense fallback={null}>
          <AdminApp params={route.params} />
        </Suspense>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <LanguageProvider>
        <LocalizedThemeDefaults>
          <ShortcutsProvider>
            <AccountProvider>
              <EditModeProvider>
                <DestructiveGuardProvider>
                  <DetailPanelProvider>
                    <GTFSApp />
                  </DetailPanelProvider>
                </DestructiveGuardProvider>
              </EditModeProvider>
            </AccountProvider>
          </ShortcutsProvider>
        </LocalizedThemeDefaults>
      </LanguageProvider>
    </ThemeProvider>
  );
};

// Projects live on the server: drop the recovery copies older builds kept in IndexedDB.
try {
  window.indexedDB?.deleteDatabase("gtfs-interpreter");
} catch {
  // Storage blocked: nothing was kept there either.
}

const container = document.getElementById("root");
const root = createRoot(container);

// The saved language's dictionary loads first, so the app never opens showing keys; a failed load falls back to
// French, which is bundled.
preloadLanguage(getInitialLanguage()).then(() =>
root.render(
  <React.StrictMode>
    <ThemeModeProvider>
      <ErrorBoundary>
        <RouterProvider>
          <ThemedApp />
        </RouterProvider>
      </ErrorBoundary>
    </ThemeModeProvider>
  </React.StrictMode>,
),
);
