// Activity: what is done with the product — the networks opened (feeds, agencies, the working copies' journey),
// the projects of the workspace, and the event log, filtered on the server by family, account and text.

import React, { useEffect, useMemo, useState } from "react";
import { Box, Button, Chip, Dialog, DialogContent, DialogTitle, IconButton, InputAdornment, Stack, TextField, Tooltip, Typography, alpha } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import SearchIcon from "@mui/icons-material/Search";
import CloseIcon from "@mui/icons-material/Close";
import { fetchEvents, fetchProjects, fetchTraffic } from "../adminApi";
import { useConsole, useConsoleTab } from "./ConsoleShell";
import { DataTable, ErrorNotice, Grid, Kpi, PageHeader, Panel, Segments, StatusPill, TABULAR, useAdminQuery } from "./ui";
import { DayTrend, useSeriesColors } from "./charts";
import { DRAFT_KINDS, EVENT_FAMILIES, eventSentence, familyOf, fmtBytes, fmtDate, fmtDateTime, fmtInt, fmtPct, fmtRelative } from "./format";

const TABS = ["networks", "projects", "events"];
const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 };

function Funnel({ funnel }) {
  const theme = useTheme();
  const steps = [
    { key: "uploaded", label: "Opened a network" },
    { key: "validated", label: "Validated it" },
    { key: "edited", label: "Edited it" },
    { key: "usedSql", label: "Used the SQL console" },
    { key: "exported", label: "Exported it" },
  ];
  const base = funnel.uploaded || 0;
  return (
    <Stack spacing={1.25}>
      {steps.map((s) => {
        const n = funnel[s.key] || 0;
        const pct = base ? n / base : 0;
        return (
          <Box key={s.key}>
            <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
              <Typography variant="body2">{s.label}</Typography>
              <Typography variant="body2" sx={{ fontWeight: 600, ...TABULAR }}>
                {fmtInt(n)} <Typography component="span" variant="caption" color="text.secondary">{s.key === "uploaded" ? "" : fmtPct(pct)}</Typography>
              </Typography>
            </Stack>
            <Box sx={{ height: 8, borderRadius: 999, bgcolor: "action.hover", overflow: "hidden" }}>
              <Box sx={{ width: `${s.key === "uploaded" ? 100 : Math.max(1, pct * 100)}%`, height: "100%", bgcolor: alpha(theme.palette.primary.main, 0.75) }} />
            </Box>
          </Box>
        );
      })}
      <Typography variant="caption" color="text.secondary">
        Working copies, since the logs began · {fmtPct((funnel.bounceRate || 0) / 100)} left without doing anything
      </Typography>
    </Stack>
  );
}

