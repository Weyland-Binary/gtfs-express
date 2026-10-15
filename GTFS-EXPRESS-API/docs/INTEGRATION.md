# GTFS Express — integration guide

Everything the application does is an HTTP call on the API. This page lists the calls an integrator, a script or another agent needs to validate, repair, design, publish and check GTFS feeds without the UI. The full contract is the OpenAPI document at `GTFS-EXPRESS-API/docs/openapi.yaml` (served at `/api-docs` when the server runs).

Base URL below: `https://your-host/gtfs`. A session is a loaded feed; its id travels in the `X-Session-ID` header. Sessions are ephemeral (hours); shares live 90 days.

## 1. Load and validate a feed

```bash
# Upload a GTFS zip → a session id and the validation report
curl -sS -F "gtfsZip=@feed.zip" $BASE/upload
# Response: { "sessionId": "…", "validationReport": { "valid": true, "counts": { "errors": 0, "warnings": 3, "infos": 5 }, … } }

# The semantic Diagnostic (speeds, duplicates, shapes, calendars, colours…)
curl -sS -H "X-Session-ID: $SID" $BASE/quality_audit
```

## 2. Design a network from a specification

The Network Spec is a small JSON document (agency, stops, lines with directions and services, holidays, an optional `sync` hub and an `operations` block). The server validates it, routes it along roads, builds the timetable and compiles the GTFS.

```bash
# Validate (issues, blockers, an estimate of the feed)
curl -sS -H "Content-Type: application/json" -d @spec.json $BASE/network/validate

# The territory dossier of a place (public data: OpenStreetMap, Wikidata, holidays, population grid)
curl -sS -H "Content-Type: application/json" -d '{"place":"Vendôme, France"}' $BASE/network/territory

# The design quality report: coverage of generators and residents, spacing, directness,
# service level, connectivity, plausibility, compliance, operations (fleet, cost), accessibility
curl -sS -H "Content-Type: application/json" -d '{"spec": …, "place":"Vendôme, France"}' $BASE/network/evaluate

# Snap and densify the stops with the existing ones
curl -sS -H "Content-Type: application/json" -d '{"spec": …, "place":"Vendôme, France"}' $BASE/network/refine

# The existing public feeds covering the place (Mobility Database), and one as a spec
curl -sS "$BASE/network/catalog?place=Vend%C3%B4me%2C%20France"
curl -sS -H "Content-Type: application/json" -d '{"url":"https://…/gtfs.zip","place":"Vendôme, France"}' $BASE/network/catalog/import

# Compile → a new session with its report (design, validation, audit, requirements, gate). A delivery:
# with options.requirements, a must clause the built timetable fails or cannot measure is refused
# (409 CLAUSES_FAILING / CLAUSES_UNKNOWN { clauses, unacknowledged }) unless a named person acknowledges it,
# the canonical validator must answer (503 VALIDATOR_UNAVAILABLE / VALIDATOR_FAILED) and find no error
# (409 VALIDATION_ERRORS); nothing of a refused build survives
curl -sS -H "Content-Type: application/json" -d '{"spec": …, "options": {"place":"Vendôme, France", "requirements": …},
     "acknowledge": {"by": {"name": "Jean Dupont"}, "clauses": ["A_peak"], "note": "peak headway negotiated"}}' $BASE/network/compile
curl -sS -H "X-Session-ID: $SID" $BASE/network/report   # report.gate: { conformance (the verdict), validation, acknowledgement }
```

