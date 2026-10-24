import React from "react";
import { Box, ButtonBase, LinearProgress, Stack, Typography, alpha } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import ReportProblemOutlinedIcon from "@mui/icons-material/ReportProblemOutlined";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import PeopleAltOutlinedIcon from "@mui/icons-material/PeopleAltOutlined";
import WorkspacePremiumOutlinedIcon from "@mui/icons-material/WorkspacePremiumOutlined";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import SwapVertOutlinedIcon from "@mui/icons-material/SwapVertOutlined";
import TrendingUpOutlinedIcon from "@mui/icons-material/TrendingUpOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import { fetchOverview } from "../adminApi";
import { useConsole } from "./ConsoleShell";
import { ErrorNotice, Fact, Grid, Kpi, PageHeader, Panel, TABULAR, useAdminQuery } from "./ui";
import { BarList, DayBars, FunnelSteps, SplitBar, useFeatureColor } from "./charts";
import { attentionText, periodText, deltaOf, featureName, fmtBytes, fmtCompact, fmtDuration, fmtEur, fmtInt, fmtMs, fmtPct, fmtUsd, LICENCE_SOURCES, stepName } from "./format";

const ATTENTION_TARGET = {
  quotes_new: ["revenue", { tab: "quotes" }],
  trials_ending: ["revenue", { tab: "trials" }],
  grants_ending: ["revenue", { tab: "grants" }],
  subscriptions_cancelling: ["revenue", { tab: "subscriptions" }],
  payments_failing: ["revenue", { tab: "subscriptions" }],
  allowance_exhausted: ["usage", { tab: "ai" }],
  server_errors: ["operations", { tab: "errors" }],
  capacity: ["operations", { tab: "sessions" }],
  ai_budget: ["usage", { tab: "ai" }],
};

function AttentionList({ items, go }) {
  const theme = useTheme();
  if (!items) return null;
  if (!items.length)
    return (
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 3, color: "success.main" }} data-testid="admin-attention-clear">
        <CheckCircleOutlineIcon fontSize="small" />
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          Nothing needs you right now.
        </Typography>
      </Stack>
    );
  const iconOf = (sev) => (sev === "alert" ? ErrorOutlineIcon : sev === "action" ? ReportProblemOutlinedIcon : InfoOutlinedIcon);
  const colorOf = (sev) => (sev === "alert" ? theme.palette.error.main : sev === "action" ? theme.palette.warning.main : theme.palette.info.main);
  return (
    <Panel title="Needs your attention" padded={false} sx={{ mb: 3 }} testId="admin-attention">
      <Box>
        {items.map((a) => {
          const Icon = iconOf(a.severity);
          const color = colorOf(a.severity);
          const [section, params] = ATTENTION_TARGET[a.kind] || ["overview", null];
          const names = (a.items || []).slice(0, 3).map((i) => i.organisation || i.display_name || i.email || i.name).filter(Boolean);
          return (
            <ButtonBase
              key={a.kind}
              onClick={() => go(section, null, params)}
              data-testid={`admin-attention-${a.kind}`}
              sx={{ width: "100%", justifyContent: "flex-start", textAlign: "left", px: 2.5, py: 1.25, gap: 1.5, borderTop: `1px solid ${theme.palette.divider}`, "&:hover": { bgcolor: "action.hover" } }}
            >
              <Box sx={{ width: 30, height: 30, borderRadius: "8px", display: "grid", placeItems: "center", bgcolor: alpha(color, 0.12), color, flexShrink: 0 }}>
                <Icon sx={{ fontSize: 18 }} />
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {attentionText(a)}
                </Typography>
                {names.length ? (
                  <Typography variant="caption" color="text.secondary" noWrap component="div">
                    {names.join(" · ")}
                    {(a.items || []).length > 3 ? ` and ${(a.items || []).length - 3} more` : ""}
                  </Typography>
                ) : null}
              </Box>
              <ChevronRightIcon sx={{ color: "text.secondary" }} />
            </ButtonBase>
          );
        })}
      </Box>
    </Panel>
  );
}

