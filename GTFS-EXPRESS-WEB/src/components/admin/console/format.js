// The console's formats and names: numbers, money, dates and durations as the operator reads them (local time,
// English, tabular), and the plain names of the API's codes (functions, licence sources, roles, event types).
// The console is English only, outside the app's i18n.

const LOCALE = "en-GB";
const intFmt = new Intl.NumberFormat(LOCALE);
const compactFmt = new Intl.NumberFormat(LOCALE, { notation: "compact", maximumFractionDigits: 1 });

export const fmtInt = (n) => (n == null || Number.isNaN(Number(n)) ? "—" : intFmt.format(Math.round(Number(n))));
export const fmtCompact = (n) => (n == null ? "—" : Math.abs(n) < 10000 ? fmtInt(n) : compactFmt.format(n));

const money = (symbol, v) => {
  if (v == null || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  if (n > 0 && n < 0.01) return `<${symbol}0.01`;
  const digits = Math.abs(n) >= 1000 ? 0 : 2;
  return `${symbol}${n.toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};
export const fmtEur = (v) => money("€", v);
export const fmtUsd = (v) => money("$", v);

export const fmtPct = (ratio, digits = 0) => (ratio == null || Number.isNaN(Number(ratio)) ? "—" : `${(Number(ratio) * 100).toFixed(digits)}%`);

export const fmtBytes = (b) => {
  if (b == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(b);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
};

export const fmtMs = (ms) => {
  if (ms == null || Number.isNaN(Number(ms))) return "—";
  const n = Number(ms);
  if (n < 1) return "<1 ms";
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(n < 10000 ? 2 : 1)} s`;
};

export const fmtDuration = (ms) => {
  if (ms == null) return "—";
  const s = Math.round(Number(ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60 ? `${m % 60} min` : ""}`.trim();
  return `${Math.round(h / 24)} days`;
};

// A date alone is the server's day (UTC): a grant « until 31 Jan » ends at 23:59:59Z that day, never « 1 Feb ».
const dateFmt = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", timeZone: "UTC" });
const timeFmt = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const valid = (iso) => iso && !Number.isNaN(Date.parse(iso));
export const fmtDate = (iso) => (valid(iso) ? dateFmt.format(new Date(iso)) : "—");
export const fmtDateTime = (iso) => (valid(iso) ? dateTimeFmt.format(new Date(iso)) : "—");
export const fmtTime = (iso) => (valid(iso) ? timeFmt.format(new Date(iso)) : "—");
/** A YYYY-MM-DD day of the API (UTC) as « 13 Oct ». */
export const fmtDay = (day) => (day ? dayFmt.format(new Date(`${day}T00:00:00Z`)) : "—");

/** « 3 min ago », « in 2 days »: how far a time is from now. */
export const fmtRelative = (iso, now = Date.now()) => {
  if (!valid(iso)) return "—";
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  let text;
  if (abs < minute) return diff < 0 ? "just now" : "in a moment";
  if (abs < hour) text = `${Math.round(abs / minute)} min`;
  else if (abs < day) text = `${Math.round(abs / hour)} h`;
  else if (abs < 60 * day) text = `${Math.round(abs / day)} days`;
  else if (abs < 730 * day) text = `${Math.round(abs / (30 * day))} months`;
  else text = `${Math.round(abs / (365 * day))} years`;
  return diff < 0 ? `${text} ago` : `in ${text}`;
};

/** The change from `prev` to `cur`, as a ratio (null when there is nothing to compare with). */
export const deltaOf = (cur, prev) => {
  if (cur == null || prev == null) return null;
  if (!prev) return cur ? null : 0;
  return (cur - prev) / prev;
};

// ── Names ──────────────────────────────────────────────────────────────────

export const FEATURES = {
  change_planner: "Change planner",
  assistant: "Assistant",
  reader_companion: "Reading companion",
  sql_question: "SQL questions",
  summary: "Summaries",
  field_suggestion: "Field suggestions",
  network_studio: "Network Studio",
  other: "Other",
  unattributed: "Earlier calls (not attributed)",
};
export const featureName = (f) => FEATURES[f] || f || "Other";

export const LICENCE_SOURCES = { owner: "Operator", subscription: "Subscription", admin: "Granted", trial: "Trial" };
/** A working copy's agency names, whatever shape its meta file gives them (a list, one string, none). */
export const agencyNamesOf = (meta) => {
  const names = meta && meta.agency ? meta.agency.names : null;
  if (Array.isArray(names)) return names.filter(Boolean).map(String);
  return names ? [String(names)] : [];
};

/** The pill of a licence: its tone and its word. */
export const licenceTone = (licence) => {
  if (!licence || !licence.active) return "neutral";
  return { subscription: "success", admin: "primary", trial: "info", owner: "neutral" }[licence.source] || "neutral";
};
export const licenceLabel = (licence) => (licence && licence.active ? LICENCE_SOURCES[licence.source] || licence.source : "Reading only");
export const ROLES = { authority: "Transport authority", operator: "Transport operator", consultancy: "Consultancy", other: "Other" };
export const MAIL_KINDS = { login_code: "Sign-in code", trial_started: "Trial started", trial_ending: "Trial ending", trial_ended: "Trial ended", quote: "Quote request" };
export const DRAFT_KINDS = { hand: "By hand", brief: "With a brief" };

/** The plain sentence of an attention item (overview). */
export const attentionText = (a) => {
  const n = a.count;
  const s = n === 1 ? "" : "s";
  switch (a.kind) {
    case "quotes_new":
      return `${n} quote request${s} to answer`;
    case "trials_ending":
      return `${n} trial${s} ending within 3 days`;
    case "grants_ending":
      return `${n} granted licence${s} ending within 30 days`;
    case "subscriptions_cancelling":
      return `${n} subscription${s} set to cancel`;
    case "payments_failing":
      return `${n} payment${s} failing`;
    case "allowance_exhausted":
      return `${n} account${s} out of AI allowance`;
    case "server_errors":
      return `${n} server error${s} in the last 24 h`;
    case "capacity":
      return `Working copies at ${n} of ${a.limit}`;
    case "ai_budget":
      return `AI daily budget at ${n} of ${a.limit} calls`;
    default:
      return a.kind;
  }
};

// The event log's families and the sentence each common type reads as.
export const EVENT_FAMILIES = {
  account: "Accounts",
  auth: "Sign-in",
  billing: "Billing",
  upload: "Uploads",
  session: "Working copies",
  validation: "Validation",
  edit: "Edit mode",
  mutation: "Edits",
  quickfix: "Quick fixes",
  export: "Exports",
  sql: "SQL console",
  chat: "Assistant",
  ai: "AI helpers",
  transform: "Change Studio",
  network: "Network Studio",
  workspace: "Projects",
  share: "Sharing",
  demand: "Demand",
  spreadsheet: "Spreadsheets",
  acknowledgement: "Decisions",
};
export const familyOf = (type) => String(type || "").split(".")[0];

const EVENT_SENTENCES = {
  "account.code_sent": () => "Sign-in code sent",
  "account.registered": () => "Account created",
  "account.login": () => "Signed in",
  "account.exported": () => "Exported their data",
  "account.deleted": () => "Account deleted",
  "account.entitlements": (d) => `Licence ${d.entitlements && d.entitlements.length ? `granted${d.grant_until ? ` until ${fmtDate(d.grant_until)}` : ""}` : "revoked"}${d.disabled ? " · disabled" : ""}`,
  "auth.logout_everywhere": (d) => `Signed out everywhere (${d.sessions ?? "?"} sessions)`,
  "billing.trial": (d) => `Trial started (${d.days ?? "?"} days)`,
  "billing.checkout": (d) => `Checkout opened (${d.period || "year"})`,
  "billing.quote": () => "Quote requested",
  "billing.webhook": () => "Payment provider event",
  upload: (d) => `Feed uploaded${d.agency_names ? ` · ${[].concat(d.agency_names).slice(0, 2).join(", ")}` : ""}`,
  "session.created": () => "Working copy opened",
  "validation.run": (d) => `Validated · ${d.errors ?? 0} errors, ${d.warnings ?? 0} warnings`,
  "edit.entered": () => "Entered edit mode",
  "edit.exited": () => "Left edit mode",
  "export.completed": (d) => `Exported${d.size_kb ? ` · ${fmtBytes(d.size_kb * 1024)}` : ""}`,
  "sql.query": (d) => `SQL ${d.kind || "query"}${d.row_count != null ? ` · ${d.row_count} rows` : ""}`,
  "mutation.applied": (d) => `Edit · ${d.entity || d.kind || "change"}${d.rows ? ` (${d.rows} rows)` : ""}`,
  "chat.turn": () => "Assistant turn",
  "chat.feedback": (d) => `Assistant rated ${d.rating === 1 || d.rating === "up" ? "helpful" : "unhelpful"}`,
  "transform.plan": (d) => `Change planned${d.model ? ` · ${d.model}` : ""}`,
  "transform.preview": () => "Change simulated",
  "transform.commit": () => "Change applied",
  "workspace.project.created": () => "Project created",
  "workspace.version": () => "Version frozen",
  "workspace.delivered": () => "Delivered",
  "workspace.package": () => "Delivery package built",
  "share.created": () => "Share link created",
  "share.opened": () => "Share link opened",
  "share.version": () => "Share link updated",
  "workspace.restored": () => "Version restored",
  "workspace.token": () => "Browser token issued",
  "workspace.review": (d) => `Version ${d.action || "reviewed"}`,
  "workspace.member": () => "Project member changed",
  "workspace.handed_over": () => "Project handed over",
  "workspace.attached": () => "Projects attached to an account",
  "network.catalog_open": () => "Public network opened from the catalogue",
  "network.catalog_import": () => "Public network imported",
  "network.document": () => "Brief document read",
  "network.plan": () => "Network Studio turn",
  "network.plan_turn": () => "Network Studio turn",
  "network.compiled": () => "Network compiled",
  "demand.feed_estimate": () => "Demand estimated",
  "transform.reference_added": () => "Reference feed added",
  "spreadsheet.parse": () => "Spreadsheet read",
  "acknowledgement.recorded": () => "Decision recorded",
  "export.blocked_by_validation": () => "Export blocked by validation",
  "export.preflight_ok": () => "Export checked",
  "chat.upsell_shown": (d) => `Licence offered${d.reason ? ` · ${d.reason}` : ""}`,
  "chat.attachment": () => "File attached to the assistant",
  "ai.summary": () => "AI summary",
  "ai.suggest": () => "AI field suggestion",
  "sql.export_csv": () => "SQL result exported",
};
// An event without a sentence of its own reads as its family and its words: « Demand · feed estimate ».
const plainType = (type) => {
  const [family, ...rest] = String(type || "").split(".");
  const words = rest.join(" ").replace(/_/g, " ");
  return `${EVENT_FAMILIES[family] || family}${words ? ` · ${words}` : ""}`;
};
export const eventSentence = (e) => {
  const fn = EVENT_SENTENCES[e.type];
  try {
    return fn ? fn(e.data || {}) : plainType(e.type);
  } catch {
    return plainType(e.type);
  }
};
