import React, { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { Box, LinearProgress } from "@mui/material";
import AdminGate from "./AdminGate";
import ConsoleShell from "./console/ConsoleShell";
import { clearAdminToken, fetchMe, getAdminToken, signOutAccount } from "./adminApi";

const OverviewPage = lazy(() => import("./console/OverviewPage"));
const FunnelPage = lazy(() => import("./console/FunnelPage"));
const AccountsPage = lazy(() => import("./console/AccountsPage"));
const RevenuePage = lazy(() => import("./console/RevenuePage"));
const UsagePage = lazy(() => import("./console/UsagePage"));
const ActivityPage = lazy(() => import("./console/ActivityPage"));
const OperationsPage = lazy(() => import("./console/OperationsPage"));

const PAGES = { overview: OverviewPage, funnel: FunnelPage, accounts: AccountsPage, revenue: RevenuePage, usage: UsagePage, activity: ActivityPage, operations: OperationsPage };

/**
 * AdminApp — the operator's console at /admin[/:section[/:id]] (`#admin` redirects there). English only.
 *
 * Boot: `?logout` forgets a stored token; then GET /admin/me tells whether this browser is in — by the operator's
 * account (its session cookie) or by a stored admin token. In: the console's frame and the section's screen.
 * Out: the sign-in (AdminGate).
 */
function AdminApp({ params = {} }) {
  const [state, setState] = useState({ status: "checking", me: null, error: "" });

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("logout")) {
      clearAdminToken();
      url.searchParams.delete("logout");
      window.history.replaceState({}, "", url.toString());
    }
    fetchMe()
      .then((me) => setState({ status: "in", me, error: "" }))
      .catch((e) => {
        if (e.status === 401 && getAdminToken()) clearAdminToken();
        setState({ status: "out", me: null, error: e.status === 503 ? "The console is off on this server." : "" });
      });
  }, []);

  const signOut = useCallback(async () => {
    const via = state.me && state.me.via;
    clearAdminToken();
    if (via === "account") await signOutAccount().catch(() => null);
    setState({ status: "out", me: null, error: "" });
  }, [state.me]);

  if (state.status === "checking") return null;
  if (state.status === "out") return <AdminGate initialError={state.error} onSignedIn={(me) => setState({ status: "in", me, error: "" })} />;

  const section = PAGES[params.section] ? params.section : "overview";
  const Page = PAGES[section];
  return (
    <ConsoleShell me={state.me} section={section} onSignOut={signOut}>
      <Suspense
        fallback={
          <Box sx={{ pt: 1 }}>
            <LinearProgress sx={{ borderRadius: 1 }} />
          </Box>
        }
      >
        <Page id={params.id || null} />
      </Suspense>
    </ConsoleShell>
  );
}

export default AdminApp;
