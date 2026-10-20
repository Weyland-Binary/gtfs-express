/**
 * spreadsheetApi — an operator's offer sheet read by the server, cell by
 * cell, deterministically: POST /spreadsheet/parse.
 *
 *   parseOfferSheet(file, { lang }) → { model, clauses, not_converted, aggregates, resolved }
 *
 * The working copy (X-Session-ID, when this tab has one) lets the server
 * name the feed's direction of each line the sheet writes as a destination;
 * nothing is stored, the feed is not written. Errors carry the server's
 * `code`, the `status` and the `body` (the refusal table renders them:
 * UNSUPPORTED_DOCUMENT, UNREADABLE_DOCUMENT, EMPTY_DOCUMENT,
 * DOCUMENT_TOO_LARGE, DOCUMENT_TOO_LONG).
 *
 * Also pure helpers the import dialog and ③ share:
 *   sheetCells(result)          → Map("sheet!A1" → { state: read | unread, reason?, text, role? }) the cell grid
 *   clauseCells(clause)         → "sheet!A1" the cell a clause cites (from its source)
 *   sheetWishes(result, opts)   → the wishes « à vérifier à la main » the import records in the contract: what the
 *                                 sheet states that no clause will cover (G5) — see below
 *   OFFER_ACCEPT                the file types the picker offers
 */

import API_BASE_URL from "../config";
import { MAX_CONTRACT_WISHES } from "./contract";
import { fetchWithSession } from "./sessionManager";

export const OFFER_ACCEPT = ".xlsx,.xlsm,.xls,.ods,.csv";
export const OFFER_MAX_BYTES = 20 * 1024 * 1024;

export const parseOfferSheet = async (file, { lang = "fr" } = {}) => {
  if (file.size > OFFER_MAX_BYTES) {
    const err = new Error("DOCUMENT_TOO_LARGE");
    err.code = "DOCUMENT_TOO_LARGE";
    err.status = 413;
    err.body = { error: "DOCUMENT_TOO_LARGE", max: OFFER_MAX_BYTES / 1024 / 1024 };
    throw err;
  }
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("lang", lang);
  let res;
  try {
    res = await fetchWithSession(`${API_BASE_URL}/spreadsheet/parse`, { method: "POST", body: form });
  } catch (err) {
    const e = new Error(err?.message || "Network error");
    e.code = err?.status === 429 ? "RATE_LIMITED" : "NETWORK_ERROR";
    e.status = err?.status || 0;
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `HTTP ${res.status}`);
    err.code = data.error || `HTTP_${res.status}`;
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
};

/** Every cell the parse speaks of, read (a value or a label) or not (with its reason). */
export const sheetCells = (result) => {
  const out = new Map();
  const model = result?.model;
  if (!model) return out;
  const walk = (x, role = null) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) return x.forEach((y) => walk(y, role));
    if (typeof x.sheet === "string" && typeof x.cell === "string" && !x.cell.includes(":")) {
      for (const c of x.cells || [x.cell]) if (!out.has(`${x.sheet}!${c}`)) out.set(`${x.sheet}!${c}`, { state: "read", text: x.text ?? "", role });
    }
    for (const [k, v] of Object.entries(x)) if (v && typeof v === "object") walk(v, ["sheet", "cell", "text", "cells"].includes(k) ? role : k);
  };
  walk(model.lines);
  for (const l of model.labels || []) out.set(`${l.sheet}!${l.cell}`, { state: "read", text: l.text, role: l.role });
  for (const u of model.unread || []) out.set(`${u.sheet}!${u.cell}`, { state: "unread", reason: u.reason, text: u.text });
  return out;
};

/** The cell a clause of the sheet cites (« file · Sheet!A1 » → "Sheet!A1"). */
export const clauseCells = (clause) => {
  const m = /·\s*(.+)$/.exec(String(clause?.source || ""));
  return m ? m[1].trim() : null;
};

export const MAX_WISHES = MAX_CONTRACT_WISHES; // the contract's wishes (contractService MAX_WISHES): never more, never cut unsaid

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * What an offer sheet states that no clause of the contract will cover (G5: every requirement of the order covered,
 * marked to check by hand, or dismissed by a named person), as wishes « à vérifier à la main »: each value the server
 * did not convert to a clause (one wish per cell, its reasons together), each cell it could not read, and each clause
 * the person leaves out (`left`). quote = the cell's text, document = the file, cell = « Sheet!B4 », why = the reason
 * in words (`words`). Items already in the contract (same document, cell and reason) are not added twice. Past the
 * room left in the contract (MAX_WISHES − `existing`), the items of one reason become one wish listing their cells,
 * and past that one wish holds the rest: never an item dropped to fit. `gather`: the kinds of items always gathered
 * that way, one wish per reason whatever the room (["unread"]: a layout the reader does not know leaves dozens of
 * cells — one point each would bury the others). → { wishes: [{ quote, document, cell, why }], items: the count of
 * what they record, full: true when the contract has no room left at all }
 *
 *   words = { unread(reason), notConverted([reasons]), left(clause), group(count, why), rest(count) }
 */
