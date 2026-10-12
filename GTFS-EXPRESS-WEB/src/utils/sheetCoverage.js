/**
 * sheetCoverage — what of the brief's spreadsheets the change covers by its
 * cells, read deterministically from the cells each side names.
 *
 * The owner's test of 2026-10-07: the assistant built the grid of a sheet the
 * cell reader could not take (read_grid: its operation cites « Ligne D
 * semaine!A5:A14 », « Ligne D semaine!B5:T14 », « Ligne D semaine!B4:T4 »),
 * and the delivery still said that grid missing (« 1 grille(s) … ne sont pas
 * dans ce changement ») and its cells « à vérifier à la main ». The review of
 * the fix then found the opposite fault: a grid of ANOTHER day type sharing
 * the stops' column was said covered by the weekday's operation — and a
 * remark in a column the grid left out (skip) too. So a point is covered only
 * where an operation COPIED its cells:
 *
 *   the reader's points   a grid it set aside (a block of the offer, or the contract's wish `grid-…`), each with
 *                         its own trips' cells (spreadsheet/operations.timesOf: `times`); a value it turned into
 *                         no objective, the cells it could not read (a wish whose `cell` lists them, clipped at
 *                         200 characters by the contract)
 *   what an operation     a grid read_grid copied (its ref, source.grid: the server writes it with the cells,
 *   copied                and keeps none a model wrote elsewhere): its cited ranges (source.cells) without the
 *                         cells it left out (source.left_out, and its times' range source.times: transform/
 *                         sheetGrid via the planner's withGrids); one recorded before those were kept is never
 *                         said to cover anything wholly
 *
 *   GRID_WISH                                   a wish recording a grid of the brief the change does not take
 *   sheetCoverage(operations, steps, blocks)    → (point) → null | { operations: [{ id, n, label, type, cells }], whole }
 *   wishesOfItem(item, wishes) / coverageOfItem(item, wishes, coveredBy)
 *                                               the contract's wishes an item of the delivery's list stands for (its
 *                                               words, as the engine keeps them), and their coverage
 *
 * Nothing here guesses: a point that names no cell, an operation that cites
 * none, another document or another sheet, are never covered.
 */

import { overlaps, parseRanges, sameDocument, within, without } from "./sheetRanges";

/** A wish that records a grid of the brief the change does not take (its id says so: the server keeps ids). */
export const GRID_WISH = /^grid-/;

// The contract keeps a point's cells within 200 characters (contractService.wishOf, spreadsheetApi's clip): a list that
// long was cut, and its last address perhaps with it.
const CELL_BOUND = 200;
// The contract's own trimming of a wish's words and cells (contractService.str), to find the block a grid's wish
// records exactly as ChangeStudio.gridWishesOf wrote it.
const kept = (s, n) => String(s ?? "").slice(0, n).trim();
const wishCellOfBlock = (b) => (b.sheet ? kept(`${b.sheet}${b.cell ? `!${b.cell}` : ""}`, 200) : "");
const wishQuoteOfBlock = (b) => kept(b.label || b.title || b.document, 400);

/**
 * A grid's own trips, as the cell reader recorded them on its block (spreadsheet/operations.timesOf: the ranges of their
 * time cells, never the stops' column the block's other day types share): the block itself, or — for a grid's wish
 * (`grid-…`) — the blocks it was written from (same document, cell and words). → { ranges, complete } | null (a block
 * recorded before, or a wish whose block left the offer: only its anchor cell is known).
 */
const gridTimesOf = (point, blocks) => {
  const mine = typeof point.reason === "string" ? [point] : (blocks || []).filter((b) => b && typeof b === "object" && sameDocument(b.document, point.document) && wishCellOfBlock(b) === kept(point.cell, 200) && wishQuoteOfBlock(b) === kept(point.quote, 400));
  if (!mine.length || mine.some((b) => !Array.isArray(b.times) || !b.times.length)) return null;
  const read = parseRanges(mine.flatMap((b) => b.times));
  return read.ranges.length ? { ranges: read.ranges, complete: read.complete && !mine.some((b) => b.times_more) } : null;
};

