/**
 * What a feed gives back at every exit (the download, and the files a validation, a version, a share or an inspection
 * reads): one writer, so what is validated is what is delivered (G1) and nothing of the source is dropped on the way
 * out. A table goes out with the columns its file had (gtfsCsvColumns), as its rows as the engine holds them, in the
 * file's order, each with the extension columns it came with, then the rows the import kept aside, as read, a row
 * that held more cells than its header with those cells; its values between quotes or bare, its numbers with the
 * decimals, its line ends, its byte order mark and its last line as the file wrote them (db/sourceForm).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { TABLE_MAP } = require("./db/feedImport");
const { columnsOut } = require("./gtfsCsvColumns");
const { keyExprOf, asideRowsOf, asideCountOf, keepsSourceFiles, sourceFileOf } = require("./db/sourceStore");
const { GROUPS, MUST_QUOTE, isPadded, withDecimals } = require("./db/sourceForm");

/** The id of a row kept aside, on the rows the writer yields for it (a symbol: never a column). */
const ASIDE_ID = Symbol("asideId");

/** The cells a row kept aside held past its header, in order: written after its columns' cells, so the row stays as long. */
const SURPLUS = Symbol("surplusCells");
// The reader's key for a cell past the header.
const SURPLUS_CELL = /^_\d+$/;

const EXTRAS = "__source_extras";

// In a copy that kept no header, a table of these goes out with its header alone when it holds no row. calendar is not
// one: a feed dated by calendar_dates.txt alone must not get an empty calendar.txt.
const REQUIRED = new Set(["agency", "routes", "stops", "trips", "stop_times"]);

// The order of a table whose file's own is not known: a copy opened before the files' forms were kept, a table the
// feed did not carry.
const ORDER_BY = Object.freeze({
  stop_times: "trip_id, stop_sequence",
  shapes: "shape_id, shape_pt_sequence",
  translations: "table_name, field_name, language",
  attributions: "rowid",
  fare_rules: "rowid",
  stop_areas: "area_id, stop_id",
  route_networks: "network_id, route_id",
  fare_products: "rowid",
  timeframes: "timeframe_group_id, start_time",
  fare_leg_rules: "rowid",
  fare_leg_join_rules: "rowid",
  fare_transfer_rules: "rowid",
});

/** The tables a feed is written from, in the order of its files: { file, table, columns, required, orderBy }. */
const FEED_TABLES = Object.freeze(
  TABLE_MAP.map(({ table, columns }) => Object.freeze({ file: `${table}.txt`, table, columns, required: REQUIRED.has(table), ...(ORDER_BY[table] ? { orderBy: ORDER_BY[table] } : {}) })),
);
const TABLE_FILES = new Set(FEED_TABLES.map((t) => t.file));
const GEOJSON_FILE = "locations.geojson";

/**
 * { columns, header, count, rows() } for one table of FEED_TABLES: the columns it goes out with, its source file's
 * header (null when the feed did not carry it) and its rows. `rows()` yields plain row objects keyed by column, in
 * the file's order; a row kept aside carries its id under ASIDE_ID and, when it had any, its cells past the header
 * under SURPLUS.
 */
