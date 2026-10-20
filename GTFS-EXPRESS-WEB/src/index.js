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
import MobileBanner from "./components/MobileBanner";
import ErrorBoundary from "./components/ErrorBoundary";
import { RouterProvider, useRoute, legacyRedirect, getNetworkId, documentTitle, history } from "./utils/routes";
import { reloadOnceForStaleChunk } from "./utils/chunkErrors";
import "./index.css";

// Service-worker cleanup: an earlier build of this app — or any other
// project ever served on this origin — may have registered a
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

// A stale chunk after a deploy: a tab opened before it asks for the old
// hashed chunk names, which the new build no longer serves. Vite's preload
// helper says so with `vite:preloadError` (a lazy import or its CSS that
// failed): the page reloads ONCE to read the new index.html — at most once
// per window (utils/chunkErrors: a sessionStorage stamp), so a chunk really
// missing on the server never turns into a reload loop. Not reloaded (the
// stamp is recent, or storage is blocked): the error is left to throw, and
// the screen's error boundary (Deferred) offers the reload in place.
window.addEventListener("vite:preloadError", (event) => {
  if (reloadOnceForStaleChunk()) event.preventDefault();
});

// Old links keep working: `?share=` → /partage/:token, `#admin` →
// /admin, `?sql=1` → the SQL tab of the network open in this browser tab
// (utils/routes.js).
// Rewritten once, before the first render, so every screen reads the routed
// URL only.
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

// Lazy: keeps the PrimeReact theme CSS that AdminDashboard imports out of
// the user app's global stylesheet. Only loaded on /admin.
const AdminApp = React.lazy(() => import("./components/admin/AdminApp"));

// The admin route (/admin). Bypasses the full GTFS app shell so the
// dashboard works without an uploaded feed and without dragging the
// edit-mode/session contexts that don't apply to an operator view.
const AdminTitle = () => {
  React.useEffect(() => {
    document.title = documentTitle("Admin");
  }, []);
  return null;
};

const ThemedApp = () => {
  // The mode and the system's request for less motion: MUI's transitions are cut with it.
  const { mode, reducedMotion } = useThemeMode();
  const theme = React.useMemo(() => themeFor(mode, { reducedMotion }), [mode, reducedMotion]);
  const route = useRoute();

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
                    <MobileBanner />
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

// Recovery copies of working files an earlier version kept in the browser (IndexedDB « gtfs-interpreter ») are
// removed: projects live on the server.
try {
  window.indexedDB?.deleteDatabase("gtfs-interpreter");
} catch {
  // Storage blocked (private window, policy): nothing was kept there either.
}

const container = document.getElementById("root");
const root = createRoot(container);

// Top-level ErrorBoundary catches any render crash that escapes the
// nested boundaries. Without it, a render exception in any component
// (validation viewer, SQL Console, map, ...) would unmount the entire
// app and leave the user staring at a blank white page with no path
// to recovery beyond a manual reload.
// The saved language's dictionary first (French is in the app; the others are chunks of their own): the
// app opens in that language, never in keys. A dictionary that cannot be loaded opens the app in French.
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
