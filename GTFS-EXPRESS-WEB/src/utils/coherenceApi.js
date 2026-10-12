/**
 * coherenceApi — the coherence report of the server (target design §6.2,
 * D11, M-5): what each line offers by direction and day type, and what does
 * not hold together, READ from the feed by the server — never computed in
 * the browser, never a verdict.
 *
 *   fetchNetworkCoherence({ sessionId, clauses, region, offset, limit, signal })
 *                                   /network/coherence (the session's feed, or a build's own session)
 *   fetchPreviewCoherence(previewId, { clauses, framing, region, offset, limit, signal })
 *                                   /transform/preview/:id/coherence (a simulated change, before → after)
 *   Both GET without clauses; with clauses, POST with them in a JSON body { clauses } — EVERY clause the
 *   report cross-checks, up to the contract's bound (240; the server refuses more, TOO_MANY_CLAUSES, never
 *   drops one): a long contract outgrows a URL (a request line past 16 KB is refused, about fifty clauses).
 *   The query keeps the page, the region and the framing.
 *   loadCoherence(source, { signal, onPage, from })  every page of a source → the report, pages merged
 *                                   (`from`: a partial report, completed from its next_offset)
 *   coherenceForNote(source, { timeoutMs })  the report a deliverable carries → { report } | { error }:
 *                                   a simulation's report as ④ read it when whole, else fetched; the
 *                                   network's always fetched (the feed may have changed since ④ read it —
 *                                   an application, an edit — and the server caches it by data version)
 *   rememberCoherence(source, report) / rememberedCoherence(source) / forgetCoherence()
 *                                   the last report of a source, this tab only (forgotten on an
 *                                   application or a build: what the network is changed)
 *   sourceKey(source)               a source's identity: { kind: "network", sessionId?, clauses? } ·
 *                                   { kind: "preview", previewId, clauses?, framing? } · { kind: "static", report }
 *   contractClauses(contract)       the clauses the report may call decided: the contract's own, only
 *                                   once ② is decided (or assumed) — a draft or an empty contract, none
 *   noteCoherence({ report } | { error }, t)  what a note carries: the report, or { unavailable: reason }
 *   frozenCoherence(report)         a compare report as a frozen scenario keeps it (§2.4 coherence):
 *                                   the rows the change touches, the unchanged ones counted
 *
 * The report as files and as clauses (mission step 7), both the server's:
 *   exportSourceOf(source, fallback)  the source the server can read again for a file or for clauses:
 *                                   a network or a simulation; a static report (a design's dry run, a
 *                                   frozen scenario) → `fallback` (the network itself, when it is the version)
 *   coherenceFileUrl(source, format, labels)   …/coherence.xlsx | .pdf (labels: network, version,
 *                                   versionAt, lang — printed in the header as they are, never a figure);
 *                                   the clauses are not in it: they ride in the body of the request
 *   downloadCoherenceFile(source, format, labels) → the file name saved (the server's, or ours)
 *   addCoherenceClauses(source, { fingerprint, rows, by, contract, version, journey, lang })
 *                                   POST …/coherence/clauses: the ticked rows named by their key, the
 *                                   server builds, measures and merges the clauses into the contract (decided,
 *                                   assumed or empty: a draft is refused, CONTRACT_UNDECIDED) → its answer;
 *                                   the report's clauses (`clauses`) ride in the body with the request
 *   mergeServerContract(contract, answer)   the project's contract with the server's merge applied: the
 *                                   clauses already there kept as this browser holds them, the new ones
 *                                   the server's (with their `origin`: where they come from)
 *   ROW_MEASURES, DEFAULT_ROW_MEASURES   the measures of a row the person may tick
 *
 * And the words of the report, pure (the table, the CSV, the note use them):
 *   dayTypeLabel · periodText · headwayText · runTimeText · anomalyText ·
 *   schoolCalendarText · coherenceCsv · coherenceNoteHtml · compactClauses · clausesBody · framingOf
 *
 * Errors carry `code`, `status` and `body` (the server's refusal, rendered by
 * RefusalNotice through refusalToAction).
 */

import API_BASE_URL from "../config";
import { fetchWithSession } from "./sessionManager";
import { formatYmd } from "./formatDate";
import { humanError } from "./humanError";

