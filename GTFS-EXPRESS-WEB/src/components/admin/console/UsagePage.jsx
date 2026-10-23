import React, { useState } from "react";
import { Alert, Box, Button, LinearProgress, Stack, Tooltip, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { fetchAiUsage, fetchApiUsage, fetchPerf, resetPerf } from "../adminApi";
import { useConsole, useConsoleTab } from "./ConsoleShell";
import { ConfirmDialog, DataTable, ErrorNotice, Fact, Grid, Kpi, PageHeader, Panel, Segments, TABULAR, useAdminQuery } from "./ui";
import { BarList, DayBars, useFeatureColor } from "./charts";
import { periodText, deltaOf, featureName, fmtCompact, fmtDate, fmtDay, fmtEur, fmtInt, fmtMs, fmtPct, fmtRelative, fmtUsd } from "./format";
import { AccountCell } from "./AccountsPage";

const TABS = ["ai", "api"];
const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 };

function Meter({ label, used, limit }) {
  const pct = limit ? Math.min(100, (100 * used) / limit) : 0;
  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="caption" sx={{ fontWeight: 600, ...TABULAR }}>
          {fmtInt(used)} / {limit == null ? "no cap" : fmtInt(limit)}
        </Typography>
      </Stack>
      <LinearProgress variant="determinate" aria-label={label} value={limit ? pct : 0} color={pct >= 100 ? "error" : pct >= 80 ? "warning" : "primary"} sx={{ height: 6, borderRadius: "12px" }} />
    </Box>
  );
}

