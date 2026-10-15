/**
 * briefReading — the reading of a modify project's brief by the assistant at
 * ② (the extraction turn), as the journey launches and records it. The whole
 * brief is read ONCE, every document together, and the objectives the cell
 * reader stated from its spreadsheets are cross-checked by the assistant
 * before they are kept (the cell reader can take a trip number for a stop,
 * or count ten trips for twelve). Pure functions, no model:
 *
 *   sheetCheckOf(contract, names) → { text, count, ids }: the objectives the
 *       cell reader stated from the spreadsheets among `names`, listed for the
 *       assistant to CHECK against their cells — never to state again: it
 *       records only what they leave out, and an objective that reads its
 *       cells wrongly as the cells say it, its words opening on that
 *       objective's id in brackets (utils/contract reconciledClauses turns it
 *       into a dispute ② asks the person to settle). Model-facing, in English
 *       like the server's prompts, bounded (CHECK_MAX_OBJECTIVES,
 *       CHECK_MAX_CHARS); it rides in the reading's message only — the
 *       conversation shows the person's words, and the contract keeps those
 *       as the reading's note
 *   leftOutOf(sent, read, { names, only, missing, tooLong }) → [{ id, name,
 *       unreadable?, too_long? }]: the documents a reading was given and did
 *       not read — the server carries what fits in one message (five
 *       documents, about 120k tokens together: network/briefDocumentService)
 *       and leaves out what it no longer holds. Why, only the server can say:
 *       the reading's record may name the ones it no longer holds (`missing`:
 *       `unreadable`, gone) and the ones past its bounds (`tooLong`:
 *       `too_long`, ids or names); a reading of left-out documents alone that
 *       read none of them could not find them (`unreadable`)
 *   pendingReading(ids, extracted, { arrivedAfter }) → { mode, ids } | null:
 *       what is left to read of `ids` (the documents the reading sends, in its
 *       order) by itself: "all" — a document no reading was given: every
 *       document read again together —, "left" — only the documents the
 *       server said it could not carry for their length (`too_long`), read on
 *       their own (never again by itself once a reading of them alone found
 *       none) —, or nothing. A document left out that the server gave no
 *       reason for was sent once already: read again only by the person's act
 *       (« Lire ces documents » at ②) — never a paid reading launched by
 *       itself for a document the server may no longer hold. A reading
 *       recorded without `left_out` (an older record) says nothing of the
 *       documents it was given: one counts as given unless it arrived after
 *       that reading (`arrivedAfter`)
 */

import { decisionOf, fromSheet } from "./contract";

/** The objectives one reading's message lists for the assistant to check, and the characters they take at most. */
export const CHECK_MAX_OBJECTIVES = 80;
export const CHECK_MAX_CHARS = 16000;
const LINE_MAX = 360;

// Model-facing (the assistant reads it, the person never does): the check asked of the reading.
const CHECK_HEAD = [
  "[Spreadsheet objectives to check] The application read the objectives below from the spreadsheets' cells, without a model; they are already proposed to the user.",
  "Do not record them again. Check each one against its cells, then record only:",
  "(1) what the spreadsheets require that none of them states;",
  '(2) for an objective that reads its cells wrongly (a direction reversed; a heading, a column title or a trip number taken for a stop; another time, count, day or period), the clause as the cells say it, its text starting with that objective\'s id in square brackets, e.g. "[trips_count_1abc] …".',
].join("\n");

const clip = (s, max) => {
  const text = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const cellsOf = (c) => (Array.isArray(c?.source?.cells) ? c.source.cells.join(", ") : typeof c?.source === "string" ? c.source : "");
const sheetOf = (c) => c?.origin?.document || c?.document || null;

/** The spreadsheets' objectives among `names`, as the reading's message lists them (see the header). */
export const sheetCheckOf = (contract, names) => {
  const wanted = new Set((names || []).filter(Boolean));
  const bySheet = new Map();
  for (const c of contract?.clauses || []) {
    const sheet = fromSheet(c) ? sheetOf(c) : null;
    if (!sheet || !wanted.has(sheet) || decisionOf(c) === "waive" || c.status === "waived") continue;
    bySheet.set(sheet, [...(bySheet.get(sheet) || []), c]);
  }
  const lines = [];
  const ids = [];
  let size = CHECK_HEAD.length;
  for (const [sheet, clauses] of bySheet) {
    const head = `« ${clip(sheet, 160)} »:`;
    let listed = 0;
    for (const c of clauses) {
      const line = clip(`- [${c.id}] ${c.kind} ${JSON.stringify(c.params || {})}${c.text ? ` — « ${c.text} »` : ""}${cellsOf(c) ? ` — cells ${cellsOf(c)}` : ""}`, LINE_MAX);
      const weight = (listed ? 0 : head.length + 1) + line.length + 1;
      if (ids.length >= CHECK_MAX_OBJECTIVES || size + weight > CHECK_MAX_CHARS) break;
      if (!listed) lines.push(head);
      lines.push(line);
      ids.push(c.id);
      size += weight;
      listed += 1;
    }
    // Past the bounds: counted, so the assistant knows the list is not the sheet's whole.
    if (listed < clauses.length) lines.push(`(… and ${clauses.length - listed} more objective(s) read from « ${clip(sheet, 160)} », not listed here.)`);
  }
  if (!ids.length) return { text: "", count: 0, ids: [] };
  return { text: `${CHECK_HEAD}\n${lines.join("\n")}`, count: ids.length, ids };
};

/** The documents a reading was given and did not read (see the header). */
export const leftOutOf = (sent, read, { names = {}, only = false, missing = null, tooLong = null } = {}) => {
  const got = new Set((read || []).map((d) => (typeof d === "string" ? d : d?.id)).filter(Boolean));
  const ids = (sent || []).filter(Boolean);
  const none = only && !ids.some((id) => got.has(id));
  // What the server said of the ones it left out: by id (or, for its bounds, by the name it gives them).
  const gone = new Set(Array.isArray(missing) ? missing.filter((x) => typeof x === "string") : []);
  const long = new Set(Array.isArray(tooLong) ? tooLong.filter((x) => typeof x === "string") : []);
  return ids
    .filter((id) => !got.has(id))
    .map((id) => {
      const name = names[id] || null;
      if (none || gone.has(id)) return { id, name, unreadable: true };
      return { id, name, ...(long.has(id) || (name && long.has(name)) ? { too_long: true } : {}) };
    });
};

/** What is left to read of `ids` (see the header). */
export const pendingReading = (ids, extracted, { arrivedAfter = () => false } = {}) => {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return null;
  if (!extracted) return { mode: "all", ids: list };
  const read = new Set((extracted.documents || []).map((d) => d?.id).filter(Boolean));
  const recorded = Array.isArray(extracted.left_out);
  const left = new Map((recorded ? extracted.left_out : []).filter((d) => d?.id).map((d) => [d.id, d]));
  if (list.some((id) => !read.has(id) && !left.has(id) && (recorded || arrivedAfter(id)))) return { mode: "all", ids: list };
  // By itself, only what the server left out for its length: a document it gave no reason for is the person's to send again.
  const again = list.filter((id) => left.has(id) && !read.has(id) && !left.get(id).unreadable && left.get(id).too_long === true);
  return again.length ? { mode: "left", ids: again } : null;
};
