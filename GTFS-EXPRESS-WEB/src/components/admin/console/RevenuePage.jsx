import React, { useState } from "react";
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Link, Stack, TextField, Tooltip, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { fetchBilling, fetchQuotes, updateQuote } from "../adminApi";
import { useConsole, useConsoleTab } from "./ConsoleShell";
import { DataTable, ErrorNotice, Fact, Grid, Kpi, PageHeader, Panel, Segments, StatusPill, TABULAR, useAdminQuery } from "./ui";
import { fmtDate, fmtDateTime, fmtEur, fmtInt, fmtPct, fmtRelative, ROLES } from "./format";
import { AccountCell } from "./AccountsPage";

const TABS = ["quotes", "trials", "subscriptions", "grants", "provider"];
const QUOTE_TONES = { new: "warning", handled: "success", archived: "neutral" };
const QUOTE_LABELS = { new: "To answer", handled: "Handled", archived: "Archived" };

function QuoteDialog({ quote, onClose, onSaved, go }) {
  const [note, setNote] = useState(quote ? quote.note || "" : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!quote) return null;
  const save = async (status) => {
    setBusy(true);
    setError("");
    try {
      await updateQuote(quote.id, { status: status || quote.status, note });
      onSaved();
    } catch (e) {
      setError(e.message || "Not saved.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth data-testid="admin-quote-dialog">
      <DialogTitle sx={{ fontSize: 17, fontWeight: 650, pb: 0.5 }}>{quote.organisation}</DialogTitle>
      <DialogContent>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <StatusPill tone={QUOTE_TONES[quote.status]} label={QUOTE_LABELS[quote.status]} />
          <Typography variant="caption" color="text.secondary">
            asked {fmtDateTime(quote.at)}
            {quote.handled_at ? ` · handled ${fmtDate(quote.handled_at)}` : ""}
          </Typography>
        </Stack>
        <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2, mb: 2 }}>
          <Fact label="Contact">{quote.name}</Fact>
          <Fact label="E-mail">
            <Link href={`mailto:${quote.email}?subject=${encodeURIComponent("GTFS Express — your quote")}`}>{quote.email}</Link>
          </Fact>
          <Fact label="Phone">{quote.phone}</Fact>
          <Fact label="Licences">{quote.seats ? fmtInt(quote.seats) : null}</Fact>
        </Box>
        {quote.message ? (
          <Box sx={{ p: 1.75, borderRadius: "8px", bgcolor: "action.hover", mb: 2 }}>
            <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
              {quote.message}
            </Typography>
          </Box>
        ) : null}
        <TextField fullWidth multiline minRows={2} size="small" label="Note (for the operator)" value={note} onChange={(e) => setNote(e.target.value)} inputProps={{ "data-testid": "admin-quote-note" }} />
        {quote.user_id ? (
          <Button size="small" sx={{ mt: 1.5 }} onClick={() => go("accounts", quote.user_id)}>
            Open the account that asked
          </Button>
        ) : null}
        {error ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {quote.status !== "archived" ? (
          <Button color="inherit" onClick={() => save("archived")} disabled={busy}>
            Archive
          </Button>
        ) : null}
        <Box sx={{ flex: 1 }} />
        <Button onClick={() => save(null)} disabled={busy}>
          Save the note
        </Button>
        {quote.status === "new" ? (
          <Button variant="contained" disableElevation onClick={() => save("handled")} disabled={busy} data-testid="admin-quote-handled">
            Mark handled
          </Button>
        ) : (
          <Button variant="outlined" onClick={() => save("new")} disabled={busy}>
            Reopen
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

const accountColumn = () => ({
  key: "account",
  label: "Account",
  value: (r) => (r.display_name || r.email || "").toLowerCase(),
  render: (r) => (r.email ? <AccountCell user={r} /> : <Typography variant="body2" color="text.secondary">Deleted account</Typography>),
  csv: (r) => r.email,
});

export default function RevenuePage() {
  const theme = useTheme();
  const { refreshKey, go } = useConsole();
  const [tab, setTab, initialQuery] = useConsoleTab(TABS, "quotes");
  const [openQuote, setOpenQuote] = useState(null);
  const billing = useAdminQuery(fetchBilling, [refreshKey]);
  const quotes = useAdminQuery(fetchQuotes, [refreshKey]);
  const b = billing.data;
  const s = b ? b.summary : null;
  const loading = billing.loading && !b;
  const openAccount = (r) => r.user_id && r.email && go("accounts", r.user_id);

  return (
    <>
      <PageHeader title="Licences & revenue" description={b ? `The licence at ${fmtEur(b.prices.year_eur)} a year or ${fmtEur(b.prices.month_eur)} a month, excl. VAT · trial of ${b.trial_days} days${b.paid ? "" : " · the paid offer is off on this server"}.` : " "} />
      <ErrorNotice error={billing.error} onRetry={billing.reload} />
      <Grid min={190} sx={{ mb: 3 }}>
        <Kpi testId="admin-kpi-quotes" label="Quotes to answer" loading={loading} color={theme.palette.warning.main} value={s ? fmtInt(s.quotes_new) : "—"} onClick={() => setTab("quotes")} />
        <Kpi label="Paid subscriptions" loading={loading} color={theme.palette.success.main} value={s ? fmtInt(s.subscriptions_active) : "—"} sub={s && s.subscriptions_cancelling ? `${s.subscriptions_cancelling} cancelling` : "none cancelling"} onClick={() => setTab("subscriptions")} />
        <Kpi label="Granted licences" loading={loading} value={s ? fmtInt(s.grants_active) : "—"} sub="bought on a quote" onClick={() => setTab("grants")} />
        <Kpi testId="admin-kpi-testers" label="Testers" loading={loading} color={theme.palette.warning.main} value={s ? fmtInt(s.testers_active || 0) : "—"} sub="not counted as revenue" onClick={() => setTab("grants")} />
        <Kpi label="Trials running" loading={loading} color={theme.palette.info.main} value={s ? fmtInt(s.trials_running) : "—"} sub={s ? `${s.trials_total} in all` : null} onClick={() => setTab("trials")} />
        <Kpi label="Trial conversion" loading={loading} color={theme.palette.info.main} value={s ? fmtPct(s.conversion_rate) : "—"} sub={s ? `${s.trials_converted} trials became a licence` : null} onClick={() => setTab("trials")} />
      </Grid>

      <Segments
        value={tab}
        onChange={setTab}
        testId="admin-revenue-tabs"
        items={[
          { value: "quotes", label: "Quotes", count: s ? s.quotes_new : 0 },
          { value: "trials", label: "Trials" },
          { value: "subscriptions", label: "Subscriptions" },
          { value: "grants", label: "Granted & testers" },
          { value: "provider", label: "Payment events" },
        ]}
      />

      {tab === "quotes" ? (
        <Panel padded={false} sx={{ pt: 2 }}>
          <ErrorNotice error={quotes.error} onRetry={quotes.reload} sx={{ mx: 2.5 }} />
          <DataTable
            testId="admin-quotes"
            initialQuery={initialQuery}
            loading={quotes.loading && !quotes.data}
            rows={quotes.data ? quotes.data.quotes : []}
            getRowId={(r) => r.id}
            onRowClick={setOpenQuote}
            searchText={(r) => [r.organisation, r.name, r.email, r.message].join(" ")}
            searchPlaceholder="Search organisation, contact, message"
            initialSort={{ key: "at", dir: "desc" }}
            csvName="quotes"
            emptyTitle="No quote asked yet"
            emptyText={quotes.data ? `A quote request is kept ${Math.round(quotes.data.retention_days / 30.4)} months after it was asked.` : null}
            columns={[
              { key: "at", label: "Asked", render: (r) => <Tooltip title={fmtDateTime(r.at)}><span>{fmtRelative(r.at)}</span></Tooltip> },
              { key: "organisation", label: "Organisation", render: (r) => <Typography variant="body2" sx={{ fontWeight: 600 }}>{r.organisation}</Typography> },
              { key: "name", label: "Contact", render: (r) => <Box><Typography variant="body2">{r.name}</Typography><Typography variant="caption" color="text.secondary">{[r.email, r.phone].filter(Boolean).join(" · ")}</Typography></Box>, csv: (r) => `${r.name} <${r.email}>${r.phone ? ` ${r.phone}` : ""}` },
              { key: "seats", label: "Licences", align: "right", render: (r) => (r.seats ? fmtInt(r.seats) : "—") },
              { key: "message", label: "Message", sortable: false, render: (r) => <Typography variant="body2" color="text.secondary" noWrap sx={{ maxWidth: 320 }}>{r.message || "—"}</Typography> },
              { key: "status", label: "Status", render: (r) => <StatusPill tone={QUOTE_TONES[r.status]} label={QUOTE_LABELS[r.status]} /> },
            ]}
          />
        </Panel>
      ) : null}

      {tab === "trials" ? (
        <Panel padded={false} sx={{ pt: 2 }}>
          <DataTable
            testId="admin-trials"
            initialQuery={initialQuery}
            loading={loading}
            rows={b ? b.trials : []}
            getRowId={(r) => r.user_id}
            onRowClick={openAccount}
            searchText={(r) => [r.email, r.display_name, r.organisation, r.network].join(" ")}
            initialSort={{ key: "started_at", dir: "desc" }}
            csvName="trials"
            emptyTitle="No trial yet"
            columns={[
              accountColumn(),
              { key: "organisation", label: "Organisation", render: (r) => <Box><Typography variant="body2">{r.organisation || "—"}</Typography><Typography variant="caption" color="text.secondary">{[ROLES[r.org_role], r.network].filter(Boolean).join(" · ")}</Typography></Box> },
              { key: "phone", label: "Phone", render: (r) => r.phone || "—" },
              { key: "started_at", label: "Started", render: (r) => fmtDate(r.started_at) },
              { key: "until", label: "Ends", render: (r) => <Tooltip title={fmtDateTime(r.until)}><span>{fmtRelative(r.until)}</span></Tooltip> },
              { key: "state", label: "Outcome", render: (r) => <StatusPill tone={r.state === "running" ? "info" : r.state === "converted" ? "success" : "neutral"} label={r.state === "running" ? "Running" : r.state === "converted" ? `Converted · ${r.licence_source === "subscription" ? "paid" : "granted"}` : "Ended"} /> },
              { key: "ai_spent_eur", label: "AI spent", align: "right", render: (r) => (r.ai_spent_eur != null ? fmtEur(r.ai_spent_eur) : "—") },
            ]}
          />
        </Panel>
      ) : null}

      {tab === "subscriptions" ? (
        <Panel padded={false} sx={{ pt: 2 }}>
          <DataTable
            testId="admin-subscriptions"
            loading={loading}
            rows={b ? b.subscriptions : []}
            getRowId={(r) => r.user_id}
            onRowClick={openAccount}
            searchText={(r) => [r.email, r.display_name, r.organisation].join(" ")}
            initialSort={{ key: "updated_at", dir: "desc" }}
            csvName="subscriptions"
            emptyTitle="No subscription yet"
            emptyText="Subscriptions are written by the payment provider's webhook only."
            columns={[
              accountColumn(),
              { key: "organisation", label: "Organisation", render: (r) => r.organisation || "—" },
              { key: "plan", label: "Plan", render: (r) => r.plan || "—" },
              { key: "status", label: "Status", render: (r) => <StatusPill tone={r.active ? (r.cancel_at_period_end ? "warning" : "success") : r.status === "past_due" ? "error" : "neutral"} label={r.active && r.cancel_at_period_end ? "Cancelling" : r.status} /> },
              { key: "current_period_end", label: "Period ends", render: (r) => fmtDate(r.current_period_end) },
              { key: "updated_at", label: "Last provider news", render: (r) => fmtRelative(r.updated_at) },
            ]}
          />
        </Panel>
      ) : null}

      {tab === "grants" ? (
        <Panel padded={false} sx={{ pt: 2 }}>
          <DataTable
            testId="admin-grants"
            loading={loading}
            rows={b ? b.grants : []}
            getRowId={(r) => r.user_id}
            onRowClick={openAccount}
            searchText={(r) => [r.email, r.display_name, r.organisation].join(" ")}
            initialSort={{ key: "until", dir: "asc" }}
            csvName="granted-licences"
            emptyTitle="No licence granted, no tester"
            emptyText="Grant one from an account's file (Accounts)."
            columns={[
              accountColumn(),
              { key: "kind", label: "Kind", render: (r) => <StatusPill tone={r.kind === "tester" ? "warning" : "primary"} label={r.kind === "tester" ? "Tester" : "Client"} /> },
              { key: "organisation", label: "Organisation", render: (r) => r.organisation || "—" },
              { key: "ai", label: "AI this month", value: (r) => r.ai_spent_usd ?? -1, render: (r) => (r.ai_limit_usd != null ? <span style={TABULAR}>{`${(r.ai_spent_usd || 0).toFixed(2)} / ${r.ai_limit_usd.toFixed(0)}`}</span> : "—") },
              { key: "until", label: "Ends", render: (r) => (r.until ? <Tooltip title={fmtDateTime(r.until)}><span style={TABULAR}>{fmtDate(r.until)} · {fmtRelative(r.until)}</span></Tooltip> : "No end") },
              { key: "active", label: "State", value: (r) => (r.active ? 1 : 0), render: (r) => <StatusPill tone={r.active ? "primary" : "neutral"} label={r.active ? "Running" : "Ended"} /> },
            ]}
          />
        </Panel>
      ) : null}

      {tab === "provider" ? (
        <Panel padded={false} sx={{ pt: 2 }} title="The payment provider's events" subtitle="Each applied once (a retried webhook changes nothing).">
          <DataTable
            rows={b ? b.provider_events : []}
            getRowId={(r) => r.type}
            initialSort={{ key: "last_at", dir: "desc" }}
            emptyTitle="No event received"
            columns={[
              { key: "type", label: "Type", render: (r) => <Typography variant="body2" sx={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12.5 }}>{r.type}</Typography> },
              { key: "count", label: "Received", align: "right", render: (r) => fmtInt(r.count) },
              { key: "last_at", label: "Last", render: (r) => fmtDateTime(r.last_at) },
            ]}
          />
        </Panel>
      ) : null}

      {openQuote ? (
        <QuoteDialog
          key={openQuote.id}
          quote={openQuote}
          go={(s, id) => {
            setOpenQuote(null);
            go(s, id);
          }}
          onClose={() => setOpenQuote(null)}
          onSaved={() => {
            setOpenQuote(null);
            quotes.reload();
            billing.reload();
          }}
        />
      ) : null}
    </>
  );
}
