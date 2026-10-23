/**
 * row_changes: a retouche by hand replayed by key as the rows it wrote (any GTFS table, cascades included) on whatever
 * the plan before it left. A row the plan no longer holds stops the step with the row named, never forced.
 * Internal: never offered to a model, it only comes from the person's hand.
 */

"use strict";

const { GTFS_TABLES } = require("../changeset");

// Insert order respecting references (parents first); deletes run reversed.
const ORDER = ["agency", "networks", "routes", "route_networks", "levels", "stops", "areas", "stop_areas", "calendar", "calendar_dates", "shapes", "trips", "stop_times", "frequencies", "transfers", "pathways", "fare_attributes", "fare_rules", "fare_media", "rider_categories", "fare_products", "timeframes", "fare_leg_rules", "fare_leg_join_rules", "fare_transfer_rules", "booking_rules", "location_groups", "location_group_stops", "translations", "attributions", "feed_info"];
const rank = (t) => {
  const i = ORDER.indexOf(t);
  return i < 0 ? ORDER.length : i;
};
// A column name is an identifier of the feed's schema (rule #2: never spliced unchecked).
const IDENT = /^[a-z_][a-z0-9_]*$/i;
const MAX_ROWS = 50000;

const fr = (lang) => String(lang || "").slice(0, 2) === "fr";
const say = (lang, fr_, en) => (fr(lang) ? fr_ : en);

const isScalar = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);
const rowOk = (row) => row && typeof row === "object" && !Array.isArray(row) && Object.entries(row).every(([k, v]) => IDENT.test(k) && isScalar(v));

/** The parameters checked: GTFS tables only, identifiers only, scalar values, a bounded size. */
const resolve = (model, params = {}, ctx = {}) => {
  const lang = ctx.lang;
  const tables = params.tables;
  const bad = (message) => ({ value: null, ambiguities: [{ param: "tables", code: "invalid", message }], warnings: [] });
  if (!tables || typeof tables !== "object" || Array.isArray(tables) || !Object.keys(tables).length) return bad(say(lang, "La retouche ne dit aucune ligne modifiée.", "The retouche names no row it changed."));
  let rows = 0;
  for (const [t, d] of Object.entries(tables)) {
    if (!GTFS_TABLES.includes(t)) return bad(say(lang, `Table inconnue : ${t}.`, `Unknown table: ${t}.`));
    if (!d || !Array.isArray(d.keyCols) || !d.keyCols.length || !d.keyCols.every((c) => IDENT.test(c))) return bad(say(lang, `Clé illisible pour ${t}.`, `Unreadable key for ${t}.`));
    for (const list of ["inserted", "deleted", "updated"]) if (d[list] != null && !Array.isArray(d[list])) return bad(say(lang, `Lignes illisibles pour ${t}.`, `Unreadable rows for ${t}.`));
    for (const r of [...(d.inserted || []), ...(d.deleted || [])]) if (!rowOk(r)) return bad(say(lang, `Ligne illisible dans ${t}.`, `Unreadable row in ${t}.`));
    for (const u of d.updated || []) if (!u || !rowOk(u.key) || !rowOk(u.set) || !Object.keys(u.set).length) return bad(say(lang, `Modification illisible dans ${t}.`, `Unreadable change in ${t}.`));
    rows += (d.inserted || []).length + (d.deleted || []).length + (d.updated || []).length;
  }
  if (rows > MAX_ROWS) return bad(say(lang, `Retouche trop grande (${rows} lignes, ${MAX_ROWS} au plus).`, `Retouche too large (${rows} rows, ${MAX_ROWS} at most).`));
  return { value: { label: typeof params.label === "string" ? params.label.slice(0, 300) : "", tables }, ambiguities: [], warnings: [] };
};

const where = (cols, row) => {
  const parts = [];
  const values = [];
  for (const c of cols) {
    if (row[c] === null || row[c] === undefined) parts.push(`${c} IS NULL`);
    else {
      parts.push(`${c} = ?`);
      values.push(row[c]);
    }
  }
  return { sql: parts.join(" AND "), values };
};
const describe = (row, cols) => cols.map((c) => `${c}=${row[c] ?? "∅"}`).join(", ");

