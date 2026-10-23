/**
 * A PDF's text, read deterministically for the quote checks (G2) and the coverage detector (G5). A PDF is untrusted
 * input: the parser runs in a child process (pdfTextWorker.mjs) with a heap limit and a timeout, so a file that makes
 * it loop or grow kills only that process. At most PDF_CONCURRENCY children run at once, so a burst of uploads queues
 * instead of taking the container's memory. Pages are joined by a form feed, so a position names its page (pageAt).
 * A PDF whose text cannot be read keeps none: its quotes stay unverifiable.
 */

"use strict";

const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const WORKER = path.join(__dirname, "pdfTextWorker.mjs");
const TIMEOUT_MS = 20000;
const HEAP_MB = 256;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
// The timeout grows with the pages OCR may read.
const OCR_SETUP_MS = 10000;
const OCR_PAGE_MS = 6000;
const PAGE_BREAK = "\f";

// A parse and an OCR are CPU-bound: half the CPUs, one to three.
const PDF_CONCURRENCY = Math.max(1, Math.min(3, Math.floor((os.cpus().length || 1) / 2)));
let running = 0;
const queue = [];
const withSlot = async (fn) => {
  if (running >= PDF_CONCURRENCY) await new Promise((resolve) => queue.push(resolve));
  else running += 1;
  try {
    return await fn();
  } finally {
    const next = queue.shift();
    if (next) next();
    else running -= 1;
  }
};

const extractPdfText = (buffer, options = {}) => withSlot(() => readInChild(buffer, options));

const readInChild = (buffer, { timeoutMs = TIMEOUT_MS, maxPages = 100, ocr = null } = {}) =>
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

const pageAt = (text, index) => {
  let page = 1;
  const s = String(text || "");
  for (let i = 0; i < Math.min(index, s.length); i++) if (s[i] === PAGE_BREAK) page += 1;
  return page;
};

module.exports = { extractPdfText, pageAt, PAGE_BREAK, _internals: { WORKER, TIMEOUT_MS, HEAP_MB, OCR_SETUP_MS, OCR_PAGE_MS, PDF_CONCURRENCY, inFlight: () => ({ running, queued: queue.length }) } };