export const sheetWishes = (result, { left = [], existing = [], words, gather = [] }) => {
  const file = result?.model?.file?.name || "";
  const at = (sheet, cell) => (sheet && cell ? `${sheet}!${cell}` : sheet || "");
  const items = [];
  // Values without a clause: one item per cell, its reasons together (a first departure may lack both its stop and
  // its direction).
  const byCell = new Map();
  for (const x of result?.not_converted || []) {
    const key = at(x.sheet, x.cell);
    if (!byCell.has(key)) byCell.set(key, { cell: key, quote: x.text || key, reasons: [] });
    if (!byCell.get(key).reasons.includes(x.reason)) byCell.get(key).reasons.push(x.reason);
  }
  for (const v of byCell.values()) items.push({ group: `nc:${v.reasons.join(",")}`, quote: v.quote, cell: v.cell, why: words.notConverted(v.reasons) });
  for (const u of result?.model?.unread || []) items.push({ group: `unread:${u.reason}`, quote: u.text || at(u.sheet, u.cell), cell: at(u.sheet, u.cell), why: words.unread(u.reason) });
  for (const c of left) items.push({ group: "left", quote: c.quote || c.text || c.kind, cell: clauseCells(c) || "", why: words.left(c) });
  const truncated = result?.model?.unread_truncated || 0;
  const seen = new Set(existing.map((w) => `${w.document || ""}|${w.cell || ""}|${w.why || ""}`));
  // The kinds always gathered: one item per reason, its cells listed (`n`: how many cells it holds).
  const gathered = new Map();
  const listed = [];
  for (const x of items) {
    if (!gather.some((g) => x.group.startsWith(`${g}:`))) listed.push(x);
    else {
      if (!gathered.has(x.group)) gathered.set(x.group, []);
      gathered.get(x.group).push(x);
    }
  }
  for (const list of gathered.values()) listed.push(list.length === 1 ? list[0] : { group: list[0].group, quote: list.map((x) => `« ${x.quote} »`).join(", "), cell: list.map((x) => x.cell).join(", "), why: words.group(list.length, list[0].why), n: list.length });
  // Compared as recorded (a gathered point's cells and reason are clipped when kept): read again, never twice.
  const fresh = listed.filter((x) => !seen.has(`${file}|${clip(x.cell, 200)}|${clip(x.why, 300)}`));
  const room = Math.max(0, MAX_WISHES - existing.length);
  const cellsOf = (list) => list.reduce((n, x) => n + (x.n || 1), 0);
  const count = cellsOf(fresh) + truncated;
  if (!count) return { wishes: [], items: 0, full: false };
  if (!room) return { wishes: [], items: count, full: true };
  const one = (x) => ({ quote: clip(String(x.quote || x.cell), 400), document: file, cell: clip(x.cell, 200), why: clip(x.why, 300) });
  if (fresh.length <= room && !truncated) return { wishes: fresh.map(one), items: count, full: false };
  // Grouped by reason: one wish per group, its cells listed.
  const groups = new Map();
  for (const x of fresh) {
    if (!groups.has(x.group)) groups.set(x.group, []);
    groups.get(x.group).push(x);
  }
  const grouped = [...groups.values()].map((list) => ({ n: cellsOf(list), wish: list.length === 1 ? one(list[0]) : one({ quote: list.map((x) => `« ${x.quote} »`).join(", "), cell: list.map((x) => x.cell).join(", "), why: words.group(cellsOf(list), list[0].why) }) }));
  // The cells the server lists past its own bound (model.unread_truncated): counted, said in one wish.
  if (truncated) grouped.push({ n: truncated, wish: one({ quote: file, cell: "", why: words.rest(truncated) }) });
  if (grouped.length <= room) return { wishes: grouped.map((g) => g.wish), items: count, full: false };
  const kept = grouped.slice(0, room - 1);
  const rest = grouped.slice(room - 1);
  const restWish = one({ quote: rest.map((g) => g.wish.quote).join(", "), cell: rest.map((g) => g.wish.cell).filter(Boolean).join(", "), why: words.rest(rest.reduce((n, g) => n + g.n, 0)) });
  return { wishes: [...kept.map((g) => g.wish), restWish], items: count, full: false };
};

/** A1 address → { r, c } (0-based); null when it is not one. */
export const decodeCell = (addr) => {
  const m = /^([A-Z]+)(\d+)$/.exec(String(addr || ""));
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]) - 1, c: c - 1 };
};

/** 0-based column → its letters (0 → A, 26 → AA). */
export const columnName = (c) => {
  let s = "";
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};
