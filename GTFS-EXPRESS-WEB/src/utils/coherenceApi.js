/**
 * The coherence report is read from the feed by the server, never computed in the browser and never a verdict.
 * A source is { kind: "network", sessionId? }, { kind: "preview", previewId, framing? } or { kind: "static",
 * report }. Errors carry `code`, `status` and `body` for RefusalNotice.
 */

import API_BASE_URL from "../config";
import { ensureOk, request, requestJson } from "./apiRequest";
import { formatYmd } from "./formatDate";
import { humanError } from "./humanError";

const PAGE = 200;
const NOTE_PAGE = 500;
const NOTE_TIMEOUT_MS = 20000;
const NOTE_MAX_ROWS = 400;
// A frozen scenario travels with the project (the server keeps it under 900 KB): about 800 bytes a row.
const FROZEN_MAX_ROWS = 80;

// ── Requests

const getJson = (url, { headers = {}, signal } = {}) => requestJson(url, { headers, signal });

/** project.context → { day_types, from, to } (ISO dates), or null. */
export const framingOf = (context) => {
  if (!context) return null;
  const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
  const dayTypes = Array.isArray(context.day_types) ? context.day_types.filter(Boolean) : [];
  const from = iso(context.from_date);
  const to = iso(context.to_date);
  return dayTypes.length || from || to ? { day_types: dayTypes, from, to } : null;
};

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

/** `sessionId`: another session than the tab's. */
export const fetchNetworkCoherence = ({ sessionId = null, region = null, offset = 0, limit = PAGE, signal } = {}) => getJson(`${API_BASE_URL}/network/coherence${query({ region, offset, limit })}`, { headers: sessionId ? { "X-Session-ID": sessionId } : {}, signal });

export const fetchPreviewCoherence = (previewId, { framing = null, region = null, offset = 0, limit = PAGE, signal } = {}) => getJson(`${API_BASE_URL}/transform/preview/${encodeURIComponent(previewId)}/coherence${query({ framing, region, offset, limit })}`, { signal });

export const sourceKey = (source) => {
  if (!source) return "";
  if (source.kind === "static") return `static|${source.report?.computed_at || ""}`;
  if (source.kind === "preview") return `preview|${source.previewId}|${JSON.stringify(framingOf(source.framing) || null)}|${source.region || ""}`;
  return `network|${source.sessionId || ""}|${source.region || ""}`;
};

const fetchPage = (source, offset, limit, signal) =>
  source.kind === "preview" ? fetchPreviewCoherence(source.previewId, { framing: framingOf(source.framing), region: source.region, offset, limit, signal }) : fetchNetworkCoherence({ sessionId: source.sessionId, region: source.region, offset, limit, signal });

/** The anomalies come whole with every page. */
export const mergePages = (a, b) => (a ? { ...b, rows: [...a.rows, ...b.rows], offset: a.offset } : b);

export const loadCoherencePage = (source, { offset = 0, limit = PAGE, signal } = {}) => (source?.kind === "static" ? Promise.resolve(source.report) : fetchPage(source, offset, limit, signal));

/** `from`: a partial report, completed from its next_offset instead of read again. */
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

// This tab only: the note carries the report the screen showed.
const _remembered = new Map();
export const rememberCoherence = (source, report) => {
  const key = sourceKey(source);
  if (!key || !report) return;
  _remembered.delete(key);
  _remembered.set(key, report);
  while (_remembered.size > 8) _remembered.delete(_remembered.keys().next().value);
};
export const rememberedCoherence = (source) => _remembered.get(sourceKey(source)) || null;
/** Called when the network changes (an application, a build). */
export const forgetCoherence = () => _remembered.clear();

const timeoutError = () => Object.assign(new Error("The coherence report took too long to read."), { code: "TIMEOUT", status: null });

