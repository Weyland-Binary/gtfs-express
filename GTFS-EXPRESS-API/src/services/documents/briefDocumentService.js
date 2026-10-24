/**
 * The brief's documents (PDF, Word, OpenDocument, spreadsheets, text files), held in memory for DOCUMENT_TTL_MS; an id
 * the memory forgot comes back from the project that keeps it. Only those with `sent_to_assistant` true reach the
 * model, the others are reported `withheld`. A PDF's text layer (OCR for a scan) is read once at ingestion for the
 * quote checks (G2) and the coverage detector (G5); the model still gets the PDF itself.
 */

"use strict";

const crypto = require("crypto");
const path = require("path");
const unzipper = require("unzipper");
const { decodeBuffer } = require("../csvUtils");
const { recordEvent, extractReqMeta } = require("../eventLogger");
const { extractPdfText } = require("./pdfText");
const config = require("../../config");

const MAX_FILE_BYTES = 20 * 1024 * 1024; // under the API's 32 MB request cap
const MAX_PDF_PAGES = 100; // the API's per-PDF page limit
const MAX_TEXT_CHARS = 400000; // ~100k tokens
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;
const DOCUMENT_TTL_MS = 2 * 60 * 60 * 1000;
const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json"]);
const SHEET_EXT = new Set([".xlsx", ".xlsm", ".xls", ".ods"]);
const MAX_SHEET_CELLS = 250000; // a workbook beyond this is a dataset, not a brief

const _store = new Map(); // id → { id, name, kind, media_type, data, pages, chars, size, createdAt }

const sweep = () => {
  const now = Date.now();
  for (const [id, d] of _store) if (now - d.createdAt > DOCUMENT_TTL_MS) _store.delete(id);
  let total = [..._store.values()].reduce((s, d) => s + (d.weight || d.size), 0);
  for (const [id, d] of [..._store.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)) {
    if (total <= MAX_TOTAL_BYTES) break;
    _store.delete(id);
    total -= d.weight || d.size;
  }
};
setInterval(sweep, 10 * 60 * 1000).unref();

const decodeXml = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");

const tidy = (s) =>
  s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** A workbook as text, one "## Sheet: <name>" section per sheet, cells as they display; throws {status, code}. */
const spreadsheetText = (buffer, { csv = null } = {}) => {
  const XLSX = require("xlsx");
  // Bounds the inflated size before SheetJS inflates the whole zip (a zip bomb).
  if (typeof csv !== "string") require("../spreadsheet/workbook").assertInflatable(buffer);
  let wb;
  try {
    wb = typeof csv === "string" ? XLSX.read(csv, { type: "string", raw: true, FS: require("../spreadsheet/workbook").csvSeparator(csv) }) : XLSX.read(buffer, { type: "buffer", cellDates: true, cellNF: false, cellText: true });
  } catch (err) {
    throw Object.assign(new Error(`This spreadsheet could not be read: ${err.message}`), { status: 400, code: "UNREADABLE_DOCUMENT" });
  }
  const sections = [];
  let cells = 0;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws["!ref"]) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false, blankrows: false });
    const clean = rows.map((r) => r.map((c) => String(c ?? "").replace(/\s+/g, " ").replace(/\|/g, "/").trim()));
    const used = clean.filter((r) => r.some((c) => c !== ""));
    if (!used.length) continue;
    const width = Math.max(...used.map((r) => r.length));
    const keep = [];
    for (let j = 0; j < width; j++) if (used.some((r) => (r[j] || "") !== "")) keep.push(j);
    cells += used.length * keep.length;
    if (cells > MAX_SHEET_CELLS) throw Object.assign(new Error(`The workbook has more than ${MAX_SHEET_CELLS} cells: send the sheets that hold the specification.`), { status: 413, code: "DOCUMENT_TOO_LONG", max: MAX_SHEET_CELLS });
    sections.push(`## Sheet: ${name}\n${used.map((r) => keep.map((j) => r[j] || "").join(" | ")).join("\n")}`);
  }
  return { text: tidy(sections.join("\n\n")), sheets: sections.length, cells };
};

