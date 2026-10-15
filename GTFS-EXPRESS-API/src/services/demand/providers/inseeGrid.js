/**
 * inseeGrid — residents per 200 m cell from the INSEE Filosofi grid
 * ("données carroyées", Licence Ouverte), read from local files: one CSV per
 * département in INSEE_GRID_DIR, named <dep>.csv (see
 * scripts/prepare-insee-grid.js, which splits the national file). Columns
 * read (case-insensitive, separator sniffed):
 *   Idcar_200m | IdINSPIRE   "CRS3035RES200mN<northing>E<easting>", the
 *                            cell's south-west corner in EPSG:3035
 *   Ind                      residents of the cell (may be fractional:
 *                            INSEE imputes small cells)
 *   lcog_geo | Depcom        the commune(s) of the cell, optional; a single
 *                            code tags the cell
 * A cell listed in two files (straddling a border) is counted once.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { cellCentre, toLaea } = require("../laea");
const { inBbox } = require("../grid");

const ID_COLUMNS = ["idcar_200m", "idinspire", "idcar200m"];
const IND_COLUMNS = ["ind"];
const COMMUNE_COLUMNS = ["lcog_geo", "depcom", "codgeo", "code_commune"];
const CELL_RE = /^CRS3035RES(\d+)mN(\d+)E(\d+)$/i;

const SOURCE = { id: "insee_filosofi", name: "INSEE — Filosofi, population carroyée à 200 m", url: "https://www.insee.fr", license: "Licence Ouverte / Open Licence" };

const unquote = (s) => String(s ?? "").trim().replace(/^"(.*)"$/, "$1").trim();
const foldHeader = (s) => unquote(s).replace(/^﻿/, "").toLowerCase();
const sniff = (line) => {
  const counts = [";", ",", "\t"].map((c) => [c, line.split(c).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ";";
};

/** The file of a département in `dir`, or null. */
const fileFor = (dir, dep) => {
  for (const name of [...new Set([`${dep}.csv`, `${String(dep).toUpperCase()}.csv`, `${String(dep).toLowerCase()}.csv`])]) {
    const f = path.join(dir, name);
    try {
      if (fs.statSync(f).isFile()) return f;
    } catch {
      /* not this one */
    }
  }
  return null;
};

/** The EPSG:3035 window (± margin m) that holds a WGS84 box. */
const laeaWindow = (b, marginM = 1000) => {
  const pts = [];
  for (const lat of [b[0], (b[0] + b[2]) / 2, b[2]]) for (const lon of [b[1], (b[1] + b[3]) / 2, b[3]]) pts.push(toLaea(lat, lon));
  return { e0: Math.min(...pts.map((p) => p.e)) - marginM, e1: Math.max(...pts.map((p) => p.e)) + marginM, n0: Math.min(...pts.map((p) => p.n)) - marginM, n1: Math.max(...pts.map((p) => p.n)) + marginM };
};

/** Read one département file into `out` (points inside the box). */
const readFile = async (file, bbox, win, seen, out, signal) => {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let sep = null;
  let iId = -1;
  let iInd = -1;
  let iCom = -1;
  let rows = 0;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      if (sep === null) {
        sep = sniff(line);
        const h = line.split(sep).map(foldHeader);
        iId = h.findIndex((x) => ID_COLUMNS.includes(x));
        iInd = h.findIndex((x) => IND_COLUMNS.includes(x));
        iCom = h.findIndex((x) => COMMUNE_COLUMNS.includes(x));
        if (iId < 0 || iInd < 0) throw new Error(`${path.basename(file)}: expected columns Idcar_200m (or IdINSPIRE) and Ind`);
        continue;
      }
      rows += 1;
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORTED" });
      const f = line.split(sep);
      const id = unquote(f[iId]);
      const m = CELL_RE.exec(id);
      if (!m) continue;
      const n = Number(m[2]);
      const e = Number(m[3]);
      if (e < win.e0 || e > win.e1 || n < win.n0 || n > win.n1 || seen.has(id)) continue;
      const v = parseFloat(unquote(f[iInd]).replace(",", "."));
      if (!(v > 0)) continue;
      const c = cellCentre(id);
      if (!c || !inBbox(c.lat, c.lon, bbox)) continue;
      seen.add(id);
      const com = iCom >= 0 ? unquote(f[iCom]) : "";
      out.push({ lat: c.lat, lon: c.lon, v, ...(/^[0-9][0-9AB][0-9]{3}$/.test(com) ? { commune: com } : {}), kind: "grid" });
    }
  } finally {
    rl.close();
  }
  return rows;
};

/**
 * Residents of the box from the grid files of `departements`:
 * { points, files, missing, rows }. A missing file is reported, not read
 * around: the caller decides (a partial grid would under-count).
 */
const readGridCells = async ({ dir, departements, bbox, signal = null }) => {
  const files = [];
  const missing = [];
  for (const dep of departements) {
    const f = fileFor(dir, dep);
    if (f) files.push(f);
    else missing.push(dep);
  }
  if (missing.length || !files.length) return { points: [], files, missing, rows: 0 };
  const win = laeaWindow(bbox);
  const seen = new Set();
  const points = [];
  let rows = 0;
  for (const f of files) rows += await readFile(f, bbox, win, seen, points, signal);
  return { points, files, missing, rows };
};

module.exports = { readGridCells, SOURCE, _internals: { fileFor, laeaWindow, sniff } };
