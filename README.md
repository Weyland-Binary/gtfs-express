<div align="center">

# GTFS Express

### Read, change and deliver your GTFS network.

Open a published GTFS feed or your own and read it for free: lines, timetables, map, a diagnostic beyond the validator, an assistant that answers your questions. Change it by hand or from a brief (text, Word, PDF, spreadsheet), draw its shapes, print its stop timetable sheets, query it in SQL, and deliver a new version checked by the official **MobilityData Canonical Validator**. Every modification runs under a licence, and nothing is delivered without a person's decision.

**[▶ Try it live: gtfsexpress.com](https://gtfsexpress.com)**

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![MobilityData Canonical Validator](https://img.shields.io/badge/validator-MobilityData%20v8.0.0-1565C0.svg)](https://gtfs-validator.mobilitydata.org/)
[![Languages](https://img.shields.io/badge/i18n-7%20languages-success.svg)](#what-the-product-holds)

</div>

---

### Why GTFS Express

- 📄 **The brief is the input.** A service-change notice, a spreadsheet of departures, a tender document: the brief and its documents are read as they come (spreadsheets cell by cell, never retyped), and each demand it makes is what the change is measured against.
- ⚙️ **The model proposes, the engine states the facts, a person decides.** With a brief, an agent (a model) writes the change in SQL on a copy of the feed, never on the feed itself. After each round the engine states what changed without a model: the rows per table, the semantic diff (lines, trips, stops, times), the validator's new errors. A demand the brief leaves open becomes a question to the person, never a guess.
- 🛡️ **No wrong GTFS presented as right.** Each demand's verdict (done, not done, unproven) comes from an independent reviewer: another model that sees only the brief and the engine's facts, never the agent's account, and backs each verdict with a measure or a query. It is a model's judgement, shown as such with its evidence, and so are, with a brief, the changes nobody asked for that it lists apart. What no model decides: a delivery is gated on the server. The canonical validator must answer and find no new error, the commit replays exactly the change that was reviewed, and nothing is applied without a person's decision by name, kept with the version ([GUARANTEES.md](GTFS-EXPRESS-API/docs/GUARANTEES.md)).
- ✅ **The official verdict.** Validation by the MobilityData Canonical Validator (Java JAR v8.0.0, embedded): 178 rules catalogued, each with its page.

Target users: transit authorities, operators and their consultants, method and data teams.

---

## How a change is made

Home finds a network: a town's published feeds (the French national access point and the Mobility Database), or a GTFS file of your own. Every network can be explored for free, or modified.

A modification is a **draft**: a copy of the network, edited directly, applied as version vN or abandoned. A draft is made one of two ways.

1. **With a brief.** The brief and its documents in one field. The agent changes the copy, the engine states the facts, the reviewer measures each demand, and what is not done goes back to the agent (two correction rounds at most). The result is shown in the reader itself, on « Après », with the report beside it: the verdict, each demand with its evidence, and apart from them the changes nobody asked for. One decision applies it.
2. **By hand.** The reader full page is the editor: every table of the feed, the schedule grid, the shapes on the map. Each retouche is written in the draft at once and listed, with undo. A plan proposed by the reader's assistant joins the draft the same way.

Either way, « Appliquer en vN » compares the draft with the current version, runs the validator and asks the person's decision by name. The version is one undoable edit, and its delivery package records the decision, the validation and what changed.

The source feed, the draft and the applied version stay visibly distinct: « Avant | Après » in the reader, and the state of the work in the status bar.

---

## What the product holds

- **Reader**: map (Leaflet, MapLibre on demand), lines, shapes and timetables day by day, a diagnostic beyond the validator; free, without an account.
- **Editor**: full edit mode on every GTFS file (32 tables: Schedule, Fares V1/V2, Flex) with undo and redo, the schedule grid, a shape editor on the map, and the SQL console. Read-only statements run out of process under a time limit; a batch that changes data is first tried out of process, its rows counted, then run inside the edit's transaction and undoable.
- **The change engine**: 42 typed operations (headways, spans, trips, extensions, cut-backs, detours, stops, calendars, holidays, lines, running times, connections, fares, vehicle blocks, row-level edits) and a judge of 32 kinds of clause that measures any table the product edits.
- **Stop timetable sheets**: one sheet per stop of a line and direction, laid out like a network's own posters: the line's path with the stop marked and the running time to each stop after, a coloured band per day type (school weekdays, holiday weekdays, Saturday, Sunday and public holidays) with the hours across and the minutes under each hour, steady headways folded into « every n min », notes worked out from the calendars rather than typed (« Fridays only », « except 11 November », « terminates at … », « on booking »), the timetable periods detected where the timetable changes for good, the school holidays, a QR code per stop and the network's message. Printed one sheet a page from the browser (A4 or A3, a PDF from « Save as PDF »), in the 7 languages; on a draft, the stops whose sheet it changes are listed before it is applied.
- **Broken-feed rescue**: an invalid feed still loads; duplicate keys are dropped at import and announced; the validation report opens a fix queue that goes from finding to finding in the draft.
- **The reader's assistant**: grounded in the session (findings, schema, real identifiers), it answers questions and drafts repairs that join a draft by hand; an account without the licence gets a few questions a month.
- **Interop**: comparison of two feeds, a GTFS-Realtime feed checked against the static one.
- **Guides and rule pages**: static pages in French and English on modifying and validating a GTFS feed, and a detailed page for the rules met most often.
- **Legal pages and accessibility**: `/conditions` (legal notice, terms of use and of sale, privacy: every figure from the server, the operator's notice from its configuration), `/accessibilite` (the statement, with its known non-conformities), `/regles` (the 178 rules).
- **Operator's console** at `/admin`: accounts, licences, conversion, AI and API consumption, operations.
- **7 languages**: EN, FR, ES, DE, PT, ZH, HI.

---

## Tests and evaluation

This repository is published as one commit per release, built from a private development repository. That repository holds what is not published here:

- the test suites: the API with Jest (about 320 files), the web with Vitest (about 130 files), the journeys end to end with Playwright;
- the evaluation of the AI: a corpus of briefs, each with hand-written oracles that read the GTFS produced and say what holds, independently of the model; deliberately wrong plans the oracles must reject; real cases rebuilt from two dated versions of a public feed; every paid campaign recorded with its cost;
- the data of the client cases some of them use.

So `npm test` in this repository only says where the tests are. The checks the code relies on at run time are part of what is published: the canonical validator's gate on every delivery, the personal-data scrub of every model request, the SQL console's limits.

---

## Accounts and the licence

Reading is free, without an account, and so is looking at the stop timetable sheets (they carry a « preview » watermark). Every modification (edit mode, SQL writes, the assistant's repairs, a change with a brief, project import) and the printing of the sheets need an account whose licence runs:

| How | What |
|---|---|
| **Free trial** | `TRIAL_DAYS` (default 14), once per mailbox, no throwaway address; everything can be tried, but the modified network cannot be exported, delivered or shared during the trial (`402 TRIAL_NO_DELIVERY` on those exits; the stop sheets print with a « trial » watermark; the copy stays readable in the application and the work is kept) |
| **Online subscription** | yearly or monthly, through Stripe Checkout, at the price shown (`LICENCE_PRICE_EUR_YEAR` / `LICENCE_PRICE_EUR_MONTH`, set to the payment provider's own prices) |
| **Quote** | the operator grants a licence until a date, from its console |
| **The operator's own addresses** | `ADMIN_EMAILS`, unlimited |

Accounts sign in with a six-digit code sent by e-mail (`MAIL_PROVIDER`; no password), then hold a cookie session (`gtfs_session`, HttpOnly, 30 days sliding), in their own SQLite file (`<PROJECTS_DIR>/projects.db`), never in the feed sessions. With `PAID_ACCESS_ENABLED` off (the default), everything is open. The AI's cost is bounded per caller and per server (`services/aiCostLimiter.js`): a caller without a licensed account is counted by its hashed address, never by a header it chooses; under the paid offer there is no AI without an account, a daily cap for trials and a share of the budget for unpaid use. API flow: [`GTFS-EXPRESS-API/docs/INTEGRATION.md`](GTFS-EXPRESS-API/docs/INTEGRATION.md#7-accounts-and-access-levels); operations: [DEPLOYMENT.md](DEPLOYMENT.md#user-accounts-accounts_enabled).

---

## Quickstart

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose v2
- A GTFS ZIP file to upload, or the built-in sample feed

### Development

```bash
git clone https://github.com/Weyland-Binary/gtfs-express.git
cd gtfs-express

# Copy and fill environment variables (docker compose reads the .env at the root)
cp .env.example .env

# Start the dev stack: the frontend image embeds Nginx serving the React build on :80,
# and the API runs on :3004. There is no separate Nginx service.
docker compose up --build
```

Open [http://localhost](http://localhost).

### Production

For the full procedure (VPS hardening, DNS, environment, checks after deployment, rollback), see **[DEPLOYMENT.md](DEPLOYMENT.md)**; `deploy/staging/` is a staging kit run on the server behind an SSH tunnel.

Quick form, assuming a working `.env.production.local`:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production.local up -d --build
```

Caddy handles TLS through Let's Encrypt. The API image embeds a Java 17 runtime and the MobilityData GTFS validator JAR: no separate Java install on the host. Without the JAR, a dev server answers 503 on delivery and production refuses to start.

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
| `DOMAIN` | Yes (prod) | Public domain name for Caddy and CORS, without protocol or trailing slash. |
| `ALLOWED_ORIGINS` | Yes | Comma-separated list of allowed CORS origins. |
| `ADMIN_TOKEN` | Yes | Secret token for the operator's scripts. **Must** be distinct from `IP_HASH_SECRET`. |
| `IP_HASH_SECRET` | Yes (prod) | HMAC secret for the hashed addresses, sign-in codes and e-mails in the logs (at least 32 random hex chars). The API stops at startup in production if it is missing or left at the default. |
| `CLIENT_TOKEN_SECRET` | Yes (prod) | HMAC secret of the browser tokens that own the projects kept without an account. Rotating it orphans every anonymous project; without it in production the projects are not kept (503 `WORKSPACE_DISABLED`). |
| `STATS_USER`, `STATS_HASH` | Yes (prod) | HTTP Basic Auth for the `/stats/` GoAccess dashboard (`caddy hash-password`; double every `$`). |
| `ANTHROPIC_API_KEY`, `LLM_PROVIDER` | No | The model: the direct API, or `bedrock` / `vertex` for processing in the EU ([DEPLOYMENT.md § 9](DEPLOYMENT.md#9-model-provider)). Every request goes through the personal-data scrub (`services/llm/personalData.js`). |
| `DIRECT_AGENT_MODEL`, `DIRECT_REVIEWER_MODEL` | No | The agent that makes a change with a brief (default `claude-opus-5-5`) and its independent reviewer (default `claude-sonnet-5-5`). |
| `NL2SQL_CHAT_ENABLED`, `NL2SQL_CHAT_MODEL`, `NL2SQL_MODEL` | No | The reader's assistant (off by default; chat model `claude-sonnet-4-6`, one-shot SQL model `claude-haiku-4-5`). |
| `NL2SQL_DAILY_BUDGET_TOTAL`, `NL2SQL_DAILY_BUDGET_UNPAID`, `TRIAL_AI_DAILY_LIMIT` | No | The AI's cost: the server's daily ceiling (never raised per account), the share unpaid use may take, a trial's daily requests. |
| `ACCOUNTS_ENABLED`, `MAIL_PROVIDER` | No | Accounts signed in by a code sent by e-mail: `brevo` (with `MAIL_API_KEY`, `MAIL_FROM`), `log` (the default outside production) or `memory` (tests). |
| `PAID_ACCESS_ENABLED`, `TRIAL_DAYS`, `ADMIN_EMAILS` | No | The paid offer ([Accounts and the licence](#accounts-and-the-licence)). |
| `LICENCE_PRICE_EUR_YEAR`, `LICENCE_PRICE_EUR_MONTH`, `STRIPE_PRICE_PRO_MONTHLY` | No | The prices shown and the monthly plan's Stripe price; without a Stripe price the monthly offer is shown, not sold. |
| `LEGAL_PUBLISHER`, `LEGAL_HOST`, `LEGAL_*` | No (prod) | The operator's legal notice on `/conditions`, never in the code; empty, the page says the operator did not fill it. `SOURCE_CODE_URL`: where the source of the version in service is offered (AGPL §13). |
| `DEMAND_PROVIDERS_ENABLED` | No | The ridership estimates on official French open data; `false` keeps them to the feed's own area, no public API called. |
| `PROJECTS_DIR` | No | Directory of `projects.db` (accounts and projects) and of the projects' files. |
| `MAX_SESSIONS`, `TRUST_PROXY_HOPS`, `LOG_RETENTION_DAYS` | No | Sessions in memory at once (hard ceiling), proxies trusted for the client's address, days the JSONL logs keep a line. |
| `BASEMAP_PROVIDER`, `MAPTILER_KEY`, `CARTO_API_KEY` | No (build) | The map's tiles; without a key, OpenFreeMap. |
| `MAINTENANCE` | No | `true`: Caddy serves a maintenance page (HTTP 503) on every route. |


---

## Architecture

```
GTFS Express/
  GTFS-EXPRESS-API/              # Backend: Express 4, better-sqlite3, Node 24; docs/openapi.yaml describes every route
  GTFS-EXPRESS-WEB/              # Frontend: React 18, Vite 7, MUI v5, PrimeReact, Leaflet / MapLibre
  deploy/staging/                # Staging kit (docker compose behind an SSH tunnel)
  scripts/                       # i18n checks
  docker-compose.yml             # Dev stack (frontend image with embedded Nginx, and the API)
  docker-compose.prod.yml        # Prod stack (Caddy, frontend, API, GoAccess)
  Caddyfile                      # Prod reverse proxy and automatic TLS
```

Each uploaded feed is a SQLite database created at upload time, the single source of truth of every read and write; a draft is a second one, a copy of it. Accounts and projects live in their own file. No database server.


---

## License

GTFS Express is dual-licensed:

- **[AGPL-3.0](LICENSE)**: free for any use that complies with its terms, commercial use included; whoever lets users interact with a modified version over a network must offer them its source (§13).
- **[Commercial License](COMMERCIAL_LICENSE.md)**: for organizations that do not want the AGPL's obligations (a modified version used over a network without offering its source, a proprietary product).

For a commercial license quote: **weylandbinary@gmail.com**

### Third-party software

The Docker images embed the official MobilityData GTFS validator (Apache License 2.0) and OpenJDK 17 (GPL-2.0 with Classpath Exception). Notices, copyright preservation and the full Apache 2.0 license text are in **[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)**.

---

## Contributing

Contributions are welcome under the AGPL-3.0 terms. By submitting a pull request, you agree that your contribution may also be included in future commercial releases under a CLA with Weyland-Binary ([CLA.md](CLA.md)).

Please open an issue before starting work on a large feature.

---

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

---

## GTFS disclaimer

GTFS Express is an independent tool. It is not affiliated with Google, MobilityData, or any transit authority. "GTFS" is a trademark of Google LLC.

---

<img src="GTFS-EXPRESS-WEB/public/img/weyland-binary.svg" width="20" height="20" alt="Weyland-Binary" align="absmiddle" /> *© 2026 [Weyland-Binary](https://github.com/Weyland-Binary). All rights reserved.*
