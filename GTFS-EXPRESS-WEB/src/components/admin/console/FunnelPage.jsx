// A visitor is counted once a day (its key changes every day); the operator's own accounts are left out.

import React, { useMemo, useState } from "react";
import { Box, Chip, Stack, Typography, alpha } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import TravelExploreOutlinedIcon from "@mui/icons-material/TravelExploreOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import SellOutlinedIcon from "@mui/icons-material/SellOutlined";
import LoginOutlinedIcon from "@mui/icons-material/LoginOutlined";
import HourglassTopOutlinedIcon from "@mui/icons-material/HourglassTopOutlined";
import ShoppingCartOutlinedIcon from "@mui/icons-material/ShoppingCartOutlined";
import PrintOutlinedIcon from "@mui/icons-material/PrintOutlined";
import { fetchFunnel } from "../adminApi";
import { useConsole } from "./ConsoleShell";
import { DataTable, EmptyState, ErrorNotice, Grid, Kpi, PageHeader, Panel, StatusPill, TABULAR, useAdminQuery } from "./ui";
import { BarList, DayBars, FunnelSteps } from "./charts";
import { AccountCell } from "./AccountsPage";
import { periodText, deltaOf, fmtDate, fmtInt, fmtPct, fmtRelative, licenceLabel, licenceTone, ROLES, sourceName, stepName } from "./format";

const pluralOf = (n, one, many) => `${fmtInt(n)} ${n === 1 ? one : many}`;
// A lead: an account that clicked « Modifier », saw the offer or chose a way in it, and holds no licence now.
const isLead = (a) => (a.offer_shown > 0 || a.offer_choice > 0 || a.modify_click > 0) && !(a.licence && a.licence.active);

function SourceList({ items, empty, testId }) {
  const theme = useTheme();
  return (
    <BarList
      testId={testId}
      items={(items || []).map((s) => ({ key: s.source, label: sourceName(s.source), value: s.events, display: fmtInt(s.events), sub: pluralOf(s.people, "person", "people"), color: theme.palette.primary.main }))}
      empty={empty}
    />
  );
}

