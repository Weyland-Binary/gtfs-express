/**
 * coherenceController — the HTTP surface of the coherence report (the checks
 * step ④ and the delivery note read it).
 *
 *   GET /network/coherence                    the report of the session's feed (X-Session-ID):
 *                                             a network built here, opened from the catalogue,
 *                                             uploaded — rows by line × direction × day type
 *   GET /transform/preview/:id/coherence      the report of a previewed plan: the feed as the
 *                                             plan would leave it (its changeset replayed on an
 *                                             in-memory copy), each row before → after, by period
 *                                             where the plan changes part of the validity
 *
 * Query (both): offset, limit (lines per page), region (the school zone, e.g.
 * "C"; else the design's, else the one the feed's calendars follow), clauses
 * (the contract's clauses as JSON — days, headway_max, span — cross-checked
 * by the anomalies; the network report falls back to the requirements stored
 * with a build). The preview adds the change's framing: day_types
 * (comma-separated), from, to (YYYY-MM-DD).
 *
 * The same report with the clauses in a JSON body, for a long contract — a
 * specification read from offer sheets states some thirty clauses a line, and
 * Node refuses a request line past 16 KB (431), about fifty clauses:
 *
 *   POST /network/coherence · POST /transform/preview/:id/coherence
 *     the query of the GET without `clauses`; body { clauses: [...] } (the body's clauses win over the
 *     query's). The same report, the same cache, the same refusals.
 *
 * Wherever they come from, the clauses are read WHOLE or refused: more than
 * conformanceService.MAX_CLAUSES (240, the contract's own bound) is 409
 * TOO_MANY_CLAUSES { max, count } — never a silent cut.
 *
 * The report as an operator's service-méthode sheet, the WHOLE report (every page of lines), rendered by the server from the same
 * data (coherence/serviceSheet: one model, two files):
 *
 *   GET /network/coherence.xlsx · GET /network/coherence.pdf
 *   GET /transform/preview/:id/coherence.xlsx · GET /transform/preview/:id/coherence.pdf
 *     the query of the report, plus labels the file's header prints as they are (never a figure):
 *     network (the project's name of the network), version ("v1"), version_at (its date), lang (fr | en)
 *   POST, same paths: the same files, the clauses in the body { clauses } as for the report
 *
 * « Chaque ligne cochée devient une clause » (coherence/rowClauses):
 *
 *   POST /network/coherence/clauses · POST /transform/preview/:id/coherence/clauses
 *     the query of the report (its clauses may ride in the body instead, `clauses`, as above); body
 *     { report: { fingerprint }, rows: [{ key, measures? }], by: { name },
 *     contract?, version?: { label, date }, journey?: "create" | "modify", lang? } → 200 { clauses, refused,
 *     rows, added, kept, contract, measured, version } — the clauses built by the server from the report IT
 *     computes (the rows named by their key, never by a value), on the version (a simulation's: the version
 *     it starts from), decided by the named person, each measured on that version before it is returned;
 *     merged into `contract` (when sent) by the contract's merge rules (conformanceService.mergeClauses by the user:
 *     a clause a person decided is never reshaped; an empty contract becomes decided by that person).
 *     `journey: "create"` (a network designed here: its next build measures the design, with no feed before
 *     it) refuses « garder telle quelle » row by row (refused: keep_not_measurable). Refusals: 400
 *     INVALID_INPUT, 400 ACKNOWLEDGEMENT_UNNAMED, 409 CONTRACT_UNDECIDED (the contract sent is a draft: its
 *     clauses are measured by nobody and a version made from it records it empty — ② decides it first),
 *     409 COHERENCE_STALE (the rows are of another version: the report's fingerprint is not the feed's any
 *     more), 400 COHERENCE_ROW_UNKNOWN (a key the report has not), 409 TOO_MANY_CLAUSES { max, count } (the
 *     contract would hold more than 240 clauses), and the report's.
 *
 * The report reads the feed, it never judges a clause (the verdict is the
 * conformance engine's) and never writes: nothing is delivered here. It is
 * computed once per state of the feed and parameters (a small cache keyed by
 * the session's data version, or the preview), stops when the person leaves
 * (the response's close cancels it between lines), and answers the typed
 * refusals of the session guard (400 INVALID_SESSION, 404 SESSION_NOT_FOUND),
 * 400 INVALID_INPUT, 404 PREVIEW_NOT_FOUND and 409 PREVIEW_STALE (the feed
 * changed since the simulation).
 */

