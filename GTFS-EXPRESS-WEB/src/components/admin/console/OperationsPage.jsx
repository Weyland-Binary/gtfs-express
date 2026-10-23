import React, { useState } from "react";
import { Alert, Box, Button, LinearProgress, Stack, Tooltip, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { endSession, fetchAudit, fetchErrors, fetchMail, fetchSessions, fetchTraffic, resetStats } from "../adminApi";
import { useConsole, useConsoleTab } from "./ConsoleShell";
import { ConfirmDialog, DataTable, ErrorNotice, Fact, Grid, Kpi, PageHeader, Panel, Segments, StatusPill, TABULAR, useAdminQuery } from "./ui";
import { BarList } from "./charts";
import { periodText, agencyNamesOf, fmtBytes, fmtDate, fmtDateTime, fmtDuration, fmtInt, fmtRelative, MAIL_KINDS } from "./format";

const TABS = ["sessions", "errors", "mail", "audit", "system"];
const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 };

const ACTS = {
  "account.entitlements": (d) => (d && d.granted && d.granted.length ? `Granted the licence${d.until ? ` until ${fmtDate(d.until)}` : ", no end"}` : "Revoked the licence") + (d && d.disabled ? " · disabled the account" : ""),
  "account.logout": (d) => `Signed the account out everywhere (${(d && d.sessions) || 0})`,
  "quote.update": (d) => `Set a quote to « ${(d && d.status) || "?"} »`,
  "session.end": () => "Ended a working copy",
  "stats.reset": () => "Archived the telemetry logs",
  "perf.reset": () => "Reset the live latency",
  "console.denied": (d) => `Console sign-in refused${d && d.reason === "not_operator" ? " (not an operator)" : d && d.reason ? ` (${d.reason.replace(/_/g, " ")} code)` : ""}`,
};

