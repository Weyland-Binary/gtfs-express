// The demo brief's Word files from their Markdown sources (# and ## headings, **bold**, numbered items):
// node build-docx.js — no pandoc needed; archiver comes from the API's dependencies.
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const build = (input, output) => {
  const md = fs.readFileSync(input, "utf8").replace(/\r\n/g, "\n");
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const runs = (text, base = {}) =>
    text
      .split(/(\*\*[^*]+\*\*)/)
      .filter(Boolean)
      .map((part) => {
        const bold = /^\*\*.*\*\*$/.test(part) || base.bold;
        const t = part.replace(/^\*\*|\*\*$/g, "");
        return `<w:r><w:rPr>${bold ? "<w:b/>" : ""}${base.size ? `<w:sz w:val="${base.size}"/>` : ""}${base.color ? `<w:color w:val="${base.color}"/>` : ""}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
      })
      .join("");
  const para = (
    inner,
    { style = null, indent = 0, hanging = 0, after = 120 } = {},
  ) =>
    `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}<w:spacing w:after="${after}"/>${indent ? `<w:ind w:left="${indent}" w:hanging="${hanging}"/>` : ""}</w:pPr>${inner}</w:p>`;
  const body = [];
  for (const line of md.split("\n")) {
    if (!line.trim()) continue;
    let m;
    if ((m = /^# (.*)$/.exec(line)))
      body.push(
        para(runs(m[1], { bold: true, size: 32, color: "1F3864" }), {
          after: 240,
        }),
      );
    else if ((m = /^## (.*)$/.exec(line)))
      body.push(
        para(runs(m[1], { bold: true, size: 26, color: "2E5395" }), {
          after: 120,
        }),
      );
    else if ((m = /^(\d+)\. (.*)$/.exec(line)))
      body.push(para(runs(`${m[1]}.\t${m[2]}`), { indent: 360, hanging: 360 }));
    else if ((m = /^\s+- (.*)$/.exec(line)))
      body.push(
        para(runs(`–\t${m[1]}`), { indent: 1080, hanging: 360, after: 60 }),
      );
    else body.push(para(runs(line.trim())));
  }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="fr-FR"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const out = fs.createWriteStream(output);
  const zip = archiver("zip", { zlib: { level: 9 } });
  zip.pipe(out);
  zip.append(types, { name: "[Content_Types].xml" });
  zip.append(rels, { name: "_rels/.rels" });
  zip.append(document, { name: "word/document.xml" });
  zip.append(styles, { name: "word/styles.xml" });
  zip.append(docRels, { name: "word/_rels/document.xml.rels" });
  out.on("close", () =>
    console.log(`built ${output} (${zip.pointer()} bytes)`),
  );
  zip.finalize();
};
for (const md of fs
  .readdirSync(__dirname)
  .filter((f) => /\.(fr|en)\.md$/.test(f)))
  build(
    path.join(__dirname, md),
    path.join(__dirname, md.replace(/\.md$/, ".docx")),
  );