const PAGE = 200;
const NOTE_PAGE = 500;
const NOTE_TIMEOUT_MS = 20000;
const NOTE_MAX_ROWS = 400;
// A frozen scenario travels with the project (the server keeps it under 900 KB): about 800 bytes a row.
const FROZEN_MAX_ROWS = 80;
const CLAUSE_KINDS = new Set(["days", "headway_max", "span"]);
const CLAUSE_PARAMS = ["line", "day", "days", "period", "from", "to", "minutes", "direction", "first_before", "last_after"];

// ── Requests ────────────────────────────────────────────────────────────────

const httpError = (res, data = {}) => {
  const err = new Error(data.message || data.error || `HTTP ${res.status}`);
  err.code = data.error || `HTTP_${res.status}`;
  err.status = res.status;
  err.body = data;
  return err;
};

const getJson = async (url, { headers = {}, signal, body = null } = {}) => {
  let res;
  try {
    res = await fetchWithSession(url, { ...requestInit(body, headers), signal });
  } catch (err) {
    const e = new Error(err?.name === "AbortError" ? "aborted" : err?.message || "Network error");
    e.code = err?.name === "AbortError" ? "ABORTED" : "NETWORK_ERROR";
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  return data;
};

/**
 * The contract's clauses the report cross-checks (days, headway_max, span), without what it does not read —
 * every one of them: the contract is bounded at 240 and the server refuses more rather than dropping any.
 */
export const compactClauses = (clauses) =>
  (Array.isArray(clauses) ? clauses : [])
    .filter((c) => c && CLAUSE_KINDS.has(c.kind) && c.status !== "waived")
    .map((c) => ({ id: c.id, kind: c.kind, level: c.level || "must", params: Object.fromEntries(CLAUSE_PARAMS.filter((k) => c.params?.[k] !== undefined && c.params?.[k] !== null && c.params?.[k] !== "").map((k) => [k, c.params[k]])) }));

/** The body a report's request carries: the compact clauses, or null without any (a GET then). */
export const clausesBody = (clauses) => {
  const compact = compactClauses(clauses);
  return compact.length ? { clauses: compact } : null;
};

/** The fetch options of a request: a GET without a body; with one, a POST that carries it as JSON. */
const requestInit = (body, headers = {}) => (body ? { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) } : { headers });

/** The change's framing (project.context) as the report reads it: { day_types, from, to } (ISO dates), or null. */
export const framingOf = (context) => {
  if (!context) return null;
  const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
  const dayTypes = Array.isArray(context.day_types) ? context.day_types.filter(Boolean) : [];
  const from = iso(context.from_date);
  const to = iso(context.to_date);
  return dayTypes.length || from || to ? { day_types: dayTypes, from, to } : null;
};

// The query of a report: the page, the region and the framing — never the clauses, which ride in the body.
const query = ({ framing = null, region = null, offset = 0, limit = PAGE } = {}) => {
  const q = new URLSearchParams();
  if (offset) q.set("offset", String(offset));
  if (limit) q.set("limit", String(limit));
  if (region) q.set("region", region);
  if (framing?.day_types?.length) q.set("day_types", framing.day_types.join(","));
  if (framing?.from) q.set("from", framing.from);
  if (framing?.to) q.set("to", framing.to);
  const s = q.toString();
  return s ? `?${s}` : "";
};

/** The report of the session's feed (`sessionId`: a build's own session instead of the tab's). */
export const fetchNetworkCoherence = ({ sessionId = null, clauses = null, region = null, offset = 0, limit = PAGE, signal } = {}) => getJson(`${API_BASE_URL}/network/coherence${query({ region, offset, limit })}`, { headers: sessionId ? { "X-Session-ID": sessionId } : {}, signal, body: clausesBody(clauses) });

/** The report of a simulated change, before → after, by period. */
export const fetchPreviewCoherence = (previewId, { clauses = null, framing = null, region = null, offset = 0, limit = PAGE, signal } = {}) => getJson(`${API_BASE_URL}/transform/preview/${encodeURIComponent(previewId)}/coherence${query({ framing, region, offset, limit })}`, { signal, body: clausesBody(clauses) });

/** A source's identity (what makes two reports the same). */
export const sourceKey = (source) => {
  if (!source) return "";
  if (source.kind === "static") return `static|${source.report?.computed_at || ""}`;
  const clauses = JSON.stringify(compactClauses(source.clauses));
  if (source.kind === "preview") return `preview|${source.previewId}|${clauses}|${JSON.stringify(framingOf(source.framing) || null)}|${source.region || ""}`;
  return `network|${source.sessionId || ""}|${clauses}|${source.region || ""}`;
};