function SessionsTab({ refreshKey, go, initialQuery }) {
  const theme = useTheme();
  const q = useAdminQuery(fetchSessions, [refreshKey], { refreshMs: 10_000 });
  const [ending, setEnding] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const d = q.data;
  const rows = d ? d.sessions : [];
  const pct = d ? Math.min(100, (100 * d.count) / Math.max(1, d.maxSessions)) : 0;
  return (
    <>
      <ErrorNotice error={q.error} onRetry={q.reload} />
      <Grid min={220} sx={{ mb: 2 }}>
        <Panel title="Capacity" subtitle="Working copies held now · refreshed every 10 s">
          <Typography sx={{ fontSize: 28, fontWeight: 650, ...TABULAR }}>
            {d ? d.count : "—"}
            <Typography component="span" sx={{ fontSize: 15, color: "text.secondary", ml: 0.75 }}>
              / {d ? d.maxSessions : "—"}
            </Typography>
          </Typography>
          <LinearProgress variant="determinate" aria-label="Working copies held" value={pct} color={pct >= 100 ? "error" : pct >= 80 ? "warning" : "primary"} sx={{ height: 6, borderRadius: "12px", my: 1 }} />
          <Typography variant="caption" color="text.secondary">
            {d ? `Visitors without a licence share ${d.maxKeylessSessions} of them.` : ""}
          </Typography>
        </Panel>
        <Kpi label="With an account" value={fmtInt(rows.filter((s) => s.owner && s.owner.user_id).length)} sub="opened by a signed-in person" />
        <Kpi label="Being changed now" color={theme.palette.warning.main} value={fmtInt(rows.filter((s) => s.busy).length)} sub="an edit in progress" />
        <Kpi label="Disk held" value={fmtBytes(rows.reduce((a, s) => a + (s.db_size_kb || 0) * 1024, 0))} sub="their databases" />
      </Grid>
      {notice ? (
        <Alert severity={notice.ok ? "success" : "error"} variant="outlined" onClose={() => setNotice(null)} sx={{ mb: 2, borderRadius: "8px" }}>
          {notice.text}
        </Alert>
      ) : null}
      <Panel padded={false} sx={{ pt: 2 }}>
        <DataTable
          testId="admin-sessions"
          initialQuery={initialQuery}
          loading={q.loading && !d}
          rows={rows}
          getRowId={(s) => s.session_id}
          searchText={(s) => [s.session_id, agencyNamesOf(s.meta).join(" "), s.owner && s.owner.email].join(" ")}
          searchPlaceholder="Search an id, an agency, an owner"
          initialSort={{ key: "idle_ms", dir: "asc" }}
          csvName="working-copies"
          emptyTitle="No working copy open"
          columns={[
            {
              key: "network",
              label: "Network",
              value: (s) => agencyNamesOf(s.meta)[0] || "",
              render: (s) => (
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" noWrap sx={{ fontWeight: 600, maxWidth: 260 }}>
                    {agencyNamesOf(s.meta).join(", ") || "No details"}
                  </Typography>
                  <Typography sx={{ ...mono, color: "text.secondary" }}>{s.session_id}</Typography>
                </Box>
              ),
            },
            { key: "owner", label: "Opened by", value: (s) => (s.owner ? s.owner.email || "" : ""), render: (s) => (s.owner && s.owner.email ? <Typography variant="body2" sx={{ color: "primary.main", cursor: "pointer" }} onClick={() => go("accounts", s.owner.user_id)}>{s.owner.email}</Typography> : <Typography variant="body2" color="text.secondary">Visitor</Typography>), csv: (s) => (s.owner ? s.owner.email : "") },
            { key: "source", label: "Source", value: (s) => (s.meta ? s.meta.source : ""), render: (s) => (s.meta ? <StatusPill tone={s.meta.source === "sample" ? "neutral" : "primary"} label={s.meta.source === "sample" ? "Demo" : s.meta.source_name || s.meta.source || "upload"} /> : "—") },
            { key: "trips", label: "Trips", align: "right", value: (s) => (s.meta && s.meta.counts ? s.meta.counts.trips : null), render: (s) => (s.meta && s.meta.counts ? fmtInt(s.meta.counts.trips) : "—") },
            { key: "errors", label: "Errors", align: "right", value: (s) => (s.meta && s.meta.validation ? s.meta.validation.errors_count : null), render: (s) => (s.meta && s.meta.validation ? fmtInt(s.meta.validation.errors_count) : "—") },
            { key: "db_size_kb", label: "Size", align: "right", render: (s) => fmtBytes((s.db_size_kb || 0) * 1024) },
            { key: "idle_ms", label: "Idle", align: "right", render: (s) => (s.busy ? <StatusPill tone="warning" label="Editing" /> : fmtDuration(s.idle_ms)) },
            { key: "expires_at", label: "Ends", render: (s) => <Tooltip title={fmtDateTime(s.expires_at)}><span>{fmtRelative(s.expires_at)}</span></Tooltip> },
            {
              key: "act",
              label: "",
              sortable: false,
              csv: false,
              render: (s) => (
                <Button size="small" color="error" onClick={(e) => { e.stopPropagation(); setEnding(s); }} disabled={s.busy} data-testid="admin-session-end">
                  End
                </Button>
              ),
            },
          ]}
        />
      </Panel>
      <ConfirmDialog
        open={Boolean(ending)}
        title="End this working copy now?"
        body="Its project keeps a snapshot of its edits (as when it expires); the person who has it open gets « session not found » and opens it again from the project."
        confirmLabel="End it"
        tone="error"
        busy={busy}
        onClose={() => setEnding(null)}
        onConfirm={async () => {
          setBusy(true);
          try {
            await endSession(ending.session_id);
            setNotice({ ok: true, text: "Working copy ended." });
          } catch (e) {
            setNotice({ ok: false, text: e.message || "It could not be ended." });
          } finally {
            setBusy(false);
            setEnding(null);
            q.reload();
          }
        }}
      />
    </>
  );
}

