/**
 * mobpro — commuting flows between communes (France), from the INSEE flow
 * tables of the census, read from local files (Licence Ouverte):
 *   MOBPRO_FILE  home → work   (base flux de mobilité domicile – lieu de
 *                travail: CODGEO, LIBGEO, DCLT, L_DCLT, NBFLUX_C<yy>_ACTOCC15P)
 *   MOBSCO_FILE  home → study  (… domicile – lieu d'études: CODGEO, LIBGEO,
 *                DCETU, L_DCETU, NBFLUX_C<yy>_SCOL02P)
 * Separator sniffed (";" in the INSEE CSVs), headers case-insensitive, the
 * flow column is the first NBFLUX_* one, decimals with "." or ",".
 *
 * The national file (hundreds of thousands of rows) is streamed once per
 * set of communes: rows starting or ending in a commune of the territory
 * are kept and the filtered table is cached on disk (DEMAND_CACHE_DIR, or
 * the OS temp directory), keyed by the file's path, size and date and by
 * the communes, so a new INSEE file or another territory reads again.
 *
 * Output: od entries at commune level, { from: { code, name, lat, lon },
 * to: { … }, flow, unit: "people", purpose: "work" | "school", source:
 * "mobpro" | "mobsco" } — flow counts commuters, not trips
 * (centre coordinates for the communes of the territory). Flows between
 * two communes of the territory are all kept; flows with the outside,
 * largest first, up to MAX_EXTERNAL, the rest summed per commune and
 * direction into an "other communes" entry.
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const config = require("../../../config");
const { addSource } = require("../sources");

const MAX_EXTERNAL = 400;
const MAX_CACHE_FILES = 200;
const OTHER = "other communes";

const SOURCES = {
  mobpro: { id: "insee_mobpro", name: "INSEE — recensement, flux de mobilité domicile – lieu de travail", url: "https://www.insee.fr", license: "Licence Ouverte / Open Licence" },
  mobsco: { id: "insee_mobsco", name: "INSEE — recensement, flux de mobilité domicile – lieu d'études", url: "https://www.insee.fr", license: "Licence Ouverte / Open Licence" },
};

const unquote = (s) => String(s ?? "").trim().replace(/^"(.*)"$/, "$1").trim();
const foldHeader = (s) => unquote(s).replace(/^﻿/, "").toLowerCase();
const sniff = (line) => {
  const counts = [";", ",", "\t"].map((c) => [c, line.split(c).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ";";
};

const cacheDir = () => config.DEMAND_CACHE_DIR || path.join(os.tmpdir(), "gtfs-express-demand");

/** Keep the cache directory bounded: the oldest files go first. */
const pruneCache = (dir) => {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }));
    if (files.length <= MAX_CACHE_FILES) return;
    files.sort((a, b) => a.t - b.t);
    for (const x of files.slice(0, files.length - MAX_CACHE_FILES)) fs.unlinkSync(path.join(dir, x.f));
  } catch {
    /* best effort */
  }
};

/**
 * Stream a flow table, keeping the rows that start or end in `codes`:
 * { rows: [[origin, originName, destination, destinationName, flow]], cached }.
 */
const filterFlows = async (file, codes, { signal = null } = {}) => {
  const stat = fs.statSync(file); // throws ENOENT: the provider reports it
  const set = new Set(codes);
  const key = crypto.createHash("sha1").update(`${path.resolve(file)}|${stat.size}|${stat.mtimeMs}|${[...set].sort().join(",")}`).digest("hex").slice(0, 24);
  const dir = cacheDir();
  const cachePath = path.join(dir, `flows-${key}.json`);
  try {
    const hit = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (Array.isArray(hit?.rows)) return { rows: hit.rows, cached: true };
  } catch {
    /* no cache yet */
  }
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  const rows = [];
  let sep = null;
  let idx = null;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      if (sep === null) {
        sep = sniff(line);
        const h = line.split(sep).map(foldHeader);
        idx = {
          o: h.findIndex((x) => x === "codgeo" || x === "commune"),
          oName: h.indexOf("libgeo"),
          d: h.findIndex((x) => x === "dclt" || x === "dcetu"),
          dName: h.findIndex((x) => x === "l_dclt" || x === "l_dcetu"),
          flow: h.findIndex((x) => /^nbflux/.test(x)),
        };
        if (idx.o < 0 || idx.d < 0 || idx.flow < 0) throw new Error(`${path.basename(file)}: expected columns CODGEO, DCLT (or DCETU) and NBFLUX_*`);
        continue;
      }
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORTED" });
      const f = line.split(sep);
      const o = unquote(f[idx.o]);
      const d = unquote(f[idx.d]);
      if (!set.has(o) && !set.has(d)) continue;
      const flow = parseFloat(unquote(f[idx.flow]).replace(",", "."));
      if (!(flow > 0)) continue;
      rows.push([o, idx.oName >= 0 ? unquote(f[idx.oName]) : null, d, idx.dName >= 0 ? unquote(f[idx.dName]) : null, Math.round(flow * 10) / 10]);
    }
  } finally {
    rl.close();
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ file: path.basename(file), rows }));
    fs.renameSync(tmp, cachePath);
    pruneCache(dir);
  } catch {
    /* the cache is an optimisation */
  }
  return { rows, cached: false };
};

