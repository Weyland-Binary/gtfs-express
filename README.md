<div align="center">

# GTFS Express

### Excel + QGIS + DBeaver, for GTFS.

A browser-based GTFS **editor & validator** powered by the official **MobilityData Canonical Validator**. Upload a feed, see every error, fix it in place — grid · map · SQL · AI — and re-export clean GTFS. No install, no account.

**[▶ Try it live → gtfsexpress.com](https://gtfsexpress.com)**

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![MobilityData Canonical Validator](https://img.shields.io/badge/validator-MobilityData%20v8.0.0-1565C0.svg)](https://gtfs-validator.mobilitydata.org/)
[![Languages](https://img.shields.io/badge/i18n-8%20languages-success.svg)](#features)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

### Why GTFS Express

- ✅ **Validate** with the *official* MobilityData canonical engine — the same verdict the GTFS ecosystem trusts.
- ✏️ **Fix everything in-browser** — schedule grid, map shape editor, SQL console, full undo/redo. No CSV hand-editing.
- 🤖 **AI repair** drafts the fix, previews the exact rows it changes, and applies it transactionally → watch *errors 12 → 0*.

> Professional GTFS Schedule editor and validator for transit operators.

**GTFS Express** is a web application for uploading, exploring, validating, editing, and re-exporting GTFS Schedule feeds, with full conformance to the [GTFS Schedule specification](https://gtfs.org/documentation/schedule/reference/) and the [MobilityData Canonical Validator](https://gtfs-validator.mobilitydata.org/rules.html).

Target users: transit operator staff (AO, DSP, BET, SNCF/RATP-grade metadata teams).  
Positioning: think **Excel + QGIS + DBeaver, for GTFS**.

---

## Features

- **Upload & validate**: drag-and-drop GTFS ZIP, instant validation by the official MobilityData Canonical Validator (Java JAR v8.0.0, embedded in the Docker image). 178 rules catalogued, all MobilityData-aligned — a feed accepted by GTFS Express is byte-for-byte the same verdict as the validator the rest of the GTFS ecosystem trusts.
- **Broken-feed rescue**: invalid feeds still load. Exact duplicate-primary-key rows are dropped at import (kept-first, announced in the report as "fixed at import"), orphan rows land editable for repair, and only the export stays gated until the feed is clean — re-validated by the canonical engine at export time.
- **Interactive map**: stop and shape visualization with Leaflet, shape editing with drag handles.
- **Schedule grid**: high-density PrimeReact DataTable with click-to-edit cells.
- **Full edit mode**: create, update, delete stops/routes/trips/calendars/shapes/… with full undo/redo history (the UI lists the last 200 actions; the underlying log is kept in full).
- **SQL Console**: direct SQLite queries on your feed; mass edits with `UPDATE`/`INSERT`/`DELETE` + undo.
- **AI repair companion (beta)**: multi-turn chat grounded in your session (validation findings, schema, real feed identifiers). It drafts repair SQL, previews the exact impact (affected rows shown), applies through the same transactional pipeline as the SQL Console, and re-validates — nothing executes without an explicit click. Includes one-shot NL2SQL in the console. Free anonymous trial (a few messages on the economy model), then beta access code (premium model).
- **Project files**: save and reload your work as a self-contained `.gtfsproj` snapshot.
- **Re-export**: clean GTFS ZIP ready for re-import or validator submission.
- **NeTEx France export**: one-click conversion to the NeTEx France profile (FR-NETEX 2.1) via the embedded [gtfs2netexfr](https://github.com/hove-io/transit_model) converter — the same engine behind transport.data.gouv.fr. Gated by the same pre-export validation as the GTFS export.
- **Admin dashboard**: usage metrics and session controls under `/#admin`, gated by `ADMIN_TOKEN`.
- **Benchmark harness**: `bench/run.mjs` runs an end-to-end perf scenario (upload, switch route, edit cell, export) against a live API.
- **8 languages**: EN, FR, ES, DE, PT, ZH, AR, HI.

---

## Quickstart

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose v2
- A GTFS ZIP file to upload, or use the built-in sample feed

### Development

```bash
git clone https://github.com/Weyland-Binary/gtfsexpress.git
cd gtfsexpress

# Copy and fill environment variables
cp GTFS-EXPRESS-API/.env.example GTFS-EXPRESS-API/.env

# Start the dev stack: the frontend image embeds Nginx serving the React build on :80,
# and the API runs on :3004. There is no separate Nginx service.
docker compose up --build
```

Open [http://localhost](http://localhost).

### Production

For the full guided procedure (VPS hardening, DNS, env vars, post-deploy verification, rollback), see **[DEPLOYMENT.md](DEPLOYMENT.md)**.

Quick form, assuming a working `.env.production.local`:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production.local up -d --build
```

Caddy handles TLS automatically via Let's Encrypt. The API image embeds OpenJDK 17 + the MobilityData GTFS validator JAR (~118 MB total) — no separate Java install needed on the host.

### Running without Docker

```bash
# Backend
cd GTFS-EXPRESS-API
npm install
npm run dev          # port 3004

# Frontend (separate terminal)
cd GTFS-EXPRESS-WEB
npm install
npm start            # port 3000, talks to the API on :3004 via VITE_API_BASE_URL
```

In this mode only, the frontend is served by the Vite dev server on http://localhost:3000.

---

## Environment variables

Copy `GTFS-EXPRESS-API/.env.example` to `.env` and set:

| Variable | Required | Description |
|---|---|---|
| `DOMAIN` | Yes (prod) | Public domain name for Caddy + CORS — without protocol or trailing slash. |
| `ADMIN_TOKEN` | Yes | Secret token for the admin dashboard. **Must** be distinct from `IP_HASH_SECRET` (independent rotation). |
| `IP_HASH_SECRET` | Yes (prod) | HMAC secret for IP anonymization in event logs (≥32 random hex chars). The API aborts at startup in production if missing or left at the default. Must be distinct from `ADMIN_TOKEN`. |
| `STATS_USER` | Yes (prod) | HTTP Basic Auth username for the `/stats/` GoAccess dashboard. |
| `STATS_HASH` | Yes (prod) | bcrypt hash of the GoAccess password (generate via `caddy hash-password`; double every `$` in the hash because Docker Compose interpolates them). |
| `ANTHROPIC_API_KEY` | No | Enables the AI features (Claude API). Required when `NL2SQL_ENABLED=true` or `NL2SQL_CHAT_ENABLED=true`. |
| `NL2SQL_CHAT_ENABLED` | No | Set `true` to enable the AI repair companion (chat FAB, guided repair). Default `false` in prod. |
| `NL2SQL_CHAT_MODEL` | No | Chat model for coded users (default `claude-sonnet-4-6`). Anonymous free-trial turns always use the cheaper `NL2SQL_MODEL`. |
| `NL2SQL_FREE_MESSAGES_PER_SESSION` | No | Anonymous free-trial chat messages per session (default 5, `0` disables the trial). Per-IP daily cap via `NL2SQL_FREE_MESSAGES_PER_IP_DAY` (default 15). |
| `BETA_GATE_DISABLED` | No | Set `true` to bypass beta-code checks in dev. |
| `MAINTENANCE` | No | Set `true` to have Caddy serve a static maintenance page (HTTP 503) on every route; apply with `up -d caddy`. |
| `NETEX_ENABLED` | No (build arg) | Default `true`: the API image build compiles the gtfs2netexfr converter (adds ~10 min to the first build). Set `false` to skip it — the NeTEx export option is then hidden. |
| `ALLOWED_ORIGINS` | Yes | Comma-separated list of allowed CORS origins. |

The full annotated reference is in [`.env.production.example`](.env.production.example).

---

## Architecture

```
GTFS Express/
  GTFS-EXPRESS-API/              # Backend: Express 4, better-sqlite3, Node 24
  GTFS-EXPRESS-WEB/              # Frontend: React 18, MUI v5, PrimeReact, react-leaflet
  bench/                         # End-to-end performance harness
  docker-compose.yml             # Dev stack (frontend image with embedded Nginx + API)
  docker-compose.prod.yml        # Prod stack (Caddy + frontend + API + GoAccess)
  Caddyfile                      # Prod reverse proxy + automatic TLS
```

The SQLite database is created at upload time and acts as the single source of truth for all read and write operations. No persistent database server is required.

---

## License

GTFS Express is dual-licensed:

- **[AGPL-3.0](LICENSE)**: free for uses that comply with its terms (open source, academic, non-commercial).
- **[Commercial License](COMMERCIAL_LICENSE.md)**: for organizations that cannot comply with AGPL-3.0 (internal deployment without source disclosure, SaaS, proprietary integration).

For a commercial license quote: **weylandbinary@gmail.com**

### Third-party software

The Docker images embed the official MobilityData GTFS validator (Apache License 2.0) and OpenJDK 17 (GPL-2.0 with Classpath Exception). Notices, copyright preservation and the full Apache 2.0 license text are in **[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)**.

---

## Contributing

Contributions are welcome under the AGPL-3.0 terms. By submitting a pull request, you agree that your contribution may also be included in future commercial releases under a CLA with Weyland Binary.

Please open an issue before starting work on a large feature.

---

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

---

## GTFS disclaimer

GTFS Express is an independent tool. It is not affiliated with Google, MobilityData, or any transit authority. "GTFS" is a trademark of Google LLC.

---

*© 2026 [Weyland Binary](https://weylandbinary.com). All rights reserved.*