"use strict";

const { requireSession } = require("../edit/_editCore");
const { getDataVersion } = require("../../middleware/readCache");
const { buildFeedModel } = require("../transform/feedModel");
const { sandboxOf, toOps, applyOps } = require("../transform/changeset");
const engine = require("../transform/engine");
const { sessionCountryCode } = require("../sessionCountry");
const coherence = require("./coherenceService");
const { sheetModel, xlsxOf, pdfOf } = require("./serviceSheet");
const { buildRowClauses, MEASURES } = require("./rowClauses");
const contractService = require("../contract/contractService");
const conformance = require("../network/conformanceService");
const { NAME_OK } = require("../acknowledgement");
const { refusal } = require("../refusal");
const crypto = require("crypto");

const REPORT_TTL_MS = 10 * 60 * 1000;
const MAX_REPORTS = 24;
const MAX_MODELS = 4;
const PREVIEW_ID_RE = /^[a-f0-9]{18}$/;
const ROW_KEY_RE = /^r[a-f0-9]{16}$/;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const MAX_ROWS = 40;
const WHOLE_PAGE = 500;
const MAX_PAGES = 40;
const REGION_RE = /^[A-Za-z0-9][A-Za-z0-9 _'-]{0,39}$/;
const JOURNEYS = ["create", "modify"];

const _reports = new Map();
const _models = new Map();

const remember = (map, key, value, max) => {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
  return value;
};

const cachedReport = (key) => {
  const hit = _reports.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > REPORT_TTL_MS) {
    _reports.delete(key);
    return null;
  }
  return hit.value;
};

/** The feed's model for this state of the session (built once, shared by the report's pages). */
const modelOf = (ctx) => {
  const key = `${ctx.sessionId}|${getDataVersion(ctx.db)}`;
  return _models.get(key) || remember(_models, key, buildFeedModel(ctx.db), MAX_MODELS);
};

/**
 * The clauses a request sends — a JSON body's array (a long contract outgrows a URL) or the query's
 * JSON string — read whole or refused: more than the contract's bound is 409 TOO_MANY_CLAUSES
 * { max, count }, never a silent cut (coherenceService.parseClauses would keep the first 240).
 */
const clausesOf = (raw) => {
  let list = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      list = null; // an unreadable string is no clause at all, as parseClauses reads it
    }
  }
  if (list && typeof list === "object" && !Array.isArray(list) && Array.isArray(list.clauses)) list = list.clauses;
  const count = Array.isArray(list) ? list.length : 0;
  if (count > conformance.MAX_CLAUSES) throw refusal(409, "TOO_MANY_CLAUSES", `${count} clauses were sent: ${conformance.MAX_CLAUSES} at most (the contract's own bound). Remove clauses at step 2.`, { max: conformance.MAX_CLAUSES, count });
  return coherence.parseClauses(list);
};

/** The request's parameters, bounded: the query's, the clauses from a JSON body first (a refusal is thrown). */
const paramsOf = (req, { framing = false } = {}) => {
  const q = req.query || {};
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const int = (v) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : undefined);
  const region = typeof q.region === "string" && REGION_RE.test(q.region.trim()) ? q.region.trim() : null;
  // `null` when nothing is sent (the network's report then reads the design's); `[]` when none is to be cross-checked.
  const sent = body.clauses != null ? body.clauses : typeof q.clauses === "string" ? q.clauses : undefined;
  return {
    offset: int(q.offset),
    limit: int(q.limit),
    region,
    clauses: sent === undefined ? null : clausesOf(sent),
    framing: framing ? coherence.parseFraming({ day_types: typeof q.day_types === "string" ? q.day_types : null, from: typeof q.from === "string" ? q.from : null, to: typeof q.to === "string" ? q.to : null }) : null,
  };
};

/** The request's parameters, or null once their refusal is answered (TOO_MANY_CLAUSES). */
const paramsOrRefuse = (req, res, opts) => {
  try {
    return paramsOf(req, opts);
  } catch (err) {
    if (!err.status || !err.code) throw err;
    res.status(err.status).json({ error: err.code, message: err.message, ...(err.details || {}) });
    return null;
  }
};