const tableOutOf = (db, spec) => {
  const { table, orderBy = null } = spec;
  const { columns, header, form, extension } = columnsOut(db, spec);
  const known = columns.filter((c) => spec.columns.includes(c));
  const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c + asideCountOf(db, table);
  // A file may name no column of the specification: its rows still count.
  const select = known.length > 0 ? known.map((c) => `t.${c}`).join(", ") : "NULL AS __none";
  const from = extension.length ? `SELECT ${select}, e.data AS ${EXTRAS} FROM ${table} t LEFT JOIN _source_extras e ON e.tbl = ? AND e.row_key = ${keyExprOf(db, table, "t.")}` : `SELECT ${select} FROM ${table} t`;
  const args = extension.length ? [table] : [];
  const withExtension = (r) => {
    const values = r[EXTRAS] ? JSON.parse(r[EXTRAS]) : [];
    delete r[EXTRAS];
    extension.forEach((c, i) => {
      r[c] = values[i] ?? null;
    });
    return r;
  };
  const whole = extension.length ? withExtension : (r) => r;
  // The table's own order is the file's: a row keeps its place, a new one comes last.
  const order = form
    ? " ORDER BY t.rowid"
    : orderBy
      ? ` ORDER BY ${orderBy
          .split(",")
          .map((c) => `t.${c.trim()}`)
          .join(", ")}`
      : "";
  const group = form && form.grouped && GROUPS[table].every((c) => known.includes(c)) ? GROUPS[table] : null;

  /**
   * The table's order, the rows of each group together and in sequence as the file had them: a group whose rows an
   * edit left apart in the table (one added, moved or removed) is written whole where its first row stands, and a
   * group renumbered in place is put back in sequence.
   */
  function* groupedRows() {
    const [by, sequence] = group;
    const apart = new Set(db.prepare(`SELECT ${by} FROM ${table} GROUP BY ${by} HAVING MAX(rowid) - MIN(rowid) + 1 <> COUNT(*)`).pluck().all());
    const ofGroup = apart.size > 0 ? db.prepare(`${from} WHERE t.${by} = ? ORDER BY t.${sequence}`) : null;
    const written = new Set();
    let current;
    let skipped = false;
    let block = [];
    let inSequence = true;
    const closed = () => {
      const rows = inSequence ? block : block.sort((a, b) => a[sequence] - b[sequence]);
      block = [];
      inSequence = true;
      return rows;
    };
    for (const r of db.prepare(`${from} ORDER BY t.rowid`).iterate(...args)) {
      const id = r[by];
      if (id !== current) {
        yield* closed();
        current = id;
        skipped = apart.has(id);
        if (skipped && !written.has(id)) {
          written.add(id);
          for (const row of ofGroup.iterate(...args, id)) yield whole(row);
        }
      }
      if (skipped) continue;
      if (block.length > 0 && !(r[sequence] > block[block.length - 1][sequence])) inSequence = false;
      block.push(whole(r));
    }
    yield* closed();
  }

  function* rows() {
    if (group) yield* groupedRows();
    else for (const r of db.prepare(`${from}${order}`).iterate(...args)) yield whole(r);
    for (const a of asideRowsOf(db, table)) {
      const row = { ...a.row };
      Object.defineProperty(row, ASIDE_ID, { value: a.id });
      const surplus = Object.keys(a.row).filter((key) => SURPLUS_CELL.test(key) && !columns.includes(key));
      if (surplus.length) Object.defineProperty(row, SURPLUS, { value: surplus.map((key) => a.row[key]) });
      yield row;
    }
  }

  return { columns, header, form, count, rows };
};

// ── CSV text (RFC 4180)

/** A number as its column's file wrote it: its own text unless the file listed another for it, zeros added up to the column's count. */
const numberText = (own, decimals, listed) => {
  if (listed !== null && Object.prototype.hasOwnProperty.call(listed, own)) return listed[own];
  return decimals > 0 ? withDecimals(own, decimals) : own;
};

/**
 * One cell. A value holding a quote, a separator or a line end goes between quotes, and so does one with a space at
 * either end: the validator's reader, and others, drop those spaces from a bare value, so only quotes carry the
 * value to every reader, and have the validator report it. `way` is the column's own in its file: "all" (every cell
 * between quotes), "filled" (every cell holding a value) or "bare" (padded values without quotes, as the file had them);
 * `decimals` the least count of decimals its file wrote a number with: zeros are added up to it, no digit is dropped;
 * `listed` the numbers its file wrote another way, each with its text.
 */