/**
 * What an operation of the plan says it copied of a sheet: its cited ranges (source.cells) without the cells it left
 * out (source.left_out: a grid read by its cells, read_grid, records the columns it skipped and the range of its
 * times, source.times), each with the pieces left. `exact`: recorded with what it left out — an operation written
 * before that (only its cited ranges known) is said to cover only partly. null: it claims nothing (no document, no
 * grid of read_grid, failed, the cell reader's own timetable, what it left out past the server's bound).
 */
// A grid read_grid copied: the server writes its ref with its cells (the planner's withGrids), and keeps no cell a model
// wrote on any other operation (modelOperation) — an operation without that ref copied nothing, whatever it cites.
const GRID_REF = /^g\d{1,4}$/;

const copiedBy = (op, i, failed) => {
  const s = op && typeof op === "object" && op.source && typeof op.source === "object" ? op.source : null;
  if (!s || !s.document || !GRID_REF.test(String(s.grid ?? "")) || failed.has(op.id) || s.offer || s.generated_by === "spreadsheet" || s.left_out_more) return null;
  const exact = typeof s.times === "string";
  const holes = exact ? parseRanges(s.left_out || []).ranges : [];
  const cited = parseRanges(s.cells || []).ranges.map((r) => ({ r, pieces: without([r], holes) }));
  if (!cited.length || cited.some((c) => !c.pieces)) return null;
  // A grid read by its cells cites [stops, times, numbers?]: its trips are its times (source.times, else the second).
  const range = exact ? parseRanges(s.times).ranges[0] || null : cited[1]?.r || null;
  const pieces = range ? without([range], holes) : null;
  return { op, n: i + 1, exact, cited, times: range && pieces ? { r: range, pieces } : null };
};

/**
 * What of the brief's spreadsheets the change covers by its cells (the owner's test of 2026-10-07: the grid the
 * assistant built from a sheet's cells was still said missing at the delivery, those cells « à vérifier à la main »).
 * A point the cell reader kept is covered by an operation of the plan that did not fail, of the same document, only
 * where that operation COPIED the point's cells (read_grid copies every cell of its ranges but the trips it left out,
 * and asks about one it cannot read) — never by its words alone, never without a cell, never by the cell reader's
 * own timetables (`source.offer`, generated_by "spreadsheet": what it kept to check is what it did not take):
 *
 *   a grid set aside (a block of the offer, or its wish `grid-…`)   by the operation's TIMES only, its own trips'
 *       cells (the block's `times`) — a grid of another day type beside it shares its stops' column, never its trips;
 *       a block recorded before those (its anchor cell alone) is never said wholly covered
 *   a value turned into no objective, cells the reader could not read   by any range the operation copied
 *
 *   sheetCoverage(operations, steps?, blocks?) → (point) → null | { operations: [{ id, n, label, type, cells }], whole }
 *     point   a wish ({ id, document, quote, cell: "Sheet!B5" or a list « Sheet!A4, Sheet!B4, … ») or a block of the
 *             offer ({ document, label, reason, sheet, cell: "B5", times? })
 *     blocks  the offer's blocks (offer.skipped): where a grid's wish finds its trips
 *   `n`: the operation's place in the plan (as the delivery numbers them); `cells`: the ranges it cites that hold what
 *   it copied of the point, as it cites them; `whole`: every cell of the point lies in what operations recorded with
 *   what they left out copied (a list cut at its bound, a grid known by its anchor, never are) — else part of it is
 *   still the person's to check by hand
 */