const fetchPage = (source, offset, limit, signal) =>
  source.kind === "preview" ? fetchPreviewCoherence(source.previewId, { clauses: source.clauses, framing: framingOf(source.framing), region: source.region, offset, limit, signal }) : fetchNetworkCoherence({ sessionId: source.sessionId, clauses: source.clauses, region: source.region, offset, limit, signal });

/** Two pages of one report, merged (the anomalies come whole with every page). */
export const mergePages = (a, b) => (a ? { ...b, rows: [...a.rows, ...b.rows], offset: a.offset } : b);

/** One page of a source (`offset`), or the static report itself. */
export const loadCoherencePage = (source, { offset = 0, limit = PAGE, signal } = {}) => (source?.kind === "static" ? Promise.resolve(source.report) : fetchPage(source, offset, limit, signal));

/** Every page of a source, merged; `from` (a report whose next pages are missing) is completed instead of read again. */
export const loadCoherence = async (source, { signal, limit = PAGE, onPage = null, from = null } = {}) => {
  if (source?.kind === "static") return source.report;
  let report = from;
  let offset = from ? from.next_offset : 0;
  if (from && offset == null) return from;
  for (let i = 0; i < 50; i++) {
    const page = await fetchPage(source, offset, limit, signal);
    report = mergePages(report, page);
    onPage?.(report);
    if (page.next_offset == null) break;
    offset = page.next_offset;
  }
  return report;
};

// The last report of each source, in this tab (the note carries the report ④ showed).
const _remembered = new Map();
export const rememberCoherence = (source, report) => {
  const key = sourceKey(source);
  if (!key || !report) return;
  _remembered.delete(key);
  _remembered.set(key, report);
  while (_remembered.size > 8) _remembered.delete(_remembered.keys().next().value);
};
export const rememberedCoherence = (source) => _remembered.get(sourceKey(source)) || null;
/** Every report remembered, forgotten: the network changed (an application, a build). */
export const forgetCoherence = () => _remembered.clear();

const timeoutError = () => Object.assign(new Error("The coherence report took too long to read."), { code: "TIMEOUT", status: null });

/**
 * The report a deliverable carries (the note, ⑤'s CSV) → { report } | { error }.
 * A simulation's (or a static) report is the one ④ read when it is whole; the
 * network's is always asked again — its key does not follow the feed's state,
 * and the server answers from its cache while the data version is the same.
 * No source: { report: null } (nothing to read). A report that takes more
 * than `timeoutMs` is { error } (code TIMEOUT), never a silent nothing.
 */
export const coherenceForNote = async (source, { timeoutMs = NOTE_TIMEOUT_MS } = {}) => {
  if (!source) return { report: null };
  if (source.kind === "static") return source.report?.error || !source.report ? { error: Object.assign(new Error(String(source.report?.error || "No coherence report.")), { code: null, status: null }) } : { report: source.report };
  if (source.kind === "preview") {
    const known = rememberedCoherence(source);
    if (known && known.next_offset == null) return { report: known };
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const report = await loadCoherence(source, { signal: controller.signal, limit: NOTE_PAGE });
    rememberCoherence(source, report);
    return { report };
  } catch (err) {
    return { error: timedOut ? timeoutError() : err };
  } finally {
    clearTimeout(timer);
  }
};

/** What a note carries for coherenceForNote's answer: the report, or `{ unavailable: reason }` (the section then says it could not be read). */
export const noteCoherence = (got, t) => (got?.report ? got.report : { unavailable: got?.error ? humanError(got.error, t).message : null });

/** The clauses the report may call decided: the contract's, once ② is decided or assumed; none for a draft or an empty contract. */
export const contractClauses = (contract) => (contract && (contract.status === "decided" || contract.status === "assumed") && Array.isArray(contract.clauses) ? contract.clauses : []);

/**
 * A compare report as a frozen scenario keeps it (§2.4, the scenario's
 * `coherence`): the rows the change touches (at most FROZEN_MAX_ROWS, the
 * rest counted in `omitted_rows`), the unchanged ones counted in
 * `unchanged_rows`, the anomalies (the server bounds them, 20 a code) —
 * small enough to travel with the project. No report, or one that is not
 * a comparison: null (nothing is kept; ④ then says so).
 */
