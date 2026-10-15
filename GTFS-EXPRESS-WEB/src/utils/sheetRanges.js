/**
 * sheetRanges — the cells a point of the brief's spreadsheets names, and the
 * cells an operation of the change cites, read as rectangles of one sheet.
 *
 * The reader's points name their cells (« Sheet!B5 », a gathered point
 * « Sheet!A4, Sheet!B4, … » clipped at its bound), the operations cite
 * theirs (source.cells): whether one meets the other is read here, without
 * any guess — a point that names no cell is never covered.
 *
 *   parseRange("Ligne D semaine!B5:T14") → { sheet, top, left, bottom, right, text } (0-based, ordered) | null
 *   parseRanges(text | [text]) → { ranges, complete }: every range of a list (« Sheet!A4, Sheet!B4 », a sheet's
 *                                name may hold a comma); a piece that does not read (the clipped end of a long list,
 *                                a sheet named without its cell) is left out and makes the list incomplete
 *   overlaps(a, b) / contains(outer, inner) → the same sheet (its name compared without case, as a workbook names
 *                                it) and the rectangles meet / the first holds the second
 *   without(ranges, holes)   → what of `ranges` lies outside every hole, as rectangles (a grid's cited ranges without
 *                                the columns it left out) — null past MAX_PIECES pieces: too scattered to tell
 *   within(ranges, pieces)   → every cell of `ranges` lies in one of `pieces` (false when it cannot be told)
 *   sameDocument(a, b) → two names of one file of the brief (trimmed, without case)
 */

const ADDRESS = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;

/** A1 → { row, col } (0-based), or null. */
const addressOf = (text) => {
  const m = ADDRESS.exec(String(text || "").trim());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = Number(m[2]);
  return row > 0 ? { row: row - 1, col: col - 1 } : null;
};

// A sheet's name as a formula may quote it ('Ligne D'!A1, a quote doubled inside).
const sheetOf = (text) => {
  const s = String(text || "").trim();
  return s.length > 1 && s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1).replace(/''/g, "'").trim() : s;
};

const key = (s) => String(s || "").normalize("NFC").trim().toLowerCase();

export const parseRange = (text) => {
  const s = String(text || "").trim();
  const bang = s.lastIndexOf("!");
  if (bang <= 0) return null;
  const sheet = sheetOf(s.slice(0, bang));
  const [from, to, extra] = s.slice(bang + 1).split(":");
  if (!sheet || extra !== undefined) return null;
  const a = addressOf(from);
  const b = to === undefined ? a : addressOf(to);
  if (!a || !b) return null;
  return { sheet, top: Math.min(a.row, b.row), left: Math.min(a.col, b.col), bottom: Math.max(a.row, b.row), right: Math.max(a.col, b.col), text: s };
};

export const parseRanges = (input) => {
  const ranges = [];
  let complete = true;
  for (const text of Array.isArray(input) ? input : [input]) {
    if (text == null || String(text).trim() === "") continue;
    // A piece is joined to the next one until it reads: a sheet named « Ligne D, semaine » spans two pieces.
    let buffer = null;
    for (const piece of String(text).split(",")) {
      buffer = buffer === null ? piece : `${buffer},${piece}`;
      const range = parseRange(buffer);
      if (range) {
        ranges.push(range);
        buffer = null;
      } else if (buffer.includes("!")) {
        // A sheet and something after it that is no cell (« Ligne D semaine!I… », clipped): left out, said incomplete.
        complete = false;
        buffer = null;
      }
    }
    if (buffer !== null && buffer.trim()) complete = false;
  }
  return { ranges, complete };
};

const sameSheet = (a, b) => key(a.sheet) === key(b.sheet);

export const overlaps = (a, b) => Boolean(a && b) && sameSheet(a, b) && a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;

export const contains = (outer, inner) => Boolean(outer && inner) && sameSheet(outer, inner) && outer.left <= inner.left && inner.right <= outer.right && outer.top <= inner.top && inner.bottom <= outer.bottom;

// A rectangle without another: the parts of `a` above, below, left and right of `b` (none when `b` holds it).
const minus = (a, b) => {
  if (!overlaps(a, b)) return [a];
  const out = [];
  if (a.top < b.top) out.push({ ...a, bottom: b.top - 1 });
  if (b.bottom < a.bottom) out.push({ ...a, top: b.bottom + 1 });
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.bottom, b.bottom);
  if (a.left < b.left) out.push({ ...a, top, bottom, right: b.left - 1 });
  if (b.right < a.right) out.push({ ...a, top, bottom, left: b.right + 1 });
  return out;
};

// Pieces at most: a grid's ranges without a few hundred columns left out stay well below.
const MAX_PIECES = 4000;

export const without = (ranges, holes) => {
  let pieces = (ranges || []).filter(Boolean);
  for (const h of holes || []) {
    pieces = pieces.flatMap((p) => minus(p, h));
    if (pieces.length > MAX_PIECES) return null;
  }
  return pieces;
};

export const within = (ranges, pieces) => {
  const rest = without(ranges, pieces);
  return Array.isArray(rest) && rest.length === 0;
};

export const sameDocument = (a, b) => Boolean(key(a)) && key(a) === key(b);
