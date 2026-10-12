/**
 * briefDocumentService — the specification a network is designed from, as
 * the client has it: a PDF (tender, study, cahier des charges), a Word or
 * OpenDocument file, a spreadsheet (the marketing teams' line-by-line
 * cahiers des charges: stops in rows, trips in columns), or plain text /
 * Markdown / CSV / JSON.
 *
 *   POST   /gtfs/network/documents        multipart "file" (+ "sent_to_assistant": "false" to keep it
 *                                         from the model) → { id, name, kind, pages?, chars?, size,
 *                                         sent_to_assistant, expiresAt }
 *   DELETE /gtfs/network/documents/:id    → 204
 *
 * Storing a document never depends on the assistant: it is part of the
 * journey with or without it. Each document carries `sent_to_assistant`
 * (default true, the person unticks it); `getDocuments` — what the two
 * planners call — hands the model only those set to true and reports the
 * others as `withheld`, so a document kept from the model is never read by
 * it, whichever route asks.
 *
 * PDFs are kept as they are and handed to the planner as document blocks:
 * the model reads the text, the tables and the layout itself. Their text
 * layer is also read at ingestion, deterministically (network/pdfText: the
 * parser in a child process with a timeout), and stored with the document
 * (`text`, pages joined by a form feed): the quotes a plan or an extracted
 * clause cites (G2) and the requirement sentences of the coverage detector
 * (G5) are looked up in it. A PDF without a text layer (a scan) is read by
 * OCR at ingestion (2026-10-09, the owner's « OCR enclenché si PDF image »:
 * tesseract.js in the same child process, French and English, the language
 * data vendored in tessdata/, PDF_OCR_MAX_PAGES pages at most, about a second
 * each), so its quotes can be checked and its sentences measured like a text
 * layer's; `text_ocr` and `ocr_pages` say so, `ocr_skipped` the pages past
 * the bound. The model still receives the PDF itself. A PDF whose text could
 * not be read either keeps `text: null`: its quotes stay unverifiable
 * ("pdf"), as before. Word (.docx)
 * and OpenDocument (.odt) files are reduced to their text (paragraphs, tabs,
 * table rows as "a | b | c"); spreadsheets (.xlsx, .xlsm, .xls, .ods) to one
 * text table per sheet ("## Sheet: name", then rows as "a | b | c", empty
 * rows and columns dropped, dates and times as they display); text files are
 * decoded (UTF-8, Latin-1 fallback). Documents live in memory for
 * DOCUMENT_TTL_MS; the planner request carries their ids, so the file is
 * uploaded once per conversation. A document kept with a project (the
 * workspace, POST /workspace/projects/:id/documents) outlives that memory:
 * an id the memory forgot is brought back from the project's copy, with its
 * `sent_to_assistant` as the person left it, for as long as the project is
 * kept (target design §2.4: documents = project).
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
  // Over the memory cap: drop the oldest first.
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

/**
 * A workbook as text: one "## Sheet: <name>" section per sheet, each row as
 * "a | b | c" with the cells as they display (dates, times, percentages),
 * empty rows and all-empty columns dropped, a "|" inside a cell replaced by
 * "/". Returns { text, sheets, cells }; throws {status, code} when the
 * workbook is unreadable or too big to be a brief.
 */