function ErrorsTab({ days, refreshKey, go }) {
  const q = useAdminQuery(() => fetchErrors(days), [days, refreshKey]);
  const d = q.data;
  return (
    <>
      <ErrorNotice error={q.error} onRetry={q.reload} />
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 2fr" }, gap: 2 }}>
        <Panel title="Per route" subtitle={`Over ${periodText(days)}`}>
          {d ? <BarList items={d.by_route.map((r) => ({ key: r.route, label: r.route, value: r.count, display: fmtInt(r.count), sub: [r.codes, `last ${fmtRelative(r.last_at)}`].filter(Boolean).join(" · ") }))} empty="No server error. Good." /> : null}
        </Panel>
        <Panel title="Server errors" subtitle="Their CODE when typed; the messages stay in the server's log" padded={false}>
          <DataTable
            testId="admin-errors"
            loading={q.loading && !d}
            rows={d ? d.items : []}
            getRowId={(r) => r.id}
            onRowClick={(r) => r.email && go("accounts", r.user_id)}
            searchText={(r) => [r.route, r.code, r.email].join(" ")}
            initialSort={{ key: "at", dir: "desc" }}
            csvName="server-errors"
            emptyTitle="No server error in the period"
            columns={[
              { key: "at", label: "When", render: (r) => fmtDateTime(r.at) },
              { key: "route", label: "Route", render: (r) => <Typography sx={mono}>{r.route}</Typography> },
              { key: "status", label: "Status", align: "right", render: (r) => <Typography variant="body2" color="error.main" sx={{ fontWeight: 600, ...TABULAR }}>{r.status}</Typography> },
              { key: "code", label: "Code", render: (r) => (r.code ? <Typography sx={mono}>{r.code}</Typography> : "—") },
              { key: "email", label: "Account", render: (r) => r.email || "—" },
            ]}
          />
        </Panel>
      </Box>
    </>
  );
}

function MailTab({ refreshKey, go }) {
  const { days } = useConsole();
  const q = useAdminQuery(() => fetchMail(days), [days, refreshKey]);
  const d = q.data;
  const failed = d ? d.mails.filter((m) => !m.ok).length : 0;
  return (
    <>
      <ErrorNotice error={q.error} onRetry={q.reload} />
      <Grid min={200} sx={{ mb: 2 }}>
        <Kpi label="Provider" value={d ? d.provider || "none" : "—"} sub={d && d.provider === "log" ? "written to the server's log: nothing leaves" : d && d.provider === "memory" ? "kept in memory: tests only" : null} />
        <Kpi label="E-mails logged" value={d ? fmtInt(d.mails.length) : "—"} sub="the last 500" />
        <Kpi label="Failed" value={d ? fmtInt(failed) : "—"} sub="refused by the provider" />
      </Grid>
      <Panel padded={false} sx={{ pt: 2 }}>
        <DataTable
          testId="admin-mail"
          loading={q.loading && !d}
          rows={d ? d.mails : []}
          getRowId={(m) => m.id}
          onRowClick={(m) => m.email && go("accounts", m.user_id)}
          searchText={(m) => [m.to_masked, m.email, m.kind].join(" ")}
          initialSort={{ key: "at", dir: "desc" }}
          csvName="mail"
          emptyTitle="No e-mail sent yet"
          columns={[
            { key: "at", label: "When", render: (m) => fmtDateTime(m.at) },
            { key: "kind", label: "E-mail", render: (m) => MAIL_KINDS[m.kind] || m.kind || "—" },
            { key: "to_masked", label: "To", render: (m) => <Typography sx={mono}>{m.to_masked}</Typography> },
            { key: "email", label: "Account", render: (m) => m.email || "—" },
            { key: "ok", label: "State", value: (m) => (m.ok ? 1 : 0), render: (m) => <StatusPill tone={m.ok ? "success" : "error"} label={m.ok ? "Sent" : `Failed${m.error ? ` · ${m.error}` : ""}`} /> },
          ]}
        />
      </Panel>
    </>
  );
}

