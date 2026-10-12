/**
 * projects/docx.js — a small Word (.docx) writer for the Project Studio's
 * notes: headings, paragraphs (with bold runs), bullet items and tables.
 * A .docx is a zip of a few XML parts; archiver (already a dependency)
 * writes it. No template, no macro, no external resource: the file opens
 * in Word, LibreOffice and Google Docs.
 *
 *   toDocx(blocks, { title, language, rtl }) → Promise<Buffer>
 *   blocks: [{ h: 1|2|3, text } | { p: text | [{ text, bold }] } | { li: text }
 *            | { table: { head: [..], rows: [[..]] } } | { note: text }]
 */

"use strict";

const archiver = require("archiver");
const { PassThrough } = require("stream");

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // XML 1.0 forbids most control characters.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

const run = (text, { bold = false, italic = false, color = null } = {}, rtl = false) =>
  `<w:r><w:rPr>${bold ? "<w:b/>" : ""}${italic ? "<w:i/>" : ""}${color ? `<w:color w:val="${color}"/>` : ""}${rtl ? "<w:rtl/>" : ""}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

const para = (runs, { style = null, rtl = false } = {}) => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${rtl ? "<w:bidi/>" : ""}</w:pPr>${runs}</w:p>`;

const table = ({ head = [], rows = [] }, rtl) => {
  const cell = (text, header) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${para(run(text, { bold: header }, rtl), { rtl })}</w:tc>`;
  const border = '<w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/>';
  const tr = (cells, header) => `<w:tr>${cells.map((c) => cell(c, header)).join("")}</w:tr>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${rtl ? '<w:bidiVisual/>' : ""}<w:tblBorders>${border}</w:tblBorders></w:tblPr>${head.length ? tr(head, true) : ""}${rows.map((r) => tr(r.map((x) => (x == null ? "—" : String(x))), false)).join("")}</w:tbl>${para("")}`;
};

const body = (blocks, rtl) =>
  blocks
    .map((b) => {
      if (b.h) return para(run(b.text, {}, rtl), { style: `Heading${Math.min(3, Math.max(1, b.h))}`, rtl });
      if (b.li) return para(run(`• ${b.li}`, {}, rtl), { style: "ListParagraph", rtl });
      if (b.note) return para(run(b.note, { italic: true, color: "595959" }, rtl), { rtl });
      if (b.table) return table(b.table, rtl);
      if (b.p !== undefined) return para(Array.isArray(b.p) ? b.p.map((r) => run(r.text, r, rtl)).join("") : run(b.p, {}, rtl), { rtl });
      return "";
    })
    .join("");

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei" w:cs="Arial"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/><w:color w:val="0F6F68"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="0F6F68"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/><w:spacing w:after="40"/></w:pPr></w:style>
</w:styles>`;

const toDocx = ({ blocks = [], title = "", language = "en" } = {}) =>
  new Promise((resolve, reject) => {
    const rtl = language === "ar";
    const lang = { en: "en-GB", fr: "fr-FR", es: "es-ES", de: "de-DE", pt: "pt-PT", zh: "zh-CN", ar: "ar-SA", hi: "hi-IN" }[language] || "en-GB";
    const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${title ? para(run(title, {}, rtl), { style: "Title", rtl }) : ""}${body(blocks, rtl)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/>${rtl ? "<w:bidi/>" : ""}</w:sectPr></w:body></w:document>`;
    const settings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:themeFontLang w:val="${lang}"/></w:settings>`;
    const out = new PassThrough();
    const chunks = [];
    out.on("data", (c) => chunks.push(c));
    out.on("end", () => resolve(Buffer.concat(chunks)));
    out.on("error", reject);
    const zip = archiver("zip", { zlib: { level: 9 } });
    zip.on("error", reject);
    zip.pipe(out);
    zip.append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>', { name: "[Content_Types].xml" });
    zip.append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', { name: "_rels/.rels" });
    zip.append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>', { name: "word/_rels/document.xml.rels" });
    zip.append(doc, { name: "word/document.xml" });
    zip.append(STYLES, { name: "word/styles.xml" });
    zip.append(settings, { name: "word/settings.xml" });
    zip.finalize();
  });

/** The same blocks as Markdown (the note's plain-text twin). */
const toMarkdown = ({ blocks = [], title = "" } = {}) => {
  const cell = (x) => String(x ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const out = title ? [`# ${title}`, ""] : [];
  for (const b of blocks) {
    if (b.h) out.push(`${"#".repeat(Math.min(3, b.h) + 1)} ${b.text}`, "");
    else if (b.li) out.push(`- ${b.li}`);
    else if (b.note) out.push(`> ${b.note}`, "");
    else if (b.table) {
      const head = b.table.head || [];
      if (head.length) out.push(`| ${head.map(cell).join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`);
      for (const r of b.table.rows || []) out.push(`| ${r.map(cell).join(" | ")} |`);
      out.push("");
    } else if (b.p !== undefined) out.push(Array.isArray(b.p) ? b.p.map((r) => (r.bold ? `**${r.text}**` : r.text)).join("") : String(b.p), "");
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
};

module.exports = { toDocx, toMarkdown, _internals: { esc } };