/** Cancelled when the person leaves before the answer (the response closes unfinished). */
const cancellation = (res) => {
  let closed = false;
  res.on("close", () => {
    if (!res.writableFinished) closed = true;
  });
  return () => closed;
};

const answer = async (res, key, compute) => {
  const hit = cachedReport(key);
  if (hit) return res.json(hit);
  try {
    const value = await compute();
    remember(_reports, key, { at: Date.now(), value }, MAX_REPORTS);
    return res.json(value);
  } catch (err) {
    if (err.cancelled) return undefined; // nobody is waiting for it any more
    if (err.status && err.code) return res.status(err.status).json({ error: err.code, message: err.message, ...(err.details || {}) });
    console.error("coherence report error:", err);
    return res.status(500).json({ error: "COHERENCE_FAILED", message: err.message });
  }
};

/** What a network built here says of itself: the brief's clauses and the region of its school calendars. */
const designOf = (sessionId) => {
  const { loadStoredReport, loadStoredSpec } = require("../network/compiler");
  const report = loadStoredReport(sessionId);
  const spec = loadStoredSpec(sessionId)?.spec || null;
  let clauses = [];
  try {
    clauses = report?.requirements ? coherence.parseClauses(require("../network/conformanceService").clausesOf(report.requirements)) : [];
  } catch {
    clauses = [];
  }
  const region = (spec?.calendars || []).find((c) => c && c.period && c.region)?.region || null;
  return { clauses, region };
};

/** GET | POST /network/coherence — the report of the session's feed (POST: the clauses in the body). */
const getNetworkCoherence = async (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return undefined;
  const params = paramsOrRefuse(req, res);
  if (!params) return undefined;
  const isCancelled = cancellation(res);
  const key = `network|${ctx.sessionId}|${getDataVersion(ctx.db)}|${JSON.stringify(params)}`;
  return answer(res, key, async () => {
    const design = designOf(ctx.sessionId);
    const region = params.region || design.region;
    return coherence.reportOf({ model: modelOf(ctx), db: ctx.db, sessionCountry: sessionCountryCode(ctx.sessionId), region, regionSource: params.region ? "asked" : design.region ? "design" : null, clauses: params.clauses ?? design.clauses, offset: params.offset, limit: params.limit, isCancelled });
  });
};

/** The feed as a stored preview would leave it (its changeset replayed on an in-memory copy), built once per preview. */
const afterModelOf = (ctx, previewId, changeset) => {
  const key = `preview|${ctx.sessionId}|${previewId}`;
  if (_models.has(key)) return _models.get(key);
  const stored = engine._internals._previews.get(previewId);
  const ops = stored?.redoOps || toOps(changeset).redoOps;
  const sandbox = sandboxOf(ctx.db);
  try {
    sandbox.transaction(() => applyOps(sandbox, ops))();
    return remember(_models, key, buildFeedModel(sandbox), MAX_MODELS);
  } finally {
    sandbox.close();
  }
};

/** GET | POST /transform/preview/:id/coherence — a previewed plan's report, before → after (POST: the clauses in the body). */
const getPreviewCoherence = async (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return undefined;
  const id = String(req.params.id || "");
  if (!PREVIEW_ID_RE.test(id)) return res.status(400).json({ error: "INVALID_INPUT", message: "A preview id is required." });
  const preview = engine.previewChangeset(ctx.sessionId, id);
  if (!preview) return res.status(404).json({ error: "PREVIEW_NOT_FOUND", message: "This preview expired or belongs to another session: preview the plan again." });
  const version = getDataVersion(ctx.db);
  const stored = engine._internals._previews.get(id);
  if (stored?.dataVersion && stored.dataVersion !== version) return res.status(409).json({ error: "PREVIEW_STALE", message: "The feed changed since the preview: preview the plan again." });
  const params = paramsOrRefuse(req, res, { framing: true });
  if (!params) return undefined;
  const isCancelled = cancellation(res);
  const key = `preview|${ctx.sessionId}|${id}|${version}|${JSON.stringify(params)}`;
  return answer(res, key, async () => {
    const before = modelOf(ctx);
    const after = afterModelOf(ctx, id, preview.changeset);
    const report = await coherence.reportOf({ model: after, before, db: ctx.db, sessionCountry: sessionCountryCode(ctx.sessionId), region: params.region, regionSource: params.region ? "asked" : null, clauses: params.clauses || [], framing: params.framing, offset: params.offset, limit: params.limit, isCancelled });
    return withRowDates({ ...report, preview_id: id, title: preview.title || null }, report);
  });
};