export default function OverviewPage() {
  const theme = useTheme();
  const { days, refreshKey, go } = useConsole();
  const featureColor = useFeatureColor();
  const q = useAdminQuery(() => fetchOverview(days), [days, refreshKey], { refreshMs: 60_000 });
  const d = q.data;
  const loading = q.loading && !d;
  const prev = days === 1 ? "vs yesterday" : `vs the ${days} days before`;
  const way = d && d.funnel ? d.funnel : null;
  const modify = way ? way.steps["modify.click"] : null;
  const link = (label, onClick) => (
    <ButtonBase onClick={onClick} sx={{ fontSize: 12.5, color: "primary.main", fontWeight: 600, borderRadius: "4px", px: 0.5 }}>
      {label}
    </ButtonBase>
  );

  return (
    <>
      <PageHeader title="Overview" description={`Every figure over ${periodText(days)}, against as many days before; what runs now is said so.`} />
      <ErrorNotice error={q.error} onRetry={q.reload} />
      <AttentionList items={d ? d.attention : null} go={go} />

      <Grid min={170} sx={{ mb: 2 }}>
        <Kpi
          testId="admin-kpi-accounts"
          icon={<PeopleAltOutlinedIcon />}
          label="Active accounts"
          loading={loading}
          value={d ? fmtInt(d.accounts.active) : "—"}
          delta={d ? deltaOf(d.accounts.active, d.accounts.active_prev) : undefined}
          sub={d ? `${fmtInt(d.accounts.new)} new · ${fmtInt(d.accounts.total)} in all` : null}
          onClick={() => go("accounts")}
        />
        <Kpi
          testId="admin-kpi-modify"
          icon={<EditOutlinedIcon />}
          label="« Modifier » clicks"
          loading={loading}
          value={modify ? fmtInt(modify.events) : "—"}
          delta={modify ? deltaOf(modify.events, modify.events_prev) : undefined}
          sub={modify ? `${fmtInt(modify.people)} ${modify.people === 1 ? "person" : "people"} · ${fmtInt(way.steps["offer.shown"].events)} offers shown` : null}
          onClick={() => go("funnel")}
        />
        <Kpi
          testId="admin-kpi-licences"
          icon={<WorkspacePremiumOutlinedIcon />}
          color={theme.palette.success.main}
          label="Licences running now"
          loading={loading}
          value={d ? fmtInt(d.licences.active) : "—"}
          sub={d ? `${d.licences.by_source.subscription} paid · ${d.licences.by_source.admin} granted · ${d.licences.by_source.trial} trials` : null}
          onClick={() => go("revenue")}
        />
        <Kpi
          testId="admin-kpi-trials"
          icon={<TrendingUpOutlinedIcon />}
          color={theme.palette.info.main}
          label="Trial conversion"
          loading={loading}
          value={d ? fmtPct(d.licences.conversion_rate) : "—"}
          sub={d ? `${d.licences.trials_converted} of the ${d.licences.trials_started} trials started in the period hold a licence` : null}
          onClick={() => go("revenue", null, { tab: "trials" })}
        />
        <Kpi
          testId="admin-kpi-ai"
          icon={<AutoAwesomeOutlinedIcon />}
          color={theme.palette.ai.main}
          label="AI cost"
          loading={loading}
          value={d ? fmtEur(d.ai.eur) : "—"}
          delta={d ? deltaOf(d.ai.usd, d.ai.usd_prev) : undefined}
          invert
          sub={d ? `${fmtUsd(d.ai.usd)} billed · ${fmtInt(d.ai.calls)} calls` : null}
          spark={d ? d.ai.by_day : null}
          sparkKey="usd"
          onClick={() => go("usage", null, { tab: "ai" })}
        />
        <Kpi
          testId="admin-kpi-api"
          icon={<SwapVertOutlinedIcon />}
          color={theme.palette.primary.main}
          label="API calls"
          loading={loading}
          value={d ? fmtCompact(d.api.calls) : "—"}
          delta={d ? deltaOf(d.api.calls, d.api.calls_prev) : undefined}
          sub={d ? `${fmtInt(d.api.server_errors)} server errors · ${fmtInt(d.api.rate_limited)} rate-limited` : null}
          spark={d ? d.api.by_day : null}
          sparkKey="calls"
          onClick={() => go("usage", null, { tab: "api" })}
        />
      </Grid>

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "2fr 1fr" }, gap: 2, mb: 2 }}>
        <Panel title="The way to the licence" subtitle={way && way.counted_since ? "People at each step · your own accounts left out" : "Counted from this version on"} actions={link("Conversion", () => go("funnel"))} testId="admin-overview-funnel">
          {way ? <FunnelSteps compact steps={way.funnel.filter((f) => f.step !== "checkout.opened").map((f) => ({ key: f.step, label: stepName(f.step), value: f.people }))} format={fmtInt} /> : <Box sx={{ height: 200 }} />}
        </Panel>
        <Panel title="Where the AI goes" subtitle="Cost per function">
          {d ? (
            <BarList
              testId="admin-ai-features"
              items={d.ai.by_feature.map((f) => ({ key: f.feature, label: featureName(f.feature), value: f.usd, display: fmtEur(f.eur), sub: `${fmtInt(f.calls)} calls`, color: featureColor(f.feature) }))}
              empty="No AI call in the period."
            />
          ) : null}
        </Panel>
      </Box>

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "2fr 1fr" }, gap: 2, mb: 2 }}>
        <Panel title="AI cost per day" subtitle={`USD as billed by the provider · ${prev}`} actions={link("Consumption", () => go("usage", null, { tab: "ai" }))}>
          {d ? <DayBars data={d.ai.by_day} series={[{ key: "usd", name: "Cost", color: theme.palette.ai.main }]} format={(v) => fmtUsd(v)} height={220} /> : <Box sx={{ height: 220 }} />}
        </Panel>
        <Panel title="Most active accounts" subtitle="AI cost, then calls">
          {d ? (
            <BarList
              testId="admin-top-accounts"
              items={d.top_accounts.map((a) => ({ key: a.user_id, label: a.display_name || a.email || "Deleted account", sub: [a.organisation, `${fmtInt(a.calls)} calls`].filter(Boolean).join(" · "), value: a.usd || a.calls / 1e6, display: fmtEur(a.eur), onClick: a.email ? () => go("accounts", a.user_id) : undefined }))}
              empty="No account active in the period."
            />
          ) : null}
        </Panel>
      </Box>

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "2fr 1fr" }, gap: 2, mb: 2 }}>
        <Panel title="API calls per day" subtitle="Calls and server errors">
          {d ? (
            <DayBars
              data={d.api.by_day.map((x) => ({ ...x, ok: Math.max(0, x.calls - x.errors) }))}
              series={[
                { key: "ok", name: "Calls", color: alpha(theme.palette.primary.main, 0.75) },
                { key: "errors", name: "Server errors", color: theme.palette.error.main },
              ]}
              height={220}
              format={fmtInt}
            />
          ) : (
            <Box sx={{ height: 220 }} />
          )}
        </Panel>
        <Panel title="Server" actions={<ButtonBase onClick={() => go("operations")} sx={{ fontSize: 12.5, color: "primary.main", fontWeight: 600, borderRadius: "4px", px: 0.5 }}>Operations</ButtonBase>}>
          {d ? (
            <Stack spacing={1.75}>
              <Box>
                <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
                  <Typography variant="caption" color="text.secondary">
                    Working copies
                  </Typography>
                  <Typography variant="caption" sx={{ fontWeight: 600, ...TABULAR }}>
                    {d.health.active_sessions} / {d.health.max_sessions}
                  </Typography>
                </Stack>
                <LinearProgress
                  variant="determinate"
                  aria-label="Working copies"
                  value={Math.min(100, (100 * d.health.active_sessions) / Math.max(1, d.health.max_sessions))}
                  color={d.health.active_sessions >= d.health.max_sessions * 0.8 ? "warning" : "primary"}
                  sx={{ height: 6, borderRadius: "12px" }}
                />
              </Box>
              <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
                <Fact label="Up for">{fmtDuration(d.health.uptime_s * 1000)}</Fact>
                <Fact label="Memory">{fmtBytes(d.health.memory_rss)}</Fact>
                <Fact label="Server errors, 24 h">{fmtInt(d.health.server_errors_24h)}</Fact>
                <Fact label="Slowest route (p95)">{d.health.slowest ? fmtMs(d.health.slowest.p95) : "—"}</Fact>
              </Box>
            </Stack>
          ) : null}
        </Panel>
      </Box>

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, gap: 2 }}>
        <Panel title="Licences by source" subtitle="Running now">
          {d ? (
            <SplitBar
              parts={Object.entries(LICENCE_SOURCES).map(([k, label]) => ({ key: k, label, value: d.licences.by_source[k] || 0, color: { owner: theme.palette.text.secondary, subscription: theme.palette.success.main, admin: theme.palette.primary.main, trial: theme.palette.info.main }[k] }))}
              format={fmtInt}
            />
          ) : null}
        </Panel>
        <Panel title="Work done" subtitle="Projects of the workspace over the period">
          {d && d.work ? (
            <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
              <Fact label="Created">{fmtInt(d.work.projects_created)}</Fact>
              <Fact label="Worked on">{fmtInt(d.work.projects_active)}</Fact>
              <Fact label="Versions applied">{fmtInt(d.work.versions_applied)}</Fact>
              <Fact label="Deliveries">{fmtInt(d.work.deliveries)}</Fact>
              <Fact label="Projects in all, now">{fmtInt(d.work.projects)}</Fact>
            </Box>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {d ? "The workspace is off." : ""}
            </Typography>
          )}
        </Panel>
      </Box>
    </>
  );
}
