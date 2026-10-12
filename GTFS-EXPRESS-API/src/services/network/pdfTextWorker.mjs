/**
 * pdfTextWorker.mjs — the text of a PDF, page by page, in a child process
 * of its own (network/pdfText.js starts it; never imported by the server
 * itself): its text layer, and, for the pages that have none, the text OCR
 * reads on the page rendered.
 *
 * Why a child process: pdfjs-dist is an ES module (the API is CommonJS and
 * its Jest suites do not load ES modules), and a PDF is untrusted input — a
 * crafted file that makes the parser loop or grow is killed with its process
 * (a timeout and a heap limit set by the parent), never the API.
 *
 * Deterministic: the same file gives the same text. No script of the PDF is
 * run (isEvalSupported false, no font face), only the text layer is read:
 * each text item's string, a line break where the item ends a line. A
 * scanned page (an image without a text layer) reads as "" — then, when the
 * parent asks for it (PDF_OCR_MAX_PAGES and PDF_OCR_LANG_PATH; 2026-10-09:
 * the owner's « OCR enclenché si PDF image »), the page is rendered
 * (pdfjs with @napi-rs/canvas, about 144 dpi, the longer side 2 500 px at
 * most) and read by tesseract.js (French and English, the language data
 * vendored in tessdata/, nothing fetched): about a second a page. Only a
 * page whose text layer is empty is read as an image (a short page of text,
 * a title alone, is a text page: the guarantee suite's two-page avenant was
 * read as a scan on its second page), and what OCR read counts only when it
 * is legible text (OCR_MIN_LEGIBLE letters or digits: a blank or a drawing
 * reads as nothing, never as noise). At most PDF_OCR_MAX_PAGES pages are
 * read, the first ones; the others keep their empty text, and the answer
 * says how many were left. OCR failing never loses the text layer: the
 * answer carries its error instead.
 *
 *   stdin  the PDF bytes
 *   stdout { "pages": ["text of page 1", …], "ocr": null | { "pages": [1, 3], "skipped": 0, "error"?: "…" } }   (exit 0)
 *   stderr a one-line reason                   (exit 1)
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const OCR_MIN_LEGIBLE = 20;
const OCR_SCALE = 2;
const OCR_MAX_SIDE = 2500;
const OCR_LANGS = "fra+eng";

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
};

/** A page's text as lines, tidy: trailing spaces off, three breaks at most two. */
const tidy = (text) =>
  String(text || "")
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** A page's text items as lines: the strings in reading order, a break where pdf.js says a line ends. */
const pageText = (items) => {
  let out = "";
  for (const item of items) {
    if (typeof item?.str !== "string") continue;
    // The items are written as pdf.js cuts them: a space is its own item or inside one, never guessed here.
    out += item.str;
    if (item.hasEOL) out += "\n";
  }
  return tidy(out);
};

/**
 * The pages named, rendered and read by OCR. → Map page number → text ("" when nothing was read).
 * One tesseract worker for the whole document (its start is the costly part), terminated whatever happens.
 */
const ocrPages = async (doc, numbers, { langPath }) => {
  const { createCanvas } = await import("@napi-rs/canvas");
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker(OCR_LANGS, 1, { langPath, gzip: true, cacheMethod: "none", logger: () => {}, errorHandler: () => {} });
  const out = new Map();
  try {
    for (const n of numbers) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(OCR_SCALE, OCR_MAX_SIDE / Math.max(base.width, base.height, 1));
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const { data } = await worker.recognize(canvas.toBuffer("image/png"));
      out.set(n, tidy(data?.text));
      page.cleanup();
    }
  } finally {
    await worker.terminate();
  }
  return out;
};

const main = async () => {
  const data = new Uint8Array(await readStdin());
  const maxPages = Number(process.env.PDF_TEXT_MAX_PAGES) || 100;
  const ocrMax = Number(process.env.PDF_OCR_MAX_PAGES) || 0;
  const langPath = process.env.PDF_OCR_LANG_PATH || "";
  const task = getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false });
  const doc = await task.promise;
  const pages = [];
  // The pages read as images: no text layer, or next to none.
  const imageOnly = [];
  for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
    const text = pageText(content.items || []);
    pages.push(text);
    if (!text) imageOnly.push(n);
    page.cleanup();
  }
  let ocr = null;
  if (imageOnly.length && ocrMax > 0 && langPath) {
    const wanted = imageOnly.slice(0, ocrMax);
    try {
      const read = await ocrPages(doc, wanted, { langPath });
      // What OCR read counts when it is legible text; a blank page or a drawing read as noise stays empty.
      const legible = (text) => (String(text || "").match(/[\p{L}\p{N}]/gu) || []).length >= OCR_MIN_LEGIBLE;
      for (const [n, text] of read) if (legible(text)) pages[n - 1] = text;
      ocr = { pages: [...read.keys()].filter((n) => legible(read.get(n))), skipped: imageOnly.length - wanted.length };
    } catch (err) {
      // The text layer stands; the OCR's failure is said, never the document's.
      ocr = { pages: [], skipped: imageOnly.length, error: String(err?.message || err).split("\n")[0].slice(0, 200) };
    }
  }
  await task.destroy();
  process.stdout.write(JSON.stringify({ pages, ocr }));
};

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(String(err?.message || err).split("\n")[0].slice(0, 300));
    process.exit(1);
  },
);