function NetworksTab({ refreshKey, initialQuery }) {
  const theme = useTheme();
  const colors = useSeriesColors();
  const q = useAdminQuery(fetchTraffic, [refreshKey]);
  const d = q.data;
  const loading = q.loading && !d;
  const k = d ? d.kpis : null;
  return (
    <>
      <ErrorNotice error={q.error} onRetry={q.reload} />
      <Grid min={180} sx={{ mb: 2 }}>
        <Kpi label="Networks opened" loading={loading} value={k ? fmtInt(k.realUploads) : "—"} sub={k ? `${fmtInt(k.last30Uploads)} in 30 days · ${fmtInt(k.sampleUploads)} demos` : null} />
        <Kpi label="Distinct feeds" loading={loading} value={k ? fmtInt(k.distinctFeeds) : "—"} sub={k ? `${fmtInt(k.distinctAgencies)} agencies` : null} />
        <Kpi label="Validations" loading={loading} value={d ? fmtInt(d.validations.runs) : "—"} sub={d ? `${fmtInt(d.validations.avgDurationMs)} ms on average` : null} />
        <Kpi label="Exports" loading={loading} value={d ? fmtInt(d.exports.runs) : "—"} sub={d ? `${fmtBytes((d.exports.avgSizeKb || 0) * 1024)} on average` : null} />
        <Kpi label="Edits" loading={loading} value={d ? fmtInt(d.mutations.total) : "—"} sub={d ? `${fmtInt(d.sql.total)} SQL queries` : null} />
      </Grid>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "2fr 1fr" }, gap: 2, mb: 2 }}>
        <Panel title="Last 30 days" subtitle="Networks opened, working copies, validations, exports">
          {d ? (
            <DayTrend
              data={d.trend}
              series={[
                { key: "uploads", name: "Networks opened", color: colors[0] },
                { key: "sessions", name: "Working copies", color: theme.palette.info.main },
                { key: "validations", name: "Validations", color: theme.palette.success.main },
                { key: "exports", name: "Exports", color: theme.palette.warning.main },
              ]}
              height={240}
              format={fmtInt}
            />
          ) : (
            <Box sx={{ height: 240 }} />
          )}
        </Panel>
        <Panel title="The working copies' journey">{d ? <Funnel funnel={d.funnel} /> : null}</Panel>
      </Box>
      <Panel title="Feeds" subtitle="Each network, by its agencies" padded={false}>
        <DataTable
          testId="admin-feeds"
          initialQuery={initialQuery}
          loading={loading}
          rows={d ? d.feeds : []}
          getRowId={(f) => f.fingerprint}
          searchText={(f) => [f.label, ...(f.agencies || []), ...(f.urls || [])].join(" ")}
          searchPlaceholder="Search an agency or a URL"
          initialSort={{ key: "lastSeen", dir: "desc" }}
          csvName="feeds"
          columns={[
            {
              key: "label",
              label: "Network",
              render: (f) => (
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" noWrap sx={{ fontWeight: 600, maxWidth: 320 }}>
                    {f.label}
                  </Typography>
                  {f.urls && f.urls[0] ? (
                    <Typography variant="caption" color="text.secondary" noWrap component="div" sx={{ maxWidth: 320 }}>
                      {f.urls[0]}
                    </Typography>
                  ) : null}
                </Box>
              ),
            },
            { key: "agencyCount", label: "Agencies", align: "right" },
            { key: "uploads", label: "Opened", align: "right", render: (f) => fmtInt(f.uploads) },
            { key: "sessions", label: "Copies", align: "right", render: (f) => fmtInt(f.sessions) },
            { key: "lastRoutes", label: "Routes", align: "right", render: (f) => fmtInt(f.lastRoutes) },
            { key: "lastStops", label: "Stops", align: "right", render: (f) => fmtInt(f.lastStops) },
            { key: "lastTrips", label: "Trips", align: "right", render: (f) => fmtInt(f.lastTrips) },
            { key: "lastSize", label: "Size", align: "right", render: (f) => fmtBytes((f.lastSize || 0) * 1024) },
            { key: "hasShapes", label: "Shapes", value: (f) => (f.hasShapes ? 1 : 0), render: (f) => (f.hasShapes ? "Yes" : "—") },
            { key: "lastSeen", label: "Last opened", render: (f) => fmtRelative(f.lastSeen) },
          ]}
        />
      </Panel>
    </>
  );
}

