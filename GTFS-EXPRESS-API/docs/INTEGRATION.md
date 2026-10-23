# GTFS Express — integration guide

Everything the application does is an HTTP call on the API. This page lists the calls an integrator, a script or another agent needs to validate, repair, change, publish and check GTFS feeds without the UI. The full contract is the OpenAPI document at `GTFS-EXPRESS-API/docs/openapi.yaml` (served at `/api-docs` when the server runs).

Base URL below: `https://your-host/gtfs`. A session is a loaded feed; its id travels in the `X-Session-ID` header. Sessions are ephemeral (hours); shares live 90 days.

## 1. Load and validate a feed

```bash
# Upload a GTFS zip → a session id and the validation report
curl -sS -F "gtfsZip=@feed.zip" $BASE/upload
# Response: { "sessionId": "…", "validationReport": { "valid": true, "counts": { "errors": 0, "warnings": 3, "infos": 5 }, … } }

# The semantic Diagnostic (speeds, duplicates, shapes, calendars, colours…)
curl -sS -H "X-Session-ID: $SID" $BASE/quality_audit
```

## 2. Find and open a public feed

```bash
# The public feeds serving a place or named like a network (Mobility Database, transport.data.gouv.fr)
curl -sS "$BASE/network/catalog?place=Vend%C3%B4me%2C%20France&light=1"
# One of them opened as it is: a new session, like an upload
curl -sS -H "Content-Type: application/json" -d '{"url":"https://…/gtfs.zip","place":"Vendôme, France"}' $BASE/network/catalog/open
```

## 2b. Change an existing network (the transformation engine)

A service change — a contract amendment, a works notice, next term's timetable — is a **change plan**: typed operations from a catalogue (frequency, span, trips added or withdrawn, extensions, cut-backs, detours, stops, calendars and holidays, lines created, merged or split, running times, connections, fares, vehicle blocks…), each with its scope (from a date, a period, school days, public holidays) and the words of the brief it implements. The engine applies them deterministically on a copy, never guesses (a missing or ambiguous parameter is a question), and shows what really changes before anything is written.

```bash
# The catalogue (types, parameters, examples)
curl -sS -H "X-Session-ID: $SID" $BASE/transform/operations

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
```

The commit is a delivery, gated on the server whatever the client, as `preview.gate` announces. It is refused while a step is blocked, while the feed changed since the preview, and while the plan breaks the feed's integrity (no override). The canonical validator then runs on the feed as the plan would leave it and on the feed as it is (when the preview did not run it with `validate: true`): a validator that is missing, unverified or crashed refuses (`503 VALIDATOR_UNAVAILABLE` / `VALIDATOR_FAILED`), and a new error refuses (`409 VALIDATION_NEW_ERRORS { new_errors: [{ code, before, after }], preexisting }`) with no override — `acknowledge.validation` is ignored, not refused. What the plan does not get is applied only under a NAMED acknowledgement, `acknowledge: { by: { name }, clauses: [ids], sources: true, baseline_errors: true, changes: true, note }` (the signed-in account's display name is the default name; `400 ACKNOWLEDGEMENT_UNNAMED` when nobody is named): a `must` clause of the plan failing or not measurable (`409 CLAUSES_FAILING` / `CLAUSES_UNKNOWN { clauses, unacknowledged }`), an operation whose quote could not be verified (`409 SOURCES_UNVERIFIED { operations: [{ id, reason }] }`), the reference feed's own errors (`409 BASELINE_ERRORS`), lines or rows changed that no clause of the plan asks for (`409 CHANGES_NOT_ASKED`). A change made by hand is applied on the person's named act, `acknowledge: { by: { name }, hand: true }`, recorded with the edit. The record — who, what, when on the server's clock — is written in the same transaction as the edit (the `_acknowledgements` table next to the edit log, never exported) and returned as `acknowledgement`; the response's `validation.status` is always `passed`. Every operation's `source.quote` is checked against the brief, the chat and the attached text documents (`quote_verified`, `quote_reason`); operations proposed by the optimiser say so (`source.generated_by: "optimizer"`) and cite nothing, so they are acknowledged as sources; an operation the user wrote or edited (`source.author: "user"`) is their own answer and is never gated.