/** Filtered rows → od entries (internal flows all, external ones bounded). */
const toOd = (rows, communes, purpose, source) => {
  const byCode = new Map(communes.map((c) => [c.code, c]));
  const place = (code, name) => {
    const c = byCode.get(code);
    return c ? { code, name: c.name, ...(Number.isFinite(c.lat) && Number.isFinite(c.lon) ? { lat: c.lat, lon: c.lon } : {}) } : { code, ...(name ? { name } : {}) };
  };
  const internal = [];
  const external = [];
  for (const [o, oName, d, dName, flow] of rows) (byCode.has(o) && byCode.has(d) ? internal : external).push({ from: place(o, oName), to: place(d, dName), flow, unit: "people", purpose, source });
  external.sort((a, b) => b.flow - a.flow);
  const kept = external.slice(0, MAX_EXTERNAL);
  const rest = new Map(); // summed per commune of the territory and direction
  for (const f of external.slice(MAX_EXTERNAL)) {
    const out = byCode.has(f.from.code);
    const inside = out ? f.from : f.to;
    const k = `${out ? "out" : "in"}|${inside.code}`;
    if (!rest.has(k)) rest.set(k, { from: out ? inside : { name: OTHER }, to: out ? { name: OTHER } : inside, flow: 0, unit: "people", purpose, source });
    rest.get(k).flow += f.flow;
  }
  const summed = [...rest.values()].map((f) => ({ ...f, flow: Math.round(f.flow * 10) / 10 }));
  return { od: [...internal, ...kept, ...summed], internal: internal.length, external: external.length };
};

const fmt = (n) => Math.round(n).toLocaleString("en-US").replace(/,/g, " ");

const mobproProvider = {
  id: "mobpro",
  label: "commuting flows (INSEE files)",
  stage: 1,
  countries: ["FR"],
  fallback: "no commuting flows",
  run: async (draft, ctx) => {
    const files = [
      { file: config.MOBPRO_FILE, purpose: "work", source: "mobpro", meta: SOURCES.mobpro },
      { file: config.MOBSCO_FILE, purpose: "school", source: "mobsco", meta: SOURCES.mobsco },
    ].filter((x) => x.file);
    if (!files.length) return; // not configured on this server: nothing to say
    const communes = (ctx.communes || []).filter((c) => !(c.share === 0));
    if (!communes.length) throw new Error("needs the official commune list");
    const codes = communes.map((c) => c.code);
    const od = [];
    const notes = [];
    for (const x of files) {
      const r = await filterFlows(x.file, codes, { signal: ctx.signal });
      const out = toOd(r.rows, communes, x.purpose, x.source);
      od.push(...out.od);
      const total = out.od.reduce((a, f) => a + f.flow, 0);
      notes.push(`od: INSEE ${x.purpose === "work" ? "home → work" : "home → study"} flows of the ${codes.length} communes — ${fmt(total)} people a day, ${out.internal} flows inside the territory and ${out.external} with other communes${out.external > MAX_EXTERNAL ? ` (the ${MAX_EXTERNAL} largest kept, the rest summed as "${OTHER}")` : ""}`);
      addSource(draft, { ...x.meta, used_for: ["od"] });
    }
    // Commit.
    draft.od = [...draft.od.filter((f) => f.source !== "mobpro" && f.source !== "mobsco"), ...od];
    if (od.length) draft.quality.od = "mobpro";
    draft.warnings.push(...notes, "od: census flows count people (unit \"people\": where they live and where they work or study), not trips — a commuter makes the outbound and the return trip on the days they commute; residents working abroad are not in them");
  },
};

module.exports = { mobproProvider, filterFlows, toOd, SOURCES, _internals: { cacheDir, sniff, MAX_EXTERNAL } };