export const frozenCoherence = (report) => {
  if (!report || !Array.isArray(report.rows) || report.error) return null;
  if (report.mode !== "compare") return null;
  const changed = report.rows.filter((r) => r.changed);
  const kept = changed.slice(0, FROZEN_MAX_ROWS);
  return { ...report, rows: kept, unchanged_rows: report.rows.length - changed.length + (report.unchanged_rows || 0), omitted_rows: changed.length - kept.length + (report.omitted_rows || 0), anomalies: report.anomalies || [], next_offset: null, frozen: true };
};

// ── Files and clauses (mission step 7) ─────────────────────────────────────

export const ROW_MEASURES = Object.freeze(["first", "last", "span", "headway_peak", "headway_offpeak", "trips", "running_time", "keep"]);
export const DEFAULT_ROW_MEASURES = Object.freeze(ROW_MEASURES.filter((m) => m !== "keep"));

/** The source the server can read again (a network, a simulation); a static report gives `fallback`. */
export const exportSourceOf = (source, fallback = null) => (source && (source.kind === "network" || source.kind === "preview") ? source : fallback && (fallback.kind === "network" || fallback.kind === "preview") ? fallback : null);

const baseOf = (source) => (source.kind === "preview" ? `${API_BASE_URL}/transform/preview/${encodeURIComponent(source.previewId)}/coherence` : `${API_BASE_URL}/network/coherence`);
// The whole report (no page): its region and framing in the query, its clauses in the body (clausesBody).
const reportQuery = (source) => (source.kind === "preview" ? query({ framing: framingOf(source.framing), region: source.region, limit: 0 }) : query({ region: source.region, limit: 0 }));
const sessionHeaders = (source) => (source?.sessionId ? { "X-Session-ID": source.sessionId } : {});

/** The URL of …/coherence.xlsx | .pdf of a source, with the labels its header prints (the clauses ride in the body). */
export const coherenceFileUrl = (source, format, { network = null, version = null, versionAt = null, lang = null } = {}) => {
  const q = new URLSearchParams(reportQuery(source).replace(/^\?/, ""));
  if (network) q.set("network", String(network).slice(0, 120));
  if (version) q.set("version", String(version).slice(0, 40));
  if (versionAt) q.set("version_at", String(versionAt).slice(0, 40));
  if (lang) q.set("lang", lang);
  const s = q.toString();
  return `${baseOf(source)}.${format}${s ? `?${s}` : ""}`;
};

const fileNameOf = (res, fallback) => {
  const m = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "");
  return m ? m[1] : fallback;
};

