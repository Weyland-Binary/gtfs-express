/**
 * A dependency-free PDF writer for the server's text-and-table documents. Standard fonts only: Courier,
 * so table columns line up by padding and a row reads back as one line, and Helvetica-Bold for headings.
 * Text is WinAnsi (cp1252); a character outside it is written as its closest ASCII form or "?".
 */

"use strict";

// cp1252 bytes 0x80–0x9F, by character.
const CP1252 = { "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f };
// The closest ASCII form of a few characters the documents may carry.
const ASCII = { "→": "->", "←": "<-", "↔": "<->", "≤": "<=", "≥": ">=", "≠": "!=", "⚑": "!", "✓": "v", "✗": "x", " ": " ", " ": " ", " ": " " };

/** A string as the bytes of a PDF literal string in WinAnsi, escaped. */
const pdfString = (s) => {
  let out = "";
  for (const ch of String(s ?? "")) {
    const swap = ASCII[ch];
    if (swap !== undefined) {
      out += pdfString(swap);
      continue;
    }
    const code = ch.codePointAt(0);
    let byte = CP1252[ch] ?? (code >= 0x20 && code < 0x7f ? code : code >= 0xa0 && code <= 0xff ? code : 0x3f);
    if (code === 0x09) byte = 0x20;
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
    else out += `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return out;
};

const monoWidth = (size) => size * 0.6;

const num = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

const pdfDocument = ({ width = 842, height = 595, title = null } = {}) => {
  const pages = [];
  let current = null;
  const doc = {
    width,
    height,
    page() {
      current = [];
      pages.push(current);
      return current;
    },
    text(x, y, text, { font = "mono", size = 8 } = {}) {
      if (!current) doc.page();
      current.push(`BT /${font === "bold" ? "F2" : "F1"} ${num(size)} Tf ${num(x)} ${num(y)} Td (${pdfString(text)}) Tj ET`);
    },
    rule(x1, y1, x2, y2, { width: w = 0.4 } = {}) {
      if (!current) doc.page();
      current.push(`${num(w)} w ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`);
    },
    pageCount: () => pages.length,
    toBuffer() {
      if (!pages.length) doc.page();
      const objects = [];
      const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(" ");
      // 1 catalog, 2 pages, 3 Courier, 4 Helvetica-Bold, then per page: the page, its content; last the info.
      objects.push("<< /Type /Catalog /Pages 2 0 R >>");
      objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
      objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
      objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
      pages.forEach((ops, i) => {
        const stream = ops.join("\n");
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(width)} ${num(height)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
        objects.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
      });
      objects.push(`<< /Producer (GTFS Express)${title ? ` /Title (${pdfString(title)})` : ""} >>`);
      const info = objects.length;
      let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
      const offsets = [];
      objects.forEach((body, i) => {
        offsets.push(Buffer.byteLength(out, "latin1"));
        out += `${i + 1} 0 obj\n${body}\nendobj\n`;
      });
      const xref = Buffer.byteLength(out, "latin1");
      out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
      out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      return Buffer.from(out, "latin1");
    },
  };
  return doc;
};

module.exports = { pdfDocument, pdfString, monoWidth };