/** The rows replayed on the sandbox; a row gone from the draft stops the step, named. */
const apply = (db, value, ctx = {}) => {
  const lang = ctx.lang;
  const tables = Object.keys(value.tables).sort((a, b) => rank(a) - rank(b));
  const stale = (t, row, cols) => new Error(say(lang, `La retouche ne s'applique plus à ce brouillon : la ligne ${t} (${describe(row, cols)}) n'y est plus.`, `The retouche no longer applies to this draft: the ${t} row (${describe(row, cols)}) is gone from it.`));
  // References are checked once every row of the step is written (a child inserted with its parent, a parent removed with its children).
  db.pragma("defer_foreign_keys = ON");
  const counts = { inserted: 0, deleted: 0, updated: 0 };
  for (const t of [...tables].reverse()) {
    const d = value.tables[t];
    const cols = d.surrogateKey ? d.columns || Object.keys((d.deleted || [])[0] || {}) : d.keyCols;
    for (const row of d.deleted || []) {
      const w = where(cols.filter((c) => IDENT.test(c)), row);
      const sql = d.surrogateKey ? `DELETE FROM ${t} WHERE rowid IN (SELECT rowid FROM ${t} WHERE ${w.sql} LIMIT 1)` : `DELETE FROM ${t} WHERE ${w.sql}`;
      const out = db.prepare(sql).run(...w.values);
      // Already gone (an earlier operation removed it): what the retouche wanted holds.
      counts.deleted += out.changes;
    }
  }
  for (const t of tables) {
    const d = value.tables[t];
    for (const u of d.updated || []) {
      const setCols = Object.keys(u.set).filter((c) => IDENT.test(c));
      const w = where(Object.keys(u.key).filter((c) => IDENT.test(c)), u.key);
      const out = db.prepare(`UPDATE ${t} SET ${setCols.map((c) => `${c} = ?`).join(", ")} WHERE ${w.sql}`).run(...setCols.map((c) => u.set[c]), ...w.values);
      if (!out.changes) throw stale(t, u.key, Object.keys(u.key));
      counts.updated += out.changes;
    }
  }
  for (const t of tables) {
    const d = value.tables[t];
    for (const row of d.inserted || []) {
      const cols = Object.keys(row).filter((c) => IDENT.test(c));
      try {
        db.prepare(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c]));
        counts.inserted += 1;
      } catch (err) {
        if (!/UNIQUE|PRIMARY KEY/i.test(String(err?.message))) throw err;
        // The same row is already there (the plan added it too): nothing to add.
        const w = where(d.keyCols.filter((c) => IDENT.test(c)), row);
        const existing = db.prepare(`SELECT * FROM ${t} WHERE ${w.sql} LIMIT 1`).get(...w.values);
        const sameRow = existing && cols.every((c) => String(existing[c] ?? "") === String(row[c] ?? ""));
        if (!sameRow) throw new Error(say(lang, `La retouche ne s'applique plus à ce brouillon : une autre ligne ${t} (${describe(row, d.keyCols)}) y existe déjà.`, `The retouche no longer applies to this draft: another ${t} row (${describe(row, d.keyCols)}) already exists in it.`));
      }
    }
  }
  const total = counts.inserted + counts.deleted + counts.updated;
  const summary = value.label || say(lang, `Retouche à la main : ${total} ligne(s)`, `Hand retouche: ${total} row(s)`);
  return { summary, noop: total === 0, tables };
};

module.exports = {
  type: "row_changes",
  title: "Retouche by hand",
  category: "generic",
  internal: true,
  tables: GTFS_TABLES,
  description: "A retouche made by hand on the draft, replayed as the rows it wrote (captured by the editors; never proposed).",
  params: [
    { name: "tables", type: "object", required: true, description: "{ table: { keyCols, columns, surrogateKey?, inserted, deleted, updated: [{ key, set }] } }" },
    { name: "label", type: "string", required: false, description: "The retouche's own sentence." },
  ],
  example: { label: "Arrêt renommé", tables: { stops: { keyCols: ["stop_id"], columns: ["stop_id", "stop_name"], inserted: [], deleted: [], updated: [{ key: { stop_id: "BRY" }, set: { stop_name: "Bryant Park" } }] } } },
  resolve,
  apply,
  _internals: { MAX_ROWS, ORDER },
};