function AiTab({ days, refreshKey, go }) {
  const theme = useTheme();
  const featureColor = useFeatureColor();
  const q = useAdminQuery(() => fetchAiUsage(days), [days, refreshKey]);
  const d = q.data;
  const loading = q.loading && !d;
  const features = d ? [...new Set(d.by_feature.map((f) => f.feature))] : [];
  return (
    <>
      <ErrorNotice error={q.error} onRetry={q.reload} />
      <Grid min={190} sx={{ mb: 2 }}>
        <Kpi testId="admin-kpi-ai-cost" label="AI cost" color={theme.palette.ai.main} loading={loading} value={d ? fmtEur(d.totals.eur) : "—"} delta={d ? deltaOf(d.totals.usd, d.usd_prev) : undefined} invert sub={d ? `${fmtUsd(d.totals.usd)} billed by the provider` : null} />
        <Kpi label="Model calls" loading={loading} value={d ? fmtInt(d.totals.calls) : "—"} sub={d && d.totals.calls ? `${fmtEur(d.totals.eur / d.totals.calls)} per call` : null} />
        <Kpi label="Tokens" loading={loading} value={d ? fmtCompact(d.totals.input_tokens + d.totals.output_tokens + d.totals.cache_read_tokens) : "—"} sub={d ? `${fmtCompact(d.totals.input_tokens)} in · ${fmtCompact(d.totals.output_tokens)} out` : null} />
        <Kpi label="Prompt cache" loading={loading} value={d ? fmtPct(d.totals.cache_ratio) : "—"} sub="of the input read from the cache" />
        <Kpi label="Reading companion" color={theme.palette.info.main} loading={loading} value={d ? fmtInt(d.reader.questions) : "—"} sub={d ? `questions this month · ${d.reader.accounts} accounts` : null} />
      </Grid>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "2fr 1fr" }, gap: 2, mb: 2 }}>
        <Panel title="Cost per day, by function" subtitle="USD as billed">
          {d ? <DayBars testId="admin-ai-trend" data={d.by_day} format={fmtUsd} series={features.map((f) => ({ key: f, name: featureName(f), color: featureColor(f) }))} height={240} /> : <Box sx={{ height: 240 }} />}
        </Panel>
        <Panel title="Per function">
          {d ? <BarList items={d.by_feature.map((f) => ({ key: f.feature, label: featureName(f.feature), value: f.usd, display: fmtEur(f.eur), sub: `${fmtInt(f.calls)} calls · ${fmtPct(d.totals.usd ? f.usd / d.totals.usd : 0)}`, color: featureColor(f.feature) }))} empty="No AI call in the period." /> : null}
        </Panel>
      </Box>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "2fr 1fr" }, gap: 2, mb: 2 }}>
        <Panel title="Accounts" subtitle="Their AI cost in the period, against their envelope now" padded={false}>
          <DataTable
            testId="admin-ai-accounts"
            loading={loading}
            rows={d ? d.accounts : []}
            getRowId={(r) => r.user_id}
            onRowClick={(r) => r.email && go("accounts", r.user_id)}
            searchText={(r) => [r.email, r.display_name, r.organisation].join(" ")}
            initialSort={{ key: "usd", dir: "desc" }}
            csvName="ai-by-account"
            pageSize={10}
            emptyTitle="No account used the AI in the period"
            columns={[
              { key: "account", label: "Account", value: (r) => r.email || "", render: (r) => (r.email ? <AccountCell user={r} /> : "Deleted account") },
              { key: "usd", label: "Cost", align: "right", render: (r) => <Tooltip title={fmtUsd(r.usd)}><span>{fmtEur(r.eur)}</span></Tooltip>, csv: (r) => r.eur },
              { key: "calls", label: "Calls", align: "right", render: (r) => fmtInt(r.calls) },
              {
                key: "allowance",
                label: "Envelope",
                value: (r) => (r.allowance ? r.allowance.spent_eur / Math.max(r.allowance.limit_eur, 0.01) : -1),
                render: (r) =>
                  r.allowance ? (
                    <Box sx={{ minWidth: 120 }}>
                      <Typography variant="caption" sx={TABULAR}>
                        {fmtEur(r.allowance.spent_eur)} / {fmtEur(r.allowance.limit_eur)} {r.allowance.kind === "trial" ? "trial" : "month"}
                      </Typography>
                      <LinearProgress variant="determinate" aria-label="AI allowance spent" value={Math.min(100, (100 * r.allowance.spent_eur) / Math.max(r.allowance.limit_eur, 0.01))} color={r.allowance.exhausted ? "error" : "primary"} sx={{ height: 4, borderRadius: "8px" }} />
                    </Box>
                  ) : (
                    <Typography variant="caption" color="text.secondary">
                      none
                    </Typography>
                  ),
                csv: (r) => (r.allowance ? `${r.allowance.spent_eur}/${r.allowance.limit_eur}` : ""),
              },
              { key: "last_at", label: "Last call", render: (r) => fmtRelative(r.last_at) },
            ]}
          />
        </Panel>
        <Stack spacing={2}>
          <Panel title="Per model">
            {d ? <BarList items={d.by_model.map((m) => ({ key: m.model, label: m.model, value: m.usd, display: fmtEur(m.eur), sub: `${fmtInt(m.calls)} calls · ${fmtCompact(m.input_tokens)} in · ${fmtCompact(m.output_tokens)} out` }))} empty="No AI call in the period." /> : null}
          </Panel>
          <Panel title="Limits, now" subtitle="Model calls over the last 24 hours">
            {d ? (
              <Stack spacing={1.75}>
                <Meter label="Whole server" used={d.limiter.global.used} limit={d.limiter.global.limit} />
                {d.limiter.unpaid ? <Meter label="Without a licence" used={d.limiter.unpaid.used} limit={d.limiter.unpaid.limit} /> : null}
                <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1.5, pt: 0.5 }}>
                  <Fact label="Trial envelope">{fmtEur(d.envelopes.trial_eur)}</Fact>
                  <Fact label="Licence, per month">{fmtEur(d.envelopes.licence_month_eur)}</Fact>
                  <Fact label="Reading companion, per month">{`${fmtEur(d.envelopes.reader_month_eur)} · ${d.reader.limit} questions`}</Fact>
                  <Fact label="Without an account">{fmtEur(d.totals.anonymous_usd)}</Fact>
                </Box>
                {d.limiter.budget && d.limiter.budget.warnings && d.limiter.budget.warnings.length ? (
                  <Alert severity="warning" variant="outlined" sx={{ borderRadius: "8px" }}>
                    {d.limiter.budget.warnings.join(" ")}
                  </Alert>
                ) : null}
              </Stack>
            ) : null}
          </Panel>
        </Stack>
      </Box>
    </>
  );
}