/** `out` with the hidden row dates of `report` (a spread copies only what is enumerable). */
const withRowDates = (out, report) => {
  const dates = coherence.rowDatesOf(report);
  if (dates) Object.defineProperty(out, "_rowDates", { value: dates, enumerable: false });
  return out;
};

// ── The whole report: every page of lines ──────────────────────────────────

/** Every page of a report merged (rows and their dates), cached like a page. */
const wholeReport = async (key, page) => {
  const hit = cachedReport(key);
  if (hit) return hit;
  let whole = null;
  const dates = new Map();
  let offset = 0;
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await page(offset, WHOLE_PAGE);
    for (const [k, v] of coherence.rowDatesOf(r) || []) dates.set(k, v);
    whole = whole ? { ...r, rows: [...whole.rows, ...r.rows], offset: 0 } : r;
    if (r.next_offset == null) break;
    offset = r.next_offset;
  }
  whole = { ...whole, next_offset: null };
  Object.defineProperty(whole, "_rowDates", { value: dates, enumerable: false });
  remember(_reports, key, { at: Date.now(), value: whole }, MAX_REPORTS);
  return whole;
};

/** The source of a request: the session's network, or a stored preview (null + answered refusal otherwise). */
const sourceOf = (req, res, { preview = false } = {}) => {
  const ctx = requireSession(req, res);
  if (!ctx) return null;
  if (!preview) {
    const params = paramsOrRefuse(req, res);
    if (!params) return null;
    const key = `whole|network|${ctx.sessionId}|${getDataVersion(ctx.db)}|${JSON.stringify({ ...params, offset: undefined, limit: undefined })}`;
    const compute = async (isCancelled = () => false) => {
      const design = designOf(ctx.sessionId);
      const region = params.region || design.region;
      return wholeReport(key, (offset, limit) => coherence.reportOf({ model: modelOf(ctx), db: ctx.db, sessionCountry: sessionCountryCode(ctx.sessionId), region, regionSource: params.region ? "asked" : design.region ? "design" : null, clauses: params.clauses ?? design.clauses, offset, limit, isCancelled }));
    };
    return { ctx, compute, version: () => modelOf(ctx), validator: () => storedValidation(ctx.sessionId), preview: null };
  }
  const id = String(req.params.id || "");
  if (!PREVIEW_ID_RE.test(id)) {
    res.status(400).json({ error: "INVALID_INPUT", message: "A preview id is required." });
    return null;
  }
  const stored = engine.previewChangeset(ctx.sessionId, id);
  if (!stored) {
    res.status(404).json({ error: "PREVIEW_NOT_FOUND", message: "This preview expired or belongs to another session: preview the plan again." });
    return null;
  }
  const version = getDataVersion(ctx.db);
  const kept = engine._internals._previews.get(id);
  if (kept?.dataVersion && kept.dataVersion !== version) {
    res.status(409).json({ error: "PREVIEW_STALE", message: "The feed changed since the preview: preview the plan again." });
    return null;
  }
  const params = paramsOrRefuse(req, res, { framing: true });
  if (!params) return null;
  const key = `whole|preview|${ctx.sessionId}|${id}|${version}|${JSON.stringify({ ...params, offset: undefined, limit: undefined })}`;
  const compute = async (isCancelled = () => false) =>
    wholeReport(key, async (offset, limit) => {
      const before = modelOf(ctx);
      const after = afterModelOf(ctx, id, stored.changeset);
      const r = await coherence.reportOf({ model: after, before, db: ctx.db, sessionCountry: sessionCountryCode(ctx.sessionId), region: params.region, regionSource: params.region ? "asked" : null, clauses: params.clauses || [], framing: params.framing, offset, limit, isCancelled });
      return withRowDates({ ...r, preview_id: id, title: stored.title || null }, r);
    });
  const validation = kept?.validation || null;
  return { ctx, compute, version: () => modelOf(ctx), validator: () => (validation ? { report: validation, savedAt: null } : null), preview: { id, title: stored.title || null } };
};

/** The latest canonical report of the session's working copy ({ report, savedAt }) or null. */
const storedValidation = (sessionId) => {
  try {
    return require("../validationReportStore").loadReport(sessionId);
  } catch {
    return null;
  }
};