/**
 * A simulation's report is reused when whole; the network's is always asked again, since its key does not follow
 * the feed's state (the server caches it by data version). Past `timeoutMs` it is { error } TIMEOUT, never nothing.
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

export const noteCoherence = (got, t) => (got?.report ? got.report : { unavailable: got?.error ? humanError(got.error, t).message : null });

/** Only the changed rows are kept (the rest counted), small enough to travel with the project; null unless a comparison. */
export const frozenCoherence = (report) => {
  if (!report || !Array.isArray(report.rows) || report.error) return null;
  if (report.mode !== "compare") return null;
  const changed = report.rows.filter((r) => r.changed);
  const kept = changed.slice(0, FROZEN_MAX_ROWS);
  return { ...report, rows: kept, unchanged_rows: report.rows.length - changed.length + (report.unchanged_rows || 0), omitted_rows: changed.length - kept.length + (report.omitted_rows || 0), anomalies: report.anomalies || [], next_offset: null, frozen: true };
};

// ── Files

/** A static report cannot be read again by the server: `fallback` then. */
export const exportSourceOf = (source, fallback = null) => (source && (source.kind === "network" || source.kind === "preview") ? source : fallback && (fallback.kind === "network" || fallback.kind === "preview") ? fallback : null);

const baseOf = (source) => (source.kind === "preview" ? `${API_BASE_URL}/transform/preview/${encodeURIComponent(source.previewId)}/coherence` : `${API_BASE_URL}/network/coherence`);
const reportQuery = (source) => (source.kind === "preview" ? query({ framing: framingOf(source.framing), region: source.region, limit: 0 }) : query({ region: source.region, limit: 0 }));
const sessionHeaders = (source) => (source?.sessionId ? { "X-Session-ID": source.sessionId } : {});

/** The labels are printed in the file's header as they are, never a figure. */
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

export const downloadCoherenceFile = async (source, format, labels = {}) => {
  const res = await ensureOk(await request(coherenceFileUrl(source, format, labels), { headers: sessionHeaders(source) }));
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

// ── Words

const DAY_TYPE_KEYS = { school_weekday: "schoolWeekday", holiday_weekday: "holidayWeekday", weekday: "weekday", saturday: "saturday", sunday_holiday: "sundayHoliday" };
const ymdOf = (iso) => String(iso || "").replace(/-/g, "");

export const dayTypeLabel = (type, t) => (DAY_TYPE_KEYS[type] ? t(`coherence.dayType.${DAY_TYPE_KEYS[type]}`) : String(type || ""));

export const dateText = (iso, language) => formatYmd(ymdOf(iso), language) || String(iso || "");

export const periodText = (period, t, language) => {
  if (!period) return "";
  if (period.name === "rest") return t("coherence.period.rest");
  return t("coherence.period.range", { from: dateText(period.from, language), to: dateText(period.to, language) });
};

export const headwayText = (headway, t) => {
  const p = headway?.peak;
  const o = headway?.offpeak;
  if (p == null && o == null) return "—";
  if (p === o || o == null) return t("coherence.minutes", { n: p });
  if (p == null) return t("coherence.minutes", { n: o });
  return t("coherence.headway.both", { peak: p, offpeak: o });
};

export const runTimeText = (rt, t) => {
  if (!rt) return "—";
  return rt.min === rt.max ? t("coherence.minutes", { n: rt.min }) : t("coherence.runTime.value", { min: rt.min, max: rt.max });
};

export const lineLabel = (row) => row?.route_short_name || row?.route_long_name || row?.route_id || "";

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

export const schoolCalendarText = (sc, t, language) => {
  if (!sc) return "";
  if (sc.status === "not_france") return t("coherence.school.notFrance");
  if (sc.status === "no_country") return t("coherence.school.noCountry");
  // A calendar that ends before the network's dates is said as such, not as missing.
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

// ── The CSV

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** What a report leaves out: lines not loaded yet, and the rows a frozen scenario did not keep. */
export const coherenceGaps = (report, t) => {
  if (!report) return [];
  const out = [];
  if (report.next_offset != null && Number.isFinite(report.routes_total)) out.push(t("coherence.partial", { count: report.routes_total - report.next_offset }));
  if (report.frozen && report.unchanged_rows) out.push(t("coherence.note.unchanged", { count: report.unchanged_rows }));
  if (report.omitted_rows) out.push(t("coherence.frozen.omitted", { count: report.omitted_rows }));
  return out;
};

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
  // What the rows leave out is said in the file itself.
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

/** With a UTF-8 BOM, so spreadsheets read the accents. */
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

// ── The note's section

/** `esc` is the note's own escaping. A report that could not be read is said, never left out. */
export const coherenceNoteHtml = (report, { t, language, esc }) => {
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