function ApiTab({ days, refreshKey, go }) {
  const theme = useTheme();
  const q = useAdminQuery(() => fetchApiUsage(days), [days, refreshKey]);
  const perf = useAdminQuery(fetchPerf, [refreshKey]);
  const [confirm, setConfirm] = useState(false);
  const d = q.data;
  const loading = q.loading && !d;
  const t = d ? d.totals : null;
  return (
    <>
      <ErrorNotice error={q.error} onRetry={q.reload} />
      <Grid min={180} sx={{ mb: 2 }}>
        <Kpi testId="admin-kpi-api-calls" label="Calls" loading={loading} value={t ? fmtCompact(t.calls) : "—"} delta={d ? deltaOf(t.calls, d.calls_prev) : undefined} />
        <Kpi label="Accounts calling" loading={loading} value={t ? fmtInt(t.accounts) : "—"} sub="signed in, besides visitors" />
        <Kpi label="Refused" color={theme.palette.warning.main} loading={loading} value={t ? fmtInt(t.refused) : "—"} sub={t && t.calls ? `${fmtPct(t.refused / t.calls, 1)} of calls (4xx)` : null} />
        <Kpi label="Rate-limited" color={theme.palette.warning.main} loading={loading} value={t ? fmtInt(t.rate_limited) : "—"} sub="answered 429" />
        <Kpi label="Server errors" color={theme.palette.error.main} loading={loading} value={t ? fmtInt(t.server_errors) : "—"} sub={t && t.calls ? `${fmtPct(t.server_errors / t.calls, 2)} of calls` : null} onClick={() => go("operations", null, { tab: "errors" })} />
        <Kpi label="Mean time" loading={loading} value={t ? fmtMs(t.avg_ms) : "—"} sub="per call, server side" />
      </Grid>
      <Panel title="Calls per day" sx={{ mb: 2 }}>
        {d ? (
          <DayBars
            data={d.by_day.map((x) => ({ ...x, ok: Math.max(0, x.calls - x.refused - x.rate_limited - x.server_errors) }))}
            series={[
              { key: "ok", name: "Answered", color: theme.palette.primary.main },
              { key: "refused", name: "Refused", color: theme.palette.warning.light },
              { key: "rate_limited", name: "Rate-limited", color: theme.palette.warning.main },
              { key: "server_errors", name: "Server errors", color: theme.palette.error.main },
            ]}
            format={fmtInt}
            height={220}
          />
        ) : (
          <Box sx={{ height: 220 }} />
        )}
      </Panel>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", xl: "1fr 1fr" }, gap: 2, mb: 2 }}>
        <Panel title="Accounts" subtitle="Who called the API in the period" padded={false}>
          <DataTable
            testId="admin-api-accounts"
            loading={loading}
            rows={d ? d.accounts : []}
            getRowId={(r) => r.user_id || "anonymous"}
            onRowClick={(r) => r.email && go("accounts", r.user_id)}
            searchText={(r) => [r.email, r.display_name, r.organisation].join(" ")}
            initialSort={{ key: "calls", dir: "desc" }}
            csvName="api-by-account"
            pageSize={10}
            columns={[
              { key: "account", label: "Account", value: (r) => (r.anonymous ? "" : r.email || ""), render: (r) => (r.anonymous ? <Typography variant="body2" color="text.secondary">Visitors without an account</Typography> : r.email ? <AccountCell user={r} /> : "Deleted account"), csv: (r) => (r.anonymous ? "anonymous" : r.email) },
              { key: "calls", label: "Calls", align: "right", render: (r) => fmtInt(r.calls) },
              { key: "routes", label: "Routes", align: "right" },
              { key: "refused", label: "Refused", align: "right", value: (r) => r.refused + r.rate_limited, render: (r) => fmtInt(r.refused + r.rate_limited) },
              { key: "server_errors", label: "5xx", align: "right", render: (r) => (r.server_errors ? <Typography variant="body2" color="error.main" sx={{ fontWeight: 600, ...TABULAR }}>{r.server_errors}</Typography> : "0") },
              { key: "last_day", label: "Last day", render: (r) => fmtDay(r.last_day) },
            ]}
          />
        </Panel>
        <Panel title="Routes" subtitle="Each route template, its use and its answers" padded={false}>
          <DataTable
            testId="admin-api-routes"
            loading={loading}
            rows={d ? d.routes : []}
            getRowId={(r) => r.route}
            searchText={(r) => r.route}
            searchPlaceholder="Search a route"
            initialSort={{ key: "calls", dir: "desc" }}
            csvName="api-by-route"
            pageSize={10}
            columns={[
              { key: "route", label: "Route", render: (r) => <Typography sx={mono} noWrap title={r.route}>{r.route}</Typography>, cellSx: { maxWidth: 340 } },
              { key: "calls", label: "Calls", align: "right", render: (r) => fmtInt(r.calls) },
              { key: "accounts", label: "Accounts", align: "right" },
              { key: "refused", label: "Refused", align: "right", value: (r) => r.refused + r.rate_limited, render: (r) => fmtInt(r.refused + r.rate_limited) },
              { key: "server_errors", label: "5xx", align: "right", render: (r) => (r.server_errors ? <Typography variant="body2" color="error.main" sx={{ fontWeight: 600, ...TABULAR }}>{r.server_errors}</Typography> : "0") },
              { key: "avg_ms", label: "Mean", align: "right", render: (r) => fmtMs(r.avg_ms) },
            ]}
          />
        </Panel>
      </Box>
      <Panel
        title="Live latency"
        subtitle={perf.data ? `The last ${fmtInt(perf.data.bufferSizePerRoute)} calls of each route since ${fmtDate(new Date(perf.data.startedAt).toISOString())} · ${perf.data.routeCount} routes` : "Since the server started"}
        padded={false}
        actions={
          <Button size="small" color="inherit" onClick={() => setConfirm(true)}>
            Reset
          </Button>
        }
      >
        <DataTable
          testId="admin-perf"
          loading={perf.loading && !perf.data}
          rows={perf.data ? perf.data.routes : []}
          getRowId={(r) => r.route}
          searchText={(r) => r.route}
          searchPlaceholder="Search a route"
          initialSort={{ key: "p95", dir: "desc" }}
          csvName="latency"
          pageSize={10}
          columns={[
            { key: "route", label: "Route", render: (r) => <Typography sx={mono} noWrap title={r.route}>{r.route}</Typography>, cellSx: { maxWidth: 380 } },
            { key: "total", label: "Calls", align: "right", render: (r) => fmtInt(r.total) },
            { key: "p50", label: "p50", align: "right", render: (r) => fmtMs(r.p50) },
            { key: "p95", label: "p95", align: "right", render: (r) => <Typography variant="body2" sx={{ fontWeight: r.p95 > 1000 ? 650 : 400, color: r.p95 > 2000 ? "error.main" : r.p95 > 1000 ? "warning.main" : "inherit", ...TABULAR }}>{fmtMs(r.p95)}</Typography> },
            { key: "p99", label: "p99", align: "right", render: (r) => fmtMs(r.p99) },
            { key: "max", label: "Max", align: "right", render: (r) => fmtMs(r.max) },
            { key: "errors", label: "5xx", align: "right" },
          ]}
        />
      </Panel>
      <ConfirmDialog
        open={confirm}
        title="Reset the live latency?"
        body="Every route's samples are dropped; the percentiles start again from the next calls. The counts per account are kept."
        confirmLabel="Reset"
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          await resetPerf().catch(() => null);
          setConfirm(false);
          perf.reload();
        }}
      />
    </>
  );
}

export default function UsagePage() {
  const { days, refreshKey, go } = useConsole();
  const [tab, setTab] = useConsoleTab(TABS, "ai");
  return (
    <>
      <PageHeader title="Consumption" description={`Who used what over ${periodText(days)}: the AI in money, the API in calls.`} />
      <Segments
        value={tab}
        onChange={setTab}
        testId="admin-usage-tabs"
        items={[
          { value: "ai", label: "AI" },
          { value: "api", label: "API" },
        ]}
      />
      {tab === "ai" ? <AiTab days={days} refreshKey={refreshKey} go={go} /> : <ApiTab days={days} refreshKey={refreshKey} go={go} />}
    </>
  );
}