/** A workbook with its cells under row numbers and column letters, so the model can name them to read_grid; null when unreadable. */
const spreadsheetModelText = (buffer, name) => {
  let book;
  try {
    book = require("../spreadsheet/workbook").readWorkbook(buffer, { name });
  } catch {
    return null;
  }
  return modelTextOf(book);
};

/**
 * Linear in the cells that hold text: a dense sheet (one slot in four filled) is written as a grid, a sparse one cell
 * by cell with its column, so a huge mostly-empty range never becomes a rectangle of empty slots.
 */
const modelTextOf = (book) => {
  const XLSX = require("xlsx");
  const V = require("../spreadsheet/values");
  const out = [];
  let length = 0;
  let truncated = false;
  const push = (line) => {
    if (truncated) return false;
    if (length + line.length + 1 > MAX_TEXT_CHARS) {
      truncated = true;
      return false;
    }
    out.push(line);
    length += line.length + 1;
    return true;
  };
  for (const sheet of book?.sheets || []) {
    if (truncated) break;
    const cells = [];
    for (const c of sheet.cells || []) {
      const text = String(V.textOf(c) ?? "").replace(/\s+/g, " ").replace(/\|/g, "/").trim();
      if (text) cells.push({ r: c.r, c: c.c, text });
    }
    if (!cells.length) continue;
    const rows = [...new Set(cells.map((x) => x.r))].sort((a, b) => a - b);
    const cols = [...new Set(cells.map((x) => x.c))].sort((a, b) => a - b);
    const byRow = new Map();
    for (const x of cells) {
      if (!byRow.has(x.r)) byRow.set(x.r, []);
      byRow.get(x.r).push(x);
    }
    const range = XLSX.utils.encode_range({ s: { r: rows[0], c: cols[0] }, e: { r: rows[rows.length - 1], c: cols[cols.length - 1] } });
    const dense = rows.length * cols.length <= 4 * cells.length;
    if (!push(`## Sheet: ${sheet.name} (${range})`)) break;
    if (dense) {
      const index = new Map(cols.map((c, i) => [c, i]));
      if (!push(`row | ${cols.map((c) => XLSX.utils.encode_col(c)).join(" | ")}`)) break;
      for (const r of rows) {
        const slots = new Array(cols.length).fill("");
        for (const x of byRow.get(r)) slots[index.get(x.c)] = x.text;
        if (!push(`${r + 1} | ${slots.join(" | ")}`)) break;
      }
    } else {
      if (!push("row | cells (column: text)")) break;
      for (const r of rows) if (!push(`${r + 1} | ${byRow.get(r).sort((a, b) => a.c - b.c).map((x) => `${XLSX.utils.encode_col(x.c)}: ${x.text}`).join(" | ")}`)) break;
    }
    const merges = (sheet.merges || []).map((m) => m.ref);
    if (merges.length) push(`Merged: ${merges.slice(0, 40).join(", ")}${merges.length > 40 ? ", …" : ""}`);
    push("");
  }
  const text = out.join("\n").trim();
  if (!text) return null;
  return { text: truncated ? `${text}\n\n[… truncated: the workbook continues beyond ${MAX_TEXT_CHARS} characters]` : text, truncated };
};

const docxText = (xml) =>
  tidy(
    decodeXml(
      xml
        .replace(/<w:tab\/>/g, "\t")
        .replace(/<w:br[^>]*\/>/g, "\n")
        .replace(/<\/w:tc>/g, " | ")
        .replace(/<\/w:tr>/g, "\n")
        .replace(/<\/w:p>/g, "\n")
        .replace(/<[^>]+>/g, ""),
    ).replace(/ \| \n/g, "\n"),
  );

