// An account's file, on the right of the accounts (/admin/accounts/:id): who it is, its licence and what grants it,
// what it consumed (AI per function and model, API per route), its projects, its activity, its e-mails — and the
// operator's acts on it (grant, revoke, sign out everywhere, disable), each confirmed and recorded.

import React, { useState } from "react";
import {
  Alert,
  Avatar,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  IconButton,
  LinearProgress,
  Skeleton,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  alpha,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import CloseIcon from "@mui/icons-material/Close";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import WorkspacePremiumOutlinedIcon from "@mui/icons-material/WorkspacePremiumOutlined";
import LogoutIcon from "@mui/icons-material/Logout";
import BlockIcon from "@mui/icons-material/Block";
import { fetchUser, logoutUser, setUserEntitlements } from "../adminApi";
import { ConfirmDialog, DataTable, EmptyState, Fact, Segments, StatusPill, TABULAR, useAdminQuery } from "./ui";
import { BarList, useFeatureColor } from "./charts";
import { DRAFT_KINDS, eventSentence, featureName, fmtDate, fmtDateTime, fmtEur, fmtInt, fmtMs, fmtRelative, licenceLabel, licenceTone, MAIL_KINDS, ROLES, sourceName, stepName } from "./format";

const WIDTH = 640;
const plusDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

// A client's licence (bought on a quote: its term, a year by default) or a tester's (the same rights, its own AI
// envelope, left out of the revenue and the way to the licence; no end by default).
const KIND_PRESET = { client: "year", tester: "none" };

function GrantDialog({ open, user, onClose, onDone }) {
  const [kind, setKind] = useState("client");
  const [preset, setPreset] = useState(KIND_PRESET.client);
  const [date, setDate] = useState(plusDays(365));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const until = preset === "none" ? null : preset === "month" ? plusDays(31) : preset === "year" ? plusDays(365) : date;
  const grant = async () => {
    setBusy(true);
    setError("");
    try {
      await setUserEntitlements(user.id, { edit: true, studio: true, until, kind });
      onDone();
    } catch (e) {
      setError(e.message || "The licence could not be granted.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 17, fontWeight: 650 }}>Grant the licence</DialogTitle>
      <DialogContent>
        <ToggleButtonGroup
          exclusive
          fullWidth
          size="small"
          value={kind}
          onChange={(_e, v) => {
            if (!v) return;
            setKind(v);
            setPreset(KIND_PRESET[v]);
          }}
          sx={{ mb: 1.5, "& .MuiToggleButton-root": { textTransform: "none", fontWeight: 600 } }}
        >
          <ToggleButton value="client" data-testid="admin-grant-kind-client">Client</ToggleButton>
          <ToggleButton value="tester" data-testid="admin-grant-kind-tester">Tester</ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {kind === "tester"
            ? `${user.email} gets everything a client has, delivery included, with the tester's AI envelope each month. Left out of the revenue and of the way to the licence.`
            : `${user.email} gets every modification, until the end of the chosen day — for a licence bought on a quote, its term.`}
        </Typography>
        <ToggleButtonGroup exclusive size="small" value={preset} onChange={(_e, v) => v && setPreset(v)} sx={{ mb: 2, "& .MuiToggleButton-root": { textTransform: "none", px: 1.5 } }}>
          <ToggleButton value="month">1 month</ToggleButton>
          <ToggleButton value="year">1 year</ToggleButton>
          <ToggleButton value="date">Until…</ToggleButton>
          <ToggleButton value="none">No end</ToggleButton>
        </ToggleButtonGroup>
        {preset === "date" ? <TextField type="date" size="small" fullWidth label="Last day" value={date} onChange={(e) => setDate(e.target.value)} InputLabelProps={{ shrink: true }} inputProps={{ "data-testid": "admin-grant-date" }} /> : null}
        <Typography variant="body2" sx={{ mt: 1, ...TABULAR }}>
          {until ? `Ends on ${fmtDate(`${until}T23:59:59Z`)}.` : "No end: revoke it by hand."}
        </Typography>
        {error ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" disableElevation onClick={grant} disabled={busy || (preset === "date" && !date)} data-testid="admin-grant-confirm">
          Grant
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function Section({ title, children, action }) {
  return (
    <Box sx={{ mb: 3 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.25 }}>
        <Typography sx={{ fontSize: 13, fontWeight: 650, color: "text.secondary", textTransform: "uppercase", letterSpacing: "0.04em" }}>{title}</Typography>
        {action}
      </Stack>
      {children}
    </Box>
  );
}

const Facts = ({ children }) => <Box sx={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 2 }}>{children}</Box>;

function LicenceTab({ data }) {
  const u = data.user;
  const l = u.licence || {};
  const sub = u.subscription;
  const a = u.ai_allowance;
  return (
    <>
      <Section title="Licence">
        <Facts>
          <Fact label="State">
            <StatusPill tone={licenceTone(l)} label={licenceLabel(l)} />
          </Fact>
          <Fact label="Ends">{l.active ? (l.until ? `${fmtDate(l.until)} (${fmtRelative(l.until)})` : "No end") : "—"}</Fact>
          <Fact label="Granted by the operator">{(u.granted || []).length ? `Yes${u.grant_until ? `, until ${fmtDate(u.grant_until)}` : ", no end"}` : "No"}</Fact>
          <Fact label="Free trial">{u.trial_started_at ? `${fmtDate(u.trial_started_at)} → ${fmtDate(u.trial_until)}` : l.trial_available ? "Not used yet" : "—"}</Fact>
        </Facts>
      </Section>
      <Section title="Subscription">
        {sub ? (
          <Facts>
            <Fact label="Status">
              <StatusPill tone={sub.active ? (sub.cancel_at_period_end ? "warning" : "success") : sub.status === "past_due" ? "error" : "neutral"} label={sub.cancel_at_period_end && sub.active ? "Cancelling" : sub.status} />
            </Fact>
            <Fact label="Plan">{sub.plan || "—"}</Fact>
            <Fact label={sub.cancel_at_period_end ? "Ends" : "Renews"}>{fmtDate(sub.current_period_end)}</Fact>
          </Facts>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No subscription.
          </Typography>
        )}
      </Section>
      <Section title="AI allowance">
        {a ? (
          <Box>
            <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.75 }}>
              <Typography variant="body2">{a.kind === "trial" ? "Over the trial" : "This month"}</Typography>
              <Typography variant="body2" sx={{ fontWeight: 600, ...TABULAR }}>
                {fmtEur(a.spent_eur)} / {fmtEur(a.limit_eur)}
              </Typography>
            </Stack>
            <LinearProgress variant="determinate" aria-label="AI allowance spent" value={Math.min(100, (100 * a.spent_eur) / Math.max(a.limit_eur, 0.01))} color={a.exhausted ? "error" : "primary"} sx={{ height: 6, borderRadius: "12px" }} />
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.75 }}>
              {a.exhausted ? "Spent: the assistant waits until " : "Renews "}
              {fmtDate(a.until)}
            </Typography>
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {l.unlimited ? "None: the operator's own account." : "None while the licence does not run."}
          </Typography>
        )}
      </Section>
      <Section title="Reading companion">
        <Typography variant="body2" sx={TABULAR}>
          {data.reader ? `${data.reader.used} of ${data.reader.limit} questions this month` : "—"}
        </Typography>
      </Section>
    </>
  );
}

function ConsumptionTab({ data }) {
  const featureColor = useFeatureColor();
  const ai = data.ai;
  const api = data.api;
  return (
    <>
      <Section title="AI, in all">
        <Facts>
          <Fact label="Cost">{`${fmtEur(ai.total.eur)} · ${fmtInt(ai.total.calls)} calls`}</Fact>
          <Fact label="Tokens">{`${fmtInt(ai.total.input_tokens)} in · ${fmtInt(ai.total.output_tokens)} out`}</Fact>
        </Facts>
      </Section>
      <Section title="AI per month">
        <BarList items={ai.by_month.map((m) => ({ key: m.month, label: m.month, value: m.usd, display: fmtEur(m.eur), sub: `${fmtInt(m.calls)} calls` }))} empty="No AI call yet." />
      </Section>
      <Section title="AI per function">
        <BarList items={ai.by_feature.map((f) => ({ key: f.feature, label: featureName(f.feature), value: f.usd, display: fmtEur(f.eur), sub: `${fmtInt(f.calls)} calls`, color: featureColor(f.feature) }))} empty="No AI call yet." />
      </Section>
      <Section title="AI per model">
        <BarList items={ai.by_model.map((m) => ({ key: m.model, label: m.model, value: m.usd, display: fmtEur(m.eur), sub: `${fmtInt(m.calls)} calls` }))} empty="No AI call yet." />
      </Section>
      <Section title="API, last 30 days">
        <Typography variant="body2" sx={{ mb: 1.25, ...TABULAR }}>
          {`${fmtInt(api.total.calls)} calls · ${fmtInt(api.total.refused)} refused · ${fmtInt(api.total.rate_limited)} rate-limited · ${fmtInt(api.total.server_errors)} server errors`}
        </Typography>
        <Box sx={{ mx: -3 }}>
          <DataTable
            columns={[
              { key: "route", label: "Route", render: (r) => <Typography variant="body2" sx={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}>{r.route}</Typography> },
              { key: "calls", label: "Calls", align: "right", render: (r) => fmtInt(r.calls) },
              { key: "refused", label: "Refused", align: "right", render: (r) => fmtInt(r.refused + r.rate_limited) },
              { key: "avg_ms", label: "Mean", align: "right", render: (r) => fmtMs(r.avg_ms) },
            ]}
            rows={api.routes}
            getRowId={(r) => r.route}
            initialSort={{ key: "calls", dir: "desc" }}
            pageSize={10}
            emptyTitle="No call in 30 days"
          />
        </Box>
      </Section>
    </>
  );
}

function ProjectsTab({ data }) {
  if (!data.projects.length) return <EmptyState title="No project" text="This account owns no project and is a member of none." />;
  return (
    <Box sx={{ mx: -3 }}>
      <DataTable
        columns={[
          { key: "name", label: "Project", value: (p) => p.name || "", render: (p) => <Box><Typography variant="body2" sx={{ fontWeight: 600 }}>{p.name || "Untitled"}</Typography><Typography variant="caption" color="text.secondary">{[p.network, p.role === "member" ? "member" : null].filter(Boolean).join(" · ")}</Typography></Box> },
          { key: "draft_kind", label: "Draft", render: (p) => DRAFT_KINDS[p.draft_kind] || "—" },
          { key: "versions", label: "Versions", align: "right" },
          { key: "deliveries", label: "Delivered", align: "right" },
          { key: "updated_at", label: "Updated", render: (p) => fmtRelative(p.updated_at) },
        ]}
        rows={data.projects}
        getRowId={(p) => p.id}
        initialSort={{ key: "updated_at", dir: "desc" }}
        pageSize={10}
      />
    </Box>
  );
}

function ActivityTab({ data }) {
  const theme = useTheme();
  const steps = data.funnel || [];
  return (
    <>
      <Section title="Way to the licence">
        {steps.length ? (
          <Box data-testid="admin-account-funnel">
            {steps.map((s) => (
              <Stack key={`${s.step}-${s.source}`} direction="row" spacing={1.5} alignItems="baseline" sx={{ py: 0.75, borderBottom: `1px solid ${theme.palette.divider}` }}>
                <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>
                  {stepName(s.step)}
                  <Typography component="span" variant="caption" color="text.secondary">
                    {s.source && s.source !== "other" ? ` · ${sourceName(s.source)}` : ""}
                  </Typography>
                </Typography>
                <Typography variant="body2" sx={{ fontWeight: 600, ...TABULAR }}>
                  {s.count > 1 ? `× ${fmtInt(s.count)}` : ""}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ width: 96, textAlign: "right", flexShrink: 0, ...TABULAR }}>
                  {fmtRelative(s.last_at)}
                </Typography>
              </Stack>
            ))}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No step counted for this account (the steps are counted from this version on).
          </Typography>
        )}
      </Section>
      <Section title="Last events">
        {data.events.length ? (
          <Box>
            {data.events.slice(0, 40).map((e, i) => (
              <Stack key={`${e.ts}-${i}`} direction="row" spacing={1.5} sx={{ py: 0.75, borderBottom: `1px solid ${theme.palette.divider}` }}>
                <Typography variant="caption" color="text.secondary" sx={{ width: 108, flexShrink: 0, ...TABULAR }}>
                  {fmtDateTime(e.ts)}
                </Typography>
                <Typography variant="body2" sx={{ flex: 1 }}>
                  {eventSentence(e)}
                </Typography>
              </Stack>
            ))}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No event recorded for this account.
          </Typography>
        )}
      </Section>
      <Section title="E-mails sent">
        {data.mails.length ? (
          data.mails.map((m) => (
            <Stack key={m.id} direction="row" spacing={1.5} alignItems="center" sx={{ py: 0.6 }}>
              <Typography variant="caption" color="text.secondary" sx={{ width: 108, ...TABULAR }}>
                {fmtDateTime(m.at)}
              </Typography>
              <Typography variant="body2" sx={{ flex: 1 }}>
                {MAIL_KINDS[m.kind] || m.kind || "E-mail"}
              </Typography>
              <StatusPill tone={m.ok ? "success" : "error"} label={m.ok ? "Sent" : "Failed"} />
            </Stack>
          ))
        ) : (
          <Typography variant="body2" color="text.secondary">
            No e-mail logged.
          </Typography>
        )}
      </Section>
      <Section title="Operator's acts">
        {data.audit.length ? (
          data.audit.map((a) => (
            <Stack key={a.id} direction="row" spacing={1.5} sx={{ py: 0.6 }}>
              <Typography variant="caption" color="text.secondary" sx={{ width: 108, ...TABULAR }}>
                {fmtDateTime(a.at)}
              </Typography>
              <Typography variant="body2" sx={{ flex: 1 }}>
                {a.action === "account.entitlements" ? (a.details && a.details.granted && a.details.granted.length ? `Licence granted${a.details.until ? ` until ${fmtDate(a.details.until)}` : ""}` : "Licence revoked") + (a.details && a.details.disabled ? " · disabled" : "") : a.action === "account.logout" ? `Signed out everywhere (${(a.details && a.details.sessions) || 0})` : a.action}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {a.actor || "token"}
              </Typography>
            </Stack>
          ))
        ) : (
          <Typography variant="body2" color="text.secondary">
            None.
          </Typography>
        )}
      </Section>
    </>
  );
}