const csvCell = (value, way, decimals = 0, listed = null) => {
  if (value === null || value === undefined || value === "") return way === "all" ? '""' : "";
  const s = typeof value === "string" ? value : typeof value === "number" ? numberText(String(value), decimals, listed) : String(value);
  if (way === "all" || way === "filled" || MUST_QUOTE.test(s) || (way !== "bare" && isPadded(s))) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

/** Each column's way of quoting in its file (`form`, db/sourceForm), aligned with `columns`. */
const waysOf = (columns, form) => {
  const quoted = (form && form.quoted) || {};
  const bare = (form && form.bare) || [];
  return columns.map((c) => quoted[c] || (bare.includes(c) ? "bare" : undefined));
};

/** Writes the rows of a table as lines: `line(row, eol)`. The cells past the header are written the writer's own way. */
const lineWriterOf = (columns, form = null) => {
  const ways = waysOf(columns, form);
  const decimals = columns.map((c) => (form && form.decimals && form.decimals[c]) || 0);
  const listed = columns.map((c) => (form && form.written && form.written[c]) || null);
  const n = columns.length;
  return (row, eol = "\n") => {
    const cells = new Array(n);
    for (let i = 0; i < n; i++) cells[i] = csvCell(row[columns[i]], ways[i], decimals[i], listed[i]);
    if (row[SURPLUS]) for (const cell of row[SURPLUS]) cells.push(csvCell(cell));
    return cells.join(",") + eol;
  };
};

const csvLine = (row, columns, eol = "\n") => lineWriterOf(columns)(row, eol);

// An extension column's name is the file's own: written as any value, quoted when it must be.
const csvHeader = (columns, eol = "\n") => columns.map((c) => csvCell(c)).join(",") + eol;

/**
 * Whether a value of that table's column with a space at either end goes out between quotes, where the validator
 * reports its spaces: (column) => boolean.
 */
const quotesPadded = (db, table) => {
  const bare = new Set(sourceFileOf(db, table)?.form?.bare || []);
  return (column) => !bare.has(column);
};

// A write a row costs a system call a row, and a deflate call a row once the file is archived.
const BLOCK_CHARS = 65536;

const BYTE_ORDER_MARK = "\uFEFF";

/**
 * The file one table of FEED_TABLES goes out as, or null when it writes none: { file, blocks(), asideLines }.
 * `blocks()` yields its text in blocks of about BLOCK_CHARS closed on a row; as they are read `asideLines` takes the
 * line each row kept aside lands on, { line: asideId }, the header being line 1. The file keeps the line end it was
 * read with unless `eol` asks for one, its byte order mark, and its last line left without a line end.
 */
const tableFileOf = (db, spec, { eol = null } = {}) => {
  const out = tableOutOf(db, spec);
  const form = out.form || {};
  const end = eol || form.eol || "\n";
  const opening = form.bom ? BYTE_ORDER_MARK : "";
  const closing = form.unclosed ? "" : end;
  const asideLines = {};
  if (out.count === 0) {
    // A table without a row goes out as its file's header alone, as read; one the feed did not carry writes no file.
    if (!out.header && (keepsSourceFiles(db) || !spec.required)) return null;
    const header = opening + csvHeader(out.header || out.columns, "") + closing;
    return { file: spec.file, asideLines, blocks: () => [header][Symbol.iterator]() };
  }
  const lineOf = lineWriterOf(out.columns, out.form);
  function* blocks() {
    let block = opening;
    // The line whose end is not written yet: the last one may have none.
    let open = csvHeader(out.columns, "");
    let line = 1;
    for (const row of out.rows()) {
      line++;
      if (row[ASIDE_ID] != null) asideLines[line] = row[ASIDE_ID];
      block += open + end;
      if (block.length >= BLOCK_CHARS) {
        yield block;
        block = "";
      }
      open = lineOf(row, "");
    }
    yield block + open + closing;
  }
  return { file: spec.file, asideLines, blocks };
};

/** locations.geojson as the database holds it: `extra_properties` is merged back into each feature's properties, so the fields kept at upload survive. */
const locationsGeojsonOf = (db, { eol = "\n" } = {}) => {
  const rows = db
    .prepare(
      `SELECT feature_id, geometry_type, coordinates, stop_name, stop_desc, extra_properties
       FROM locations_geojson
       ORDER BY feature_id`,
    )
    .all();
  const features = rows.map((r) => {
    const props = {};
    if (r.stop_name != null) props.stop_name = r.stop_name;
    if (r.stop_desc != null) props.stop_desc = r.stop_desc;
    if (r.extra_properties) {
      try {
        Object.assign(props, JSON.parse(r.extra_properties));
      } catch (_) {
        // A corrupted blob is skipped rather than break the export.
      }
    }
    let coords;
    try {
      coords = JSON.parse(r.coordinates);
    } catch (_) {
      coords = []; // the validator reports invalid_geometry
    }
    return {
      type: "Feature",
      id: r.feature_id,
      geometry: { type: r.geometry_type, coordinates: coords },
      properties: props,
    };
  });
  return JSON.stringify({ type: "FeatureCollection", features }) + eol;
};

const removeStale = (dir, name) => {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return;
  try {
    fs.unlinkSync(file);
  } catch (err) {
    console.warn(`Could not remove stale ${name}:`, err.message);
  }
};

/**
 * The feed the database holds, written into `dir`: a file a table, then locations.geojson; a file of them the feed no
 * longer has is removed from `dir`. Answers the files written, in their order, and where the rows kept aside landed,
 * { file: { line: asideId } }, so a validation of these files can name them. `eol` asks for one line end in every
 * file; without it each file keeps its own.
 */
const writeFeedFiles = (db, dir, { eol = null } = {}) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const files = [];
  const asideLines = {};
  for (const spec of FEED_TABLES) {
    const out = tableFileOf(db, spec, { eol });
    if (!out) {
      removeStale(dir, spec.file);
      continue;
    }
    const fd = fs.openSync(path.join(dir, spec.file), "w");
    try {
      for (const block of out.blocks()) fs.writeSync(fd, block);
    } finally {
      fs.closeSync(fd);
    }
    files.push(spec.file);
    if (Object.keys(out.asideLines).length > 0) asideLines[spec.file] = out.asideLines;
  }
  if (db.prepare("SELECT COUNT(*) AS c FROM locations_geojson").get().c === 0) removeStale(dir, GEOJSON_FILE);
  else {
    fs.writeFileSync(path.join(dir, GEOJSON_FILE), locationsGeojsonOf(db, { eol: eol || "\n" }), "utf8");
    files.push(GEOJSON_FILE);
  }
  return { files, asideLines };
};