function ProjectsTab({ refreshKey, go, initialQuery }) {
  const q = useAdminQuery(fetchProjects, [refreshKey]);
  const rows = useMemo(() => (q.data ? q.data.projects : []), [q.data]);
  const totals = useMemo(() => ({ n: rows.length, delivered: rows.filter((p) => p.deliveries).length, bytes: rows.reduce((a, p) => a + (p.bytes || 0), 0), browser: rows.filter((p) => !p.owner_user_id).length }), [rows]);
  return (
    <>
      <ErrorNotice error={q.error} onRetry={q.reload} />
      <Grid min={190} sx={{ mb: 2 }}>
        <Kpi label="Projects" loading={q.loading && !q.data} value={fmtInt(totals.n)} sub={`${totals.browser} kept by a browser, without an account`} />
        <Kpi label="Delivered at least once" loading={q.loading && !q.data} value={fmtInt(totals.delivered)} sub={totals.n ? `${fmtPct(totals.delivered / totals.n)} of projects` : null} />
        <Kpi label="Documents stored" loading={q.loading && !q.data} value={fmtBytes(totals.bytes)} sub="the projects' own data" />
      </Grid>
      <Panel padded={false} sx={{ pt: 2 }}>
        <DataTable
          testId="admin-projects"
          initialQuery={initialQuery}
          loading={q.loading && !q.data}
          rows={rows}
          getRowId={(p) => p.id}
          onRowClick={(p) => p.owner && p.owner.email && go("accounts", p.owner_user_id)}
          searchText={(p) => [p.name, p.network, p.id, p.owner && p.owner.email].join(" ")}
          searchPlaceholder="Search a project, a network, an owner"
          initialSort={{ key: "updated_at", dir: "desc" }}
          csvName="projects"
          emptyTitle={q.data && !q.data.enabled ? "The workspace is off" : "No project yet"}
          columns={[
            { key: "name", label: "Project", render: (p) => <Box><Typography variant="body2" sx={{ fontWeight: 600 }}>{p.name || "Untitled"}</Typography><Typography variant="caption" color="text.secondary">{p.network || "—"}</Typography></Box>, csv: (p) => p.name },
            { key: "network", label: "Network", hidden: true },
            { key: "owner", label: "Owner", value: (p) => (p.owner ? p.owner.email || "" : ""), render: (p) => (p.owner ? p.owner.email || "Deleted account" : <Typography variant="body2" color="text.secondary">A browser</Typography>), csv: (p) => (p.owner ? p.owner.email : "browser") },
            { key: "draft_kind", label: "Draft", render: (p) => (p.draft_kind ? <StatusPill tone={p.draft_kind === "brief" ? "ai" : "warning"} label={DRAFT_KINDS[p.draft_kind]} /> : "—") },
            { key: "versions", label: "Versions", align: "right" },
            { key: "deliveries", label: "Delivered", align: "right" },
            { key: "members", label: "Members", align: "right" },
            { key: "documents", label: "Docs", align: "right" },
            { key: "bytes", label: "Size", align: "right", render: (p) => fmtBytes(p.bytes) },
            { key: "updated_at", label: "Updated", render: (p) => <Tooltip title={fmtDateTime(p.updated_at)}><span>{fmtRelative(p.updated_at)}</span></Tooltip> },
            { key: "retention_until", label: "Kept until", render: (p) => fmtDate(p.retention_until) },
          ]}
        />
      </Panel>
    </>
  );
}