function ProfileTab({ data }) {
  const theme = useTheme();
  const u = data.user;
  const p = u.profile || {};
  return (
    <>
      <Section title="Profile">
        <Facts>
          <Fact label="Organisation">{p.organisation}</Fact>
          <Fact label="Role">{ROLES[p.org_role] || p.org_role}</Fact>
          <Fact label="Network">{p.network}</Fact>
          <Fact label="Phone">{p.phone}</Fact>
          <Fact label="Language">{u.language ? u.language.toUpperCase() : null}</Fact>
          <Fact label="Site">{u.site_origin}</Fact>
          <Fact label="Joined">{fmtDateTime(u.created_at)}</Fact>
          <Fact label="Last sign-in">{u.last_login_at ? `${fmtDateTime(u.last_login_at)} (${fmtRelative(u.last_login_at)})` : null}</Fact>
          <Fact label="Address verified">{u.email_verified_at ? fmtDateTime(u.email_verified_at) : "No"}</Fact>
          <Fact label="Account id" mono>
            {u.id}
          </Fact>
        </Facts>
      </Section>
      <Section title={`Devices signed in (${data.sessions.length})`}>
        {data.sessions.length ? (
          data.sessions.map((s, i) => (
            <Stack key={i} direction="row" spacing={2} sx={{ py: 0.75, borderBottom: `1px solid ${theme.palette.divider}` }}>
              <Typography variant="body2" sx={{ flex: 1, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}>
                {s.device || "device"}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={TABULAR}>
                seen {fmtRelative(s.last_seen_at)} · since {fmtDate(s.created_at)}
              </Typography>
            </Stack>
          ))
        ) : (
          <Typography variant="body2" color="text.secondary">
            Signed in nowhere.
          </Typography>
        )}
      </Section>
    </>
  );
}

export default function AccountDrawer({ id, onClose, onChanged }) {
  const theme = useTheme();
  const [tab, setTab] = useState("licence");
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const q = useAdminQuery(() => fetchUser(id), [id], { enabled: Boolean(id) });
  const data = q.data && q.data.user && q.data.user.id === id ? q.data : null;
  const u = data ? data.user : null;

  const done = (text) => {
    setDialog(null);
    setNotice(text);
    q.reload();
    onChanged && onChanged();
  };
  const act = async (fn, text) => {
    setBusy(true);
    try {
      await fn();
      done(text);
    } catch (e) {
      setDialog(null);
      setNotice(e.message || "That did not work.");
    } finally {
      setBusy(false);
    }
  };
  const copy = (text) => {
    try {
      navigator.clipboard.writeText(text);
      setNotice("Copied.");
    } catch {
      /* the clipboard is not offered here */
    }
  };

  return (
    <Drawer anchor="right" open={Boolean(id)} onClose={onClose} PaperProps={{ sx: { width: WIDTH, maxWidth: "100vw", bgcolor: "background.paper" } }} data-testid="admin-account-drawer">
      <Stack direction="row" alignItems="flex-start" spacing={1.5} sx={{ px: { xs: 2, sm: 3 }, pt: 2.5, pb: 2 }}>
        {u ? (
          <Avatar sx={{ width: 44, height: 44, fontWeight: 700, bgcolor: alpha(theme.palette.primary.main, 0.14), color: "primary.main" }}>{String(u.display_name || u.email).slice(0, 1).toUpperCase()}</Avatar>
        ) : (
          <Skeleton variant="circular" width={44} height={44} />
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {u ? (
            <>
              <Typography sx={{ fontSize: 18, fontWeight: 650, lineHeight: 1.3 }} noWrap>
                {u.display_name || u.email}
              </Typography>
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Typography variant="body2" color="text.secondary" noWrap>
                  {u.email}
                </Typography>
                <Tooltip title="Copy the address">
                  <IconButton size="small" onClick={() => copy(u.email)} aria-label="Copy the address">
                    <ContentCopyIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </Tooltip>
              </Stack>
              <Stack direction="row" spacing={0.75} sx={{ mt: 0.75, flexWrap: "wrap" }}>
                <StatusPill tone={licenceTone(u.licence)} label={licenceLabel(u.licence)} testId="admin-account-licence" />
                {u.disabled ? <StatusPill tone="error" label="Disabled" /> : null}
                {!u.email_verified ? <StatusPill tone="warning" label="Unverified" /> : null}
                {u.profile && u.profile.organisation ? <StatusPill label={u.profile.organisation} /> : null}
              </Stack>
            </>
          ) : (
            <>
              <Skeleton width="60%" height={28} />
              <Skeleton width="40%" />
            </>
          )}
        </Box>
        <IconButton onClick={onClose} aria-label="Close" data-testid="admin-account-close">
          <CloseIcon />
        </IconButton>
      </Stack>
      {u ? (
        <Stack direction="row" spacing={1} useFlexGap sx={{ px: { xs: 2, sm: 3 }, pb: 2, flexWrap: "wrap", rowGap: 1 }}>
          <Button size="small" variant="contained" disableElevation startIcon={<WorkspacePremiumOutlinedIcon />} onClick={() => setDialog("grant")} data-testid="admin-account-grant">
            {(u.granted || []).length ? "Extend the licence" : "Grant the licence"}
          </Button>
          {(u.granted || []).length ? (
            <Button size="small" variant="outlined" color="inherit" onClick={() => setDialog("revoke")} data-testid="admin-account-revoke">
              Revoke
            </Button>
          ) : null}
          <Button size="small" variant="outlined" color="inherit" startIcon={<LogoutIcon />} onClick={() => setDialog("logout")} disabled={!data.sessions.length} data-testid="admin-account-logout">
            Sign out everywhere
          </Button>
          <Box sx={{ flex: 1 }} />
          {u.disabled ? (
            <Button size="small" color="primary" onClick={() => act(() => setUserEntitlements(u.id, { disabled: false }), "Account enabled.")} data-testid="admin-account-enable">
              Enable
            </Button>
          ) : (
            <Button size="small" color="error" startIcon={<BlockIcon />} onClick={() => setDialog("disable")} data-testid="admin-account-disable">
              Disable
            </Button>
          )}
        </Stack>
      ) : null}
      {notice ? (
        <Alert severity="info" variant="outlined" onClose={() => setNotice(null)} sx={{ mx: { xs: 2, sm: 3 }, mb: 1.5, borderRadius: "8px" }}>
          {notice}
        </Alert>
      ) : null}
      <Divider />
      <Box sx={{ px: { xs: 2, sm: 3 }, pt: 1, overflowY: "auto", flex: 1 }}>
        {q.error && !data ? <Alert severity="error" sx={{ mt: 2 }}>{q.error.status === 404 ? "This account no longer exists." : q.error.message}</Alert> : null}
        {data ? (
          <>
            <Segments
              value={tab}
              onChange={setTab}
              testId="admin-account-tabs"
              items={[
                { value: "licence", label: "Licence" },
                { value: "consumption", label: "Consumption" },
                { value: "projects", label: "Projects", count: data.projects.length },
                { value: "activity", label: "Activity" },
                { value: "profile", label: "Profile" },
              ]}
            />
            {tab === "licence" ? <LicenceTab data={data} /> : null}
            {tab === "consumption" ? <ConsumptionTab data={data} /> : null}
            {tab === "projects" ? <ProjectsTab data={data} /> : null}
            {tab === "activity" ? <ActivityTab data={data} /> : null}
            {tab === "profile" ? <ProfileTab data={data} /> : null}
          </>
        ) : !q.error ? (
          <Box sx={{ pt: 2 }}>
            <Skeleton height={32} />
            <Skeleton height={120} />
          </Box>
        ) : null}
      </Box>
      {u ? (
        <>
          <GrantDialog open={dialog === "grant"} user={u} onClose={() => setDialog(null)} onDone={() => done("Licence granted.")} />
          <ConfirmDialog
            open={dialog === "revoke"}
            title="Revoke the granted licence?"
            body={`${u.email} keeps any subscription or trial of its own; the operator's grant ends now.`}
            confirmLabel="Revoke"
            tone="error"
            busy={busy}
            onClose={() => setDialog(null)}
            onConfirm={() => act(() => setUserEntitlements(u.id, { edit: false, studio: false, until: null }), "Licence revoked.")}
          />
          <ConfirmDialog
            open={dialog === "logout"}
            title="Sign this account out everywhere?"
            body={`Its ${data.sessions.length} device(s) will have to sign in again with a code.`}
            confirmLabel="Sign out"
            busy={busy}
            onClose={() => setDialog(null)}
            onConfirm={() => act(async () => {
              const out = await logoutUser(u.id);
              return out;
            }, "Signed out everywhere.")}
          />
          <ConfirmDialog
            open={dialog === "disable"}
            title="Disable this account?"
            body={`${u.email} is signed out at once and can no longer sign in, until it is enabled again. Its projects are kept.`}
            confirmLabel="Disable"
            tone="error"
            typed="disable"
            busy={busy}
            onClose={() => setDialog(null)}
            onConfirm={() => act(() => setUserEntitlements(u.id, { disabled: true }), "Account disabled.")}
          />
        </>
      ) : null}
    </Drawer>
  );
}