A spec can describe a real network, not a sketch: `lines[].variants` (short-turns, branches, deviations in one direction, run by `services[].variant`), running times by time of day (`running_time_profile` for the network's road lines, `lines[].speed_profile` for one line), school-term and school-holiday calendars (`{ "period": "school_days", "region": "C", "days": [...] }`: the dates come from the official school holidays and public holidays, never guessed — a missing zone where zones differ blocks the spec), calendars with their own dates (`include_dates` / `exclude_dates`), and operating costs (`cost_per_vehicle_year`, `deadhead_pct`, `reserve_pct`, `commercial_km_contract`). The compile reports each dated calendar (`calendars`), the estimate each variant's routed length and running time by band, and the road legs over twice the straight distance (`suspicious_legs`).

The planner (`POST /network/plan`, Server-Sent Events) turns a brief into a spec through the same tools; it is gated like the assistant (the licence, or the free messages). When the brief modifies the network that already runs, the planner does not redraw it: it finds the current public feed and hands over (`handoff` event) to the Change Studio, which changes the real feed. The brief's clauses are merged server-side (the model may add or refine a clause, never drop a must clause, never waive one, never lower a must to should; a clause the user decided is kept whole). Each turn ends with a `verdict` event — the engine's verdict, recomputed from the conformance results and emitted apart from the model's prose, with the sentences of the prose that contradict it — then `done` with `ready` (false while a must clause fails or cannot be measured, or while the server has no validator: `not_ready_reasons[].code` `clause_failed`, `clause_unknown`, `validator_unavailable`) and `acknowledgeable`, the clauses a named person may accept at compile time.

## 2b. Change an existing network (the transformation engine)

A service change — a contract amendment, a works notice, next term's timetable — is a **change plan**: typed operations from a catalogue (frequency, span, trips added or withdrawn, extensions, cut-backs, detours, stops, calendars and holidays, lines created, merged or split, running times, connections, fares, vehicle blocks…), each with its scope (from a date, a period, school days, public holidays) and the words of the brief it implements. The engine applies them deterministically on a copy, never guesses (a missing or ambiguous parameter is a question), and shows what really changes before anything is written.

```bash
# The catalogue (types, parameters, examples)
curl -sS -H "X-Session-ID: $SID" $BASE/transform/operations

# The feed's health on one yardstick: quality (planners' thresholds), fewest vehicles, consumer checks
curl -sS -H "X-Session-ID: $SID" $BASE/transform/quality

# Preview a plan: steps (applied / blocked with questions / failed), rows changed, the semantic diff,
# integrity, consumer checks, impact (km, hours, cost, fleet, stops losing service), quality before → after,
# conformance to the brief's clauses, the passenger alerts, phase timings. Nothing is written.
curl -sS -H "X-Session-ID: $SID" -H "Content-Type: application/json" -d '{"plan": {
  "title": "Avenant n°1 art. 3",
  "operations": [{ "id": "op1", "type": "set_headway",
    "params": { "route": "C", "days": "weekday", "period": "school_days", "region": "C",
                "from_date": "2026-11-02", "from": "07:00", "to": "09:00", "headway_min": 10 },
    "source": { "quote": "à compter du 2 novembre, un bus toutes les 10 minutes entre 7h et 9h" } }],
  "requirements": { "clauses": [{ "id": "c1", "kind": "headway_max", "params": { "line": "C", "day": "weekday", "from": "07:00", "to": "09:00", "minutes": 10 } }] }
}}' $BASE/transform/preview

# Apply it as ONE undoable edit (edit mode), or take it back. A delivery: the canonical validator runs on
# both sides of the plan (503 when it cannot answer, 409 VALIDATION_NEW_ERRORS on a new error, no override)
curl -sS -H "X-Session-ID: $SID" -H "Content-Type: application/json" -d '{"previewId":"…"}' $BASE/transform/commit
# What the gate lists (preview.gate.acknowledgeable) is applied only under a named acknowledgement
curl -sS -H "X-Session-ID: $SID" -H "Content-Type: application/json" -d '{"previewId":"…",
  "acknowledge": {"by": {"name": "Jean Dupont"}, "clauses": ["c1"], "sources": true, "assumptions": ["a1"], "note": "…"}}' $BASE/transform/commit
# → { ok, editId, description, tables, validation: { status: "passed", engine, before, after, new_errors: [] },
#     acknowledgement: { id, by: { name, user_id }, at, scope: "commit", clauses, items, note } | null }
curl -sS -X POST -H "X-Session-ID: $SID" $BASE/edit/undo

# The change for other tools (GTFS Diff v1 CSV / v2 draft JSON), and what riders must be told
# (GTFS-RT service alerts as JSON or protobuf, a notice in French or English)
curl -sS -H "X-Session-ID: $SID" $BASE/transform/preview/$PREVIEW/gtfs-diff/csv
curl -sS -H "X-Session-ID: $SID" "$BASE/transform/preview/$PREVIEW/alerts?language=fr&cause=CONSTRUCTION&format=pb" > alerts.pb

# Other operators' timetables to align connections on (kept only where they call near the network)
curl -sS -H "X-Session-ID: $SID" -H "Content-Type: application/json" -d '{"url":"https://…/ter-gtfs.zip","name":"TER"}' $BASE/transform/references
curl -sS -H "X-Session-ID: $SID" "$BASE/transform/references/$REF/departures?stop=Albi%20Ville&towards=Toulouse&dates=2027-01-05&from=06:30&to=09:00"
```

The commit is a delivery, gated on the server whatever the client, as `preview.gate` announces. It is refused while a step is blocked, while the feed changed since the preview, and while the plan breaks the feed's integrity (no override). The canonical validator then runs on the feed as the plan would leave it and on the feed as it is (when the preview did not run it with `validate: true`): a validator that is missing, unverified or crashed refuses (`503 VALIDATOR_UNAVAILABLE` / `VALIDATOR_FAILED`), and a new error refuses (`409 VALIDATION_NEW_ERRORS { new_errors: [{ code, before, after }], preexisting }`) with no override — `acknowledge.validation` is ignored, not refused. What the brief does not get is applied only under a NAMED acknowledgement, `acknowledge: { by: { name }, clauses: [ids], sources: true, assumptions: [ids], note }` (the signed-in account's display name is the default name; `400 ACKNOWLEDGEMENT_UNNAMED` when nobody is named): a `must` clause failing or not measurable (`409 CLAUSES_FAILING` / `CLAUSES_UNKNOWN { clauses, unacknowledged }`), an operation whose quote could not be verified (`409 SOURCES_UNVERIFIED { operations: [{ id, reason }] }`), an assumption of the plan (`409 ASSUMPTIONS_UNVALIDATED { assumptions, unacknowledged }`, ids `a1…an`). The record — who, what, when on the server's clock — is written in the same transaction as the edit (the `_acknowledgements` table next to the edit log, never exported) and returned as `acknowledgement`; the response's `validation.status` is always `passed`. Every operation's `source.quote` is checked against the brief, the chat and the attached text documents (`quote_verified`, `quote_reason`); operations proposed by the optimiser say so (`source.generated_by: "optimizer"`) and cite nothing, so they are acknowledged as sources; an operation the user wrote or edited (`source.author: "user"`) is their own answer and is never gated.

