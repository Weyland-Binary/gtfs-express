import React, { useMemo, useState } from "react";
import { Avatar, Box, Chip, LinearProgress, Stack, Tooltip, Typography, alpha } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { fetchUsers } from "../adminApi";
import { useConsole } from "./ConsoleShell";
import { DataTable, ErrorNotice, PageHeader, Panel, StatusPill, TABULAR, useAdminQuery } from "./ui";
import { periodShort, fmtDate, fmtEur, fmtInt, fmtRelative, licenceLabel, licenceTone, ROLES } from "./format";
import AccountDrawer from "./AccountDrawer";


const FILTERS = [
  { id: "all", label: "All", test: () => true },
  { id: "licensed", label: "Licensed", test: (u) => u.licence && u.licence.active },
  { id: "subscription", label: "Paid", test: (u) => u.licence && u.licence.active && u.licence.source === "subscription" },
  { id: "admin", label: "Granted", test: (u) => u.licence && u.licence.active && u.licence.source === "admin" },
  { id: "tester", label: "Testers", test: (u) => u.licence && u.licence.active && u.licence.source === "tester" },
  { id: "trial", label: "On trial", test: (u) => u.licence && u.licence.active && u.licence.source === "trial" },
  { id: "reading", label: "Reading only", test: (u) => !(u.licence && u.licence.active) },
  { id: "disabled", label: "Disabled", test: (u) => u.disabled },
];

export function AccountCell({ user }) {
  const theme = useTheme();
  const name = user.display_name || user.email;
  return (
    <Stack direction="row" spacing={1.25} alignItems="center" sx={{ minWidth: 0 }}>
      <Avatar sx={{ width: 28, height: 28, fontSize: 12, fontWeight: 700, bgcolor: alpha(theme.palette.primary.main, 0.12), color: "primary.main" }}>{String(name || "?").slice(0, 1).toUpperCase()}</Avatar>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" noWrap sx={{ fontWeight: 600, maxWidth: 220 }}>
          {name}
        </Typography>
        {user.display_name ? (
          <Typography variant="caption" color="text.secondary" noWrap component="div" sx={{ maxWidth: 220 }}>
            {user.email}
          </Typography>
        ) : null}
      </Box>
    </Stack>
  );
}

/** This month's AI cost, against the account's envelope when it has one. */
export function AllowanceCell({ user }) {
  const a = user.ai_allowance;
  const month = user.ai_eur ? user.ai_eur.month : 0;
  if (!a) return <Typography variant="body2" sx={TABULAR}>{month ? fmtEur(month) : "—"}</Typography>;
  const pct = a.limit_eur ? Math.min(100, (100 * (a.spent_eur || 0)) / a.limit_eur) : 0;
  return (
    <Tooltip title={`${fmtEur(a.spent_eur)} of ${fmtEur(a.limit_eur)} ${a.kind === "trial" ? "for the trial" : "this month"}`}>
      <Box sx={{ minWidth: 110 }}>
        <Typography variant="body2" sx={TABULAR}>
          {fmtEur(a.spent_eur)} <Typography component="span" variant="caption" color="text.secondary">/ {fmtEur(a.limit_eur)}</Typography>
        </Typography>
        <LinearProgress variant="determinate" aria-label="AI allowance spent" value={pct} color={a.exhausted ? "error" : pct > 80 ? "warning" : "primary"} sx={{ height: 4, borderRadius: "8px", mt: 0.5 }} />
      </Box>
    </Tooltip>
  );
}