The direct mode (`POST /transform/direct`, Server-Sent Events) turns a brief — text or attached documents — into a change: an agent changes a working copy of the feed in SQL and reads the engine's facts after every write (the rows changed per table, the semantic diff, the validator's new errors), an independent reviewer on another model sees only the brief and those facts and reports each demand done, not done or unproven with its evidence, and what is not done goes back to the agent twice at most; a question only the person can answer stops the turn (`question`), and `answer` resumes it. The turn ends with `done { reason, previewId, deliverable, report, facts, validation }`; the delivery is `POST /transform/commit` with `acknowledge: { by: { name }, direct: true }`, the person's one decision over the report. Evaluation: `eval/transform/run.mjs` runs the direct mode's workflow on a corpus of briefs in their real formats (synthetic, operators' notices, spreadsheets, uploaded files, changes reconstructed from two dated versions of a public feed), each with an oracle measured on the delivered GTFS and mutants the oracle must reject; the recorded campaigns and their cost are in `eval/results/` (`eval/README.md`).

### An operator's offer sheet (deterministic, no model)

An offer order often arrives as a spreadsheet — per line, direction and day type, the first and last departures and the headway by time band, or a full timetable. Attached to a brief, it is read cell by cell without a model (xlsx, xlsm, xls, ods, csv), every value with its sheet and cell.

`build_timetable` builds exactly the trips the order states on the line's existing stop patterns, in place of the direction's trips on the scope's dates. It asks for everything the order does not say — the stop pattern when the direction runs several, the running times (`running_times: "existing"`: each trip runs like the pattern's trip nearest in time; not asked when a timetable gives a time at every stop), the dates the direction runs nothing on (`new_dates: add | skip`), the direction's other patterns (`others: replace | keep`), a departure no band holds (`gaps: band_start`), a timetable trip whose every stop pattern calls at a stop it marks "pass" (« | »: `pass_stops: serve`). A stop marked "pass" is never given a time; a band without service never gets a departure.

### The coherence report: a service-méthode sheet