The change planner (`POST /transform/plan`, Server-Sent Events) turns a brief — text or attached documents — into a plan with the same tools, previews it, fixes its own mistakes and asks the user what only they can decide. The brief's requirements are merged server-side (the model may add or refine a clause, never drop, waive or downgrade one) and an operation without a quote is refused to the model. Each turn ends with a `verdict` event — the engine's verdict, emitted apart from the model's prose, with the sentences of the prose that contradict it — then `done { ready, blocked, previewId, asked, planChanged, gate, failingClauses, unknownClauses, pendingAssumptions, verdict }`, where `ready` is the gate's word (a plan that needs an acknowledgement, or a server without the validator, is never ready). A network designed from scratch in the Network Studio is changed the same way once compiled. With `readings: 2` the brief is read twice when the first reading builds a plan and asks nothing: the two readings are compared on what they do to the feed and each divergence is asked as a question (A or B) with the alternative plan in a `readings` event. Evaluation: `eval/transform/run.mjs` runs the real planner on a corpus of briefs in their real formats (synthetic, operators' notices, spreadsheets, uploaded files, changes reconstructed from two dated versions of a public feed), each with an oracle measured on the resulting GTFS and mutants the oracle must reject; the recorded campaigns and their cost are in `eval/results/` (`eval/README.md`).

### An operator's offer sheet (deterministic, no model)

An offer order often arrives as a spreadsheet — per line, direction and day type, the first and last departures and the headway by time band, or a full timetable. `POST /spreadsheet/parse` reads it cell by cell (xlsx, xlsm, xls, ods, csv) and answers the typed model (every value with its sheet and cell, every cell it could not read listed with its reason), the contract clauses it states (each citing its cell, quoting its text) and one `build_timetable` operation per line, direction and day type. Nothing is stored and the feed is not written; with `X-Session-ID` the sheet's destinations are matched to the working copy's directions (needed by `span`, `headway_max` and a `trips_count` without a destination, never guessed from « Aller » or « Sens 1 »). What gives no clause is said in `not_converted` with its cell and text (a band without service, a count nobody can tie to a direction…), and the day types that give no operation in `operations_skipped`.

```bash
curl -sS -H "X-Session-ID: $SID" -F "file=@offre.xlsx" -F "lang=fr" $BASE/spreadsheet/parse
# → { model: { lines: [{ line, direction, destination, origin, day_types: [{ day_type, period, bands, first, last, trips, timetable? }] }],
#               unread: [{ sheet, cell, reason }] }, clauses: [...], not_converted: [...], operations: [{ type: "build_timetable", params, incomplete? }],
#    operations_skipped: [{ label, reason }] }
```

`build_timetable` builds exactly the trips the order states on the line's existing stop patterns, in place of the direction's trips on the scope's dates. It asks for everything the order does not say — the stop pattern when the direction runs several, the running times (`running_times: "existing"`: each trip runs like the pattern's trip nearest in time; not asked when a timetable gives a time at every stop), the dates the direction runs nothing on (`new_dates: add | skip`), the direction's other patterns (`others: replace | keep`), a departure no band holds (`gaps: band_start`), a timetable trip whose every stop pattern calls at a stop it marks "pass" (« | »: `pass_stops: serve`). A stop marked "pass" is never given a time; a band without service never gets a departure. `eval/tools/spreadsheet-check.mjs` runs the parser on spreadsheets kept outside the repository and prints only aggregates.

