/**
 * The coherence report of the session's feed, of a previewed plan (before → after) or of a frozen version, and its
 * service-méthode sheet in xlsx and PDF. It reads the feed and never judges a clause nor writes. Clauses come in the
 * query or, for a long list (Node refuses a request line past 16 KB), in a POST body, and are read whole or refused.
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
const conformance = require("../judge");
const { refusal } = require("../refusal");
const crypto = require("crypto");

const REPORT_TTL_MS = 10 * 60 * 1000;
const MAX_REPORTS = 24;
const MAX_MODELS = 4;
const PREVIEW_ID_RE = /^[a-f0-9]{18}$/;
const WHOLE_PAGE = 500;
const MAX_PAGES = 40;
const REGION_RE = /^[A-Za-z0-9][A-Za-z0-9 _'-]{0,39}$/;

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
 * The request's clauses, read whole or refused 409 TOO_MANY_CLAUSES: never a silent cut (coherenceService.parseClauses
 * would keep the first ones).
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
  if (count > conformance.MAX_CLAUSES) throw refusal(409, "TOO_MANY_CLAUSES", `${count} clauses were sent: ${conformance.MAX_CLAUSES} at most.`, { max: conformance.MAX_CLAUSES, count });
  return coherence.parseClauses(list);
};

/** The request's parameters, bounded: the query's, the clauses from a JSON body first (a refusal is thrown). */
const paramsOf = (req, { framing = false } = {}) => {
  const q = req.query || {};
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const int = (v) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : undefined);
  const region = typeof q.region === "string" && REGION_RE.test(q.region.trim()) ? q.region.trim() : null;
  const sent = body.clauses != null ? body.clauses : typeof q.clauses === "string" ? q.clauses : undefined;
  return {
    offset: int(q.offset),
    limit: int(q.limit),
    region,
    clauses: sent === undefined ? [] : clausesOf(sent),
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

const getNetworkCoherence = async (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return undefined;
  const params = paramsOrRefuse(req, res);
  if (!params) return undefined;
  const isCancelled = cancellation(res);
  const key = `network|${ctx.sessionId}|${getDataVersion(ctx.db)}|${JSON.stringify(params)}`;
  return answer(res, key, async () =>
    coherence.reportOf({ model: modelOf(ctx), db: ctx.db, sessionCountry: sessionCountryCode(ctx.sessionId), region: params.region, regionSource: params.region ? "asked" : null, clauses: params.clauses, offset: params.offset, limit: params.limit, isCancelled }),
  );
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

const getPreviewCoherence = async (req, res) => {
  let ctx = requireSession(req, res);
  if (!ctx) return undefined;
  const id = String(req.params.id || "");
  if (!PREVIEW_ID_RE.test(id)) return res.status(400).json({ error: "INVALID_INPUT", message: "A preview id is required." });
  const preview = engine.previewChangeset(ctx.sessionId, id);
  if (!preview) return res.status(404).json({ error: "PREVIEW_NOT_FOUND", message: "This preview expired or belongs to another session: preview the plan again." });
  // A draft's preview compares with the working copy, not the draft's own session.
  const base = engine.previewBase(ctx.sessionId, id);
  if (!base) return res.status(404).json({ error: "PREVIEW_NOT_FOUND", message: "This preview expired or belongs to another session: preview the plan again." });
  if (base.stale) return res.status(409).json({ error: "PREVIEW_STALE", message: "The feed changed since the preview: preview the plan again." });
  const version = base.version;
  ctx = { ...ctx, sessionId: base.sessionId, db: base.db };
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

// ── The whole report: every page of lines

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

/** The session's network or a stored preview, or null once the refusal is answered. */
const sourceOf = (req, res, { preview = false } = {}) => {
  let ctx = requireSession(req, res);
  if (!ctx) return null;
  if (!preview) {
    const params = paramsOrRefuse(req, res);
    if (!params) return null;
    const key = `whole|network|${ctx.sessionId}|${getDataVersion(ctx.db)}|${JSON.stringify({ ...params, offset: undefined, limit: undefined })}`;
    const compute = async (isCancelled = () => false) =>
      wholeReport(key, (offset, limit) => coherence.reportOf({ model: modelOf(ctx), db: ctx.db, sessionCountry: sessionCountryCode(ctx.sessionId), region: params.region, regionSource: params.region ? "asked" : null, clauses: params.clauses, offset, limit, isCancelled }));
    return { ctx, compute, version: () => modelOf(ctx), validator: () => storedValidation(ctx.sessionId), preview: null };
  }
  const id = String(req.params.id || "");
  if (!PREVIEW_ID_RE.test(id)) {
    res.status(400).json({ error: "INVALID_INPUT", message: "A preview id is required." });
    return null;
  }
  const stored = engine.previewChangeset(ctx.sessionId, id);
  // A draft's preview compares with the working copy, not the draft's own session.
  const base = stored ? engine.previewBase(ctx.sessionId, id) : null;
  if (!stored || !base) {
    res.status(404).json({ error: "PREVIEW_NOT_FOUND", message: "This preview expired or belongs to another session: preview the plan again." });
    return null;
  }
  const kept = engine._internals._previews.get(id);
  if (base.stale) {
    res.status(409).json({ error: "PREVIEW_STALE", message: "The feed changed since the preview: preview the plan again." });
    return null;
  }
  const version = base.version;
  ctx = { ...ctx, sessionId: base.sessionId, db: base.db };
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

// ── The service-méthode sheet: xlsx and PDF

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

/** The query's labels are printed as they are, never a figure; the facts are the server's. */
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

const getNetworkCoherenceXlsx = exportHandler("xlsx");
const getNetworkCoherencePdf = exportHandler("pdf");
const getPreviewCoherenceXlsx = exportHandler("xlsx", { preview: true });
const getPreviewCoherencePdf = exportHandler("pdf", { preview: true });

// ── A frozen version's report
// The version read back into a database of its own gets exactly the network's report, so its package's files are
// what the network's route would have read.

/** Too many clauses throws the 409 TOO_MANY_CLAUSES refusal, which the workspace handler answers. */
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
 * A version's whole report as its package's two service-méthode files. `validation`: the package's own validator
 * report when it has one, else the read copy's.
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

module.exports = { getNetworkCoherence, getPreviewCoherence, getNetworkCoherenceXlsx, getNetworkCoherencePdf, getPreviewCoherenceXlsx, getPreviewCoherencePdf, versionParamsOf, versionReport, versionSheets, _internals: { _reports, _models, headerOf, clausesOf, paramsOf } };
