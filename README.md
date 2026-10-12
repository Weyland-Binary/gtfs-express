<div align="center">

# GTFS Express

### Make a transit network evolve from its brief.

Upload a GTFS feed, give it the service-change brief, review the objectives the brief states and the change the engine proposes line by line, check it with the official **MobilityData Canonical Validator**, and deliver a new version. Reading is free; every modification runs under a licence.

**[▶ Try it live → gtfsexpress.com](https://gtfsexpress.com)**

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![MobilityData Canonical Validator](https://img.shields.io/badge/validator-MobilityData%20v8.0.0-1565C0.svg)](https://gtfs-validator.mobilitydata.org/)
[![Languages](https://img.shields.io/badge/i18n-8%20languages-success.svg)](#the-rest-of-the-product)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

### Why GTFS Express

- 📄 **The brief is the input.** A service-change notice, a spreadsheet of departures, a scanned timetable, a tender document: the brief's objectives are extracted, quoted and kept as the requirements the change is measured against.
- ⚙️ **The engine does the change, not the model.** The assistant writes a plan of typed, sourced operations (39 deterministic operators: headways, spans, trips, extensions, cut-backs, detours, stops, calendars, holidays, lines, running times, connections, fares, vehicle blocks, row-level edits); the engine simulates it on a copy and says what really changes. A missing or ambiguous parameter becomes a question, never a guess; what the engine settles by itself is recorded as an assumption a named person accepts.
- 🛡️ **Never a wrong GTFS presented as right.** The verdict shown is the engine's measure of the brief's objectives, not the assistant's prose (the sentences of the prose that contradict it are struck through). A delivery is gated on the server: the canonical validator must answer and find no new error, and a failing or unmeasurable objective, an unverified quote or a pending assumption is delivered only under an acknowledgement by name, kept with the version.
- ✅ **The official verdict.** Validation by the MobilityData Canonical Validator (Java JAR v8.0.0, embedded): 178 rules catalogued, the same verdict the GTFS ecosystem trusts.

Target users: transit authorities, operators and their consultants (AO, DSP, BET), method and data teams.

---

## The modification journey

Home asks « Quel réseau voulez-vous faire évoluer ? » — a town search over the open-data feeds or a GTFS drop opens a modify project in four steps:

1. **Réseau et documents** — the feed, its diagnostic, and the brief: text, or documents attached (Word, OpenDocument, spreadsheets, PDF, scanned PDF read by OCR, CSV, plain mails). Spreadsheets are read cell by cell, never retyped.
2. **Objectifs** — the contract: the brief's objectives as the extractor reads them, each with its quote checked against the brief, the sentences no objective covers flagged. The person decides it under their name; the assistant may propose corrections, never apply them.
3. **Changement** — the change builds itself (the engine's own answers recorded as assumptions), or with the assistant in a conversation, or by hand with the editors. The middle of the screen is what the draft changes, line by line; each line opens the project's reader full width on « Avant | Après » at that line and date, through a read-only lens on the draft. The same working copy, one reader: the source feed, the simulated draft and the applied version stay visibly distinct.
4. **Livraison** — controls (the validator, integrity, consumer checks, impact in km, hours, vehicles and cost, network quality before → after), then the version vN applied as one undoable edit, with the delivery package and a printable note (objectives met, assumptions accepted, validation, sources).

On the API, a planner turn can read the brief twice (`readings: 2`): when the two readings do different things to the feed, each divergence is asked as a question, A or B, before anything is delivered.

---

## Reliability, measured

The engine and the assistant are evaluated on a corpus of simulated briefs with **oracles**: for each brief, hand-written checks read the GTFS the assistant produced and say what holds, independently of the assistant; **mutants** (deliberately wrong plans) must be rejected, so the oracle itself is tested. The briefs come in strata — synthetic, real operators' notices, fictive spreadsheets, uploaded files in their real formats, and *roundtrip* cases reconstructed from two dated versions of a public feed, where the right answer is what the operator actually put in service.

- Level 0 runs for free: the oracles on the reference plans, the recorded plans replayed on the current engine, the silent-failure rate (a wrong feed delivered without a refusal).
- Level 1 calls the real model: every campaign is recorded with its cost.
- A frozen test set is never tuned on.


---

## The rest of the product

- **Reader**: map (Leaflet, MapLibre on demand), routes, shapes and timetables, « Avant | Après » on a draft; free, no account.
- **Editor**: schedule grid (PrimeReact), map shape editor with drag handles, full edit mode on every GTFS file (32 tables: Schedule, Fares V1/V2, Flex) with undo/redo, and the SQL console (read-only statements run out of process; batches that change data run inside the edit's transaction, undoable).
- **Broken-feed rescue**: invalid feeds still load; duplicate primary keys are dropped at import and announced; orphan rows land editable; every delivery (export, NeTEx, share, change) stays gated by the canonical engine, with the verdict in the `X-GTFS-Validation` header.
- **AI repair companion**: a chat grounded in the session (findings, schema, real identifiers) that drafts repair SQL, previews the exact rows, applies through the same transactional pipeline and re-validates; one-shot NL2SQL in the console.
- **Network Studio**: a brief or a territory becomes a network spec — stops, lines with their variants, services, running times, school calendars from the official holidays, costs — routed, scored (coverage, service level, fleet, cost, accessibility, conformance clause by clause) and compiled into a validated GTFS. A brief that modifies the running network opens the Change Studio instead.
- **Demand & optimisation** (estimates): ridership from public data (INSEE grid, SIRENE jobs, schools, home–work and home–school flows) and the user's own counts, always with its uncertainty; frequencies and contrasted scenarios proposed, never applied on their own.
- **Passenger information & interop**: GTFS-RT service alerts and a notice generated from what a plan changes; GTFS Diff; other operators' timetables as read-only references; NeTEx France export ([gtfs2netexfr](https://github.com/hove-io/transit_model), the engine behind transport.data.gouv.fr); `.gtfsproj` snapshots.
- **Legal pages and accessibility**: `/conditions` (legal notice, terms of use, the licence's terms of sale, privacy: every figure from the server, the operator's notice from its configuration), `/accessibilite` (the statement, with its known non-conformities), `/regles` (the 178 rules).
- **Admin dashboard** (`ADMIN_TOKEN`): usage, sessions, accounts and licences.
- **8 languages**: EN, FR, ES, DE, PT, ZH, AR, HI.

---

## Accounts and the licence

Reading is free, without an account. Every modification (edit mode, SQL writes, the repair companion's fixes, the Change Studio, the Network Studio, project import) needs an account whose licence runs:

| How | What |
|---|---|
| **Free trial** | `TRIAL_DAYS` (default 14), once per mailbox, no throwaway address; everything can be tried but the modified network never leaves during the trial |
| **Online subscription** | yearly or monthly, through Stripe Checkout (the price shown, `LICENCE_PRICE_EUR_YEAR` / `LICENCE_PRICE_EUR_MONTH`, is indicative: the payment provider's price is what is charged) |
| **Quote** | the administrator grants a licence until a date (`X-Admin-Token`, or the dashboard) |
| **The operator's own addresses** | `ADMIN_EMAILS`, unlimited |

Accounts sign in with a six-digit code sent by e-mail (`MAIL_PROVIDER`; no password), then hold a cookie session (`gtfs_session`, HttpOnly, 30 days sliding), in their own SQLite file (`<PROJECTS_DIR>/projects.db`), never in the feed sessions. With `PAID_ACCESS_ENABLED` off (the default), everything is open. The AI's cost is bounded per account and per server (`services/aiCostLimiter.js`): no AI without an account under the paid offer, a daily cap for trials, a share of the budget for unpaid use. API flow: [`GTFS-EXPRESS-API/docs/INTEGRATION.md`](GTFS-EXPRESS-API/docs/INTEGRATION.md#7-accounts-and-access-levels); operations: [DEPLOYMENT.md](DEPLOYMENT.md#user-accounts-accounts_enabled).

---

## Quickstart

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose v2
- A GTFS ZIP file to upload, or use the built-in sample feed

### Development

```bash
git clone https://github.com/Weyland-Binary/gtfs-express.git
cd gtfs-express

# Copy and fill environment variables
cp GTFS-EXPRESS-API/.env.example GTFS-EXPRESS-API/.env

# Start the dev stack: the frontend image embeds Nginx serving the React build on :80,
# and the API runs on :3004. There is no separate Nginx service.
docker compose up --build
```

Open [http://localhost](http://localhost).

### Production

For the full guided procedure (VPS hardening, DNS, env vars, post-deploy verification, rollback), see **[DEPLOYMENT.md](DEPLOYMENT.md)**; `deploy/staging/` is a staging kit run on the server behind an SSH tunnel.

Quick form, assuming a working `.env.production.local`:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production.local up -d --build
```

Caddy handles TLS automatically via Let's Encrypt. The API image embeds a Java 17 runtime + the MobilityData GTFS validator JAR — no separate Java install needed on the host. Without the JAR, a dev server answers 503 on delivery and production refuses to start.

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

Copy `GTFS-EXPRESS-API/.env.example` to `.env`. The full annotated reference is [`.env.production.example`](.env.production.example); the ones that decide what the server is:

| Variable | Required | Description |
|---|---|---|
| `DOMAIN` | Yes (prod) | Public domain name for Caddy + CORS — without protocol or trailing slash. |
| `ALLOWED_ORIGINS` | Yes | Comma-separated list of allowed CORS origins. |
| `ADMIN_TOKEN` | Yes | Secret token for the admin dashboard. **Must** be distinct from `IP_HASH_SECRET`. |
| `IP_HASH_SECRET` | Yes (prod) | HMAC secret for the hashed addresses, sign-in codes and e-mails in the logs (≥32 random hex chars). The API aborts at startup in production if missing or left at the default. |
| `CLIENT_TOKEN_SECRET` | Yes (prod) | HMAC secret the browser tokens that own the projects kept without an account are stored under. Rotating it orphans every anonymous project; without it in production the projects are not kept (503 `WORKSPACE_DISABLED`). |
| `STATS_USER`, `STATS_HASH` | Yes (prod) | HTTP Basic Auth for the `/stats/` GoAccess dashboard (`caddy hash-password`; double every `$`). |
| `ANTHROPIC_API_KEY`, `LLM_PROVIDER` | No | The model: the direct API, or `bedrock` / `vertex` for processing in the EU ([DEPLOYMENT.md § 9](DEPLOYMENT.md#9-model-provider)). Every request goes through the personal-data scrub (`services/llm/personalData.js`). |
| `TRANSFORM_PLANNER_MODEL`, `NETWORK_PLANNER_MODEL` | No | The Change Studio planner (default `claude-sonnet-5-5`) and the Network Studio planner (default `claude-opus-5-5`). |
| `NL2SQL_CHAT_ENABLED`, `NL2SQL_CHAT_MODEL`, `NL2SQL_MODEL` | No | The repair companion (default off in prod; chat model `claude-sonnet-4-6`, one-shot model `claude-haiku-4-5`). |
| `NL2SQL_DAILY_BUDGET_TOTAL`, `NL2SQL_DAILY_BUDGET_UNPAID`, `TRIAL_AI_DAILY_LIMIT` | No | The AI's cost: the server's daily ceiling (never raised per account), the share unpaid use may take, a trial's daily requests. |
| `ACCOUNTS_ENABLED`, `MAIL_PROVIDER` | No | Accounts signed in by a code sent by e-mail: `brevo` (with `MAIL_API_KEY`, `MAIL_FROM`), `log` (the default outside production) or `memory` (tests). |
| `PAID_ACCESS_ENABLED`, `TRIAL_DAYS`, `ADMIN_EMAILS` | No | The paid offer ([Accounts and the licence](#accounts-and-the-licence)). |
| `LICENCE_PRICE_EUR_YEAR`, `LICENCE_PRICE_EUR_MONTH`, `STRIPE_PRICE_PRO_MONTHLY` | No | The prices shown and the monthly plan's Stripe price; without a Stripe price the monthly offer is shown, not sold. |
| `LEGAL_PUBLISHER`, `LEGAL_HOST`, `LEGAL_*` | No (prod) | The operator's legal notice on `/conditions`, never in the code; empty, the page says the operator did not fill it. `SOURCE_CODE_URL`: where the source of the version in service is offered (AGPL §13). |
| `PROJECTS_DIR` | No | Directory of `projects.db` (accounts and projects) and of the projects' files. |
| `MAX_SESSIONS`, `TRUST_PROXY_HOPS`, `LOG_RETENTION_DAYS` | No | Sessions in memory at once (hard ceiling), proxies trusted for the client's address, days the JSONL logs keep a line. |
| `DEMAND_PROVIDERS_ENABLED` | No | `false`: the demand tools use the OpenStreetMap dossier and the user's data only, no public API called. |
| `BASEMAP_PROVIDER`, `MAPTILER_KEY`, `CARTO_API_KEY` | No (build) | The map's tiles; without a key, OpenFreeMap. |
| `NETEX_ENABLED` | No (build arg) | Default `true`: the image builds the gtfs2netexfr converter (~10 min on the first build). |
| `MAINTENANCE` | No | `true`: Caddy serves a maintenance page (HTTP 503) on every route. |

A new variable must be passed in both compose files or allowlisted (`deployEnvCoverage.test.js`).

---

## Architecture

```
GTFS Express/
  GTFS-EXPRESS-API/              # Backend: Express 4, better-sqlite3, Node 24; docs/openapi.yaml matches every route
  GTFS-EXPRESS-WEB/              # Frontend: React 18, Vite 7, MUI v5, PrimeReact, Leaflet / MapLibre
  deploy/staging/                # Staging kit (docker compose behind an SSH tunnel)
  scripts/                       # i18n checks
  docker-compose.yml             # Dev stack (frontend image with embedded Nginx + API)
  docker-compose.prod.yml        # Prod stack (Caddy + frontend + API + GoAccess)
  Caddyfile                      # Prod reverse proxy + automatic TLS
```

Each uploaded feed is a SQLite database created at upload time, the single source of truth of every read and write; accounts and projects live in their own file. No database server.


---

## License

GTFS Express is dual-licensed:

- **[AGPL-3.0](LICENSE)**: free for any use that complies with its terms, commercial use included; whoever lets users interact with a modified version over a network must offer them its source (§13).
- **[Commercial License](COMMERCIAL_LICENSE.md)**: for organizations that cannot comply with AGPL-3.0 (internal deployment without source disclosure, SaaS, proprietary integration).

For a commercial license quote: **weylandbinary@gmail.com**

### Third-party software

The Docker images embed the official MobilityData GTFS validator (Apache License 2.0) and OpenJDK 17 (GPL-2.0 with Classpath Exception). Notices, copyright preservation and the full Apache 2.0 license text are in **[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)**. The real feeds used as test fixtures are redistributed under their own open licences, with attribution (`GTFS-EXPRESS-API/src/__tests__/fixtures/real/README.md`).

---

## Contributing

Contributions are welcome under the AGPL-3.0 terms. By submitting a pull request, you agree that your contribution may also be included in future commercial releases under a CLA with Weyland Binary ([CLA.md](CLA.md)).

Please open an issue before starting work on a large feature.

---

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

---

## GTFS disclaimer

GTFS Express is an independent tool. It is not affiliated with Google, MobilityData, or any transit authority. "GTFS" is a trademark of Google LLC.

---

*© 2026 [Weyland Binary](https://weylandbinary.com). All rights reserved.*
