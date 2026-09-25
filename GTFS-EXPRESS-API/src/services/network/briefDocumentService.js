/**
 * briefDocumentService — the specification a network is designed from, as
 * the client has it: a PDF (tender, study, cahier des charges), a Word or
 * OpenDocument file, or plain text / Markdown / CSV / JSON.
 *
 *   POST   /gtfs/network/documents        multipart "file" → { id, name, kind, pages?, chars?, size, expiresAt }
 *   DELETE /gtfs/network/documents/:id    → 204
 *
 * PDFs are kept as they are and handed to the planner as document blocks:
 * the model reads the text, the tables and the layout itself. Word (.docx)
 * and OpenDocument (.odt) files are reduced to their text (paragraphs, tabs,
 * table rows as "a | b | c"); text files are decoded (UTF-8, Latin-1
 * fallback). Documents live in memory for DOCUMENT_TTL_MS; the planner
 * request carries their ids, so the file is uploaded once per conversation.
 */

"use strict";

const crypto = require("crypto");
const path = require("path");
const unzipper = require("unzipper");
const config = require("../../config");
const { decodeBuffer } = require("../csvUtils");
const { recordEvent, extractReqMeta } = require("../eventLogger");

const MAX_FILE_BYTES = 20 * 1024 * 1024; // under the API's 32 MB request cap
const MAX_PDF_PAGES = 100; // the API's per-PDF page limit
const MAX_TEXT_CHARS = 400000; // ~100k tokens
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;
const DOCUMENT_TTL_MS = 2 * 60 * 60 * 1000;
const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json"]);

const _store = new Map(); // id → { id, name, kind, media_type, data, pages, chars, size, createdAt }

const sweep = () => {
  const now = Date.now();
  for (const [id, d] of _store) if (now - d.createdAt > DOCUMENT_TTL_MS) _store.delete(id);
  let total = [..._store.values()].reduce((s, d) => s + d.size, 0);
  // Over the memory cap: drop the oldest first.
  for (const [id, d] of [..._store.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)) {
    if (total <= MAX_TOTAL_BYTES) break;
    _store.delete(id);
    total -= d.size;
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

const zipEntry = async (buffer, name) => {
  const zip = await unzipper.Open.buffer(buffer);
  const entry = zip.files.find((f) => f.path === name);
  if (!entry) return null;
  if ((entry.uncompressedSize || 0) > 60 * 1024 * 1024) throw Object.assign(new Error("The document is too large once decompressed."), { status: 413, code: "DOCUMENT_TOO_LARGE" });
  return (await entry.buffer()).toString("utf8");
};

/** PDF page count from the page objects (approximate when objects are compressed). */
const pdfPages = (buffer) => {
  const s = buffer.toString("latin1");
  const count = (s.match(/\/Type\s*\/Page(?!s)\b/g) || []).length;
  if (count) return count;
  const m = s.match(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/);
  return m ? parseInt(m[1], 10) : null;
};

const truncate = (text) => (text.length > MAX_TEXT_CHARS ? { text: `${text.slice(0, MAX_TEXT_CHARS)}\n\n[… truncated: the document continues beyond ${MAX_TEXT_CHARS} characters]`, truncated: true } : { text, truncated: false });

/** Turn an uploaded file into a stored document. Throws {status, code} on refusal. */
const ingestDocument = async ({ name, buffer }) => {
  const fileName = path.basename(String(name || "document")).slice(0, 160);
  const ext = path.extname(fileName).toLowerCase();
  if (!buffer || !buffer.length) throw Object.assign(new Error("The file is empty."), { status: 400, code: "INVALID_INPUT" });
  if (buffer.length > MAX_FILE_BYTES) throw Object.assign(new Error(`The file exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB.`), { status: 413, code: "DOCUMENT_TOO_LARGE" });
  let doc;
  if (buffer.slice(0, 5).toString("latin1") === "%PDF-") {
    const pages = pdfPages(buffer);
    if (pages && pages > MAX_PDF_PAGES) throw Object.assign(new Error(`The PDF has ${pages} pages; ${MAX_PDF_PAGES} at most can be read. Send the relevant chapters.`), { status: 413, code: "DOCUMENT_TOO_LONG" });
    doc = { kind: "pdf", media_type: "application/pdf", data: buffer.toString("base64"), pages, chars: null, truncated: false };
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
  } else if (TEXT_EXT.has(ext)) {
    const t = truncate(decodeBuffer(buffer, fileName).text.trim());
    if (!t.text) throw Object.assign(new Error("The document contains no text."), { status: 400, code: "EMPTY_DOCUMENT" });
    doc = { kind: "text", media_type: "text/plain", data: t.text, pages: null, chars: t.text.length, truncated: t.truncated };
  } else {
    throw Object.assign(new Error("Unsupported file: send a PDF, Word (.docx), OpenDocument (.odt) or text file."), { status: 415, code: "UNSUPPORTED_DOCUMENT" });
  }
  sweep();
  const id = crypto.randomBytes(12).toString("hex");
  const stored = { id, name: fileName, ...doc, size: buffer.length, createdAt: Date.now() };
  _store.set(id, stored);
  return stored;
};

const describe = (d) => ({ id: d.id, name: d.name, kind: d.kind, pages: d.pages, chars: d.chars, truncated: d.truncated, size: d.size, expiresAt: new Date(d.createdAt + DOCUMENT_TTL_MS).toISOString() });

/** The stored documents for a list of ids: { found, missing }. */
const getDocuments = (ids) => {
  sweep();
  const found = [];
  const missing = [];
  for (const id of Array.isArray(ids) ? ids.slice(0, 5) : []) {
    const d = typeof id === "string" ? _store.get(id) : null;
    if (d) found.push(d);
    else missing.push(String(id).slice(0, 40));
  }
  return { found, missing };
};

/** Anthropic document blocks (the last one cached: the planner resends the turn every round). */
const toContentBlocks = (docs) =>
  docs.map((d, i) => ({
    type: "document",
    source: d.kind === "pdf" ? { type: "base64", media_type: "application/pdf", data: d.data } : { type: "text", media_type: "text/plain", data: d.data },
    title: d.name,
    ...(i === docs.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
  }));

// ── HTTP ───────────────────────────────────────────────────────────────────

const postDocument = async (req, res) => {
  if (!config.NL2SQL_CHAT_ENABLED) return res.status(503).json({ error: "NL2SQL_CHAT_DISABLED", message: "The AI assistant is disabled on this server." });
  const file = req.files && (req.files.file || Object.values(req.files)[0]);
  const f = Array.isArray(file) ? file[0] : file;
  if (!f) return res.status(400).json({ error: "INVALID_INPUT", message: "Send the document in a multipart field named 'file'." });
  try {
    const d = await ingestDocument({ name: f.name, buffer: f.data });
    recordEvent("network.document", { ...extractReqMeta(req), kind: d.kind, pages: d.pages, chars: d.chars, size: d.size });
    res.status(201).json(describe(d));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.code || "DOCUMENT_FAILED", message: err.message });
  }
};

const deleteDocument = (req, res) => {
  _store.delete(String(req.params.id || ""));
  res.status(204).end();
};

module.exports = { ingestDocument, getDocuments, toContentBlocks, describe, postDocument, deleteDocument, MAX_FILE_BYTES, MAX_PDF_PAGES, _internals: { _store, docxText, odtText, pdfPages, DOCUMENT_TTL_MS } };