function EventsTab({ refreshKey, go, initialQuery }) {
  const theme = useTheme();
  const [family, setFamily] = useState("");
  const [text, setText] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [pages, setPages] = useState([]);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    const id = setTimeout(() => setQuery(text.trim()), 350);
    return () => clearTimeout(id);
  }, [text]);
  const q = useAdminQuery(() => fetchEvents({ type: family, q: query, limit: 200 }), [family, query, refreshKey]);
  useEffect(() => setPages([]), [family, query, refreshKey]);
  const events = useMemo(() => [...(q.data ? q.data.events : []), ...pages.flatMap((p) => p.events)], [q.data, pages]);
  const nextBefore = pages.length ? pages[pages.length - 1].next_before : q.data ? q.data.next_before : null;
  const families = useMemo(() => {
    const counts = {};
    for (const [type, n] of Object.entries(q.data ? q.data.types : {})) {
      const f = familyOf(type);
      counts[f] = (counts[f] || 0) + n;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [q.data]);
  const more = async () => {
    const page = await fetchEvents({ type: family, q: query, limit: 200, before: nextBefore }).catch(() => null);
    if (page) setPages((p) => [...p, page]);
  };
  return (
    <Panel padded={false} sx={{ pt: 2 }}>
      <ErrorNotice error={q.error} onRetry={q.reload} sx={{ mx: 2.5 }} />
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ px: 2.5, pb: 1.5, flexWrap: "wrap", rowGap: 1 }}>
        <TextField
          size="small"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search the log (an id, a word)"
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
          inputProps={{ "data-testid": "admin-events-search" }}
          sx={{ width: { xs: "100%", sm: 300 } }}
        />
        <Stack direction="row" spacing={0.75} sx={{ flexWrap: "wrap", rowGap: 0.75 }}>
          <Chip size="small" label="All" color={!family ? "primary" : "default"} variant={!family ? "filled" : "outlined"} onClick={() => setFamily("")} sx={{ fontWeight: 600 }} />
          {families.map(([f, n]) => (
            <Chip key={f} size="small" label={`${EVENT_FAMILIES[f] || f} ${fmtInt(n)}`} color={family === f ? "primary" : "default"} variant={family === f ? "filled" : "outlined"} onClick={() => setFamily(family === f ? "" : f)} data-testid={`admin-events-family-${f}`} sx={{ fontWeight: 600, ...TABULAR }} />
          ))}
        </Stack>
      </Stack>
      <DataTable
        testId="admin-events"
        loading={q.loading && !q.data}
        rows={events}
        getRowId={(e) => `${e.ts}|${e.type}|${e.session}|${e.user_id}|${JSON.stringify(e.data).length}`}
        onRowClick={setOpen}
        pageSize={50}
        csvName="events"
        emptyTitle="No event matches"
        columns={[
          { key: "ts", label: "When", render: (e) => <Tooltip title={fmtDateTime(e.ts)}><span style={TABULAR}>{fmtDateTime(e.ts)}</span></Tooltip> },
          { key: "sentence", label: "Event", value: (e) => eventSentence(e), render: (e) => <Typography variant="body2">{eventSentence(e)}</Typography> },
          { key: "type", label: "Type", render: (e) => <Typography sx={{ ...mono, color: "text.secondary" }}>{e.type}</Typography> },
          { key: "email", label: "Account", render: (e) => (e.email ? <Typography variant="body2" sx={{ color: "primary.main" }}>{e.email}</Typography> : <Typography variant="body2" color="text.secondary">—</Typography>) },
          { key: "session", label: "Working copy", render: (e) => (e.session ? <Typography sx={{ ...mono, color: "text.secondary" }}>{String(e.session).slice(0, 8)}</Typography> : "—") },
        ]}
      />
      {nextBefore ? (
        <Box sx={{ textAlign: "center", py: 1.5, borderTop: `1px solid ${theme.palette.divider}` }}>
          <Button size="small" onClick={more} data-testid="admin-events-more">
            Older events
          </Button>
        </Box>
      ) : null}
      <Dialog open={Boolean(open)} onClose={() => setOpen(null)} maxWidth="sm" fullWidth>
        {open ? (
          <>
            <DialogTitle sx={{ fontSize: 16, fontWeight: 650, pr: 6 }}>
              {eventSentence(open)}
              <IconButton onClick={() => setOpen(null)} sx={{ position: "absolute", right: 12, top: 12 }} aria-label="Close">
                <CloseIcon />
              </IconButton>
            </DialogTitle>
            <DialogContent>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1.5 }}>
                {fmtDateTime(open.ts)} · {open.type}
                {open.session ? ` · working copy ${open.session}` : ""}
              </Typography>
              {open.user_id && open.email ? (
                <Button size="small" sx={{ mb: 1.5 }} onClick={() => { setOpen(null); go("accounts", open.user_id); }}>
                  Open {open.email}
                </Button>
              ) : null}
              <Box component="pre" sx={{ ...mono, m: 0, p: 1.75, borderRadius: "8px", bgcolor: "action.hover", overflow: "auto", maxHeight: 360 }}>
                {JSON.stringify(open.data, null, 2)}
              </Box>
            </DialogContent>
          </>
        ) : null}
      </Dialog>
    </Panel>
  );
}

export default function ActivityPage() {
  const { refreshKey, go } = useConsole();
  const [tab, setTab, initialQuery] = useConsoleTab(TABS, "networks");
  return (
    <>
      <PageHeader title="Activity" description="What is done with the product: the networks opened, the projects, every event logged." />
      <Segments
        value={tab}
        onChange={setTab}
        testId="admin-activity-tabs"
        items={[
          { value: "networks", label: "Networks" },
          { value: "projects", label: "Projects" },
          { value: "events", label: "Event log" },
        ]}
      />
      {tab === "networks" ? <NetworksTab refreshKey={refreshKey} initialQuery={initialQuery} /> : null}
      {tab === "projects" ? <ProjectsTab refreshKey={refreshKey} go={go} initialQuery={initialQuery} /> : null}
      {tab === "events" ? <EventsTab refreshKey={refreshKey} go={go} initialQuery={initialQuery} /> : null}
    </>
  );
}