// ── The service-méthode sheet: xlsx and PDF ────────────────────────────────

const text = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n) : "");
const langOf = (v) => (typeof v === "string" && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(v) ? v : "fr");
const sha256 = (v) => crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");
const slug = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 40);

/** The names of the feed's operators (the header's network when the project names none). */
const agencyNames = (db) => {
  try {
    return db
      .prepare("SELECT DISTINCT agency_name FROM agency WHERE agency_name IS NOT NULL AND agency_name <> '' LIMIT 3")
      .all()
      .map((r) => r.agency_name)
      .join(", ");
  } catch {
    return "";
  }
};

/** The header of the files: the labels the query gives, the facts the server reads (see the module's header). */
const headerOf = (req, src, report) => {
  const q = req.query || {};
  const validation = src.validator();
  const computed = String(report.computed_at || "").replace("T", " ").slice(0, 16);
  return {
    network: text(q.network, 120) || agencyNames(src.ctx.db) || null,
    version: text(q.version, 40) || null,
    version_at: text(q.version_at, 40) || null,
    computed_at: computed ? `${computed} UTC` : null,
    engine: validation?.report?.engine || null,
    validated_at: validation?.savedAt ? new Date(validation.savedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC" : null,
    validator_fingerprint: validation?.report ? sha256(validation.report) : null,
    version_fingerprint: report.version?.fingerprint || null,
    title: src.preview?.title || null,
  };
};

/** GET | POST …/coherence.xlsx | .pdf — the whole report as a service-méthode sheet (POST: the clauses in the body). */
const exportHandler = (format, { preview = false } = {}) => async (req, res) => {
  const src = sourceOf(req, res, { preview });
  if (!src) return undefined;
  const isCancelled = cancellation(res);
  try {
    const report = await src.compute(isCancelled);
    const header = headerOf(req, src, report);
    const model = sheetModel(report, { header, lang: langOf(req.query?.lang) });
    const body = format === "xlsx" ? xlsxOf(model) : pdfOf(model);
    const name = ["rapport-coherence", slug(header.network), slug(header.version), String(report.computed_at || "").slice(0, 10)].filter(Boolean).join("_");
    res.setHeader("Content-Type", format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.${format}"`);
    res.setHeader("X-Coherence-Fingerprint", report.version?.fingerprint || "");
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(body);
  } catch (err) {
    if (err.cancelled) return undefined;
    if (err.status && err.code) return res.status(err.status).json({ error: err.code, message: err.message, ...(err.details || {}) });
    console.error("coherence export error:", err);
    return res.status(500).json({ error: "COHERENCE_FAILED", message: err.message });
  }
};

// ── « Chaque ligne cochée devient une clause » ─────────────────────────────

/** The body of a request for clauses, checked (refusals thrown). */
const clauseRequestOf = (body) => {
  const b = body && typeof body === "object" ? body : {};
  const rows = Array.isArray(b.rows) ? b.rows : null;
  if (!rows || !rows.length || rows.length > MAX_ROWS) throw refusal(400, "INVALID_INPUT", `rows: 1 to ${MAX_ROWS} rows of the report, each { key, measures? }.`);
  const picks = [];
  const seen = new Set();
  for (const r of rows) {
    if (!r || typeof r !== "object" || typeof r.key !== "string" || !ROW_KEY_RE.test(r.key)) throw refusal(400, "INVALID_INPUT", "a row is named by its key, as the report gives it (key).");
    if (r.measures != null && (!Array.isArray(r.measures) || r.measures.some((m) => !MEASURES.includes(m)))) throw refusal(400, "INVALID_INPUT", `measures: a list of ${MEASURES.join(", ")}.`);
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    picks.push({ key: r.key, measures: r.measures ? [...new Set(r.measures)] : null });
  }
  const name = b.by && typeof b.by === "object" ? b.by.name : null;
  if (!NAME_OK(name)) throw refusal(400, "ACKNOWLEDGEMENT_UNNAMED", "A clause added to the contract names the person who decides it (by.name, 2–120 characters).", { required: ["by.name"] });
  const fingerprint = b.report && typeof b.report === "object" ? b.report.fingerprint : null;
  if (typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint)) throw refusal(400, "INVALID_INPUT", "report.fingerprint: the version's fingerprint the report gave (report.version.fingerprint).");
  const v = b.version && typeof b.version === "object" ? b.version : {};
  const version = { label: text(v.label, 40) || null, date: /^\d{4}-\d{2}-\d{2}/.test(String(v.date || "")) ? String(v.date).slice(0, 10) : null };
  if (b.journey != null && !JOURNEYS.includes(b.journey)) throw refusal(400, "INVALID_INPUT", `journey: ${JOURNEYS.join(" or ")}.`);
  const contract = b.contract == null ? null : contractService.normalizeContract(b.contract);
  // A draft is decided by nobody: its clauses are never measured, and a version made from it records it empty —
  // the person's named clauses would vanish unsaid. ② decides the contract first; then its rows join it.
  if (contract && contract.status === "draft") throw refusal(409, "CONTRACT_UNDECIDED", "The contract is not decided yet: decide it at step 2 under a name, then add the rows of the report to it.", { status: "draft" });
  return { picks, by: { name: name.trim() }, fingerprint, version, contract, journey: b.journey || null, lang: langOf(b.lang) };
};

/** The contract with the clauses merged by the contract's merge rules (a person's decided clause stays whole). */
const mergedContract = (contract, clauses, { by, at }) => {
  const existing = contract.clauses || [];
  const have = new Set(existing.map((c) => c.id));
  const fresh = clauses.filter((c) => !have.has(c.id));
  if (existing.length + fresh.length > conformance.MAX_CLAUSES) throw refusal(409, "TOO_MANY_CLAUSES", `The contract would hold ${existing.length + fresh.length} clauses: ${conformance.MAX_CLAUSES} at most. Tick fewer rows or measures, or remove clauses at step 2.`, { max: conformance.MAX_CLAUSES, count: existing.length + fresh.length });
  // The engine's merge normalises what it adds (the measured shape): the new clauses keep their origin (display only).
  const originOf = new Map(clauses.filter((c) => c.origin).map((c) => [c.id, c.origin]));
  const merged = conformance.mergeClauses(existing, clauses, [], { by: "user" }).map((c) => (!have.has(c.id) && originOf.has(c.id) ? { ...c, origin: originOf.get(c.id) } : c));
  // An empty contract is the record of nothing decided: a clause decided now makes it decided, by that person.
  const status = contract.status === "empty" ? "decided" : contract.status;
  return { contract: { ...contract, status, ...(contract.status === "empty" ? { decided_by: by.name, decided_at: at } : {}), clauses: merged }, added: fresh.map((c) => c.id), kept: clauses.filter((c) => have.has(c.id)).map((c) => c.id) };
};

/** POST …/coherence/clauses — the ticked rows as clauses of the contract (see the module's header). */
const clausesHandler = ({ preview = false } = {}) => async (req, res) => {
  let ask;
  try {
    ask = clauseRequestOf(req.body);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.code || "INVALID_INPUT", message: err.message, ...(err.details || {}) });
  }
  const src = sourceOf(req, res, { preview });
  if (!src) return undefined;
  try {
    const report = await src.compute();
    const fingerprint = report.version?.fingerprint || null;
    if (fingerprint !== ask.fingerprint) throw refusal(409, "COHERENCE_STALE", "These rows are of another version of the network: read the report again, then tick its rows.", { fingerprint });
    const keys = new Set(report.rows.map((r) => r.key));
    const unknown = ask.picks.filter((p) => !keys.has(p.key)).map((p) => p.key);
    if (unknown.length) throw refusal(400, "COHERENCE_ROW_UNKNOWN", "No row of the report has this key: tick the rows of the report the server gave.", { keys: unknown });
    const at = new Date().toISOString();
    // A network designed here is measured on its design at the next build: no feed before it, no « telle quelle ».
    const built = buildRowClauses({ model: src.version(), report, picks: ask.picks, by: ask.by, at, lang: ask.lang, version: ask.version, keep: ask.journey !== "create" });
    let merged = null;
    if (ask.contract) merged = mergedContract(ask.contract, built.clauses, { by: ask.by, at });
    const contract = merged ? merged.contract : null;
    return res.json({
      clauses: built.clauses,
      refused: built.refused,
      rows: built.rows,
      added: merged ? merged.added : built.clauses.map((c) => c.id),
      kept: merged ? merged.kept : [],
      contract,
      // Measured at every next measure: the contract they joined is decided or assumed (a draft is refused, an empty one
      // becomes decided); without a contract sent, nothing is merged and nothing is measured yet.
      measured: Boolean(contract && contractService.isReady(contract) && contract.status !== "empty"),
      version: { fingerprint, label: ask.version.label, date: ask.version.date },
    });
  } catch (err) {
    if (err.cancelled) return undefined;
    if (err.status && err.code) return res.status(err.status).json({ error: err.code, message: err.message, ...(err.details || {}) });
    console.error("coherence clauses error:", err);
    return res.status(500).json({ error: "COHERENCE_FAILED", message: err.message });
  }
};