function AuditTab({ refreshKey }) {
  const { days } = useConsole();
  const q = useAdminQuery(() => fetchAudit(days), [days, refreshKey]);
  return (
    <Panel padded={false} sx={{ pt: 2 }}>
      <ErrorNotice error={q.error} onRetry={q.reload} sx={{ mx: 2.5 }} />
      <DataTable
        testId="admin-audit"
        loading={q.loading && !q.data}
        rows={q.data ? q.data.actions : []}
        getRowId={(a) => a.id}
        searchText={(a) => [a.actor, a.action, a.target_email, a.target].join(" ")}
        initialSort={{ key: "at", dir: "desc" }}
        csvName="operator-acts"
        emptyTitle="No act recorded yet"
        columns={[
          { key: "at", label: "When", render: (a) => fmtDateTime(a.at) },
          { key: "actor", label: "By", render: (a) => (a.actor_via === "token" ? <StatusPill label="Admin token" /> : a.actor_via === "sign-in" ? <StatusPill tone="error" label={(a.details && a.details.to) || "Unknown address"} /> : a.actor || "Deleted account"), csv: (a) => (a.actor_via === "token" ? "token" : a.actor_via === "sign-in" ? (a.details && a.details.to) || "" : a.actor) },
          { key: "action", label: "Act", value: (a) => (ACTS[a.action] ? ACTS[a.action](a.details) : a.action), render: (a) => (ACTS[a.action] ? ACTS[a.action](a.details) : a.action) },
          { key: "target", label: "On", value: (a) => a.target_email || a.target || "", render: (a) => a.target_email || (a.target ? <Typography sx={mono}>{a.target}</Typography> : "—") },
        ]}
      />
    </Panel>
  );
}