### The coherence report: a service-méthode sheet, and rows that become clauses

`GET /network/coherence` (the session's feed) and `GET /transform/preview/{id}/coherence` (a simulated change, before → after) read, per line × direction × day type (× period), the first and last departure, the headway at peak and off-peak, the trips, the patterns and the running time, and the anomalies first. The same report, WHOLE, comes as an operator's service-méthode sheet the server renders from the same data: `….xlsx` (the anomalies and the header on the first sheet, then one sheet per day type and period, lines × directions in rows) and `….pdf`. The header names the network and the version (`network`, `version`, `version_at` query labels, printed as they are), the date, the canonical validator's engine and the SHA-256 of its report, and the version's fingerprint (`report.version.fingerprint`).

Each row carries a `key`. `POST …/coherence/clauses { report: { fingerprint }, rows: [{ key, measures? }], by: { name }, contract? }` turns the rows a person ticks into clauses of the contract — departure_at for the first and last departures, span, headway_max per band, trips_count, running_time, and unchanged_except for `keep` (« garder cette ligne telle quelle ») — built by the server from the report IT computes on the version (never from a figure the client sends), dated with the row's dates that run the same timetable, decided by the named person, each measured on that version before it is returned, and merged into `contract` with the step-3 rules. Each clause says where it comes from in `source` and `origin` (`{ kind: "coherence_row", key, fingerprint, version, date, figures }`), never in `quote` (the brief's words). The contract must be decided, assumed or empty: a draft answers 409 `CONTRACT_UNDECIDED` (decide it at step ② first — a draft's clauses are measured by nobody). `journey: "create"` (a network designed here, whose next build measures the design with no feed before it) refuses `keep` row by row (`keep_not_measurable`). A row of another version — any edit of what the rows show, an intermediate stop time or a headsign included — answers 409 `COHERENCE_STALE`, an unknown key 400 `COHERENCE_ROW_UNKNOWN`, a contract over 60 clauses 409 `TOO_MANY_CLAUSES`. The next preview with that contract measures the change against them.

```bash
curl -sS -H "X-Session-ID: $SID" "$BASE/network/coherence.xlsx?network=Valmont&version=v1" -o fiche.xlsx
FP=$(curl -sS -H "X-Session-ID: $SID" "$BASE/network/coherence" | jq -r .version.fingerprint)
KEY=$(curl -sS -H "X-Session-ID: $SID" "$BASE/network/coherence" | jq -r '.rows[0].key')
curl -sS -H "X-Session-ID: $SID" -H "Content-Type: application/json" \
  -d "{\"report\":{\"fingerprint\":\"$FP\"},\"rows\":[{\"key\":\"$KEY\",\"measures\":[\"first\",\"last\",\"keep\"]}],\"by\":{\"name\":\"Camille Durand\"}}" \
  "$BASE/network/coherence/clauses"
# → { clauses: [...], refused: [{ key, measure, reason }], rows, added, kept, contract, measured, version }
```

## 2c. Estimate ridership and optimise (estimates, never counts)

The demand model estimates trips from the territory — residents (INSEE 200 m grid when installed, else commune populations), jobs (SIRENE size bands), pupils (Éducation nationale), home–work and home–study flows (INSEE MOBPRO / MOBSCO when installed) — and from the user's own data (counts per stop or per line, OD tables, places), then chooses the mode and assigns the trips on the timetable. Every figure comes with `calibrated` and `uncertainty` (±50 % uncalibrated, ±20–30 % calibrated on counts, wider with a stop-based population proxy).

```bash
# The user's own data (CSV, XLSX, ODS, GeoJSON, JSON; French or English headers), kept two hours
curl -sS -F "file=@comptages.csv" $BASE/network/demand/data          # → { id, kind, rows, warnings }

# A designed network: the territory's demand and the spec's estimated ridership and KPIs
curl -sS -H "Content-Type: application/json" -d '{"place":"Albi, France","spec": …,"dataIds":["…"]}' $BASE/network/demand

# Its frequencies optimised (ridership | balanced | cost) under caps, the brief's clauses kept passing
curl -sS -H "Content-Type: application/json" -d '{"place":"Albi, France","spec": …,"objective":"ridership","constraints":{"max_vehicles":12}}' $BASE/network/optimize

# Three contrasted networks for the territory (trunk, coverage, balanced), compared, with their Pareto front
curl -sS -H "Content-Type: application/json" -d '{"place":"Albi, France","requirements": …}' $BASE/network/scenarios

# The loaded feed's ridership — or, with a preview id, the feed a previewed plan would produce
curl -sS -H "X-Session-ID: $SID" -H "Content-Type: application/json" -d '{}' $BASE/transform/demand
curl -sS -H "X-Session-ID: $SID" -H "Content-Type: application/json" -d '{"previewId":"…"}' $BASE/transform/demand

# Optimised frequencies of the loaded feed, as a change plan of set_headway proposals (previewed, never committed)
curl -sS -H "X-Session-ID: $SID" -H "Content-Type: application/json" -d '{"objective":"cost","constraints":{"max_vehicles":20}}' $BASE/transform/optimize
```

Both planners use the same model through their tools (`estimate_demand`, `optimize_service`, `generate_scenarios` in the Network Studio; `estimate_ridership`, `propose_optimization` in the Change Studio) and pass the user's data with `dataIds`. These endpoints have their own hourly budget (`RATE_LIMIT_MAX_DEMAND`) and run a few at a time per process (`DEMAND_MAX_CONCURRENT`; `429 BUSY` with `Retry-After` when the queue is full).

## 3. Publish

```bash
# A public read-only share of the session's feed (edited state included) → token + secret
curl -sS -X POST -H "X-Session-ID: $SID" -H "Content-Type: application/json" -d '{"title":"Réseau 2026"}' $BASE/share
# { "token": "…", "secret": "…", "card": { counts, validation, audit, design, versions } }

# Public: the card, the visitor's own copy, the feed itself (a stable URL journey planners can poll)
curl -sS $BASE/share/$TOKEN
curl -sS -X POST $BASE/share/$TOKEN/open
curl -sSO $BASE/share/$TOKEN/gtfs.zip           # latest;  ?v=2 for a given version

# A new version of the same link, with a changelog (needs the secret)
curl -sS -X POST -H "X-Session-ID: $SID" -H "X-Share-Secret: $SECRET" -H "Content-Type: application/json" \
     -d '{"note":"Line 3 extended to the hospital"}' $BASE/share/$TOKEN/versions
```

A share and each of its versions are deliveries: the snapshot goes through the canonical validator before it exists (`503 VALIDATOR_UNAVAILABLE` / `VALIDATOR_FAILED` when it cannot answer; `409 VALIDATION_NEW_ERRORS { new_errors, preexisting }` on errors above the session's baseline — the report of the feed as loaded —, `409 VALIDATION_ERRORS { errors, warnings, by_rule }` on any error when the session has none; nothing is published on a refusal; `429 BUSY` with `Retry-After` behind the compute gate). The card's `validation` is the report of that snapshot, never a stored report of an older state: `{ errors, warnings, infos, valid, engine, preexisting_errors, new_errors: [] }`. For a feed built by the Network Studio the card's `gate` carries the build's verdict, validation and acknowledgement, without the person's name.

## 4. Passenger documents

```bash
curl -sS -H "X-Session-ID: $SID" "$BASE/documents/timetable?route_id=A&date=20260112&lang=fr" > line-A.html
curl -sS -H "X-Session-ID: $SID" "$BASE/documents/stop?stop_id=gare&lang=fr" > stop-gare.html
```

Print-ready HTML (A4 landscape, matrix or hour/minutes grid), in the 7 languages of the application.

## 5. GTFS-Realtime

```bash
# Check a realtime feed against the loaded static feed (protobuf, JSON mapping, or a URL)
curl -sS -X POST -H "X-Session-ID: $SID" -H "Content-Type: application/x-protobuf" --data-binary @trip-updates.pb $BASE/realtime/validate
curl -sS -X POST -H "X-Session-ID: $SID" -H "Content-Type: application/json" -d '{"url":"https://…/vehicle-positions.pb"}' $BASE/realtime/validate
# { "ok": false, "summary": {…}, "counts": { "error": 2, "warning": 1 }, "findings": [{ "code": "unknown_trip", … }] }
```

## 6. Export

```bash
curl -sS -D headers.txt -H "X-Session-ID: $SID" -o edited.zip $BASE/edit/export
# headers.txt may carry: X-GTFS-Validation: preexisting-errors=3  (errors the uploaded feed already had)
```

The export is a delivery. The canonical validator runs before anything streams — `503 VALIDATOR_UNAVAILABLE` / `VALIDATOR_FAILED` when it cannot answer, in every environment — and the feed is compared with the session's baseline, the verified report of the feed as loaded: `422 VALIDATION_NEW_ERRORS { new_errors, preexisting, errorCount, warningCount, infoCount, report }` on errors above it, `422 VALIDATION_ERRORS { errors, warnings, by_rule, …, report }` on any error when the session has no baseline. There is no bypass: `?force=true` answers `400 INVALID_INPUT` and is audited. Pre-existing errors of the baseline are delivered announced in the `X-GTFS-Validation: preexisting-errors=<n>` header.

## 6b. What is guaranteed on every delivery

Deterministic server code, proved by the level-0 suites under `src/__tests__/guarantees/` (each with the wrong inputs it must reject), holds on every path that delivers a GTFS — `POST /transform/commit`, `GET /edit/export`, `POST /share`, `POST /share/:token/versions`, `POST /network/compile` and a project version's package (`POST /workspace/projects/:id/versions/:vid/package`) — whatever the client or the model says:

| Guarantee | On the API |
|---|---|
| No delivery without a verified report of the canonical validator | `503 VALIDATOR_UNAVAILABLE { reason: not_installed \| unverified }`, `503 VALIDATOR_FAILED { validator_error }`; nothing written or streamed; no environment lets an unvalidated feed through; no `?force` |
| 0 new error for a modification, 0 error for a creation | the report of the feed as loaded is the baseline (written once per feed); `VALIDATION_NEW_ERRORS { new_errors, preexisting }` (409; 422 on the exports) above it, `VALIDATION_ERRORS { errors, warnings, by_rule }` for a creation or without a baseline; never acknowledgeable; pre-existing errors announced (`X-GTFS-Validation` header, `preexisting_errors` on a card, `preexisting` on a deliverable) |
| Every element traces to its source | an operation whose quote is not verified, and every assumption of the plan, are applied only under a named acknowledgement (`SOURCES_UNVERIFIED`, `ASSUMPTIONS_UNVALIDATED`); the model cannot produce an operation without a quote |
| The verdict is the server's | the `verdict` SSE event and `done.verdict`, recomputed from the conformance results; a sentence of the model contradicting it is flagged (`prose.spans`), measured, never relied upon |
| A must clause failing or not measurable is delivered only under a NAMED acknowledgement | `409 CLAUSES_FAILING` / `CLAUSES_UNKNOWN { clauses, unacknowledged }`, `400 ACKNOWLEDGEMENT_UNNAMED`; the record `{ id, by: { name, user_id }, at, scope, clauses, items, note }` is written with the delivery (edit log, network report `gate`, project review and version); no automatic acknowledgement anywhere; the brief's clauses are merged server-side, the model cannot delete or waive one |
| Nothing changes outside the perimeter without appearing in the change list | the preview's `changes` and `lines` are computed from what the plan really wrote (every written table is diffed), and the commit replays exactly that changeset |

Measurement is not delivery: `POST /transform/preview` replays the plan on an in-memory copy — no validator, no acknowledgement — and always return the failing and unknown clause ids. Every refusal answers `{ error: <code>, message, ...details }`.

## 7. Accounts and the licence

Behind `ACCOUNTS_ENABLED` (off by default: every `/auth/*` and `/admin/users*` call then answers `503 { "error": "ACCOUNTS_DISABLED" }` and nothing else changes). Reading a feed is free and needs no account. Under the paid offer (`PAID_ACCESS_ENABLED=true`) every modification needs the **licence**; without it (the open model, the default) everything is open.

| Level | What it opens | How it is obtained |
|---|---|---|
| **Read** | upload, validate, explore, compare, shares, the coherence report | free, no account |
| **Modify** (the licence: `edit` and `studio`) | edit mode, SQL mutations, the assistant's fixes, the Change Studio, the Network Studio, project import, `GET /edit/export` | under the paid offer: an online subscription, the administrator's grant with its end (a quote), the free trial (`TRIAL_DAYS`, once per address), or an address of `ADMIN_EMAILS` (the operator's own, no end, no per-account AI cap); open to everyone in the open model |

Signing in is a six-digit code sent by e-mail (`MAIL_PROVIDER`: `brevo`, `log` or `memory`), no password: the first verified code creates the account. The session is a cookie, `gtfs_session` (HttpOnly, SameSite=Lax, Path=/, Secure over https, 30 days sliding on use). From a script, keep it in a cookie jar (`-c` to save, `-b` to send). Code requests and checks are limited to 10 per 15 minutes per IP (`429 RATE_LIMITED`); per address, one code a minute and six an hour (`429 LOGIN_CODE_TOO_SOON { retry_after_s }`), five tries per code (`429 LOGIN_CODE_LOCKED`), ten minutes' validity (`410 LOGIN_CODE_EXPIRED`).

```bash
# Ask a code: 202 whether or not an account holds the address (no enumeration). 503 MAIL_UNAVAILABLE without a mail provider.
curl -sS -H "Content-Type: application/json" -d '{"email":"planner@example.org","language":"en"}' $BASE/auth/code
# { "sent": true, "expires_in_s": 600, "resend_after_s": 60 }

# Check it: the session cookie lands in the jar. 201 + created: true the first time (the account is created, its address verified).
curl -sS -c jar.txt -H "Content-Type: application/json" \
     -d '{"email":"planner@example.org","code":"123456","display_name":"Planner"}' $BASE/auth/code/verify
# { "user": { "id": "…", "email": "planner@example.org", "email_verified": true, "display_name": "Planner", "entitlements": [],
#             "licence": { "active": false, "source": null, "until": null, "unlimited": false, "trial_available": true, "trial_until": null },
#             "created_at": "…", "subscription": null }, "created": true }
# 401 LOGIN_CODE_INVALID { attempts_left } · 410 LOGIN_CODE_EXPIRED · 429 LOGIN_CODE_LOCKED · 403 ACCOUNT_DISABLED

# Who am I (401 NOT_SIGNED_IN without a live cookie); change the name the account's acts are signed with
curl -sS -b jar.txt $BASE/auth/me
curl -sS -b jar.txt -X PATCH -H "Content-Type: application/json" -d '{"display_name":"Planner"}' $BASE/auth/me

# Start the free trial of the licence (paid offer): 409 LICENCE_ACTIVE, 409 TRIAL_USED, 403 EMAIL_UNVERIFIED, 503 TRIAL_UNAVAILABLE
curl -sS -b jar.txt -X POST $BASE/billing/trial

# The cookie alone opens edit mode once the licence runs
curl -sS -b jar.txt -X POST -H "X-Session-ID: $SID" $BASE/edit/enter

# Sign out: 204, the cookie is cleared and the session ended server-side
curl -sS -b jar.txt -c jar.txt -X POST $BASE/auth/logout
```

Under the paid offer the guard answers before any handler, on every modifying route:

```bash
curl -sS -b jar.txt -X POST -H "X-Session-ID: $SID" $BASE/edit/enter
# anonymous          → 401 { "error": "NOT_SIGNED_IN", "entitlement": "edit", "paid": true, "message": "…" }
# no licence         → 402 { "error": "SUBSCRIPTION_REQUIRED", "entitlement": "edit", "message": "…" }
# the licence runs   → the usual response
```

The planners (`POST /network/plan`, `POST /transform/plan`) also want the `studio` entitlement whenever accounts are on (401 NOT_SIGNED_IN, 403 ENTITLEMENT_REQUIRED). The administrator grants the licence, with its end, after a quote (`POST /billing/quote` mails the operator), with the admin token (`X-Admin-Token`, see `ADMIN_TOKEN`) — or from the admin dashboard's « Accounts and licences »:

```bash
# The accounts (never a hash; adds last_login_at, disabled, granted, grant_until, trial_until)
curl -sS -H "X-Admin-Token: $ADMIN_TOKEN" $BASE/admin/users
# Grant the licence until a date (the end of that day, UTC); "until": null for no end; booleans otherwise.
# { "disabled": true } also ends the account's sessions. 404 USER_NOT_FOUND.
curl -sS -H "X-Admin-Token: $ADMIN_TOKEN" -H "Content-Type: application/json" \
     -d '{"edit": true, "studio": true, "until": "2027-10-31"}' $BASE/admin/users/$USER_ID/entitlements
# With MAIL_PROVIDER=memory (tests, end-to-end runs), the last messages, the sign-in codes among them:
curl -sS -H "X-Admin-Token: $ADMIN_TOKEN" $BASE/admin/mail/outbox
```

`GET /config/features` reports the state to a client: `features.accounts = { enabled, signedIn, entitlements }` and, under the paid offer, `access.edit` / `access.studio_access` (`ok`, `sign_in_required`, `subscription_required`, `unavailable`), `access.licence` and `access.billing` (`checkout`, `portal`, `trial_days`, `quote`, `price_eur_year`). When accounts are on the response is `Cache-Control: no-store`, since it names the caller. A browser client on another origin must send `credentials: "include"` on every call: the API answers `Access-Control-Allow-Credentials: true` only for the origins in `ALLOWED_ORIGINS`, and only when accounts are on.

## Self-hosting notes

- User accounts: `ACCOUNTS_ENABLED=true` (default `false`). They live in their own SQLite file, `<PROJECTS_DIR>/projects.db` (default: a `projects` directory beside the uploads, outside the session sweeper's reach), created on the first call and never while the flag is off. Back it up: it holds the accounts, unlike the sessions. `RATE_LIMIT_MAX_AUTH` (default 10) is the budget of code requests and checks per 15 minutes per IP. Signing in needs a mail provider: `MAIL_PROVIDER=brevo` with `MAIL_API_KEY` and `MAIL_FROM` (`log` writes the message to the API's log, for development).
- The territory dossier uses public instances (Nominatim, Overpass, Wikidata, Nager.Date, OpenHolidays, Open-Meteo) with fair-use limits; set `NOMINATIM_URL`, `OVERPASS_URL`, … to your own instances for production volumes. Road routing: `OSRM_URL`; geocoding: `GEOCODER_URL`.
- Shares live under `SHARES_DIR` (default beside the uploads) for `SHARE_TTL_DAYS` (default 90).
- The Mobility Database catalog URL is `MOBILITY_CATALOG_URL`.
- Every public data source is attributed in the UI; OpenStreetMap data is ODbL.