`GET /network/coherence` (the session's feed) and `GET /transform/preview/{id}/coherence` (a simulated change, before → after) read, per line × direction × day type (× period), the first and last departure, the headway at peak and off-peak, the trips, the patterns and the running time, and the anomalies first. The same report, WHOLE, comes as an operator's service-méthode sheet the server renders from the same data: `….xlsx` (the anomalies and the header on the first sheet, then one sheet per day type and period, lines × directions in rows) and `….pdf`. The header names the network and the version (`network`, `version`, `version_at` query labels, printed as they are), the date, the canonical validator's engine and the SHA-256 of its report, and the version's fingerprint (`report.version.fingerprint`).

```bash
curl -sS -H "X-Session-ID: $SID" "$BASE/network/coherence.xlsx?network=Valmont&version=v1" -o fiche.xlsx
```

## 2c. Estimate ridership (estimates, never counts)

The demand model estimates trips from the territory the feed serves — residents (INSEE 200 m grid when installed, else commune populations), jobs (SIRENE size bands), pupils (Éducation nationale), home–work and home–study flows (INSEE MOBPRO / MOBSCO when installed) — then chooses the mode and assigns the trips on the timetable. Every figure comes with `calibrated` and `uncertainty` (±50 % uncalibrated, wider with a stop-based population proxy).

```bash
# The loaded feed's ridership — or, with a preview id, the feed a previewed plan would produce
curl -sS -H "X-Session-ID: $SID" -H "Content-Type: application/json" -d '{}' $BASE/transform/demand
curl -sS -H "X-Session-ID: $SID" -H "Content-Type: application/json" -d '{"previewId":"…"}' $BASE/transform/demand
```

The endpoint has its own hourly budget (`RATE_LIMIT_MAX_DEMAND`) and runs a few at a time per process (`DEMAND_MAX_CONCURRENT`; `429 BUSY` with `Retry-After` when the queue is full).

## 3. Publish

```bash
# A public read-only share of the session's feed (edited state included) → token + secret
curl -sS -X POST -H "X-Session-ID: $SID" -H "Content-Type: application/json" -d '{"title":"Réseau 2026"}' $BASE/share
# { "token": "…", "secret": "…", "card": { counts, validation, audit, versions } }

# Public: the card, the visitor's own copy, the feed itself (a stable URL journey planners can poll)
curl -sS $BASE/share/$TOKEN
curl -sS -X POST $BASE/share/$TOKEN/open
curl -sSO $BASE/share/$TOKEN/gtfs.zip           # latest;  ?v=2 for a given version

# A new version of the same link, with a changelog (needs the secret)
curl -sS -X POST -H "X-Session-ID: $SID" -H "X-Share-Secret: $SECRET" -H "Content-Type: application/json" \
     -d '{"note":"Line 3 extended to the hospital"}' $BASE/share/$TOKEN/versions
```

A share and each of its versions are deliveries: the snapshot goes through the canonical validator before it exists (`503 VALIDATOR_UNAVAILABLE` / `VALIDATOR_FAILED` when it cannot answer; `409 VALIDATION_NEW_ERRORS { new_errors, preexisting }` on errors above the session's baseline — the report of the feed as loaded —, `409 VALIDATION_ERRORS { errors, warnings, by_rule }` on any error when the session has none; nothing is published on a refusal; `429 BUSY` with `Retry-After` behind the compute gate). The card's `validation` is the report of that snapshot, never a stored report of an older state: `{ errors, warnings, infos, valid, engine, preexisting_errors, new_errors: [] }`.

## 4. Passenger documents

```bash
curl -sS -H "X-Session-ID: $SID" "$BASE/documents/timetable?route_id=A&date=20260112&lang=fr" > line-A.html
curl -sS -H "X-Session-ID: $SID" -H "Content-Type: application/json" -d '{"stop_ids":["gare"],"lang":"fr"}' "$BASE/documents/sheets" > sheets-gare.json
```

The line timetable is print-ready HTML (A4 landscape, matrix or hour/minutes grid). The stop sheets come as data over a period (`from`, `to`, the timetable periods from `GET /documents/sheets/setup`): per line and direction, one column per day type, the departures by hour with their notes, the next stops, and what to check before printing; the web app lays them out and prints them. Both in the 7 languages of the application.

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

Deterministic server code, proved by the level-0 suites under `src/__tests__/guarantees/` (each with the wrong inputs it must reject), holds on every path that delivers a GTFS — `POST /transform/commit`, `GET /edit/export`, `POST /share` and `POST /share/:token/versions` and a project version's package (`POST /workspace/projects/:id/versions/:vid/package`) — whatever the client or the model says:

| Guarantee | On the API |
|---|---|
| No delivery without a verified report of the canonical validator | `503 VALIDATOR_UNAVAILABLE { reason: not_installed \| unverified }`, `503 VALIDATOR_FAILED { validator_error }`; nothing written or streamed; no environment lets an unvalidated feed through; no `?force` |
| 0 new error, 0 error without a baseline | the report of the feed as loaded is the baseline (written once per feed); `VALIDATION_NEW_ERRORS { new_errors, preexisting }` (409; 422 on the exports) above it, `VALIDATION_ERRORS { errors, warnings, by_rule }` without a baseline; never acknowledgeable; pre-existing errors announced (`X-GTFS-Validation` header, `preexisting_errors` on a card, `preexisting` on a deliverable) |
| Every element traces to its source | with a brief, a change no demand of the reviewer's report asks for is listed as not asked, sent back to the agent and shown with the report; an operation whose quote is not verified is applied only under a named acknowledgement (`SOURCES_UNVERIFIED`); the model cannot produce an operation without a quote |
| The facts and the measures are the server's | the direct mode's `facts` (rows per table, semantic diff, the validator's new errors) and the judge's measures are computed by the engine; the verdict per demand is the independent reviewer's, which reads only the brief and those facts |
| Nothing is delivered without a NAMED decision | a change with a brief needs `acknowledge.direct` (`409 DIRECT_REPORT_UNACCEPTED`), a change by hand `acknowledge.hand`; a must clause failing or not measurable needs `acknowledge.clauses` (`409 CLAUSES_FAILING` / `CLAUSES_UNKNOWN { clauses, unacknowledged }`); `400 ACKNOWLEDGEMENT_UNNAMED`; the record `{ id, by: { name, user_id }, at, scope, clauses, items, note }` is written with the delivery (edit log, project review and version); no automatic acknowledgement anywhere |
| Nothing changes outside the perimeter without appearing in the change list | the preview's `changes` and `lines` are computed from what the plan really wrote (every written table is diffed), and the commit replays exactly that changeset |

Measurement is not delivery: `POST /transform/preview` replays the plan on an in-memory copy — no validator, no acknowledgement — and always return the failing and unknown clause ids. Every refusal answers `{ error: <code>, message, ...details }`.

## 7. Accounts and the licence

Behind `ACCOUNTS_ENABLED` (off by default: every `/auth/*` and `/admin/users*` call then answers `503 { "error": "ACCOUNTS_DISABLED" }` and nothing else changes). Reading a feed is free and needs no account. Under the paid offer (`PAID_ACCESS_ENABLED=true`) every modification needs the **licence**; without it (the open model, the default) everything is open.

| Level | What it opens | How it is obtained |
|---|---|---|
| **Read** | upload, validate, explore, compare, shares, the coherence report | free, no account |
| **Modify** (the licence: `edit` and `studio`) | edit mode, SQL mutations, the assistant's fixes, the Change Studio, project import, `GET /edit/export` | under the paid offer: an online subscription, the administrator's grant with its end (a quote), the free trial (`TRIAL_DAYS`, once per address), or an address of `ADMIN_EMAILS` (the operator's own, no end, no per-account AI cap); open to everyone in the open model |

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

The direct mode's turn that changes a network (`POST /transform/direct`) also wants the `studio` entitlement whenever accounts are on (401 NOT_SIGNED_IN, 403 ENTITLEMENT_REQUIRED). The administrator grants the licence, with its end, after a quote (`POST /billing/quote` mails the operator), with the admin token (`X-Admin-Token`, see `ADMIN_TOKEN`) — or from the admin dashboard's « Accounts and licences »:

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
