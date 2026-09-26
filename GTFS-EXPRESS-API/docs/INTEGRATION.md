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

# Compile → a new session with its report (design, validation, audit, requirements)
curl -sS -H "Content-Type: application/json" -d '{"spec": …, "options": {"place":"Vendôme, France"}}' $BASE/network/compile
curl -sS -H "X-Session-ID: $SID" $BASE/network/report
```

The planner (`POST /network/plan`, Server-Sent Events) turns a brief into a spec through the same tools; it is gated like the assistant (beta code or free trial).

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

# Apply it as ONE undoable edit (edit mode), or take it back
curl -sS -H "X-Session-ID: $SID" -H "Content-Type: application/json" -d '{"previewId":"…"}' $BASE/transform/commit
curl -sS -X POST -H "X-Session-ID: $SID" $BASE/edit/undo

# The change for other tools (GTFS Diff v1 CSV / v2 draft JSON), and what riders must be told
# (GTFS-RT service alerts as JSON or protobuf, a notice in French or English)
curl -sS -H "X-Session-ID: $SID" $BASE/transform/preview/$PREVIEW/gtfs-diff/csv
curl -sS -H "X-Session-ID: $SID" "$BASE/transform/preview/$PREVIEW/alerts?language=fr&cause=CONSTRUCTION&format=pb" > alerts.pb

# Other operators' timetables to align connections on (kept only where they call near the network)
curl -sS -H "X-Session-ID: $SID" -H "Content-Type: application/json" -d '{"url":"https://…/ter-gtfs.zip","name":"TER"}' $BASE/transform/references
curl -sS -H "X-Session-ID: $SID" "$BASE/transform/references/$REF/departures?stop=Albi%20Ville&towards=Toulouse&dates=2027-01-05&from=06:30&to=09:00"
```

The change planner (`POST /transform/plan`, Server-Sent Events) turns a brief — text or attached documents — into a plan with the same tools, previews it, fixes its own mistakes and asks the user what only they can decide. A network designed from scratch in the Network Studio is changed the same way once compiled. Level-1 evaluation on real briefs: `eval/transform/run.mjs` (ten service-change notices on the real Albi feed, each with an oracle measured on the resulting GTFS).

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

## 4. Passenger documents

```bash
curl -sS -H "X-Session-ID: $SID" "$BASE/documents/timetable?route_id=A&date=20260112&lang=fr" > line-A.html
curl -sS -H "X-Session-ID: $SID" "$BASE/documents/stop?stop_id=gare&lang=fr" > stop-gare.html
```

Print-ready HTML (A4 landscape, matrix or hour/minutes grid), in the 8 languages of the application.

## 5. GTFS-Realtime

```bash
# Check a realtime feed against the loaded static feed (protobuf, JSON mapping, or a URL)
curl -sS -X POST -H "X-Session-ID: $SID" -H "Content-Type: application/x-protobuf" --data-binary @trip-updates.pb $BASE/realtime/validate
curl -sS -X POST -H "X-Session-ID: $SID" -H "Content-Type: application/json" -d '{"url":"https://…/vehicle-positions.pb"}' $BASE/realtime/validate
# { "ok": false, "summary": {…}, "counts": { "error": 2, "warning": 1 }, "findings": [{ "code": "unknown_trip", … }] }
```

## 6. Export

```bash
curl -sS -H "X-Session-ID: $SID" -o edited.zip $BASE/edit/export
```

## Self-hosting notes

- The territory dossier uses public instances (Nominatim, Overpass, Wikidata, Nager.Date, OpenHolidays, Open-Meteo) with fair-use limits; set `NOMINATIM_URL`, `OVERPASS_URL`, … to your own instances for production volumes. Road routing: `OSRM_URL`; geocoding: `GEOCODER_URL`.
- Shares live under `SHARES_DIR` (default beside the uploads) for `SHARE_TTL_DAYS` (default 90).
- The Mobility Database catalog URL is `MOBILITY_CATALOG_URL`.
- Every public data source is attributed in the UI; OpenStreetMap data is ODbL.
