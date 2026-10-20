/**
 * pdfText — the text of a PDF document, read deterministically at ingestion
 * (briefDocumentService), so that what a brief in PDF says can be checked:
 * the quotes of the plans and of the extracted clauses (G2) and the
 * requirement sentences of the coverage detector (G5) are looked up in it.
 * The model still receives the PDF itself (text, tables and layout).
 *
 * A scan (a page without a text layer) is read by OCR in the same child
 * process when the caller asks for it (`ocr: { maxPages, langPath }`): the
 * page rendered and read by tesseract.js, French and English, the language
 * data in tessdata/ — nothing fetched. The timeout
 * grows with the pages the OCR may read (OCR_SETUP_MS, OCR_PAGE_MS each).
 *
 * The parser (pdfjs-dist, Apache-2.0) runs in a child process
 * (pdfTextWorker.mjs) with a heap limit and a timeout: a PDF is untrusted
 * input, and a file that makes the parser loop or grow is killed with its
 * process, never the API. A PDF whose text cannot be read (a scan without a
 * text layer, a parser failure, the timeout) keeps no text: its quotes stay
 * "pdf" (unverifiable, acknowledged by name at delivery) and its sentences
 * are not measured.
 *
 *   extractPdfText(buffer, { timeoutMs, maxPages, ocr }) → Promise<{ pages: [text], text, chars, ocr: null | { pages: [n], skipped, error? } } | { error }>
 *     `ocr.pages` the pages OCR read (1-based), `skipped` those past ocr.maxPages left to their empty text layer
 *     `text` joins the pages with a form feed ("\f"), so a position in it
 *     names its page (pageAt); `chars` is 0 for a PDF without a text layer.
 *   pageAt(text, index) → the 1-based page of a position of `text`
 */

"use strict";

const path = require("path");
const { spawn } = require("child_process");

const WORKER = path.join(__dirname, "pdfTextWorker.mjs");
const TIMEOUT_MS = 20000;
const HEAP_MB = 256;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
// What the OCR of a page may take (the worker's start, then each page rendered and read): the timeout grows by it.
const OCR_SETUP_MS = 10000;
const OCR_PAGE_MS = 6000;
const PAGE_BREAK = "\f";

const extractPdfText = (buffer, { timeoutMs = TIMEOUT_MS, maxPages = 100, ocr = null } = {}) =>
  new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    const ocrPages = ocr && Number(ocr.maxPages) > 0 && ocr.langPath ? Math.min(Number(ocr.maxPages), maxPages) : 0;
    const deadline = timeoutMs + (ocrPages ? OCR_SETUP_MS + OCR_PAGE_MS * ocrPages : 0);
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn(process.execPath, [`--max-old-space-size=${HEAP_MB}`, WORKER], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH || "", PDF_TEXT_MAX_PAGES: String(maxPages), ...(ocrPages ? { PDF_OCR_MAX_PAGES: String(ocrPages), PDF_OCR_LANG_PATH: String(ocr.langPath) } : {}) } });
    } catch (e) {
      resolve({ error: `pdf text: ${e.message}` });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ error: "pdf text: timeout" });
    }, deadline);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.length > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        done({ error: "pdf text: too large" });
      }
    });
    child.stderr.on("data", (chunk) => {
      err = `${err}${chunk}`.slice(0, 400);
    });
    child.on("error", (e) => done({ error: `pdf text: ${e.message}` }));
    child.on("close", (code) => {
      if (code !== 0) return done({ error: `pdf text: ${err.trim() || `exit ${code}`}` });
      try {
        const parsed = JSON.parse(out);
        const pages = (Array.isArray(parsed.pages) ? parsed.pages : []).map((p) => String(p || ""));
        const text = pages.join(PAGE_BREAK);
        const read = parsed.ocr && typeof parsed.ocr === "object" && Array.isArray(parsed.ocr.pages) ? { pages: parsed.ocr.pages.map(Number).filter(Number.isFinite), skipped: Number(parsed.ocr.skipped) || 0, ...(parsed.ocr.error ? { error: String(parsed.ocr.error).slice(0, 200) } : {}) } : null;
        done({ pages, text, chars: text.replace(/\s+/g, "").length, ocr: read });
      } catch (e) {
        done({ error: `pdf text: unreadable answer (${e.message})` });
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(buffer);
  });

/** The 1-based page of a position in a text whose pages are joined by a form feed. */
const pageAt = (text, index) => {
  let page = 1;
  const s = String(text || "");
  for (let i = 0; i < Math.min(index, s.length); i++) if (s[i] === PAGE_BREAK) page += 1;
  return page;
};

module.exports = { extractPdfText, pageAt, PAGE_BREAK, _internals: { WORKER, TIMEOUT_MS, HEAP_MB, OCR_SETUP_MS, OCR_PAGE_MS } };
