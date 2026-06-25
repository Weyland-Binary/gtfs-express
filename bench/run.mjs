#!/usr/bin/env node
/**
 * run.mjs — End-to-end perf harness for GTFSExpress.
 *
 * For each .zip fixture in bench/fixtures/, runs a scripted user journey
 * against a live API and times the 5 critical actions:
 *
 *   1. upload       — POST /gtfs/upload (one-shot, end-to-end)
 *   2. switch_route — GET /gtfs/stops_and_times for the busiest route
 *                     (5 iterations, cold + warm)
 *   3. switch_date  — same endpoint, different date inside the
 *                     calendar window (5 iterations)
 *   4. edit_cell    — POST /edit/enter, then PATCH a stop_time
 *                     (5 iterations on different rows)
 *   5. export       — GET /edit/export, drains the ZIP stream
 *
 * Output:
 *   - bench/results/<timestamp>.json   raw measurements
 *   - bench/results/<timestamp>.md     human-readable table
 *
 * Usage:
 *   node bench/run.mjs                       # default API at localhost:3004
 *   node bench/run.mjs --api http://...
 *   node bench/run.mjs --only small.zip
 *
 * Prerequisites:
 *   1. API running with BETA_GATE_DISABLED=true (so /edit/enter does
 *      not require a beta code).
 *   2. ADMIN_TOKEN set if you want to also fetch perf samples after
 *      the run (see --admin-token flag).
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");
const RESULTS_DIR = join(__dirname, "results");

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  return args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const API = flag("api", "http://localhost:3004");
const ONLY = flag("only", null);
const ADMIN_TOKEN = flag("admin-token", null);
const VERBOSE = has("verbose");
const ITERATIONS = parseInt(flag("iters", "5"), 10);

// ── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fmtMs = (ms) => {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

const percentile = (arr, p) => {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const w = rank - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
};

const summarize = (samples) => {
  if (samples.length === 0) return { count: 0 };
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    count: samples.length,
    min: Math.min(...samples),
    avg: sum / samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    max: Math.max(...samples),
  };
};

const time = async (fn) => {
  const start = process.hrtime.bigint();
  const result = await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms, result };
};

const fetchJSON = async (url, opts = {}) => {
  const r = await fetch(url, opts);
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`${opts.method || "GET"} ${url} -> ${r.status} ${body.slice(0, 200)}`);
  }
  return r.json();
};

// ── Fixture discovery ──────────────────────────────────────────────────────

if (!existsSync(FIXTURES_DIR)) {
  console.error(
    `No fixtures directory at ${FIXTURES_DIR}. Run \`node bench/zip-sample.mjs\` first.`,
  );
  process.exit(1);
}

let fixtures = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".zip"));
if (ONLY) {
  fixtures = fixtures.filter((f) => f === ONLY || f.startsWith(ONLY));
}
if (fixtures.length === 0) {
  console.error("No .zip fixtures matched. Place files in bench/fixtures/.");
  process.exit(1);
}

console.log(
  `\nGTFSExpress bench harness\n  API:        ${API}\n  Fixtures:   ${fixtures.join(", ")}\n  Iterations: ${ITERATIONS}\n`,
);

// ── Health probe ───────────────────────────────────────────────────────────

try {
  const r = await fetch(`${API}/health`);
  if (!r.ok) throw new Error(`/health returned ${r.status}`);
  if (VERBOSE) console.log(`API healthy at ${API}`);
} catch (err) {
  console.error(`API not reachable at ${API}: ${err.message}`);
  console.error(
    "Hint: start the API with `npm run dev` from GTFS-EXPRESS-API/.",
  );
  process.exit(1);
}

// Optional reset of perf stats so this run produces a clean snapshot.
if (ADMIN_TOKEN) {
  try {
    await fetch(`${API}/gtfs/admin/perf/reset`, {
      method: "POST",
      headers: { "X-Admin-Token": ADMIN_TOKEN },
    });
    if (VERBOSE) console.log("Perf stats reset.");
  } catch (err) {
    console.warn(`Could not reset perf stats: ${err.message}`);
  }
}

// ── Per-fixture journey ────────────────────────────────────────────────────

const allResults = [];

for (const fixture of fixtures) {
  const fixturePath = join(FIXTURES_DIR, fixture);
  const fixtureBytes = statSync(fixturePath).size;
  console.log(`\n=== ${fixture} (${(fixtureBytes / 1024).toFixed(1)} KB) ===`);

  const sessionId = randomUUID();
  const headers = { "X-Session-ID": sessionId };
  const result = {
    fixture,
    sizeKb: Math.round(fixtureBytes / 1024),
    sessionId,
    actions: {},
    failed: [],
  };

  // ── 1. UPLOAD ────────────────────────────────────────────────────────────
  try {
    const buf = readFileSync(fixturePath);
    const blob = new Blob([buf], { type: "application/zip" });
    const fd = new FormData();
    fd.append("gtfsZip", blob, fixture);

    const { ms } = await time(() =>
      fetchJSON(`${API}/gtfs/upload`, {
        method: "POST",
        headers,
        body: fd,
      }),
    );
    result.actions.upload = { count: 1, only: ms };
    console.log(`  upload       ${fmtMs(ms).padStart(8)}`);
  } catch (err) {
    console.error(`  upload       FAIL: ${err.message}`);
    result.failed.push("upload");
    allResults.push(result);
    continue;
  }

  // ── 2. Discover a route + a date for the next steps ─────────────────────
  let routeId, agencyId, date, direction;
  try {
    const agencies = await fetchJSON(`${API}/gtfs/agencies`, { headers });
    agencyId = agencies[0]?.agency_id;
    const routes = await fetchJSON(
      `${API}/gtfs/routes/${encodeURIComponent(agencyId)}`,
      { headers },
    );
    routeId = routes[0]?.route_id;
    const calendar = await fetchJSON(
      `${API}/gtfs/calendar/${encodeURIComponent(routeId)}`,
      { headers },
    );
    if (calendar.length > 0) {
      // Pick a date near the middle of the active period.
      const start = calendar[0].start_date;
      date = start; // YYYYMMDD
    }
    const dirs = await fetchJSON(
      `${API}/gtfs/directions/${encodeURIComponent(routeId)}/${date}`,
      { headers },
    );
    direction =
      dirs[0]?.direction_id === null || dirs[0]?.direction_id === undefined
        ? "null"
        : String(dirs[0].direction_id);

    if (VERBOSE) {
      console.log(
        `  discovered  agency=${agencyId} route=${routeId} date=${date} dir=${direction}`,
      );
    }
  } catch (err) {
    console.error(`  discovery    FAIL: ${err.message}`);
    result.failed.push("discovery");
    allResults.push(result);
    continue;
  }

  // ── 3. SWITCH_ROUTE / SWITCH_DATE (same endpoint, different params) ─────
  const switchRouteSamples = [];
  const switchDateSamples = [];
  try {
    // First call (cold) to warm the cache
    await fetchJSON(
      `${API}/gtfs/stops_and_times/${encodeURIComponent(routeId)}/${direction}/${date}`,
      { headers },
    );
    for (let i = 0; i < ITERATIONS; i++) {
      const { ms } = await time(() =>
        fetchJSON(
          `${API}/gtfs/stops_and_times/${encodeURIComponent(routeId)}/${direction}/${date}`,
          { headers: { ...headers, "Cache-Control": "no-cache" } },
        ),
      );
      switchRouteSamples.push(ms);
    }
    result.actions.switch_route = summarize(switchRouteSamples);
    console.log(
      `  switch_route min=${fmtMs(result.actions.switch_route.min)} p50=${fmtMs(result.actions.switch_route.p50)} p95=${fmtMs(result.actions.switch_route.p95)} max=${fmtMs(result.actions.switch_route.max)}`,
    );

    // Switch dates: walk a few different YYYYMMDD within the calendar
    const calendarRows = await fetchJSON(
      `${API}/gtfs/calendar/${encodeURIComponent(routeId)}`,
      { headers },
    );
    const dates = [];
    if (calendarRows.length > 0) {
      const startStr = calendarRows[0].start_date;
      const endStr = calendarRows[0].end_date;
      const start = parseInt(startStr.slice(0, 4)) * 10000 + parseInt(startStr.slice(4, 6)) * 100 + parseInt(startStr.slice(6, 8));
      const end = parseInt(endStr.slice(0, 4)) * 10000 + parseInt(endStr.slice(4, 6)) * 100 + parseInt(endStr.slice(6, 8));
      const span = Math.max(1, end - start);
      for (let i = 0; i < ITERATIONS; i++) {
        const offset = Math.floor((i / ITERATIONS) * span);
        const candidate = start + offset;
        const y = Math.floor(candidate / 10000);
        const m = String(Math.floor(candidate / 100) % 100).padStart(2, "0");
        const d = String(candidate % 100).padStart(2, "0");
        dates.push(`${y}${m}${d}`);
      }
    }
    for (const d of dates) {
      try {
        const { ms } = await time(() =>
          fetchJSON(
            `${API}/gtfs/stops_and_times/${encodeURIComponent(routeId)}/${direction}/${d}`,
            { headers: { ...headers, "Cache-Control": "no-cache" } },
          ),
        );
        switchDateSamples.push(ms);
      } catch (err) {
        // Some dates may have no service; that's a 404, not a failure.
        if (VERBOSE) console.log(`    date ${d} skipped: ${err.message}`);
      }
    }
    result.actions.switch_date = summarize(switchDateSamples);
    if (switchDateSamples.length > 0) {
      console.log(
        `  switch_date  min=${fmtMs(result.actions.switch_date.min)} p50=${fmtMs(result.actions.switch_date.p50)} p95=${fmtMs(result.actions.switch_date.p95)} max=${fmtMs(result.actions.switch_date.max)}  (n=${switchDateSamples.length})`,
      );
    } else {
      console.log("  switch_date  no valid dates in calendar window");
    }
  } catch (err) {
    console.error(`  switch_route/date FAIL: ${err.message}`);
    result.failed.push("switch_route_date");
  }

  // ── 4. EDIT_CELL ────────────────────────────────────────────────────────
  try {
    await fetchJSON(`${API}/gtfs/edit/enter`, { method: "POST", headers });

    // Grab a few stop_times rows of the busiest route to PATCH.
    const grid = await fetchJSON(
      `${API}/gtfs/stops_and_times/${encodeURIComponent(routeId)}/${direction}/${date}`,
      { headers },
    );
    const editTargets = (grid.stop_times || [])
      .filter((st) => st.arrival_time && !String(st.trip_id).startsWith("freq_"))
      .slice(0, ITERATIONS);

    const editSamples = [];
    for (const st of editTargets) {
      // Bump arrival_time by 1 second; harmless mutation.
      const [hh, mm, ss] = (st.arrival_time || "00:00:00").split(":").map(Number);
      const newSecs = (ss + 1) % 60;
      const newArrival = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(newSecs).padStart(2, "0")}`;
      const url = `${API}/gtfs/edit/stop_times/${encodeURIComponent(st.trip_id)}/${st.stop_sequence}`;
      try {
        const { ms } = await time(() =>
          fetchJSON(url, {
            method: "PATCH",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ arrival_time: newArrival }),
          }),
        );
        editSamples.push(ms);
      } catch (err) {
        if (VERBOSE) console.log(`    edit skip ${st.trip_id}@${st.stop_sequence}: ${err.message}`);
      }
    }
    result.actions.edit_cell = summarize(editSamples);
    if (editSamples.length > 0) {
      console.log(
        `  edit_cell    min=${fmtMs(result.actions.edit_cell.min)} p50=${fmtMs(result.actions.edit_cell.p50)} p95=${fmtMs(result.actions.edit_cell.p95)} max=${fmtMs(result.actions.edit_cell.max)}  (n=${editSamples.length})`,
      );
    } else {
      console.log("  edit_cell    no valid targets, skipped");
    }
  } catch (err) {
    console.error(`  edit_cell    FAIL: ${err.message}`);
    result.failed.push("edit_cell");
  }

  // ── 5. EXPORT ───────────────────────────────────────────────────────────
  try {
    const start = process.hrtime.bigint();
    const r = await fetch(`${API}/gtfs/edit/export`, { headers });
    if (!r.ok) throw new Error(`export -> ${r.status}`);
    let bytes = 0;
    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    result.actions.export = { count: 1, only: ms, bytes };
    console.log(`  export       ${fmtMs(ms).padStart(8)}  (${(bytes / 1024).toFixed(1)} KB)`);
  } catch (err) {
    console.error(`  export       FAIL: ${err.message}`);
    result.failed.push("export");
  }

  // Cleanup: leave edit mode so the next fixture starts clean.
  try {
    await fetch(`${API}/gtfs/edit/exit`, { method: "POST", headers });
  } catch {
    // best-effort
  }

  allResults.push(result);
  // Tiny pause between fixtures to let the server settle.
  await sleep(250);
}

// ── Server-side perf snapshot (optional) ───────────────────────────────────

let serverPerf = null;
if (ADMIN_TOKEN) {
  try {
    serverPerf = await fetchJSON(`${API}/gtfs/admin/perf/sample`, {
      headers: { "X-Admin-Token": ADMIN_TOKEN },
    });
  } catch (err) {
    console.warn(`Could not fetch server perf: ${err.message}`);
  }
}

// ── Output ────────────────────────────────────────────────────────────────

if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const jsonPath = join(RESULTS_DIR, `${ts}.json`);
const mdPath = join(RESULTS_DIR, `${ts}.md`);

const payload = {
  ts: new Date().toISOString(),
  api: API,
  iterations: ITERATIONS,
  fixtures: allResults,
  serverPerf,
};
writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

// Markdown table
let md = `# Bench results — ${new Date().toISOString()}\n\n`;
md += `API: ${API}\nIterations per action: ${ITERATIONS}\n\n`;
md += `| Fixture | Action | n | min | p50 | p95 | p99 | max |\n`;
md += `|---|---|---:|---:|---:|---:|---:|---:|\n`;
for (const r of allResults) {
  for (const [action, s] of Object.entries(r.actions)) {
    if (s.only !== undefined) {
      md += `| ${r.fixture} | ${action} | 1 | — | ${fmtMs(s.only)} | — | — | — |\n`;
    } else if (s.count > 0) {
      md += `| ${r.fixture} | ${action} | ${s.count} | ${fmtMs(s.min)} | ${fmtMs(s.p50)} | ${fmtMs(s.p95)} | ${fmtMs(s.p99)} | ${fmtMs(s.max)} |\n`;
    }
  }
}
if (serverPerf?.routes?.length) {
  md += `\n## Server-side perf snapshot (top 10 by p95)\n\n`;
  md += `| Route | n | min | p50 | p95 | p99 | max | errors |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|---:|\n`;
  for (const r of serverPerf.routes.slice(0, 10)) {
    md += `| \`${r.route}\` | ${r.count} | ${fmtMs(r.min)} | ${fmtMs(r.p50)} | ${fmtMs(r.p95)} | ${fmtMs(r.p99)} | ${fmtMs(r.max)} | ${r.errors} |\n`;
  }
}
writeFileSync(mdPath, md);

console.log(`\nResults written to:\n  ${jsonPath}\n  ${mdPath}\n`);
