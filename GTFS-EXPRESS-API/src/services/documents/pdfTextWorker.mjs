/**
 * A PDF's text page by page, run as a child of pdfText.js: pdfjs-dist is an ES module the CommonJS API and its Jest
 * suites cannot load, and a crafted PDF must only kill this process. No script of the PDF runs (isEvalSupported false).
 * A page with an empty text layer is rendered and read by tesseract.js with the vendored tessdata/, nothing fetched.
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

const tidy = (text) =>
  String(text || "")
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const pageText = (items) => {
  let out = "";
  for (const item of items) {
    if (typeof item?.str !== "string") continue;
    // Spaces come from pdf.js's own items, never guessed here.
    out += item.str;
    if (item.hasEOL) out += "\n";
  }
  return tidy(out);
};

/** One tesseract worker for the whole document: its start is the costly part. */
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
  // Only an empty text layer is read as a scan: a page holding a title alone is a text page.
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
      // A blank page or a drawing that OCR reads as noise stays empty.
      const legible = (text) => (String(text || "").match(/[\p{L}\p{N}]/gu) || []).length >= OCR_MIN_LEGIBLE;
      for (const [n, text] of read) if (legible(text)) pages[n - 1] = text;
      ocr = { pages: [...read.keys()].filter((n) => legible(read.get(n))), skipped: imageOnly.length - wanted.length };
    } catch (err) {
      // An OCR failure never loses the text layer.
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
