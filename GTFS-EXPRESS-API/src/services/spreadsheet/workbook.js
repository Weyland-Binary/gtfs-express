/**
 * An offer sheet as a grid of addressed cells. A merged range's value is repeated on each cell it covers with the
 * address that holds it (`at`), so it is read on every row and cited where it is written; `cells` are the physical
 * ones the parser must account for. `bounds` is the box of the cells that exist, never the sheet's `!ref` (a
 * workbook may declare A1:XFD1048576 around three cells): nothing walks a declared range.
 * A CSV keeps every cell as text, so « 6:05 » stays what the operator typed.
 */

"use strict";

const path = require("path");
const XLSX = require("xlsx");
const { refusal } = require("../refusal");
const { decodeBuffer } = require("../csvUtils");
const { assertZipInflatesWithin, isZip } = require("../../utils/zipInflateBound");

const FORMATS = { ".xlsx": "xlsx", ".xlsm": "xlsm", ".xls": "xls", ".ods": "ods", ".csv": "csv" };
const MAX_CELLS = 250000;
// A stray cell far from the offer would make every row × column walk cost the whole box.
const MAX_AREA = 2000000;

const key = (r, c) => `${r},${c}`;

const countOutsideQuotes = (line, sep) => {
  let n = 0;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === sep && !quoted) n += 1;
  }
  return n;
};
/**
 * Read on the first lines, not the first alone: a title above the table carries no separator. The separator whose
 * count the most lines share wins (a table's rows share their width), then the one seen most.
 */
const csvSeparator = (text) => {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  let best = { sep: ",", rows: 0, total: 0 };
  for (const sep of [";", ",", "\t"]) {
    const used = lines.map((l) => countOutsideQuotes(l, sep)).filter((n) => n > 0);
    if (!used.length) continue;
    const width = new Map();
    for (const n of used) width.set(n, (width.get(n) || 0) + 1);
    const rows = Math.max(...width.values());
    const total = used.reduce((a, b) => a + b, 0);
    if (rows > best.rows || (rows === best.rows && total > best.total)) best = { sep, rows, total };
  }
  return best.sep;
};

const formatOf = (name) => {
  const ext = path.extname(String(name || "")).toLowerCase();
  if (!FORMATS[ext]) throw refusal(415, "UNSUPPORTED_DOCUMENT", `An offer sheet is a .xlsx, .xlsm, .xls, .ods or .csv file (got ${ext || "no extension"}).`);
  return FORMATS[ext];
};

// A zip (xlsx, xlsm, ods); an OLE compound file or an HTML/XML table (xls).
const SIGNATURES = { xlsx: [[0x50, 0x4b]], xlsm: [[0x50, 0x4b]], ods: [[0x50, 0x4b]], xls: [[0xd0, 0xcf, 0x11, 0xe0], [0x3c], [0x09, 0x08]] };
const signed = (buffer, format) => !SIGNATURES[format] || SIGNATURES[format].some((sig) => sig.every((b, i) => buffer[i] === b));

// SheetJS inflates a zipped workbook whole on the request's thread, before the cell caps can apply.
const MAX_INFLATED_BYTES = 100 * 1024 * 1024;
const assertInflatable = (buffer) => {
  if (isZip(buffer)) assertZipInflatesWithin(buffer, MAX_INFLATED_BYTES);
};

const readBook = (buffer, format) => {
  if (!signed(buffer, format)) throw refusal(400, "UNREADABLE_DOCUMENT", `This file is not a readable .${format} workbook.`);
  if (format !== "csv") {
    try {
      assertInflatable(buffer);
    } catch (err) {
      throw refusal(err.status || 400, err.code || "UNREADABLE_DOCUMENT", err.message, err.max_mb ? { max_mb: err.max_mb } : null);
    }
  }
  try {
    if (format === "csv") {
      const { text } = decodeBuffer(buffer, "offer.csv");
      return XLSX.read(text, { type: "string", raw: true, FS: csvSeparator(text), dense: false });
    }
    return XLSX.read(buffer, { type: "buffer", cellFormula: true, cellNF: true, cellText: true, cellDates: false, dense: false });
  } catch (err) {
    throw refusal(400, "UNREADABLE_DOCUMENT", `This spreadsheet could not be read: ${err.message}`);
  }
};

const tooMany = () => refusal(413, "DOCUMENT_TOO_LONG", `The workbook has more than ${MAX_CELLS} cells: send the sheets that hold the offer.`, { max: MAX_CELLS });