const spreadsheetText = (buffer, { csv = null } = {}) => {
  const XLSX = require("xlsx");
  let wb;
  try {
    // A CSV's text read as a table with its own separator (spreadsheet/workbook.csvSeparator), every cell as written.
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

/**
 * A workbook as the model reads it: each sheet's cells under their row numbers and column letters — only the rows
 * and the columns that hold something, a merged range said once at its first cell and listed after the sheet — so
 * that the model can name a grid's cells to read_grid (the change planner). Null when the workbook cannot be
 * addressed cell by cell (the text above still is read).
 */
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
 * A parsed workbook as the model reads it → { text, truncated } | null. Built in a time linear in the cells that hold
 * text (a formula without a value, an empty string, are no cell here): a sheet dense enough to read as a grid (one
 * slot in four holds text) is a line per row and a column per letter; a sparse one says each cell by its column
 * (« 12 | B: 7:10 | F: 8:20 ») — never a rectangle of empty slots. The text stops at MAX_TEXT_CHARS as it is built.
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

/** Word: paragraphs, line breaks, tabs, table cells and rows. */
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

/** OpenDocument text: paragraphs, headings, spaces, tabs, table cells and rows. */
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
  // The declared size is the archive's own word: a crafted file declares a few kilobytes and inflates to gigabytes
  // (the review of 2026-10-08). The bytes are counted as they inflate, and the reading stops past the bound.
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

// The OCR language data (tessdata/README.md), beside the package.
const TESSDATA_DIR = path.join(__dirname, "..", "..", "..", "tessdata");
/** The OCR the PDF reader runs on the pages without a text layer (config PDF_OCR_ENABLED, PDF_OCR_MAX_PAGES): null when off. */
const ocrOptions = () => (config.PDF_OCR_ENABLED && config.PDF_OCR_MAX_PAGES > 0 ? { maxPages: config.PDF_OCR_MAX_PAGES, langPath: TESSDATA_DIR } : null);

/** PDF page count from the page objects (approximate when objects are compressed). */
const pdfPages = (buffer) => {
  const s = buffer.toString("latin1");
  const count = (s.match(/\/Type\s*\/Page(?!s)\b/g) || []).length;
  if (count) return count;
  const m = s.match(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/);
  return m ? parseInt(m[1], 10) : null;
};

const truncate = (text) => (text.length > MAX_TEXT_CHARS ? { text: `${text.slice(0, MAX_TEXT_CHARS)}\n\n[… truncated: the document continues beyond ${MAX_TEXT_CHARS} characters]`, truncated: true } : { text, truncated: false });

/** A multipart / JSON flag: only an explicit "false", "0", "no" or `false` keeps a document from the model. */
const sentToAssistantOf = (value) => !(value === false || value === 0 || /^(false|0|no|off)$/i.test(String(value ?? "").trim()));

/** Turn an uploaded file into a stored document. Throws {status, code} on refusal. */
const ingestDocument = async ({ name, buffer, sentToAssistant = true }) => {
  const fileName = path.basename(String(name || "document")).slice(0, 160);
  const ext = path.extname(fileName).toLowerCase();
  if (!buffer || !buffer.length) throw Object.assign(new Error("The file is empty."), { status: 400, code: "INVALID_INPUT" });
  if (buffer.length > MAX_FILE_BYTES) throw Object.assign(new Error(`The file exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB.`), { status: 413, code: "DOCUMENT_TOO_LARGE", max: MAX_FILE_BYTES / 1024 / 1024 });
  let doc;
  if (buffer.slice(0, 5).toString("latin1") === "%PDF-") {
    const pages = pdfPages(buffer);
    if (pages && pages > MAX_PDF_PAGES) throw Object.assign(new Error(`The PDF has ${pages} pages; ${MAX_PDF_PAGES} at most can be read. Send the relevant chapters.`), { status: 413, code: "DOCUMENT_TOO_LONG", max: MAX_PDF_PAGES });
    // The text layer, read once here (never by the model's route): what the quote checks and the coverage detector read.
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
    // A real workbook is a zip (.xlsx, .xlsm, .ods) or an OLE compound file (.xls); anything
    // else under that name would be "read" by the parser as a one-cell sheet of garbage.
    const zip = buffer.slice(0, 2).toString("latin1") === "PK";
    const ole = buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0;
    if (!zip && !ole) throw Object.assign(new Error(`This ${ext} file is not a spreadsheet the service can read.`), { status: 400, code: "UNREADABLE_DOCUMENT" });
    const s = spreadsheetText(buffer);
    const t = truncate(s.text);
    if (!t.text) throw Object.assign(new Error("The workbook contains no data."), { status: 400, code: "EMPTY_DOCUMENT" });
    // As the model reads it (rows numbered, columns lettered), and the file itself for read_grid to copy its cells.
    const m = spreadsheetModelText(buffer, fileName);
    doc = { kind: "text", media_type: "text/plain", data: t.text, pages: s.sheets, chars: t.text.length, truncated: t.truncated, sheet: true, raw_b64: buffer.toString("base64"), ...(m ? { model_text: m.text, ...(m.truncated ? { model_truncated: true } : {}) } : {}) };
  } else if (TEXT_EXT.has(ext)) {
    const decoded = decodeBuffer(buffer, fileName).text.trim();
    // A CSV is a sheet too: its text a table as a workbook's is (« ## Sheet: », its cells between « | ») — the coverage
    // reads its rows as a sheet's, never « Route de Gisors;09:39;11:09 » as a sentence of the brief (2026-10-07) —, its
    // cells numbered and lettered for the model, the file kept for read_grid to copy them.
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
  // What the memory holds beyond the file's size: a sheet's copy of the file and the text the model reads (the sweep).
  const weight = buffer.length + (typeof doc.raw_b64 === "string" ? doc.raw_b64.length : 0) + (typeof doc.model_text === "string" ? doc.model_text.length : 0);
  const stored = { id, name: fileName, ...doc, size: buffer.length, weight, sent_to_assistant: sentToAssistant !== false, createdAt: Date.now() };
  _store.set(id, stored);
  return stored;
};

const describe = (d) => ({ id: d.id, name: d.name, kind: d.kind, pages: d.pages, chars: d.chars, truncated: d.truncated, size: d.size, sent_to_assistant: d.sent_to_assistant !== false, text_chars: textOf(d) ? textOf(d).length : 0, text_ocr: Boolean(d.text_ocr), expiresAt: new Date(d.createdAt + DOCUMENT_TTL_MS).toISOString() });

/** The text the server can read of a stored document: a text document's own, a PDF's text layer, else null. */
const textOf = (d) => (!d ? null : d.kind === "text" ? (typeof d.data === "string" ? d.data : null) : typeof d.text === "string" && d.text.trim() ? d.text : null);

/**
 * Every document of a list of ids with the text the server reads in it, sent to the assistant or not: the
 * deterministic checks (the quotes, the coverage detector) read what the person attached, the model never does
 * through here. → [{ id, name, kind, text, truncated, error? }] (text null: a PDF without a text layer, or whose
 * layer could not be read — `error` says why; truncated: the text stops at MAX_TEXT_CHARS), unknown ids left out:
 * the coverage detector reports each id it could not read (coverage.unread), it never skips one silently.
 * `canRead(id)`, when given, decides whether this caller may read a document (the coverage route: a document a
 * project keeps is read only through its owner).
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
 * The documents the model may read, for a list of ids: { found, missing,
 * withheld }. `found` holds only those sent to the assistant; a stored
 * document the person kept from the model is listed in `withheld` by name,
 * never handed over; an unknown or expired id is `missing`.
 */
/** A document by id from the memory, else from the project that keeps it (put back in the memory), else null. */
const storedDocument = (id) => {
  if (typeof id !== "string" || !id) return null;
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

// The documents one message carries at most: five, and about 120k tokens of their text together (a PDF counted by
// its pages) — the model reads the rest of the turn beside them. Past five they are counted (`overflow`, never named:
// one may be kept from the assistant), past the text they are named (`too_long`), for the planners to say so —
// never sent past the model's window, never dropped in silence. The first is always carried (each document is
// bounded on its own: MAX_TEXT_CHARS, MAX_PDF_PAGES); the journey lists the ones it needs most first.
const MAX_TURN_DOCUMENTS = 5;
const MAX_TURN_CHARS = 480000;
const PDF_PAGE_CHARS = 8000;
const turnWeight = (d) => (d.kind === "pdf" ? (Number(d.pages) || 1) * PDF_PAGE_CHARS : typeof d.model_text === "string" && d.model_text ? d.model_text.length : typeof d.data === "string" ? d.data.length : 0);
const getDocuments = (ids) => {
  sweep();
  const found = [];
  const missing = [];
  const withheld = [];
  const tooLong = [];
  const tooLongIds = [];
  let used = 0;
  const list = Array.isArray(ids) ? ids : [];
  for (const id of list.slice(0, MAX_TURN_DOCUMENTS)) {
    const d = storedDocument(id);
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
  // The ids of the ones past either bound too: a reading's record names them, so that the client reads them again on
  // their own — never a document it no longer has (`missing`), which it says gone.
  return { found, missing, withheld, overflow: Math.max(0, list.length - MAX_TURN_DOCUMENTS), too_long: tooLong, too_long_ids: tooLongIds, overflow_ids: list.slice(MAX_TURN_DOCUMENTS).map((id) => String(id).slice(0, 40)) };
};

/** Anthropic document blocks (the last one cached: the planner resends the turn every round). */
const toContentBlocks = (docs) =>
  docs.map((d, i) => ({
    type: "document",
    // A spreadsheet as the model reads it: its cells numbered and lettered (model_text), for read_grid.
    source: d.kind === "pdf" ? { type: "base64", media_type: "application/pdf", data: d.data } : { type: "text", media_type: "text/plain", data: typeof d.model_text === "string" && d.model_text ? d.model_text : d.data },
    title: d.name,
    ...(i === docs.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
  }));

// ── HTTP ───────────────────────────────────────────────────────────────────

const postDocument = async (req, res) => {
  const file = req.files && (req.files.file || Object.values(req.files)[0]);
  const f = Array.isArray(file) ? file[0] : file;
  if (!f) return res.status(400).json({ error: "INVALID_INPUT", message: "Send the document in a multipart field named 'file'." });
  try {
    const d = await ingestDocument({ name: f.name, buffer: f.data, sentToAssistant: sentToAssistantOf(req.body && req.body.sent_to_assistant) });
    recordEvent("network.document", { ...extractReqMeta(req), kind: d.kind, pages: d.pages, chars: d.chars, size: d.size, sent_to_assistant: d.sent_to_assistant });
    res.status(201).json(describe(d));
  } catch (err) {
    // A size refusal carries its limit, so the sentence on screen names it (« Ce document dépasse {max} … »).
    res.status(err.status || 500).json({ error: err.code || "DOCUMENT_FAILED", message: err.message, ...(Number.isFinite(err.max) ? { max: err.max } : {}) });
  }
};

const deleteDocument = (req, res) => {
  _store.delete(String(req.params.id || ""));
  res.status(204).end();
};

/**
 * The text the server reads in a stored document, for the person's own screen (the owner's UX lot 3, 2026-10-11: the
 * brief annotated — each objective's quote and each sentence nothing answers marked in the person's own text):
 * { id, name, kind, pages, truncated, text } — `text` null for a PDF without a text layer (said by `text_error`);
 * 404 DOCUMENT_NOT_FOUND once the document expired or was removed. Never the file itself, never for the model.
 */
const getDocumentText = (req, res) => {
  const d = storedDocument(String(req.params.id || ""));
  if (!d) return res.status(404).json({ error: "DOCUMENT_NOT_FOUND", message: "This document is no longer held by the server." });
  return res.json({ id: d.id, name: d.name, kind: d.kind, pages: d.pages ?? null, truncated: Boolean(d.truncated || d.text_truncated), text: textOf(d), ...(d.text_error ? { text_error: d.text_error } : {}) });
};

module.exports = { MAX_TURN_DOCUMENTS, MAX_TURN_CHARS, ingestDocument, getDocuments, storedDocument, documentTexts, textOf, toContentBlocks, describe, postDocument, deleteDocument, getDocumentText, sentToAssistantOf, MAX_FILE_BYTES, MAX_PDF_PAGES, _internals: { _store, docxText, odtText, pdfPages, spreadsheetText, spreadsheetModelText, modelTextOf, turnWeight, DOCUMENT_TTL_MS, SHEET_EXT, MAX_SHEET_CELLS, MAX_TEXT_CHARS, PDF_PAGE_CHARS } };
