// AccountsLicences.js — the accounts and their licence, in the admin dashboard (2026-10-08: the beta codes retired,
// the licence bought on a quote is granted here). One row per account: who, where its licence comes from and until
// when, the free trial's end, the last sign-in; the operator grants the licence until a date (a year by default,
// the usual term of a quote), takes it back, or disables the account (its sessions end). The server's word is the
// only state: every act re-reads the row it answers (POST /admin/users/:id/entitlements). English, as the rest of
// the dashboard (an operator's tool, not the product's screens).

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Box, Button, Chip, CircularProgress, Stack, TextField, Typography } from "@mui/material";
import { fetchUsers, setUserEntitlements } from "./adminApi";

const SOURCE_LABELS = { owner: "Operator (unlimited)", subscription: "Paid online", admin: "Granted", trial: "Free trial" };
const SOURCE_COLORS = { owner: "secondary", subscription: "success", admin: "primary", trial: "warning" };

/** A year from today, the default end of a licence granted on a quote (YYYY-MM-DD). */
const inAYear = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
};

const day = (iso) => (iso ? String(iso).slice(0, 10) : "—");

// Who tries (POST /billing/trial since 2026-10-12) and what the AI cost the account (llm/aiMeter, in USD as billed).
const ROLE_LABELS = { authority: "Transport authority", operator: "Operator", consultancy: "Consultancy", other: "Other" };
const usd = (n) => (Number(n) || 0).toFixed(2) + " $";
const profileLine = (user) => {
  const p = user.profile || {};
  return [p.organisation, ROLE_LABELS[p.org_role] || null, p.network, p.phone].filter(Boolean).join(" · ");
};

function LicenceCell({ user }) {
  const licence = user.licence || {};
  if (!licence.active) {
    return (
      <Typography variant="caption" color="text.secondary">
        Reading only{user.trial_until ? ` · trial ended ${day(user.trial_until)}` : ""}
      </Typography>
    );
  }
  return (
    <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
      <Chip size="small" label={SOURCE_LABELS[licence.source] || licence.source} color={SOURCE_COLORS[licence.source] || "default"} variant="outlined" sx={{ fontWeight: 700 }} />
      <Typography variant="caption" color="text.secondary">
        {licence.until ? `until ${day(licence.until)}` : "no end"}
      </Typography>
    </Stack>
  );
}

export default function AccountsLicences() {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // the id of the account being changed
  const [until, setUntil] = useState({}); // { [id]: "YYYY-MM-DD" }
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    setError(null);
    fetchUsers()
      .then((body) => setUsers(body.users || []))
      .catch((err) => setError(err.status === 503 ? "Accounts are not enabled on this server (ACCOUNTS_ENABLED)." : err.message));
  }, []);

  useEffect(() => load(), [load]);

  const act = async (user, changes) => {
    setBusy(user.id);
    setError(null);
    try {
      const body = await setUserEntitlements(user.id, changes);
      setUsers((list) => list.map((u) => (u.id === user.id ? body.user : u)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = users || [];
    return q ? list.filter((u) => `${u.email} ${u.display_name || ""} ${u.profile?.organisation || ""}`.toLowerCase().includes(q)) : list;
  }, [users, query]);

  if (error && !users) return <Alert severity="warning">{error}</Alert>;
  if (!users) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
        <CircularProgress size={20} />
      </Box>
    );
  }
  return (
    <Stack spacing={1.25} data-testid="admin-accounts">
      <Stack direction="row" spacing={1} alignItems="center">
        <TextField size="small" placeholder="Search an e-mail, a name or an organisation" value={query} onChange={(e) => setQuery(e.target.value)} sx={{ flex: 1 }} inputProps={{ "data-testid": "admin-accounts-search" }} />
        <Button size="small" onClick={load} sx={{ textTransform: "none" }}>
          Refresh
        </Button>
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      {shown.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: "center" }}>
          {users.length === 0 ? "No account yet." : "No account matches."}
        </Typography>
      )}
      {shown.map((user) => {
        const granted = Array.isArray(user.granted) && user.granted.length > 0;
        const value = until[user.id] ?? inAYear();
        return (
          <Box key={user.id} data-testid="admin-account" data-email={user.email} sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "minmax(200px, 1.3fr) minmax(180px, 1fr) auto" }, gap: 1.25, alignItems: "center", py: 1, borderTop: (t) => `1px solid ${t.palette.divider}`, opacity: user.disabled ? 0.55 : 1 }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" fontWeight={700} noWrap title={user.email}>
                {user.email}
                {!user.email_verified && (
                  <Typography component="span" variant="caption" color="warning.main" sx={{ ml: 0.75 }}>
                    unverified
                  </Typography>
                )}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap component="div">
                {user.display_name || "—"} · last sign-in {day(user.last_login_at)}
                {user.disabled ? " · disabled" : ""}
              </Typography>
              {profileLine(user) && (
                <Typography variant="caption" color="text.secondary" noWrap component="div" data-testid="admin-account-profile" title={profileLine(user)}>
                  {profileLine(user)}
                </Typography>
              )}
              {user.ai_usd && (
                <Typography variant="caption" color="text.secondary" component="div" data-testid="admin-account-ai">
                  AI {usd(user.ai_usd.month)} this month · {usd(user.ai_usd.total)} in all
                </Typography>
              )}
            </Box>
            <LicenceCell user={user} />
            <Stack direction="row" spacing={0.75} alignItems="center" justifyContent="flex-end" flexWrap="wrap" useFlexGap>
              <TextField type="date" size="small" value={value} onChange={(e) => setUntil((m) => ({ ...m, [user.id]: e.target.value }))} disabled={busy === user.id} inputProps={{ "data-testid": "admin-account-until", "aria-label": "Licence end" }} sx={{ width: 150 }} />
              <Button size="small" variant="contained" disableElevation disabled={busy === user.id || !value} onClick={() => act(user, { edit: true, studio: true, until: value })} data-testid="admin-account-grant" sx={{ textTransform: "none", fontWeight: 700 }}>
                {granted ? "Extend" : "Grant licence"}
              </Button>
              {granted && (
                <Button size="small" color="inherit" disabled={busy === user.id} onClick={() => act(user, { edit: false, studio: false, until: null })} data-testid="admin-account-revoke" sx={{ textTransform: "none" }}>
                  Revoke
                </Button>
              )}
              <Button size="small" color={user.disabled ? "primary" : "error"} disabled={busy === user.id} onClick={() => act(user, { disabled: !user.disabled })} data-testid="admin-account-disable" sx={{ textTransform: "none" }}>
                {user.disabled ? "Enable" : "Disable"}
              </Button>
            </Stack>
          </Box>
        );
      })}
    </Stack>
  );
}