const indexOf = (grid) => {
  const rows = new Map();
  const cols = new Map();
  let bounds = null;
  for (const cell of grid.values()) {
    if (!rows.has(cell.r)) rows.set(cell.r, []);
    rows.get(cell.r).push(cell);
    if (!cols.has(cell.c)) cols.set(cell.c, []);
    cols.get(cell.c).push(cell.r);
    if (!bounds) bounds = { s: { r: cell.r, c: cell.c }, e: { r: cell.r, c: cell.c } };
    else {
      bounds.s.r = Math.min(bounds.s.r, cell.r);
      bounds.s.c = Math.min(bounds.s.c, cell.c);
      bounds.e.r = Math.max(bounds.e.r, cell.r);
      bounds.e.c = Math.max(bounds.e.c, cell.c);
    }
  }
  for (const list of rows.values()) list.sort((a, b) => a.c - b.c);
  for (const list of cols.values()) list.sort((a, b) => a - b);
  return { rows: new Map([...rows.entries()].sort((a, b) => a[0] - b[0])), cols: new Map([...cols.entries()].sort((a, b) => a[0] - b[0])), bounds };
};

const readWorkbook = (buffer, { name = "offer.xlsx" } = {}) => {
  const format = formatOf(name);
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw refusal(400, "EMPTY_DOCUMENT", "The file is empty.");
  const wb = readBook(buffer, format);
  const sheets = [];
  let total = 0;
  for (const sheetName of wb.SheetNames || []) {
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws["!ref"]) {
      sheets.push({ name: sheetName, grid: new Map(), cells: [], merges: [], bounds: null, rows: new Map(), cols: new Map(), byAt: new Map() });
      continue;
    }
    const grid = new Map();
    const cells = [];
    for (const [addr, raw] of Object.entries(ws)) {
      if (addr[0] === "!") continue;
      const { r, c } = XLSX.utils.decode_cell(addr);
      const empty = (raw.v == null || (typeof raw.v === "string" && !raw.v.trim())) && !raw.f;
      if (empty) continue;
      const cell = { at: addr, r, c, v: raw.v, t: raw.t, w: raw.w, z: raw.z, f: raw.f };
      grid.set(key(r, c), cell);
      cells.push(cell);
    }
    total += cells.length;
    if (total > MAX_CELLS) throw tooMany();
    // Counted on each cell they cover before any is written: a merge over a whole sheet is refused, never expanded.
    const merges = (ws["!merges"] || []).map((m) => ({ s: m.s, e: m.e, ref: XLSX.utils.encode_range(m) })).filter((m) => grid.has(key(m.s.r, m.s.c)));
    for (const m of merges) {
      total += (m.e.r - m.s.r + 1) * (m.e.c - m.s.c + 1) - 1;
      if (total > MAX_CELLS) throw tooMany();
    }
    for (const m of merges) {
      const head = grid.get(key(m.s.r, m.s.c));
      head.merged = m.ref;
      for (let r = m.s.r; r <= m.e.r; r++) for (let c = m.s.c; c <= m.e.c; c++) if (r !== m.s.r || c !== m.s.c) grid.set(key(r, c), { ...head, r, c, copy: true, hr: m.s.r, hc: m.s.c });
    }
    cells.sort((a, b) => a.r - b.r || a.c - b.c);
    const { rows, cols, bounds } = indexOf(grid);
    if (bounds && (bounds.e.r - bounds.s.r + 1) * (bounds.e.c - bounds.s.c + 1) > MAX_AREA) {
      throw refusal(413, "DOCUMENT_TOO_LONG", `The cells of sheet "${sheetName}" span ${XLSX.utils.encode_range(bounds)}, more than ${MAX_AREA} addresses: remove the cells far from the offer, or send the sheets that hold it.`, { max: MAX_AREA });
    }
    sheets.push({ name: sheetName, grid, cells, merges, bounds, rows, cols, byAt: new Map(cells.map((x) => [x.at, x])) });
  }
  if (!total) throw refusal(400, "EMPTY_DOCUMENT", "The workbook holds no cell.");
  return { format, sheets };
};

const cellAt = (sheet, r, c) => sheet.grid.get(key(r, c)) || null;

/** Merged copies included, never an empty address. */
const cellsOfRow = (sheet, r) => sheet.rows?.get(r) || [];

module.exports = { assertInflatable, MAX_INFLATED_BYTES, readWorkbook, cellAt, cellsOfRow, indexOf, formatOf, csvSeparator, FORMATS, MAX_CELLS, MAX_AREA, key };