export default function AccountsPage({ id }) {
  const { days, refreshKey, go } = useConsole();
  const [filter, setFilter] = useState("all");
  const q = useAdminQuery(() => fetchUsers(days), [days, refreshKey]);
  const users = useMemo(() => (q.data ? q.data.users : []), [q.data]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, users.filter(f.test).length])), [users]);
  const shown = useMemo(() => users.filter((FILTERS.find((f) => f.id === filter) || FILTERS[0]).test), [users, filter]);

  const columns = [
    { key: "account", label: "Account", value: (u) => (u.display_name || u.email || "").toLowerCase(), render: (u) => <AccountCell user={u} />, csv: (u) => u.email },
    { key: "name", label: "Name", hidden: true, value: (u) => u.display_name || "" },
    { key: "org_csv", label: "Organisation", hidden: true, value: (u) => (u.profile && u.profile.organisation) || "" },
    {
      key: "organisation",
      label: "Organisation",
      value: (u) => (u.profile && u.profile.organisation) || "",
      csv: (u) => [u.profile && u.profile.org_role, u.profile && u.profile.network].filter(Boolean).join(" · "),
      render: (u) =>
        u.profile && u.profile.organisation ? (
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" noWrap sx={{ maxWidth: 180 }}>
              {u.profile.organisation}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap component="div" sx={{ maxWidth: 180 }}>
              {[ROLES[u.profile.org_role], u.profile.network].filter(Boolean).join(" · ")}
            </Typography>
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">—</Typography>
        ),
    },
    {
      key: "licence",
      label: "Licence",
      value: (u) => (u.licence && u.licence.active ? `${u.licence.source}` : "~"),
      render: (u) => (
        <Stack spacing={0.25} alignItems="flex-start">
          <Stack direction="row" spacing={0.75}>
            <StatusPill tone={licenceTone(u.licence)} label={licenceLabel(u.licence)} />
            {u.disabled ? <StatusPill tone="error" label="Disabled" /> : null}
            {!u.email_verified ? <StatusPill tone="warning" label="Unverified" /> : null}
          </Stack>
          {u.licence && u.licence.active && u.licence.until ? (
            <Typography variant="caption" color="text.secondary" sx={TABULAR}>
              ends {fmtRelative(u.licence.until)}
            </Typography>
          ) : null}
        </Stack>
      ),
      csv: (u) => (u.licence && u.licence.active ? `${u.licence.source}${u.licence.until ? ` until ${u.licence.until.slice(0, 10)}` : ""}` : "reading"),
    },
    { key: "ai", label: "AI this month", align: "right", value: (u) => (u.ai_allowance ? u.ai_allowance.spent_eur : u.ai_eur ? u.ai_eur.month : 0), render: (u) => <AllowanceCell user={u} />, csv: (u) => (u.ai_eur ? u.ai_eur.month : 0) },
    { key: "calls", label: `Calls, ${periodShort(days)}`, align: "right", value: (u) => u.calls || 0, render: (u) => fmtInt(u.calls) },
    { key: "projects", label: "Projects", align: "right", value: (u) => u.projects || 0, render: (u) => (u.projects ? `${fmtInt(u.projects)}${u.deliveries ? ` · ${u.deliveries} delivered` : ""}` : "—") },
    { key: "last_active_at", label: "Last active", value: (u) => u.last_active_at || "", render: (u) => <Tooltip title={u.last_active_at ? new Date(u.last_active_at).toLocaleString("en-GB") : ""}><span>{fmtRelative(u.last_active_at)}</span></Tooltip> },
    { key: "created_at", label: "Joined", value: (u) => u.created_at || "", render: (u) => fmtDate(u.created_at) },
  ];

  return (
    <>
      <PageHeader title="Accounts" description="Every account, its licence and what it used. Open one for its whole file." />
      <ErrorNotice error={q.error} onRetry={q.reload} />
      <Panel padded={false} sx={{ pt: 2 }}>
        <DataTable
          testId="admin-accounts"
          columns={columns}
          rows={shown}
          loading={q.loading && !q.data}
          getRowId={(u) => u.id}
          selectedId={id}
          onRowClick={(u) => go("accounts", u.id)}
          searchText={(u) => [u.email, u.display_name, u.profile && u.profile.organisation, u.profile && u.profile.network, u.id].join(" ")}
          searchPlaceholder="Search e-mail, name, organisation"
          initialSort={{ key: "last_active_at", dir: "desc" }}
          csvName="accounts"
          emptyTitle="No account yet"
          toolbar={
            <Stack direction="row" spacing={0.75} sx={{ flexWrap: "wrap" }}>
              {FILTERS.map((f) => (
                <Chip
                  key={f.id}
                  size="small"
                  label={`${f.label} ${counts[f.id] ?? 0}`}
                  color={filter === f.id ? "primary" : "default"}
                  variant={filter === f.id ? "filled" : "outlined"}
                  onClick={() => setFilter(f.id)}
                  data-testid={`admin-accounts-filter-${f.id}`}
                  sx={{ fontWeight: 600, ...TABULAR }}
                />
              ))}
            </Stack>
          }
        />
      </Panel>
      <AccountDrawer id={id} onClose={() => go("accounts")} onChanged={q.reload} />
    </>
  );
}