export default function FunnelPage() {
  const theme = useTheme();
  const { days, refreshKey, go } = useConsole();
  const q = useAdminQuery(() => fetchFunnel(days), [days, refreshKey], { refreshMs: 60_000 });
  const d = q.data;
  const loading = q.loading && !d;
  const step = (s) => (d ? d.steps[s] : null) || { events: 0, people: 0, events_prev: 0, people_prev: 0 };
  const visits = step("visit").people;
  const ofVisits = (n) => (visits ? fmtPct(n / visits, n / visits < 0.1 ? 1 : 0) : "—");
  const period = periodText(days);
  const sheetsLocked = d ? ((d.sources["sheets.print"] || []).find((s) => s.source === "locked") || {}).events || 0 : 0;
  const newAccounts = d ? ((d.sources["signin.done"] || []).find((s) => s.source === "new") || {}).events || 0 : 0;

  const [leadsOnly, setLeadsOnly] = useState(false);
  const accounts = useMemo(() => (d ? d.accounts : []), [d]);
  const leads = useMemo(() => accounts.filter(isLead), [accounts]);
  const funnel = useMemo(() => (d ? d.funnel.map((f) => ({ key: f.step, label: stepName(f.step), value: f.people, prev: f.people_prev })) : []), [d]);

  const columns = [
    { key: "account", label: "Account", value: (a) => (a.display_name || a.email || "").toLowerCase(), render: (a) => (a.email ? <AccountCell user={a} /> : <Typography variant="body2" color="text.secondary">Deleted account</Typography>), csv: (a) => a.email || "" },
    {
      key: "organisation",
      label: "Organisation",
      value: (a) => a.organisation || "",
      render: (a) =>
        a.organisation ? (
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" noWrap sx={{ maxWidth: 200 }}>
              {a.organisation}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap component="div">
              {ROLES[a.org_role] || ""}
            </Typography>
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">—</Typography>
        ),
      csv: (a) => [a.organisation, ROLES[a.org_role]].filter(Boolean).join(" · "),
    },
    { key: "licence", label: "Licence now", value: (a) => (a.licence && a.licence.active ? a.licence.source : "~"), render: (a) => <StatusPill tone={licenceTone(a.licence)} label={licenceLabel(a.licence)} />, csv: (a) => licenceLabel(a.licence) },
    { key: "modify_click", label: "« Modifier »", align: "right", value: (a) => a.modify_click || 0, render: (a) => fmtInt(a.modify_click) },
    { key: "offer_shown", label: "Offer seen", align: "right", value: (a) => a.offer_shown || 0, render: (a) => fmtInt(a.offer_shown) },
    { key: "signin_open", label: "Sign-in opened", align: "right", value: (a) => a.signin_open || 0, render: (a) => fmtInt(a.signin_open) },
    {
      key: "choices",
      label: "Chose",
      value: (a) => (a.choices || []).join(" "),
      sortable: false,
      render: (a) =>
        a.choices && a.choices.length ? (
          <Stack direction="row" spacing={0.5}>
            {a.choices.map((c) => (
              <Chip key={c} size="small" label={sourceName(c)} variant="outlined" sx={{ height: 22, fontSize: 11.5, fontWeight: 600 }} />
            ))}
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">—</Typography>
        ),
      csv: (a) => (a.choices || []).join(" "),
    },
    { key: "first_at", label: "First seen", value: (a) => a.first_at || "", render: (a) => fmtDate(a.first_at) },
    { key: "last_at", label: "Last seen", value: (a) => a.last_at || "", render: (a) => fmtRelative(a.last_at) },
  ];

  const nothingYet = d && !d.counted_since;

  return (
    <>
      <PageHeader
        title="Conversion"
        description={`The way from a visit to the licence over ${period}, against as many days before. A visitor counts once a day; a visitor who signs in is given its clicks of that day. Your own accounts are left out.`}
      >
        {d && d.counted_since ? (
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.75, ...TABULAR }}>
            Counted since {fmtDate(d.counted_since)}
            {d.operator_events_left_out ? ` · ${pluralOf(d.operator_events_left_out, "step", "steps")} of your own left out` : ""}
          </Typography>
        ) : null}
      </PageHeader>
      <ErrorNotice error={q.error} onRetry={q.reload} />
      {nothingYet ? (
        <Panel>
          <EmptyState title="Nothing counted yet" text="The steps are counted from this version on: the first visits, clicks on « Modifier » and sign-ins will show here." />
        </Panel>
      ) : (
        <>
          <Grid min={170} sx={{ mb: 2 }}>
            <Kpi testId="admin-funnel-kpi-visits" icon={<TravelExploreOutlinedIcon />} color={theme.palette.text.secondary} label="Visitors" loading={loading} value={fmtInt(visits)} delta={d ? deltaOf(visits, step("visit").people_prev) : undefined} sub="once a day each" />
            <Kpi
              testId="admin-funnel-kpi-modify"
              icon={<EditOutlinedIcon />}
              label="« Modifier » clicks"
              loading={loading}
              value={fmtInt(step("modify.click").events)}
              delta={d ? deltaOf(step("modify.click").events, step("modify.click").events_prev) : undefined}
              sub={`${pluralOf(step("modify.click").people, "person", "people")} · ${ofVisits(step("modify.click").people)} of visitors`}
            />
            <Kpi
              testId="admin-funnel-kpi-offer"
              icon={<SellOutlinedIcon />}
              color={theme.palette.warning.main}
              label="Offer shown"
              loading={loading}
              value={fmtInt(step("offer.shown").events)}
              delta={d ? deltaOf(step("offer.shown").events, step("offer.shown").events_prev) : undefined}
              sub={`${pluralOf(step("offer.shown").people, "person", "people")} · ${fmtInt(step("offer.choice").events)} chose a way`}
            />
            <Kpi
              testId="admin-funnel-kpi-signin"
              icon={<LoginOutlinedIcon />}
              color={theme.palette.info.main}
              label="« Se connecter » clicks"
              loading={loading}
              value={fmtInt(step("signin.open").events)}
              delta={d ? deltaOf(step("signin.open").events, step("signin.open").events_prev) : undefined}
              sub={`${pluralOf(step("signin.done").people, "person", "people")} signed in · ${pluralOf(newAccounts, "new account", "new accounts")}`}
            />
            <Kpi testId="admin-funnel-kpi-trials" icon={<HourglassTopOutlinedIcon />} color={theme.palette.success.main} label="Trials started" loading={loading} value={fmtInt(step("trial.started").people)} delta={d ? deltaOf(step("trial.started").people, step("trial.started").people_prev) : undefined} sub={`${pluralOf(step("quote.sent").events, "quote", "quotes")} asked`} onClick={() => go("revenue", null, { tab: "trials" })} />
            <Kpi
              testId="admin-funnel-kpi-sheets"
              icon={<PrintOutlinedIcon />}
              label="Stop sheets opened"
              loading={loading}
              value={fmtInt(step("sheets.open").people)}
              delta={d ? deltaOf(step("sheets.open").people, step("sheets.open").people_prev) : undefined}
              sub={`${pluralOf(sheetsLocked, "print", "prints")} asked without the licence`}
            />
            <Kpi testId="admin-funnel-kpi-checkout" icon={<ShoppingCartOutlinedIcon />} color={theme.palette.success.main} label="Payment page opened" loading={loading} value={fmtInt(step("checkout.opened").people)} delta={d ? deltaOf(step("checkout.opened").people, step("checkout.opened").people_prev) : undefined} sub="people" onClick={() => go("revenue", null, { tab: "subscriptions" })} />
          </Grid>

          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "3fr 2fr" }, gap: 2, mb: 2 }}>
            <Panel title="The way to the licence" subtitle="People at each step over the period, and the share that came from the step before">
              {d ? <FunnelSteps testId="admin-funnel-steps" steps={funnel} format={fmtInt} /> : <Box sx={{ height: 240 }} />}
            </Panel>
            <Panel title="Per day" subtitle="People who clicked « Modifier », saw the offer, opened the sign-in">
              {d ? (
                <DayBars
                  testId="admin-funnel-days"
                  stacked={false}
                  data={d.by_day}
                  height={240}
                  format={fmtInt}
                  series={[
                    { key: "modify_click", name: "« Modifier »", color: theme.palette.primary.main },
                    { key: "offer_shown", name: "Offer shown", color: theme.palette.warning.main },
                    { key: "signin_open", name: "Sign-in opened", color: theme.palette.info.main },
                  ]}
                />
              ) : (
                <Box sx={{ height: 240 }} />
              )}
            </Panel>
          </Box>

          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "1fr 1fr", xl: "repeat(4, 1fr)" }, gap: 2, mb: 2 }}>
            <Panel title="Where « Modifier » is clicked">{d ? <SourceList testId="admin-funnel-src-modify" items={d.sources["modify.click"]} empty="No click in the period." /> : null}</Panel>
            <Panel title="What opened the offer">{d ? <SourceList testId="admin-funnel-src-offer" items={d.sources["offer.shown"]} empty="The offer was not shown in the period." /> : null}</Panel>
            <Panel title="Where the sign-in is opened">{d ? <SourceList testId="admin-funnel-src-signin" items={d.sources["signin.open"]} empty="No sign-in opened in the period." /> : null}</Panel>
            <Panel title="Features opened from Home's showcase">{d ? <SourceList testId="admin-funnel-src-showcase" items={d.sources["showcase.try"]} empty="No feature opened from the showcase in the period." /> : null}</Panel>
            <Panel title="Ways chosen in the offer">{d ? <SourceList testId="admin-funnel-src-choice" items={d.sources["offer.choice"]} empty="No way chosen in the period." /> : null}</Panel>
          </Box>

          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" }, gap: 2, mb: 2 }}>
            <Panel title="Where visits land" subtitle="The first page of each visit">
              {d ? <SourceList testId="admin-funnel-src-visit" items={d.sources.visit} empty="No visit in the period." /> : null}
            </Panel>
            <Panel title="Where visitors come from" subtitle="The site a visit came from, when it came from another one">
              {d ? (
                <BarList
                  testId="admin-funnel-referrers"
                  items={d.referrers.map((r) => ({ key: r.ref, label: r.ref, value: r.people, display: fmtInt(r.people), color: theme.palette.text.secondary }))}
                  empty="No visit came from another site in the period (typed addresses and bookmarks say nothing)."
                />
              ) : null}
            </Panel>
          </Box>

          <Panel
            title="Who"
            subtitle="The accounts that took a step in the period, newest first. A lead clicked « Modifier » or saw the offer, and holds no licence now."
            padded={false}
            testId="admin-funnel-who"
          >
            <DataTable
              testId="admin-funnel-accounts"
              columns={columns}
              rows={leadsOnly ? leads : accounts}
              loading={loading}
              getRowId={(a) => a.user_id}
              onRowClick={(a) => (a.email ? go("accounts", a.user_id) : null)}
              searchText={(a) => [a.email, a.display_name, a.organisation].join(" ")}
              searchPlaceholder="Search e-mail, name, organisation"
              initialSort={{ key: "last_at", dir: "desc" }}
              csvName="conversion"
              emptyTitle="No account took a step in the period"
              emptyText="Visitors who never signed in are counted above, without a name."
              toolbar={
                <Stack direction="row" spacing={0.75}>
                  <Chip size="small" label={`All ${accounts.length}`} color={leadsOnly ? "default" : "primary"} variant={leadsOnly ? "outlined" : "filled"} onClick={() => setLeadsOnly(false)} data-testid="admin-funnel-filter-all" sx={{ fontWeight: 600, ...TABULAR }} />
                  <Chip size="small" label={`Leads ${leads.length}`} color={leadsOnly ? "primary" : "default"} variant={leadsOnly ? "filled" : "outlined"} onClick={() => setLeadsOnly(true)} data-testid="admin-funnel-filter-leads" sx={{ fontWeight: 600, ...TABULAR }} />
                </Stack>
              }
            />
            {d && d.anonymous && d.anonymous.people ? (
              <Box sx={{ px: 2.5, py: 1.5, borderTop: `1px solid ${theme.palette.divider}`, bgcolor: alpha(theme.palette.text.primary, 0.02) }}>
                <Typography variant="caption" color="text.secondary" sx={TABULAR}>
                  And {pluralOf(d.anonymous.people, "visitor", "visitors")} who never signed in: {pluralOf(d.anonymous.modify_click, "click", "clicks")} on « Modifier », the offer shown {pluralOf(d.anonymous.offer_shown, "time", "times")}, the sign-in opened {pluralOf(d.anonymous.signin_open, "time", "times")}.
                </Typography>
              </Box>
            ) : null}
          </Panel>
        </>
      )}
    </>
  );
}