function SystemTab({ refreshKey }) {
  const theme = useTheme();
  const { me } = useConsole();
  // The system's facts are the traffic in full, whatever the period.
  const q = useAdminQuery(() => fetchTraffic(), [refreshKey]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const sys = q.data ? q.data.system : null;
  const server = me && me.server ? me.server : {};
  return (
    <>
      <ErrorNotice error={q.error} onRetry={q.reload} />
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, gap: 2, mb: 2 }}>
        <Panel title="Process">
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr 1fr", sm: "1fr 1fr 1fr" }, gap: 2 }}>
            <Fact label="Environment">{server.env}</Fact>
            <Fact label="Node">{sys ? sys.nodeVersion : server.node}</Fact>
            <Fact label="Up for">{sys ? fmtDuration(sys.uptimeSec * 1000) : null}</Fact>
            <Fact label="Memory (RSS)">{sys ? fmtBytes(sys.memoryRssBytes) : null}</Fact>
            <Fact label="Heap used">{sys ? fmtBytes(sys.memoryHeapUsedBytes) : null}</Fact>
            <Fact label="CPU load (1/5/15 min)">{sys ? sys.cpuLoad.map((v) => v.toFixed(2)).join(" · ") : null}</Fact>
          </Box>
        </Panel>
        <Panel title="Disk">
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr 1fr", sm: "1fr 1fr 1fr" }, gap: 2 }}>
            <Fact label="Working copies">{sys ? fmtInt(sys.disk.folderCount) : null}</Fact>
            <Fact label="Their size">{sys ? fmtBytes(sys.disk.totalBytes) : null}</Fact>
            <Fact label="Largest">{sys ? fmtBytes(sys.disk.largestFolderBytes) : null}</Fact>
            <Fact label="Events logged">{sys ? fmtInt(sys.eventsLogged) : null}</Fact>
            <Fact label="Logs kept">{server.log_retention_days ? `${server.log_retention_days} days` : "Forever"}</Fact>
            <Fact label="Quotes kept">{server.quote_retention_days ? `${Math.round(server.quote_retention_days / 30.4)} months` : null}</Fact>
          </Box>
        </Panel>
      </Box>
      <Panel title="Configuration" sx={{ mb: 2 }}>
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "repeat(2, 1fr)", sm: "repeat(4, 1fr)" }, gap: 2 }}>
          <Fact label="Accounts">{server.accounts ? "On" : "Off"}</Fact>
          <Fact label="Paid offer">{server.paid ? "On" : "Off"}</Fact>
          <Fact label="Workspace">{server.workspace ? "On" : "Off"}</Fact>
          <Fact label="E-mail provider">{server.mail_provider || "None"}</Fact>
          <Fact label="AI provider">{server.ai_provider || "None"}</Fact>
          <Fact label="Working copies, at most">{server.max_sessions}</Fact>
          <Fact label="Trial">{server.trial_days ? `${server.trial_days} days` : "None"}</Fact>
        </Box>
      </Panel>
      <Panel title="Maintenance" subtitle="Acts that cannot be undone" sx={{ borderColor: theme.palette.error.main }}>
        {notice ? (
          <Alert severity={notice.ok ? "success" : "error"} variant="outlined" onClose={() => setNotice(null)} sx={{ mb: 2, borderRadius: "8px" }}>
            {notice.text}
          </Alert>
        ) : null}
        <Stack direction="row" alignItems="center" spacing={2}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              Archive the telemetry logs
            </Typography>
            <Typography variant="caption" color="text.secondary">
              The event log and the upload log are renamed beside themselves (kept, then swept by their retention); the counts of Activity start again from zero. Accounts, AI and API counts are not touched.
            </Typography>
          </Box>
          <Button variant="outlined" color="error" onClick={() => setConfirm(true)} data-testid="admin-reset-stats">
            Archive and reset
          </Button>
        </Stack>
      </Panel>
      <ConfirmDialog
        open={confirm}
        title="Archive the telemetry logs?"
        body="Activity's networks, journey and event log start again from zero."
        confirmLabel="Archive and reset"
        tone="error"
        typed="reset"
        busy={busy}
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          setBusy(true);
          try {
            const out = await resetStats();
            setNotice({ ok: true, text: `${(out.archivedFiles || []).length} log(s) archived.` });
          } catch (e) {
            setNotice({ ok: false, text: e.message || "Nothing was archived." });
          } finally {
            setBusy(false);
            setConfirm(false);
            q.reload();
          }
        }}
      />
    </>
  );
}

export default function OperationsPage() {
  const { days, refreshKey, go, attention } = useConsole();
  const [tab, setTab, initialQuery] = useConsoleTab(TABS, "sessions");
  const errors = (attention || []).find((a) => a.kind === "server_errors");
  return (
    <>
      <PageHeader title="Operations" description="The server as it runs: its working copies, its errors, its e-mails, the operator's own acts." />
      <Segments
        value={tab}
        onChange={setTab}
        testId="admin-operations-tabs"
        items={[
          { value: "sessions", label: "Working copies" },
          { value: "errors", label: "Errors", count: errors ? errors.count : 0 },
          { value: "mail", label: "E-mails" },
          { value: "audit", label: "Operator's acts" },
          { value: "system", label: "System" },
        ]}
      />
      {tab === "sessions" ? <SessionsTab refreshKey={refreshKey} go={go} initialQuery={initialQuery} /> : null}
      {tab === "errors" ? <ErrorsTab days={days} refreshKey={refreshKey} go={go} /> : null}
      {tab === "mail" ? <MailTab refreshKey={refreshKey} go={go} /> : null}
      {tab === "audit" ? <AuditTab refreshKey={refreshKey} /> : null}
      {tab === "system" ? <SystemTab refreshKey={refreshKey} /> : null}
    </>
  );
}
