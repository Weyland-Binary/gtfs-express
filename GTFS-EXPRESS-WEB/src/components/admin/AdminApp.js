import React, { useEffect, useState } from "react";
import AdminGate from "./AdminGate";
import AdminDashboard from "./AdminDashboard";
import { ping, getAdminToken, clearAdminToken } from "./adminApi";

/**
 * AdminApp — entry point for the #admin route.
 *
 * Boot flow:
 *   1. If `?logout` is in the URL → wipe stored token, then strip it from URL.
 *   2. Try to validate any stored token via `/admin/ping`.
 *   3. On 200 → render <AdminDashboard/>. Otherwise render <AdminGate/>.
 */
function AdminApp() {
  const [state, setState] = useState({ status: "checking", error: "" });

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("logout")) {
      clearAdminToken();
      url.searchParams.delete("logout");
      window.history.replaceState({}, "", url.toString());
    }
    const token = getAdminToken();
    if (!token) {
      setState({ status: "needs-token", error: "" });
      return;
    }
    ping(token)
      .then(() => setState({ status: "authenticated", error: "" }))
      .catch((e) => {
        if (e.status === 503) {
          setState({
            status: "needs-token",
            error: "Admin dashboard disabled — set ADMIN_TOKEN on the API.",
          });
        } else {
          // 401 or other — drop stored token to avoid loops.
          clearAdminToken();
          setState({ status: "needs-token", error: "" });
        }
      });
  }, []);

  if (state.status === "checking") return null;

  if (state.status === "needs-token") {
    return (
      <AdminGate
        onAuthenticated={() => setState({ status: "authenticated", error: "" })}
        initialError={state.error}
      />
    );
  }

  return (
    <AdminDashboard onLogout={() => setState({ status: "needs-token", error: "" })} />
  );
}

export default AdminApp;