const getNetworkCoherenceXlsx = exportHandler("xlsx");
const getNetworkCoherencePdf = exportHandler("pdf");
const getPreviewCoherenceXlsx = exportHandler("xlsx", { preview: true });
const getPreviewCoherencePdf = exportHandler("pdf", { preview: true });
const postNetworkCoherenceClauses = clausesHandler();
const postPreviewCoherenceClauses = clausesHandler({ preview: true });

// ── A frozen version's report ──────────────────────────────────────────────
//
// A project's version is a zip kept with the project; workspace/versionReader
// reads it back into a database of its own (never a working copy anyone
// holds). The report of that database is computed exactly as the network's —
// same model, same anomalies, same cache keyed by its data version — so the
// version's report at ⑤ and the files of its package are the report ④ would
// have read on that network.

/**
 * The parameters of a version's report (offset, limit, region, clauses — from a JSON body first), as the network's
 * route reads them; too many clauses throws the 409 TOO_MANY_CLAUSES refusal, which the workspace handler answers.
 */
const versionParamsOf = (req) => paramsOf(req);

/** One page of a version's report: `ctx` = { sessionId, db } of the version read back. */
const versionReport = (ctx, params, isCancelled = () => false) => {
  const key = `version|${ctx.sessionId}|${getDataVersion(ctx.db)}|${JSON.stringify(params)}`;
  const hit = cachedReport(key);
  if (hit) return Promise.resolve(hit);
  return coherence
    .reportOf({ model: modelOf(ctx), db: ctx.db, sessionCountry: sessionCountryCode(ctx.sessionId), region: params.region, regionSource: params.region ? "asked" : null, clauses: params.clauses || [], offset: params.offset, limit: params.limit, isCancelled })
    .then((value) => remember(_reports, key, { at: Date.now(), value }, MAX_REPORTS).value);
};

