/**
 * spreadsheet/workbook — an offer sheet as a grid of addressed cells, read
 * with SheetJS whatever its format: .xlsx, .xlsm, .xls, .ods and .csv.
 *
 *   readWorkbook(buffer, { name }) → { format, sheets: [{ name, grid, cells, merges, bounds, rows, cols, byAt }] }
 *     grid    Map("r,c" → cell) — every cell the sheet shows, a merged range's value repeated on each of its
 *             cells with the address of the cell that holds it (`at`), so a line written once over the rows it
 *             covers is read on each of them and cited where it is written
 *     cells   [cell] — the physical non-empty cells (merged ranges counted once, at their first cell): what the
 *             parser must account for, each read or listed in `unread`
 *     bounds  { s: { r, c }, e: { r, c } } — the box of the cells that EXIST (grid), never the sheet's `!ref`: a
 *             workbook may declare A1:XFD1048576 around three cells, and nothing here walks a declared range
 *     rows    Map(r → [cell] sorted by column) and cols Map(c → [r] sorted): the grid indexed, so the parser walks
 *             the cells there are, row by row or column by column, never every address of the box
 *     byAt    Map("B4" → cell): a physical cell by its address
 *   cell = { at: "B4", r, c, v, t, w, z, f, merged?: "B4:B9" } — a merged range's other cells: { ...its first cell,
 *          r, c, copy: true, hr, hc } (hr, hc: the row and column of the cell that holds the value)
 *
 * Refusals (typed, the refusal table of the web): 415 UNSUPPORTED_DOCUMENT (another extension), 400
 * UNREADABLE_DOCUMENT (SheetJS cannot read it), 400 EMPTY_DOCUMENT (no cell), 413 DOCUMENT_TOO_LONG (more cells
 * than MAX_CELLS — merged ranges counted on each cell they cover — : a dataset, not an offer; or a sheet whose
 * cells span a box of more than MAX_AREA addresses: a stray cell far from the offer, which no reading needs and
 * which would make every row × column walk of the parser cost the whole box).
 *
 * A CSV is decoded as text (UTF-8, Latin-1 fallback) and read with its separator (« ; » or « , » or a tab, the
 * most frequent on its first line), every cell as the text it is — SheetJS never turns « 6:05 » into a number
 * there, so the readers see what the operator typed.
 */

"use strict";

const path = require("path");
const XLSX = require("xlsx");
const { refusal } = require("../refusal");
const { decodeBuffer } = require("../csvUtils");

const FORMATS = { ".xlsx": "xlsx", ".xlsm": "xlsm", ".xls": "xls", ".ods": "ods", ".csv": "csv" };
const MAX_CELLS = 250000;
// The box the cells of one sheet may span (rows × columns): 2 000 rows × 1 000 columns, far beyond any offer sheet.
const MAX_AREA = 2000000;

const key = (r, c) => `${r},${c}`;

/** How many times `sep` appears in a CSV line outside double quotes. */
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
 * A CSV's separator, read on its first non-empty lines rather than its first one alone: a title above the table
 * (« Ligne 4 — dimanche ») carries no separator, and a French export uses « ; ». The separator whose count is shared
 * by the most lines wins (a table's rows share their width), then the one seen most; « , » when none is found.
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

/** The format a file name says, or a 415 refusal. */
const formatOf = (name) => {
  const ext = path.extname(String(name || "")).toLowerCase();
  if (!FORMATS[ext]) throw refusal(415, "UNSUPPORTED_DOCUMENT", `An offer sheet is a .xlsx, .xlsm, .xls, .ods or .csv file (got ${ext || "no extension"}).`);
  return FORMATS[ext];
};

// What a file of each format starts with: a zip (xlsx, xlsm, ods), an OLE compound file or an HTML/XML table (xls).
const SIGNATURES = { xlsx: [[0x50, 0x4b]], xlsm: [[0x50, 0x4b]], ods: [[0x50, 0x4b]], xls: [[0xd0, 0xcf, 0x11, 0xe0], [0x3c], [0x09, 0x08]] };
const signed = (buffer, format) => !SIGNATURES[format] || SIGNATURES[format].some((sig) => sig.every((b, i) => buffer[i] === b));

const readBook = (buffer, format) => {
  if (!signed(buffer, format)) throw refusal(400, "UNREADABLE_DOCUMENT", `This file is not a readable .${format} workbook.`);
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

/**
 * The grid indexed by row and by column, and the box of its cells (null when it has none) — also the parser's view of
 * a sheet read across its diagonal (a timetable written with one trip per row).
 */
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

/** A workbook as addressed grids (see the header). */
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
    // Merged ranges: the first cell's value on every cell of the range, cited at the first cell — counted on each
    // cell they cover before any is written (a merge declared over a whole sheet is refused, never expanded).
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

/** The cell at (r, c) of a sheet's grid, or null. */
const cellAt = (sheet, r, c) => sheet.grid.get(key(r, c)) || null;

/** The cells of row r of a sheet's grid (merged copies included), left to right: never an empty address. */
const cellsOfRow = (sheet, r) => sheet.rows?.get(r) || [];

module.exports = { readWorkbook, cellAt, cellsOfRow, indexOf, formatOf, csvSeparator, FORMATS, MAX_CELLS, MAX_AREA, key };