export const sheetCoverage = (operations, steps = null, blocks = null) => {
  const failed = new Set((steps || []).filter((s) => s && s.status === "failed").map((s) => s.id));
  const copying = (operations || []).map((op, i) => copiedBy(op, i, failed)).filter(Boolean);
  const said = (x, cells) => ({ id: x.op.id ?? null, n: x.n, label: x.op.label || null, type: x.op.type || null, cells });
  return (point) => {
    if (!point || typeof point !== "object" || !copying.length) return null;
    const mine = copying.filter((x) => sameDocument(x.op.source.document, point.document));
    if (!mine.length) return null;
    if (typeof point.reason === "string" || GRID_WISH.test(String(point.id || ""))) {
      const own = gridTimesOf(point, blocks);
      const anchor = parseRanges(point.sheet ? `${point.sheet}!${point.cell || ""}` : point.cell || "").ranges.slice(0, 1);
      const ranges = own ? own.ranges : anchor;
      const found = mine.filter((x) => x.times && x.times.pieces.some((q) => ranges.some((p) => overlaps(p, q))));
      if (!found.length) return null;
      const whole = Boolean(own && own.complete) && within(ranges, found.filter((x) => x.exact).flatMap((x) => x.times.pieces));
      return { operations: found.map((x) => said(x, [x.times.r.text])), whole };
    }
    const text = typeof point.cell === "string" ? point.cell : "";
    if (!text.trim()) return null;
    const read = parseRanges(text);
    // Cut at its bound: an ellipsis already left the clipped address unread; a bare cut may have kept half of one.
    const cut = text.length >= CELL_BOUND;
    const ranges = cut && !/…\s*$/.test(text) ? read.ranges.slice(0, -1) : read.ranges;
    const found = mine.map((x) => ({ x, cells: x.cited.filter((c) => c.pieces.some((q) => ranges.some((p) => overlaps(p, q)))) })).filter((f) => f.cells.length);
    if (!found.length) return null;
    const whole = read.complete && !cut && within(ranges, found.filter((f) => f.x.exact).flatMap((f) => f.x.cited.flatMap((c) => c.pieces)));
    return { operations: found.map((f) => said(f.x, f.cells.map((c) => c.r.text))), whole };
  };
};

// A point's words as the delivery's list carries them: the engine keeps the first 300 characters of a wish's quote,
// and of its why once trimmed (engine.pendingAssumptions) — cut there on both sides, then read with their spaces.
const wordsOf = (s, { trim = false } = {}) => (trim ? String(s ?? "").trim() : String(s ?? "")).slice(0, 300).replace(/\s+/g, " ").trim();
const wordsKey = (quote, why) => `${wordsOf(quote)}\u0000${wordsOf(why, { trim: true })}`;
// The contract's wishes by their words, read once per list (a list of 2 000 items against 240 wishes, at every render).
const wishIndex = new WeakMap();
const indexOf = (wishes) => {
  if (!wishIndex.has(wishes)) {
    const index = new Map();
    for (const w of wishes) {
      if (!w || w.checked) continue;
      const key = wordsKey(w.quote, w.why);
      index.set(key, [...(index.get(key) || []), w]);
    }
    wishIndex.set(wishes, index);
  }
  return wishIndex.get(wishes);
};

/** The contract's wishes an item of the delivery's list stands for: a wish travels there as an assumption, its quote and its why. */
export const wishesOfItem = (item, wishes) => (item?.wish && Array.isArray(wishes) ? indexOf(wishes).get(wordsKey(item.quote, item.why)) || [] : []);

/**
 * An item of the delivery's list covered by the plan's operations (`coveredBy`: sheetCoverage's): every wish it stands
 * for is covered — one that is not keeps it the person's to check by hand. → null | { operations, whole }
 */
export const coverageOfItem = (item, wishes, coveredBy) => {
  const mine = wishesOfItem(item, wishes);
  const all = coveredBy ? mine.map((w) => coveredBy(w)) : [];
  if (!all.length || all.some((c) => !c)) return null;
  const byOp = new Map();
  for (const c of all) for (const o of c.operations) byOp.set(o.n, byOp.has(o.n) ? { ...byOp.get(o.n), cells: [...new Set([...byOp.get(o.n).cells, ...o.cells])] } : o);
  return { operations: [...byOp.values()].sort((a, b) => a.n - b.n), whole: all.every((c) => c.whole) };
};
