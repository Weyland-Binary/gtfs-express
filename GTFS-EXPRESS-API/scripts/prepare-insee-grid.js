#!/usr/bin/env node
/**
 * prepare-insee-grid — split the national INSEE 200 m population grid into
 * one file per département, the layout INSEE_GRID_DIR expects
 * (services/demand/providers/inseeGrid.js).
 *
 *   node scripts/prepare-insee-grid.js <national.csv> <out-dir> [--departements 81,31,2A] [--commune-column <name>]
 *
 * Input: the INSEE Filosofi "données carroyées" at 200 m, as published
 * (e.g. carreaux_200m_met.csv, carreaux_200m_reun.csv), separator ";" or ","
 * (sniffed), with the cell id column (Idcar_200m, or IdINSPIRE in the 2015
 * edition), the residents column (Ind) and a commune column (lcog_geo, or
 * Depcom in 2015, or the one named by --commune-column).
 *
 * Output: <out-dir>/<dep>.csv, each with the national header and the rows of
 * its département. The département is read from the commune code — the
 * first two characters of each 5-character code (2A / 2B for Corsica),
 * three for the overseas départements (971–976); it is never guessed from
 * coordinates. A cell whose lcog_geo lists several communes (it straddles a
 * boundary: "8100481065") goes to every département concerned; the reader
 * counts a cell once. Rows without a readable commune code are counted and
 * reported. The input is streamed: the national file is never held in memory.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { once } = require("events");

const ID_COLUMNS = ["idcar_200m", "idinspire", "idcar200m"];
const COMMUNE_COLUMNS = ["lcog_geo", "depcom", "codgeo", "code_commune"];
const CODE_RE = /^([0-9][0-9AB])([0-9]{3})$/;

const unquote = (s) => String(s ?? "").trim().replace(/^"(.*)"$/, "$1").trim();
const sniff = (line) => [";", ",", "\t"].map((c) => [c, line.split(c).length - 1]).sort((a, b) => b[1] - a[1])[0][0];

/** The départements of a commune field ("81004", "8100481065", "97411"). */
const departementsOf = (field) => {
  const s = unquote(field).toUpperCase();
  if (!s || s.length % 5 !== 0) return [];
  const out = new Set();
  for (let i = 0; i < s.length; i += 5) {
    const code = s.slice(i, i + 5);
    if (!CODE_RE.test(code)) return [];
    out.add(code.startsWith("97") ? code.slice(0, 3) : code.slice(0, 2));
  }
  return [...out];
};

/**
 * Split `input` into `outDir`/<dep>.csv. Resolves { rows, written, files,
 * unassigned } (written counts row copies: a straddling cell counts once
 * per département).
 */
const splitGrid = async ({ input, outDir, departements = null, communeColumn = null }) => {
  const only = departements && departements.length ? new Set(departements.map((d) => String(d).toUpperCase())) : null;
  fs.mkdirSync(outDir, { recursive: true });
  const rl = readline.createInterface({ input: fs.createReadStream(input, { encoding: "utf8" }), crlfDelay: Infinity });
  const streams = new Map();
  let header = null;
  let sep = null;
  let iCom = -1;
  let rows = 0;
  let written = 0;
  let unassigned = 0;
  const streamFor = (dep) => {
    if (!streams.has(dep)) {
      const ws = fs.createWriteStream(path.join(outDir, `${dep}.csv`), { encoding: "utf8" });
      ws.write(`${header}\n`);
      streams.set(dep, ws);
    }
    return streams.get(dep);
  };
  try {
    for await (const raw of rl) {
      const line = raw.replace(/^﻿/, "");
      if (!line.trim()) continue;
      if (header === null) {
        header = line;
        sep = sniff(line);
        const cols = line.split(sep).map((h) => unquote(h).toLowerCase());
        if (!cols.some((c) => ID_COLUMNS.includes(c))) throw new Error(`${path.basename(input)}: no cell id column (Idcar_200m or IdINSPIRE) in the header`);
        if (!cols.includes("ind")) throw new Error(`${path.basename(input)}: no residents column (Ind) in the header`);
        iCom = communeColumn ? cols.indexOf(String(communeColumn).toLowerCase()) : cols.findIndex((c) => COMMUNE_COLUMNS.includes(c));
        if (iCom < 0) throw new Error(`${path.basename(input)}: no commune column (lcog_geo, Depcom) — name it with --commune-column`);
        continue;
      }
      rows += 1;
      const deps = departementsOf(line.split(sep)[iCom]);
      if (!deps.length) {
        unassigned += 1;
        continue;
      }
      for (const dep of deps) {
        if (only && !only.has(dep)) continue;
        const ws = streamFor(dep);
        written += 1;
        if (!ws.write(`${line}\n`)) await once(ws, "drain");
      }
    }
  } finally {
    rl.close();
    await Promise.all([...streams.values()].map((ws) => new Promise((resolve) => ws.end(resolve))));
  }
  return { rows, written, unassigned, files: [...streams.keys()].sort().map((d) => `${d}.csv`) };
};

const main = async (argv) => {
  const args = argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return null;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const deps = opt("--departements");
  const communeColumn = opt("--commune-column");
  const [input, outDir] = args;
  if (!input || !outDir) {
    console.error("Usage: node scripts/prepare-insee-grid.js <national.csv> <out-dir> [--departements 81,31,2A] [--commune-column <name>]");
    process.exit(2);
  }
  const r = await splitGrid({ input, outDir, departements: deps ? deps.split(",").map((s) => s.trim()).filter(Boolean) : null, communeColumn });
  console.log(`${r.rows} cells read, ${r.written} rows written into ${r.files.length} files in ${outDir}${r.unassigned ? `; ${r.unassigned} cells without a commune code were left out` : ""}.`);
  console.log(`Set INSEE_GRID_DIR=${path.resolve(outDir)}`);
};

if (require.main === module) {
  main(process.argv).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { splitGrid, departementsOf };