// The files a feed ships beyond the spec (an operator's extension): no table holds them, so every exit carries them as
// opened. The product's own files start with "_".
const extraFilesOf = (sessionDir) => {
  try {
    return fs
      .readdirSync(sessionDir)
      .filter((f) => (f.endsWith(".txt") || f.endsWith(".geojson")) && !f.startsWith("_") && !TABLE_FILES.has(f) && f !== GEOJSON_FILE)
      .filter((f) => fs.statSync(path.join(sessionDir, f)).isFile());
  } catch (err) {
    console.warn("Could not read session dir for extra files:", err.message);
    return [];
  }
};

/** Copies them beside the written files and answers their names; with `onError(file, err)` one that cannot be copied is said and left out. */
const copyExtraFiles = (sessionDir, targetDir, { onError = null } = {}) => {
  const copied = [];
  for (const f of extraFilesOf(sessionDir)) {
    try {
      fs.copyFileSync(path.join(sessionDir, f), path.join(targetDir, f));
      copied.push(f);
    } catch (err) {
      if (!onError) throw err;
      onError(f, err);
    }
  }
  return copied;
};

module.exports = { FEED_TABLES, tableOutOf, tableFileOf, writeFeedFiles, locationsGeojsonOf, extraFilesOf, copyExtraFiles, csvLine, csvHeader, lineWriterOf, quotesPadded, ASIDE_ID, SURPLUS, BLOCK_CHARS };