/**
 * The whole report of a version as its two service-méthode files — the files of the
 * version's package: { report, header, xlsx, pdf, base } (`base`: the file name without its extension).
 * `labels` are printed as they are: { network, version, version_at }; `validation` is the version's own
 * validator report when the package has one ({ report, savedAt }), else the read copy's.
 */
const versionSheets = async (ctx, { params = {}, labels = {}, lang = "fr", validation = null, isCancelled = () => false } = {}) => {
  const clean = { region: params.region || null, clauses: params.clauses || [] };
  const key = `whole|version|${ctx.sessionId}|${getDataVersion(ctx.db)}|${JSON.stringify(clean)}`;
  const report = await wholeReport(key, (offset, limit) => coherence.reportOf({ model: modelOf(ctx), db: ctx.db, sessionCountry: sessionCountryCode(ctx.sessionId), region: clean.region, regionSource: clean.region ? "asked" : null, clauses: clean.clauses, offset, limit, isCancelled }));
  const src = { ctx, validator: () => validation || storedValidation(ctx.sessionId), preview: null };
  const header = headerOf({ query: { network: labels.network || "", version: labels.version || "", version_at: labels.version_at || "" } }, src, report);
  const model = sheetModel(report, { header, lang: langOf(lang) });
  const base = ["rapport-coherence", slug(header.network), slug(header.version), String(report.computed_at || "").slice(0, 10)].filter(Boolean).join("_");
  return { report, header, xlsx: xlsxOf(model), pdf: pdfOf(model), base };
};

module.exports = { getNetworkCoherence, getPreviewCoherence, getNetworkCoherenceXlsx, getNetworkCoherencePdf, getPreviewCoherenceXlsx, getPreviewCoherencePdf, postNetworkCoherenceClauses, postPreviewCoherenceClauses, versionParamsOf, versionReport, versionSheets, _internals: { _reports, _models, clauseRequestOf, mergedContract, headerOf, clausesOf, paramsOf } };
