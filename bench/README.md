# Bench harness — GTFS Express

End-to-end performance harness. The goal is to **measure before optimizing**:
the bench runs a scripted user journey against a live API for each fixture
in `bench/fixtures/` and writes a timestamped report under `bench/results/`.

## What it measures

For each `bench/fixtures/*.zip`:

1. **upload** — `POST /gtfs/upload`, end-to-end time including extraction,
   migration to SQLite, and validation.
2. **switch_route** — `GET /gtfs/stops_and_times` for the busiest route
   on the busiest date, 5 iterations (cold + warm).
3. **switch_date** — same endpoint, 5 different dates within the
   calendar window.
4. **edit_cell** — `POST /edit/enter`, then `PATCH /edit/stop_times/...`
   on 5 distinct rows (small, harmless time bumps).
5. **export** — `GET /edit/export`, drains the streamed ZIP.

If `--admin-token` is provided, the harness also resets the server-side
perf stats before the run and pulls a snapshot of P50/P95/P99 per route
at the end.

## Running it

```bash
# 1. Build the small fixture (Amiens) from the bundled sample.
node bench/zip-sample.mjs

# 2. (optional) drop your own .zip files into bench/fixtures/
#     - medium.zip  — a regional feed (BreizhGo, Mulhouse, …)
#     - xl.zip      — SNCF, Eurostar, regional aggregator

# 3. Start the API (BETA_GATE_DISABLED=true so /edit/enter works)
cd GTFS-EXPRESS-API
BETA_GATE_DISABLED=true npm run dev

# 4. In another terminal, run the bench
node bench/run.mjs

# Or, with a server-perf snapshot:
node bench/run.mjs --admin-token "$ADMIN_TOKEN"

# Other flags:
#   --api http://...        target a different API (default localhost:3004)
#   --only small.zip        run a single fixture
#   --iters 10              override iteration count (default 5)
#   --verbose               print discovery details
```

## Reading the output

Two files are produced under `bench/results/<ISO timestamp>.{json,md}`.

- `*.json` — raw measurements, machine-readable, suitable for diffing
  between runs (`diff <run-before>.json <run-after>.json`).
- `*.md` — human-readable table; paste this into your commit message
  when you ship a perf optimization, alongside the React DevTools
  Profiler screenshot (see `docs/PROFILING.md`).

The `serverPerf` block (when present) reports the top routes by P95 as
seen from inside the API process, which captures DB time + JSON
serialization, things the client cannot measure.

## Conventions

- `bench/fixtures/` is gitignored except for `.gitignore`. Operator
  data stays out of the repository.
- `bench/results/` is gitignored too. Reports are local artifacts.
- The harness is **read+edit only**; it never deletes routes or trips,
  it bumps stop_times by 1 second. After each fixture it calls
  `/edit/exit` so the next iteration starts clean.

## What to do when a number regresses

1. Re-run the bench on the previous commit (`git stash` or
   `git worktree add`) to confirm the baseline.
2. Capture a React DevTools Profiler trace (see `docs/PROFILING.md`)
   on the slow action.
3. Decide: backend (look at the serverPerf snapshot first), frontend
   (Profiler), or network (DevTools waterfall).

## What it does not measure

- Concurrent users / load testing — out of scope, single-tenant only.
- Frontend bundle size or first paint — use the CRA build output.
- Memory pressure — checked manually via `node --inspect` and the
  Chrome heap profiler.