const odtText = (xml) =>
  tidy(
    decodeXml(
      xml
        .replace(/<text:s(?: text:c="(\d+)")?\/>/g, (_, n) => " ".repeat(n ? Math.min(40, parseInt(n, 10)) : 1))
        .replace(/<text:tab\/>/g, "\t")
        .replace(/<text:line-break\/>/g, "\n")
        .replace(/<\/table:table-cell>/g, " | ")
        .replace(/<\/table:table-row>/g, "\n")
        .replace(/<\/text:(p|h)>/g, "\n")
        .replace(/<[^>]+>/g, ""),
    ).replace(/ \| \n/g, "\n"),
  );

const MAX_ENTRY_BYTES = 60 * 1024 * 1024;
const entryTooLarge = () => Object.assign(new Error("The document is too large once decompressed."), { status: 413, code: "DOCUMENT_TOO_LARGE", max: 60 });
const zipEntry = async (buffer, name) => {
  const zip = await unzipper.Open.buffer(buffer);
  const entry = zip.files.find((f) => f.path === name);
  if (!entry) return null;
  if ((entry.uncompressedSize || 0) > MAX_ENTRY_BYTES) throw entryTooLarge();
  // The declared size can lie (a zip bomb): the bytes are counted as they inflate and the reading stops past the bound.
  const chunks = [];
  let total = 0;
  await new Promise((resolve, reject) => {
    const stream = entry.stream();
    stream.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_ENTRY_BYTES) {
        stream.destroy();
        reject(entryTooLarge());
      } else chunks.push(chunk);
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return Buffer.concat(chunks).toString("utf8");
};

const TESSDATA_DIR = path.join(__dirname, "..", "..", "..", "tessdata");
const ocrOptions = () => (config.PDF_OCR_ENABLED && config.PDF_OCR_MAX_PAGES > 0 ? { maxPages: config.PDF_OCR_MAX_PAGES, langPath: TESSDATA_DIR } : null);

/** Approximate when the page objects are compressed. */
const pdfPages = (buffer) => {
  const s = buffer.toString("latin1");
  const count = (s.match(/\/Type\s*\/Page(?!s)\b/g) || []).length;
  if (count) return count;
  const m = s.match(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/);
  return m ? parseInt(m[1], 10) : null;
};

const truncate = (text) => (text.length > MAX_TEXT_CHARS ? { text: `${text.slice(0, MAX_TEXT_CHARS)}\n\n[… truncated: the document continues beyond ${MAX_TEXT_CHARS} characters]`, truncated: true } : { text, truncated: false });

/** Only an explicit false-like value keeps a document from the model. */
const sentToAssistantOf = (value) => !(value === false || value === 0 || /^(false|0|no|off)$/i.test(String(value ?? "").trim()));

/** Throws {status, code} on refusal. */
const ingestDocument = async ({ name, buffer, sentToAssistant = true }) => {
  const fileName = path.basename(String(name || "document")).slice(0, 160);
  const ext = path.extname(fileName).toLowerCase();
  if (!buffer || !buffer.length) throw Object.assign(new Error("The file is empty."), { status: 400, code: "INVALID_INPUT" });
  if (buffer.length > MAX_FILE_BYTES) throw Object.assign(new Error(`The file exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB.`), { status: 413, code: "DOCUMENT_TOO_LARGE", max: MAX_FILE_BYTES / 1024 / 1024 });
  let doc;
  if (buffer.slice(0, 5).toString("latin1") === "%PDF-") {
    const pages = pdfPages(buffer);
    if (pages && pages > MAX_PDF_PAGES) throw Object.assign(new Error(`The PDF has ${pages} pages; ${MAX_PDF_PAGES} at most can be read. Send the relevant chapters.`), { status: 413, code: "DOCUMENT_TOO_LONG", max: MAX_PDF_PAGES });
    const read = await extractPdfText(buffer, { maxPages: MAX_PDF_PAGES, ocr: ocrOptions() });
    const layer = read.error || !read.chars ? null : truncate(read.text);
    doc = { kind: "pdf", media_type: "application/pdf", data: buffer.toString("base64"), pages: pages || (read.pages ? read.pages.length : null), chars: null, truncated: false, text: layer ? layer.text : null, text_chars: layer ? layer.text.length : 0, ...(layer?.truncated ? { text_truncated: true } : {}), ...(read.ocr && read.ocr.pages.length ? { text_ocr: true, ocr_pages: read.ocr.pages.length } : {}), ...(read.ocr && read.ocr.skipped ? { ocr_skipped: read.ocr.skipped } : {}), ...(read.error ? { text_error: read.error } : {}) };
  } else if (ext === ".docx" || ext === ".odt") {
    let xml;
    try {
      xml = await zipEntry(buffer, ext === ".docx" ? "word/document.xml" : "content.xml");
    } catch (err) {
      if (err.status) throw err;
      xml = null;
    }
    if (!xml) throw Object.assign(new Error(`This ${ext} file could not be read.`), { status: 400, code: "UNREADABLE_DOCUMENT" });
    const t = truncate(ext === ".docx" ? docxText(xml) : odtText(xml));
    if (!t.text) throw Object.assign(new Error("The document contains no text."), { status: 400, code: "EMPTY_DOCUMENT" });
    doc = { kind: "text", media_type: "text/plain", data: t.text, pages: null, chars: t.text.length, truncated: t.truncated };
  } else if (SHEET_EXT.has(ext)) {
    // A real workbook is a zip or an OLE file; the parser would read anything else as a one-cell sheet of garbage.
    const zip = buffer.slice(0, 2).toString("latin1") === "PK";
    const ole = buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0;
    if (!zip && !ole) throw Object.assign(new Error(`This ${ext} file is not a spreadsheet the service can read.`), { status: 400, code: "UNREADABLE_DOCUMENT" });
    const s = spreadsheetText(buffer);
    const t = truncate(s.text);
    if (!t.text) throw Object.assign(new Error("The workbook contains no data."), { status: 400, code: "EMPTY_DOCUMENT" });
    // The file itself is kept for read_grid to copy its cells.
    const m = spreadsheetModelText(buffer, fileName);
    doc = { kind: "text", media_type: "text/plain", data: t.text, pages: s.sheets, chars: t.text.length, truncated: t.truncated, sheet: true, raw_b64: buffer.toString("base64"), ...(m ? { model_text: m.text, ...(m.truncated ? { model_truncated: true } : {}) } : {}) };
  } else if (TEXT_EXT.has(ext)) {
    const decoded = decodeBuffer(buffer, fileName).text.trim();
    // A CSV is read as a sheet, so the coverage never takes one of its rows for a sentence of the brief.
    const table = ext === ".csv" && decoded ? spreadsheetText(null, { csv: decoded }) : null;
    const t = truncate(table && table.text ? table.text : decoded);
    if (!t.text) throw Object.assign(new Error("The document contains no text."), { status: 400, code: "EMPTY_DOCUMENT" });
    doc = { kind: "text", media_type: "text/plain", data: t.text, pages: null, chars: t.text.length, truncated: t.truncated };
    if (ext === ".csv") {
      const m = spreadsheetModelText(buffer, fileName);
      if (m) doc = { ...doc, pages: 1, sheet: true, raw_b64: buffer.toString("base64"), model_text: m.text, ...(m.truncated ? { model_truncated: true } : {}) };
    }
  } else {
    throw Object.assign(new Error("Unsupported file: send a PDF, Word (.docx), OpenDocument (.odt), spreadsheet (.xlsx, .xls, .ods) or text file."), { status: 415, code: "UNSUPPORTED_DOCUMENT" });
  }
  sweep();
  const id = crypto.randomBytes(12).toString("hex");
  // The sweep's memory cap counts a sheet's copy of the file and its model text too.
  const weight = buffer.length + (typeof doc.raw_b64 === "string" ? doc.raw_b64.length : 0) + (typeof doc.model_text === "string" ? doc.model_text.length : 0);
  const stored = { id, name: fileName, ...doc, size: buffer.length, weight, sent_to_assistant: sentToAssistant !== false, createdAt: Date.now() };
  _store.set(id, stored);
  return stored;
};

const describe = (d) => ({ id: d.id, name: d.name, kind: d.kind, pages: d.pages, chars: d.chars, truncated: d.truncated, size: d.size, sent_to_assistant: d.sent_to_assistant !== false, text_chars: textOf(d) ? textOf(d).length : 0, text_ocr: Boolean(d.text_ocr), expiresAt: new Date(d.createdAt + DOCUMENT_TTL_MS).toISOString() });

/** The text the server can read of a stored document: a text document's own, a PDF's text layer, else null. */
const textOf = (d) => (!d ? null : d.kind === "text" ? (typeof d.data === "string" ? d.data : null) : typeof d.text === "string" && d.text.trim() ? d.text : null);

/**
 * The server-side text of every document, sent to the assistant or not: for the deterministic checks only, never the
 * model. Unknown ids are left out (the caller reports them); `canRead(id)` restricts a project's documents to its owner.
 */
const documentTexts = (ids, { canRead = null } = {}) => {
  sweep();
  const out = [];
  for (const id of Array.isArray(ids) ? ids.slice(0, 20) : []) {
    if (canRead && !canRead(id)) continue;
    const d = storedDocument(id);
    if (d) out.push({ id: d.id, name: d.name, kind: d.kind, text: textOf(d), truncated: Boolean(d.truncated || d.text_truncated), ...(d.text_ocr ? { ocr: true } : {}), ...(d.text_error ? { error: String(d.text_error).slice(0, 80) } : {}) });
  }
  return out;
};

/**
 * Who may read a document a project keeps: an account or browser reaching that project, or a request whose working
 * copy (or the one its draft was made from) is bound to it. A document held in memory only keeps its random id as
 * its credential.
 */
const documentReaderOf = (req) => {
  let workspace = null;
  try {
    workspace = require("../workspace/workspaceStore");
    if (!workspace.enabled() || !workspace.exists()) return () => true;
  } catch {
    return () => true;
  }
  const raw = req?.headers?.["x-client-token"];
  const tokenHash = raw ? workspace.tokenOwner(String(raw)) : null;
  const owner = req?.user?.id != null ? { user_id: String(req.user.id), token_hash: tokenHash } : tokenHash ? { token_hash: tokenHash } : null;
  const sessionId = typeof req?.headers?.["x-session-id"] === "string" ? req.headers["x-session-id"] : null;
  const sessions = sessionId ? [sessionId, require("../transform/draftSession").mainOf(sessionId)].filter(Boolean) : [];
  const bound = new Set(sessions.map((s) => workspace.bindingOf(s)?.project_id).filter(Boolean));
  return (id) => {
    const access = workspace.documentKeptBy(owner, id);
    return !access.kept || access.owned || workspace.projectsKeeping(id).some((p) => bound.has(p));
  };
};

/** From the memory, else from the project that keeps it (put back in the memory); `canRead` refuses it to whom it holds false. */
const storedDocument = (id, { canRead = null } = {}) => {
  if (typeof id !== "string" || !id) return null;
  if (canRead && !canRead(id)) return null;
  const inMemory = _store.get(id);
  if (inMemory) return inMemory;
  let kept = null;
  try {
    const workspace = require("../workspace/workspaceStore");
    kept = workspace.enabled() && workspace.exists() ? workspace.keptDocument(id) : null;
  } catch {
    kept = null;
  }
  if (!kept || kept.id !== id || !kept.data) return null;
  const restored = { ...kept, createdAt: Date.now() };
  _store.set(id, restored);
  return restored;
};

// One turn carries at most five documents and about 120k tokens of their text (a PDF counted by its pages), so the
// model's window holds the rest of the turn; what is left out is reported (`overflow`, `too_long`), never dropped in
// silence. Overflow is counted, not named, since one may be withheld from the assistant. The first is always carried.
const MAX_TURN_DOCUMENTS = 5;
const MAX_TURN_CHARS = 480000;
const PDF_PAGE_CHARS = 8000;
const turnWeight = (d) => (d.kind === "pdf" ? (Number(d.pages) || 1) * PDF_PAGE_CHARS : typeof d.model_text === "string" && d.model_text ? d.model_text.length : typeof d.data === "string" ? d.data.length : 0);
const getDocuments = (ids, { canRead = null } = {}) => {
  sweep();
  const found = [];
  const missing = [];
  const withheld = [];
  const tooLong = [];
  const tooLongIds = [];
  let used = 0;
  const list = Array.isArray(ids) ? ids : [];
  for (const id of list.slice(0, MAX_TURN_DOCUMENTS)) {
    const d = storedDocument(id, { canRead });
    if (!d) missing.push(String(id).slice(0, 40));
    else if (d.sent_to_assistant === false) withheld.push(d.name);
    else if (found.length && used + turnWeight(d) > MAX_TURN_CHARS) {
      tooLong.push(d.name);
      tooLongIds.push(d.id);
    }
    else {
      found.push(d);
      used += turnWeight(d);
    }
  }
  // The ids past either bound let the client read them again on their own.
  return { found, missing, withheld, overflow: Math.max(0, list.length - MAX_TURN_DOCUMENTS), too_long: tooLong, too_long_ids: tooLongIds, overflow_ids: list.slice(MAX_TURN_DOCUMENTS).map((id) => String(id).slice(0, 40)) };
};

/** The last block is cached: the agent resends the turn every round. */
const toContentBlocks = (docs) =>
  docs.map((d, i) => ({
    type: "document",
    source: d.kind === "pdf" ? { type: "base64", media_type: "application/pdf", data: d.data } : { type: "text", media_type: "text/plain", data: typeof d.model_text === "string" && d.model_text ? d.model_text : d.data },
    title: d.name,
    ...(i === docs.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
  }));

const postDocument = async (req, res) => {
  const file = req.files && (req.files.file || Object.values(req.files)[0]);
  const f = Array.isArray(file) ? file[0] : file;
  if (!f) return res.status(400).json({ error: "INVALID_INPUT", message: "Send the document in a multipart field named 'file'." });
  try {
    const d = await ingestDocument({ name: f.name, buffer: f.data, sentToAssistant: sentToAssistantOf(req.body && req.body.sent_to_assistant) });
    recordEvent("network.document", { ...extractReqMeta(req), kind: d.kind, pages: d.pages, chars: d.chars, size: d.size, sent_to_assistant: d.sent_to_assistant });
    res.status(201).json(describe(d));
  } catch (err) {
    // A size refusal carries its limit for the message on screen.
    res.status(err.status || 500).json({ error: err.code || "DOCUMENT_FAILED", message: err.message, ...(Number.isFinite(err.max) ? { max: err.max } : {}) });
  }
};

const deleteDocument = (req, res) => {
  const id = String(req.params.id || "");
  if (!documentReaderOf(req)(id)) return res.status(404).json({ error: "DOCUMENT_NOT_FOUND", message: "No such document." });
  _store.delete(id);
  res.status(204).end();
};

module.exports = { MAX_TURN_DOCUMENTS, MAX_TURN_CHARS, ingestDocument, getDocuments, storedDocument, documentReaderOf, documentTexts, textOf, toContentBlocks, describe, postDocument, deleteDocument, sentToAssistantOf, spreadsheetText, MAX_FILE_BYTES, MAX_PDF_PAGES, _internals: { _store, docxText, odtText, pdfPages, spreadsheetText, spreadsheetModelText, modelTextOf, turnWeight, DOCUMENT_TTL_MS, SHEET_EXT, MAX_SHEET_CELLS, MAX_TEXT_CHARS, PDF_PAGE_CHARS } };
