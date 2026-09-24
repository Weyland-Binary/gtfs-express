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