/** Download the report as a file the server rendered (xlsx | pdf) → the file name. Errors carry code, status, body. */
export const downloadCoherenceFile = async (source, format, labels = {}) => {
  let res;
  try {
    // A GET for a source without clauses; with them, a POST carrying every one in its body (never cut to fit a URL).
    res = await fetchWithSession(coherenceFileUrl(source, format, labels), requestInit(clausesBody(source.clauses), sessionHeaders(source)));
  } catch (err) {
    const e = new Error(err?.message || "Network error");
    e.code = err?.status === 429 ? "RATE_LIMITED" : "NETWORK_ERROR";
    e.status = err?.status ?? null;
    throw e;
  }
  if (!res.ok) throw httpError(res, await res.json().catch(() => ({})));
  const name = fileNameOf(res, `rapport-coherence.${format}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
};

/** POST …/coherence/clauses: the server builds the ticked rows' clauses on the version, measures them and merges them. */
export const addCoherenceClauses = async (source, { fingerprint, rows, by, contract = null, version = null, journey = null, lang = null }) => {
  let res;
  try {
    // The report's clauses (`clauses`, the ones it cross-checks) ride in the body too, beside the contract they may join.
    res = await fetchWithSession(`${baseOf(source)}/clauses${reportQuery(source)}`, { method: "POST", headers: { "Content-Type": "application/json", ...sessionHeaders(source) }, body: JSON.stringify({ report: { fingerprint }, rows, by, ...(contract ? { contract } : {}), ...(version ? { version } : {}), ...(journey ? { journey } : {}), ...(lang ? { lang } : {}), ...(clausesBody(source.clauses) || {}) }) });
  } catch (err) {
    const e = new Error(err?.message || "Network error");
    e.code = err?.status === 429 ? "RATE_LIMITED" : "NETWORK_ERROR";
    e.status = err?.status ?? null;
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  return data;
};

/**
 * The project's contract once the server merged the clauses (its `contract`): the server's list and order, a
 * clause this browser already held kept as it holds it (its own bookkeeping included), the new ones as the server
 * built them (`answer.clauses`: their `origin` with them); the status the server gives (an empty contract becomes
 * decided by the person). Without a contract in the answer the server merged nothing: the contract is left as it
 * is (clauses a person decided are never slipped into a contract nobody decided — a draft would drop them).
 */
export const mergeServerContract = (contract, answer) => {
  if (!answer?.contract) return contract;
  const prev = contract || { status: "draft", decided_by: null, decided_at: null, clauses: [], wishes: [], assumptions: [], dismissed: [], brief: null, extracted: null };
  const byId = new Map((prev.clauses || []).map((c) => [c.id, c]));
  const built = new Map((answer.clauses || []).map((c) => [c.id, c]));
  const added = new Set(answer.added || []);
  const server = answer.contract;
  const clauseOf = (c) => (byId.has(c.id) && !added.has(c.id) ? byId.get(c.id) : added.has(c.id) && built.has(c.id) ? { ...c, ...(built.get(c.id).origin ? { origin: built.get(c.id).origin } : {}) } : c);
  return { ...prev, status: server.status, decided_by: server.decided_by ?? prev.decided_by ?? null, decided_at: server.decided_at ?? prev.decided_at ?? null, clauses: (server.clauses || []).map(clauseOf) };
};

// ── Words ───────────────────────────────────────────────────────────────────

const DAY_TYPE_KEYS = { school_weekday: "schoolWeekday", holiday_weekday: "holidayWeekday", weekday: "weekday", saturday: "saturday", sunday_holiday: "sundayHoliday" };
const ymdOf = (iso) => String(iso || "").replace(/-/g, "");

/** A day type in the reader's words ("Semaine scolaire"). */
export const dayTypeLabel = (type, t) => (DAY_TYPE_KEYS[type] ? t(`coherence.dayType.${DAY_TYPE_KEYS[type]}`) : String(type || ""));

/** A date of the report (ISO) in the interface's language. */
export const dateText = (iso, language) => formatYmd(ymdOf(iso), language) || String(iso || "");

/** A row's period: "du 2 nov. 2026 au 18 déc. 2026", "Reste de la validité", or "" without one. */
export const periodText = (period, t, language) => {
  if (!period) return "";
  if (period.name === "rest") return t("coherence.period.rest");
  return t("coherence.period.range", { from: dateText(period.from, language), to: dateText(period.to, language) });
};

/** A headway { peak, offpeak } in minutes: "10 / 20 min", "30 min" when both are equal, "—" without any. */
export const headwayText = (headway, t) => {
  const p = headway?.peak;
  const o = headway?.offpeak;
  if (p == null && o == null) return "—";
  if (p === o || o == null) return t("coherence.minutes", { n: p });
  if (p == null) return t("coherence.minutes", { n: o });
  return t("coherence.headway.both", { peak: p, offpeak: o });
};

/** A running time { min, max } in minutes. */
export const runTimeText = (rt, t) => {
  if (!rt) return "—";
  return rt.min === rt.max ? t("coherence.minutes", { n: rt.min }) : t("coherence.runTime.value", { min: rt.min, max: rt.max });
};

/** A line's name as the report says it. */
export const lineLabel = (row) => row?.route_short_name || row?.route_long_name || row?.route_id || "";

/**
 * An anomaly in the reader's words: { head, text } — the head names the line
 * and the day type when the anomaly has them, the text is the code's sentence.
 */
export const anomalyText = (a, t, language) => {
  const line = a.route_short_name || a.route_id || "";
  const dayType = a.day_type ? dayTypeLabel(a.day_type, t) : "";
  const period = a.period ? a.period.name || t("coherence.period.range", { from: dateText(a.period.from, language), to: dateText(a.period.to, language) }) : "";
  const params = { line, dayType, clause: a.clause_id || "", period, trips: a.trips ?? "", from: dateText(a.from, language), to: dateText(a.to, language), count: a.count ?? "", id: a.id || "" };
  const head = [line, dayType].filter(Boolean).join(" · ");
  const known = ["no_service_vs_clause", "school_pattern_in_holidays", "headway_one_direction", "uncovered_dates", "stop_without_coords", "calendar_without_day", "day_type_touched_out_of_scope"].includes(a.code);
  let text = known ? t(`coherence.anomaly.${a.code}`, params) : a.text || a.code;
  if (a.code === "day_type_touched_out_of_scope" && a.reason === "dates") text = `${text} ${t("coherence.anomaly.outOfDates", params)}`;
  // The sentences that name the line and the day type themselves need no head.
  return { head: a.code === "no_service_vs_clause" || a.code === "day_type_touched_out_of_scope" ? "" : head, text };
};

/** What the day types rest on, in one sentence (the school calendar, its zone, or why weekdays are one). */
export const schoolCalendarText = (sc, t, language) => {
  if (!sc) return "";
  if (sc.status === "not_france") return t("coherence.school.notFrance");
  if (sc.status === "no_country") return t("coherence.school.noCountry");
  // A calendar published only up to a date before the network's: said as such (the server has one, it ends too early).
  if (sc.status === "unavailable") return sc.covered_until ? t("coherence.school.ended", { date: dateText(sc.covered_until, language) }) : t("coherence.school.unavailable");
  const source = sc.source ? t(`coherence.school.source.${sc.source}`) : "";
  const parts = [];
  if (sc.region) parts.push(t("coherence.school.zone", { region: sc.region, source }));
  else parts.push(t("coherence.school.common"));
  if (sc.region && sc.region_source === "inferred") parts.push(t("coherence.school.inferred"));
  if (sc.asked_region) parts.push(t("coherence.school.regionUnknown", { region: sc.asked_region }));
  if (sc.covered_until) parts.push(t("coherence.school.coveredUntil", { date: dateText(sc.covered_until, language) }));
  return parts.join(" ");
};

// ── The CSV ─────────────────────────────────────────────────────────────────

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * What a report leaves out, in words (the CSV, the caption, the note): the
 * lines of the network not loaded yet (a paginated report, `next_offset`),
 * the unchanged rows and the changed rows beyond what a frozen scenario
 * keeps (frozenCoherence).
 */
export const coherenceGaps = (report, t) => {
  if (!report) return [];
  const out = [];
  if (report.next_offset != null && Number.isFinite(report.routes_total)) out.push(t("coherence.partial", { count: report.routes_total - report.next_offset }));
  if (report.frozen && report.unchanged_rows) out.push(t("coherence.note.unchanged", { count: report.unchanged_rows }));
  if (report.omitted_rows) out.push(t("coherence.frozen.omitted", { count: report.omitted_rows }));
  return out;
};

/** The report as CSV (a header in the reader's language, one line per row; before → after columns when comparing). */
export const coherenceCsv = (report, t, language) => {
  const compare = report?.mode === "compare";
  const cols = [t("coherence.col.line"), t("coherence.col.direction"), t("coherence.col.dayType"), t("coherence.col.period"), t("coherence.representativeDate"), t("coherence.col.first"), t("coherence.col.last"), t("coherence.headway.peak"), t("coherence.headway.offpeak"), t("coherence.col.trips"), t("coherence.col.patterns"), t("coherence.col.runTime")];
  const before = compare ? cols.slice(5).map((c) => `${t("coherence.before")} — ${c}`) : [];
  const lines = [[...cols, ...before, ...(compare ? [t("coherence.changedMark")] : [])].map(csvCell).join(",")];
  const measures = (m) => [m?.first_departure || "", m?.last_departure || "", m?.headway?.peak ?? "", m?.headway?.offpeak ?? "", m?.trips ?? "", (m?.patterns || []).length, m?.running_time ? `${m.running_time.min}-${m.running_time.max}` : ""];
  for (const r of report?.rows || []) {
    const cells = [lineLabel(r), r.direction_name || r.direction_id, dayTypeLabel(r.day_type, t), periodText(r.period, t, language), r.date || "", ...measures(r), ...(compare ? [...measures(r.before), r.changed ? "1" : "0"] : [])];
    lines.push(cells.map(csvCell).join(","));
  }
  // What the rows above leave out, said in the file itself: the lines not loaded, the rows a frozen scenario did not keep.
  for (const note of coherenceGaps(report, t)) lines.push(csvCell(note));
  if ((report?.anomalies || []).length) {
    lines.push("");
    lines.push(csvCell(t("coherence.anomalies", { count: report.anomalies.length })));
    for (const a of report.anomalies) {
      const { head, text } = anomalyText(a, t, language);
      lines.push([head, text, a.preexisting ? t("coherence.preexisting") : ""].map(csvCell).join(","));
    }
  }
  return `${lines.join("\r\n")}\r\n`;
};

/** Save the report as a CSV file (UTF-8 with its mark, so spreadsheets read the accents). */
export const downloadCoherenceCsv = (report, t, language, name = "rapport-coherence") => {
  const blob = new Blob([`\ufeff${coherenceCsv(report, t, language)}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// ── The note's section ──────────────────────────────────────────────────────

/**
 * The report as a section of a delivery note (HTML): the anomalies first,
 * then the table — when comparing, only the rows the change touches (the
 * unchanged ones counted) — at most NOTE_MAX_ROWS rows, the rest said.
 * `{ unavailable: reason | null }` in place of a report: the section says
 * the report could not be read. `esc` is the note's own escaping.
 */
export const coherenceNoteHtml = (report, { t, language, esc }) => {
  // A report that could not be read is said, never left out (`{ unavailable: reason }`).
  if (report && "unavailable" in report) return `<h2>${esc(t("coherence.title"))}</h2>\n<p class="note">${esc(report.unavailable ? t("coherence.note.unavailableReason", { reason: report.unavailable }) : t("coherence.note.unavailable"))}</p>`;
  if (!report || !Array.isArray(report.rows)) return "";
  const compare = report.mode === "compare";
  const out = [`<h2>${esc(t("coherence.title"))}</h2>`];
  const school = schoolCalendarText(report.school_calendar, t, language);
  if (school) out.push(`<p class="note">${esc(school)}</p>`);
  const anomalies = report.anomalies || [];
  if (anomalies.length) {
    out.push(`<p><strong>${esc(t("coherence.anomalies", { count: anomalies.length }))}</strong></p><ul>`);
    for (const a of anomalies) {
      const { head, text } = anomalyText(a, t, language);
      out.push(`<li>${head ? `<strong>${esc(head)}</strong> — ` : ""}${esc(text)}${a.preexisting ? ` <span class="note">(${esc(t("coherence.preexisting"))})</span>` : ""}</li>`);
    }
    out.push("</ul>");
  } else out.push(`<p>${esc(t("coherence.noAnomaly"))}</p>`);
  const rows = compare ? report.rows.filter((r) => r.changed) : report.rows;
  const shown = rows.slice(0, NOTE_MAX_ROWS);
  const cell = (m) => `<td>${esc(m?.first_departure || "—")}</td><td>${esc(m?.last_departure || "—")}</td><td class="num">${esc(headwayText(m?.headway, t))}</td><td class="num">${esc(m?.trips ?? 0)}</td>`;
  if (shown.length) {
    out.push(`<table><tr><th>${esc(t("coherence.col.line"))}</th><th>${esc(t("coherence.col.direction"))}</th><th>${esc(t("coherence.col.dayType"))}</th>${compare ? `<th>${esc(t("coherence.col.period"))}</th><th></th>` : ""}<th>${esc(t("coherence.col.first"))}</th><th>${esc(t("coherence.col.last"))}</th><th class="num">${esc(t("coherence.col.headway"))}</th><th class="num">${esc(t("coherence.col.trips"))}</th></tr>`);
    for (const r of shown) {
      const lead = `<td>${esc(lineLabel(r))}</td><td>${esc(r.direction_name || r.direction_id)}</td><td>${esc(dayTypeLabel(r.day_type, t))}</td>`;
      if (compare) {
        const period = esc(periodText(r.period, t, language) || t("coherence.period.whole"));
        out.push(`<tr>${lead}<td>${period}</td><td>${esc(t("coherence.before"))}</td>${cell(r.before)}</tr>`);
        out.push(`<tr><td></td><td></td><td></td><td></td><td>${esc(t("coherence.after"))}</td>${cell(r)}</tr>`);
      } else out.push(`<tr>${lead}${cell(r)}</tr>`);
    }
    out.push("</table>");
  }
  if (compare) out.push(`<p class="note">${esc(t("coherence.note.unchanged", { count: report.rows.length - rows.length + (report.unchanged_rows || 0) }))}</p>`);
  if (report.omitted_rows) out.push(`<p class="note">${esc(t("coherence.frozen.omitted", { count: report.omitted_rows }))}</p>`);
  if (rows.length > shown.length) out.push(`<p class="note">${esc(t("coherence.note.truncated", { count: shown.length }))}</p>`);
  return out.join("\n");
};
