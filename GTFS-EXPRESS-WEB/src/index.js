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

// Old links keep working (D1, D48): `?share=` → /partage/:token, `#admin` →
// /admin, `?sql=1` → the SQL tab of the network open in this browser tab
// (utils/routes.js; the `?tab=` redirections were dropped by the last lot).
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
  // The mode and the system's request for less motion (WP9): MUI's transitions are cut with it.
  const { mode, reducedMotion } = useThemeMode();
  const theme = React.useMemo(() => themeFor(mode, { reducedMotion }), [mode, reducedMotion]);
  const route = useRoute();

  if (route.name === "admin") {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <AdminTitle />
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

const container = document.getElementById("root");
const root = createRoot(container);

// Top-level ErrorBoundary catches any render crash that escapes the
// nested boundaries. Without it, a render exception in any component
// (validation viewer, SQL Console, map, ...) would unmount the entire
// app and leave the user staring at a blank white page with no path
// to recovery beyond a manual reload.
// The saved language's dictionary first (French is in the app; the others are chunks of their own, 2026-10-11): the
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
