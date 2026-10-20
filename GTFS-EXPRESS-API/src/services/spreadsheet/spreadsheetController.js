/**
 * spreadsheetController — an operator's offer sheet, read deterministically
 * (no model, no feed change).
 *
 *   POST /gtfs/spreadsheet/parse   multipart "file" (.xlsx, .xlsm, .xls, .ods, .csv), field "lang" (fr | en…,
 *                                  the language of the clauses' lines; default fr), header X-Session-ID (optional)
 *     → 200 { model, clauses, not_converted, aggregates, resolved: { session } }
 *       model       the typed model of spreadsheet/parser: every value with its sheet and cell, `unread` lists
 *                   every non-empty cell not read and why
 *       clauses     the step-2 clauses the sheet states (spreadsheet/clauses): source = the cell, quote = its text;
 *                   ② adds the ones the person selects to the contract, merged server-side like any clause
 *       not_converted  the values that give no clause, and why (direction_unresolved, origin_unknown,
 *                   band_without_service, headway_without_window…), each with its cell and the cell's text: ②
 *                   records them to check by hand
 *       resolved.session  whether the working copy named by X-Session-ID gave the directions of the clauses
 *                   (a direction the sheet writes as a destination, matched by the engine's own resolver) — and
 *                   its stop names: a timetable written across (one trip per row) is read only where they hold
 *                   its header, else left unread (aggregates.timetables_unsure) for the assistant to read
 *     400 INVALID_INPUT (no file), 400 UNREADABLE_DOCUMENT, 400 EMPTY_DOCUMENT, 413 DOCUMENT_TOO_LARGE { max }
 *     (more than 20 MB), 413 DOCUMENT_TOO_LONG { max } (more than 250 000 cells, merged ranges counted on each
 *     cell they cover, or one sheet's cells spanning more than 2 000 000 addresses), 415 UNSUPPORTED_DOCUMENT,
 *     429 (app.js: its own limiter)
 *
 * Nothing is stored: the file is read in memory and forgotten; the feed is only read (its lines and
 * directions), never written.
 */

"use strict";

const { parseWorkbook, aggregatesOf } = require("./parser");
const { clausesOf } = require("./clauses");
const { recordEvent, extractReqMeta } = require("../eventLogger");

const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** The working copy named by X-Session-ID, as the engine models it (only read) — or null. */
const feedOf = (req) => {
  const id = req.headers["x-session-id"];
  try {
    if (!id || !require("../sessionManager").validateSessionId(id)) return null;
    const db = require("../db/connection").ensureDbHandle(id);
    return db ? require("../transform/feedModel").buildFeedModel(db) : null;
  } catch {
    return null;
  }
};

/**
 * The direction of the loaded feed a line of the sheet names — its destination (matched by the engine's own
 * resolver), or the 0 / 1 of a « direction_id » column — or null: never a guess (« Aller », « Sens 1 » name none).
 */
const directionResolver = (model) => {
  if (!model) return null;
  const R = require("../transform/resolve");
  return (line, { direction, destination }) => {
    try {
      const route = R.route(model, line);
      if (!route.value) return null;
      for (const word of [direction === "0" || direction === "1" ? direction : null, destination]) {
        if (!word) continue;
        const d = R.direction(model, route.value.id, word);
        if (d.value === "0" || d.value === "1") return d.value;
      }
    } catch {
      // A line the resolver cannot read gives no direction: the clauses say so (direction_unresolved).
    }
    return null;
  };
};

/** The feed's stop names: a timetable written across is read only where they hold its header (spreadsheet/parser). */
const stopNamesOf = (model) => (model?.stops ? [...model.stops.values()].map((s) => s.name).filter(Boolean) : null);

const postParse = (req, res) => {
  const file = req.files && (req.files.file || Object.values(req.files)[0]);
  const f = Array.isArray(file) ? file[0] : file;
  if (!f || !f.data) return res.status(400).json({ error: "INVALID_INPUT", message: "Send the offer sheet in a multipart field named 'file'." });
  if (f.data.length > MAX_FILE_BYTES) return res.status(413).json({ error: "DOCUMENT_TOO_LARGE", message: `An offer sheet is at most ${MAX_FILE_BYTES / 1024 / 1024} MB.`, max: MAX_FILE_BYTES / 1024 / 1024 });
  const lang = typeof req.body?.lang === "string" && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(req.body.lang) ? req.body.lang : "fr";
  try {
    const feed = feedOf(req);
    const model = parseWorkbook(f.data, { name: f.name, stopNames: stopNamesOf(feed) });
    const resolveDirection = directionResolver(feed);
    const { clauses, not_converted } = clausesOf(model, { resolveDirection, lang });
    const aggregates = aggregatesOf(model);
    recordEvent("spreadsheet.parse", { ...extractReqMeta(req), format: model.file.format, sheets: aggregates.sheets, lines: aggregates.lines, cells: aggregates.cells, unread: aggregates.unread });
    res.json({ model, clauses, not_converted, aggregates, resolved: { session: Boolean(resolveDirection) } });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.code || "SPREADSHEET_FAILED", message: err.message, ...(Number.isFinite(err.details?.max) ? { max: err.details.max } : {}) });
  }
};

module.exports = { postParse, MAX_FILE_BYTES };
