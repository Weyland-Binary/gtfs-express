# Deployment Guide — GTFS Express

This document covers two scenarios:

1. **Local** — testing on your machine (Windows / macOS / Linux) with Docker Desktop or Docker Engine
2. **Production** — deployment on an OVH VPS (or any Linux server) with automatic HTTPS

> Last reviewed: 2026-10-01 — aligned with `docker-compose.yml`, `docker-compose.prod.yml`, `Caddyfile`, `nginx.conf`, `.env.production.example`, and the `Dockerfile`s.

---

## Deployment architecture

### Local development

```
        ┌──────────┐
        │  Nginx   │  ← React SPA + API proxy
        │   :80    │
        └────┬─────┘
             │ /api/gtfs/ → proxy_pass
             ▼
        ┌──────────┐
        │ Express  │  ← Node.js API (internal only)
        │  :3004   │
        └──────────┘
```

**2 containers**: `gtfs-frontend` + `gtfs-api`. Only the frontend exposes port 80 on the host.

### Production

```
                         Internet
                            │
                            ▼  (ports 80 / 443)
                      ┌──────────┐
                      │  Caddy   │  ← automatic Let's Encrypt TLS
                      │  :80/443 │     HSTS preload · JSON logs
                      └────┬─────┘
                           │
        ┌──────────────────┼──────────────────────────┐
        │                  │                          │
        ▼                  ▼                          ▼
   /  · /api/gtfs/*    /api/gtfs/upload-stats     /stats/*
        │              (Caddy basic_auth)         (basic_auth + WS)
        ▼                  ▼                          ▼
   ┌──────────┐       ┌──────────┐              ┌──────────┐
   │  Nginx   │       │  Nginx   │              │ GoAccess │
   │ frontend │       │ frontend │              │  :7890   │
   │  (256M)  │       │  (256M)  │              │  (128M)  │
   └────┬─────┘       └──────────┘              └──────────┘
        │  /api/gtfs/* → api:3004
        ▼
   ┌──────────┐
   │ Express  │
   │   api    │
   │  (2G)    │
   └──────────┘
```

**4 containers**: `gtfs-caddy` + `gtfs-frontend` + `gtfs-api` + `gtfs-goaccess`.
Internal Docker network `internal` is isolated — only Caddy exposes 80/443 on the host.

**Compose files**:
- `docker-compose.yml` — dev (ports exposed on the host, no HTTPS)
- `docker-compose.prod.yml` — prod (Caddy + HTTPS + GoAccess + memory limits + `no-new-privileges:true`)

---

## Environment variables

All variables are defined in `docker-compose*.yml`. Prod secrets (`DOMAIN`, `STATS_USER`, `STATS_HASH`) are passed via `--env-file .env.production.local`.

`docker-compose.prod.yml` lists the API's environment explicitly: a variable it does not pass is never seen by the API, whatever `.env.production.local` says. It passes **every** variable the API's code reads (an empty value means the code's default), except the few an allowlist names with its reason (set by the image, like `GTFS_CANONICAL_VALIDATOR_JAR`, or development and test only); `GTFS-EXPRESS-API/src/__tests__/deployEnvCoverage.test.js` fails when the code reads a variable that neither the file nor the allowlist names, and holds `deploy/staging/docker-compose.staging.yml` to the same rule. The directories the API writes to (`GTFS_UPLOAD_DIR`, `PROJECTS_DIR`, `WORKSPACE_DIR`, `SHARES_DIR`, the `beta/` files) are pinned to the volumes' mount points in that file, not overridable from the env file: a directory outside a volume is lost at the next rebuild.

| Variable | Dev (compose) | Prod (compose) | Role |
|---|---|---|---|
| `NODE_ENV` | `production` | `production` | Node.js env |
| `PORT` | `3004` | `3004` | API internal port |
| `ALLOWED_ORIGINS` | `http://localhost:80` | `https://${DOMAIN}` | CORS allow-list (CSV supported) |
| `RATE_LIMIT_WINDOW_MS` | `3600000` (1h) | `3600000` | Global rate limiter window |
| `RATE_LIMIT_MAX_REQUESTS` | `1000` | `500` | Max requests / IP / window |
| `RATE_LIMIT_MAX_UPLOADS` | `20` | `10` | Max uploads / IP / window |
| `RATE_LIMIT_SAMPLE_WINDOW_MS` | default 900000 | `900000` (15 min) | Sample-loading rate limiter window |
| `RATE_LIMIT_MAX_SAMPLES` | default 5 | `5` | Demo GTFS loads / IP / window |
| `SESSION_CLEANUP_AGE_MS` | `7200000` (2h) | `3600000` (1h) | Session TTL before RAM + DB purge |
| `MAX_SESSIONS` | `50` | `20` | Max concurrent in-RAM sessions |
| `DOMAIN` | — | required | Public domain (e.g. `gtfs.example.com`) |
| `STATS_USER` | — | required | basic_auth login for `/stats/` and `/api/gtfs/upload-stats` |
| `STATS_HASH` | — | required | bcrypt hash of the password (see GoAccess section) |
| `ADMIN_TOKEN` | — | required | Admin dashboard token (≥24 chars in prod — boot guard). Distinct from `IP_HASH_SECRET`. |
| `IP_HASH_SECRET` | — | required | HMAC salt of the hashed addresses and e-mails in the audit logs, and of the sign-in codes and free-trial records the accounts store keeps (`openssl rand -hex 32`). API exits at boot in prod when missing/default. Rotating it forgets which addresses already had their free trial. |
| `CLIENT_TOKEN_SECRET` | — | required | HMAC secret of the browser tokens that own the projects kept without an account (`openssl rand -hex 32`). Distinct from `ADMIN_TOKEN` and `IP_HASH_SECRET`; never rotate it with them (every anonymous project would be orphaned). Missing in prod: the workspace answers 503 `WORKSPACE_DISABLED`. |
| `ANTHROPIC_API_KEY` | — | optional | Key of the direct API (`LLM_PROVIDER` empty or `anthropic`). Without the selected provider's settings every AI surface is hidden/disabled. |
| `LLM_PROVIDER` | empty (`anthropic`) | empty, or `bedrock` / `vertex` for EU processing | Where the model runs: the direct API (default), Amazon Bedrock or Google Vertex AI. An unknown value stops the API at boot in prod. See [Model provider](#9-model-provider). |
| `LLM_AWS_REGION` | — | required with `bedrock` | Bedrock region, no default: `eu-west-3` (Paris), `eu-central-1` (Frankfurt). Credentials: the AWS default chain. |
| `LLM_VERTEX_PROJECT_ID` / `LLM_VERTEX_REGION` | — / `eu` | required with `vertex` / default `eu` | Google Cloud project and Vertex AI region (`eu` = the EU multi-region). Credentials: Google application default credentials. |
| `NL2SQL_ENABLED` | `true` | `true` | One-shot NL2SQL kill switch. |
| `NL2SQL_CHAT_ENABLED` | `false` | `false` → set `true` | AI repair companion (chat FAB + guided repair). |
| `NL2SQL_CHAT_MODEL` | default `claude-sonnet-4-6` | same | Chat model of the full assistant (an account whose licence runs, or everyone in the open model); the paid offer's free messages without a licence use `NL2SQL_MODEL` (Haiku). |
| `NL2SQL_FREE_MESSAGES_PER_SESSION` | default 0 | same | Under the paid offer, the assistant's free messages per browser session without a licence: none by default (the SQL console's AI answers `402`, and so does the chat when the reading companion is off; the free trial is the way to try the assistant). Set above 0, a daily per-IP cap `NL2SQL_FREE_MESSAGES_PER_IP_DAY` (15) applies and they draw on `NL2SQL_DAILY_BUDGET_UNPAID`. |
| `TRIAL_AI_DAILY_LIMIT` | `30` | same (the owner's decision) | The free trial's AI requests per account and per 24 h (its hourly cap never above it). |
| `TRIAL_AI_BUDGET_EUR` | `5` | same (the owner's decision of 2026-10-12) | The free trial's whole AI envelope in euros over its days, summed from what each model call really cost (`services/llm/aiMeter.js`, kept in `projects.db`); spent, the assistant answers 402 `AI_ALLOWANCE_EXHAUSTED`. `0` turns it off. |
| `LICENCE_AI_BUDGET_EUR_MONTH` | `100` | to set against the licence's price | A licence's AI envelope in euros per calendar month (UTC); spent, 429 `AI_ALLOWANCE_EXHAUSTED` until the next month. `0` turns it off. The operator's own accounts (`ADMIN_EMAILS`) have none. |
| `READER_AI_QUESTIONS_MONTH` | `20` | same | Under the paid offer, the reading companion: the questions per calendar month (UTC) a signed-in account without the licence may ask the reader's assistant (`POST /gtfs/sql/nl2sql-chat`), with its read-only tools only and the licence's chat model; counted per account in `projects.db` (`reader_questions`), `403 FREE_QUOTA_EXHAUSTED` { scope: month } once spent; a visitor without an account gets `401 NOT_SIGNED_IN` (entitlement `reader`). `0` turns it off: the chat is then the licence's, or the free messages of `NL2SQL_FREE_MESSAGES_PER_SESSION`. Its calls draw on `NL2SQL_DAILY_BUDGET_UNPAID`. |
| `READER_AI_BUDGET_EUR_MONTH` | `3` | same | The reading companion's envelope in euros per account and per calendar month, a safety under the count (summed like the others from `ai_usage` since the month began); spent, `402 AI_ALLOWANCE_EXHAUSTED` until the next month. |
| `AI_USD_PER_EUR` | `1` | the day's rate, or keep `1` | Turns the envelopes into the dollars the model provider bills; `1`, below the usual rate, keeps an envelope from being exceeded in euros. |
| `NL2SQL_DAILY_BUDGET_UNPAID` | `100` | same (the owner's decision) | The share of `NL2SQL_DAILY_BUDGET_TOTAL` the calls nobody pays for (the trials, the free messages) may take: the rest stays the paying accounts'. `0`: no share of their own. |
| `MAINTENANCE` | — | `false` | `true` → Caddy serves a static 503 maintenance page on every route (see Maintenance mode below). |
| `NETWORK_STUDIO_ENABLED` | default `false` | `false` | The Network Studio (designing a new network from a territory). Off: its routes answer `404 NETWORK_STUDIO_DISABLED`, the workspace refuses a project of the create job and the web shows no entry; the modify journey is not affected. `true` turns it back on. |
| `NETWORK_ROUTING_ENABLED` | default `true` | same | Road routing of new line sections (Network Studio, Change Studio). `false`: straight lines × 1.3. |
| `SCHOOL_HOLIDAYS_FETCH_ENABLED` | default `true` | same | The coherence report (step ④) asks OpenHolidays (`OPENHOLIDAYS_URL`, cached a day) for the school calendar of a French network the server has no territory dossier for, to tell school weekdays from weekdays in the holidays. `false` keeps the server offline: weekdays are then one "weekday", and the report says so. |
| `OSRM_URL` | default: the public OSRM demo (car profile) | set it to your own instance | OSRM `route` endpoint. The demo is for trials only: see [Road routing for buses](#8-road-routing-for-buses). |
| `DIRECT_AGENT_MODEL` / `DIRECT_REVIEWER_MODEL` / `DIRECT_MAX_ROUNDS` | `claude-opus-5-5` (Opus 5.5) / `claude-sonnet-5-5` (Sonnet 5.5) / `16` | same | The Change Studio's direct mode, a draft with a brief: the agent that changes a working copy in SQL, the independent reviewer that measures each demand of the brief on the result (another model than the agent's, so that its reading of the brief is not the agent's own), and the agent's tool rounds in one pass. |
| `NETWORK_PLANNER_MODEL` / `NETWORK_PLANNER_EFFORT` | `claude-opus-5-5` / the model's default | same | The Network Studio's planner (a brief → a network spec) and its reading of the brief; the reasoning effort reaches the direct mode's models too (only those that accept it). |
| `PLANNER_FREE_MODEL` | empty (the economy chat model) | same, or a stronger model if the trial must convince | Model of the free-trial turns (no licence) of the direct mode's agent and the Network Studio's planner; those turns say their result is a first sketch. |
| `GEOCODER_URL` | default: the public Photon instance (komoot) | self-host Photon for production volumes | Photon-compatible geocoder for stop names. With the territory known, local candidates come first and each gives its distance. |
| `BAN_URL` / `GEOCODER_BAN_ENABLED` | `https://api-adresse.data.gouv.fr/search/` / `true` | same | In France the Base Adresse Nationale (official, keyless) completes the geocoder for addresses; `false` turns it off. |
| `DEMAND_PROVIDERS_ENABLED` | default `true` | same | Ridership estimates on official French open data (keyless public APIs below). `false`: the territory dossier's layers and the user's own data only. |
| `GEO_API_URL` / `RECHERCHE_ENTREPRISES_URL` / `EDUCATION_API_URL` | public APIs (geo.api.gouv.fr, recherche-entreprises.api.gouv.fr, data.education.gouv.fr) | same | Commune population and contours, establishments by size band (SIRENE), schools and enrolments. |
| `INSEE_GRID_DIR` | empty | optional | INSEE Filosofi 200 m population grid split per département (`GTFS-EXPRESS-API/scripts/prepare-insee-grid.js`), mounted read-only. Empty: commune populations spread over the dossier's grid. |
| `MOBPRO_FILE` / `MOBSCO_FILE` | empty | optional | INSEE home→work / home→study flow tables (CSV), mounted read-only; filtered extracts are cached in `DEMAND_CACHE_DIR` (default: the OS temp directory). |
| `RATE_LIMIT_MAX_DEMAND` / `BETA_RATE_LIMIT_MAX_DEMAND` | `120` / `1200` | same | Ridership estimates, optimisations and scenarios per IP (an account whose licence runs: per account) and window: each costs seconds of CPU and a copy of the feed. |
| `DEMAND_MAX_CONCURRENT` | `2` | `2` (raise with the CPU count) | Demand computations running at once per API process; six more wait in a queue (a minute at most), beyond that `429 BUSY` with `Retry-After`. |
| `NETWORK_ROUTING_CURB` | default `false` | `true` when every stop serves one direction | Reach each stop on the side it serves (OSRM `approaches=curb`). See [Road routing for buses](#8-road-routing-for-buses). |
| `ACCOUNTS_ENABLED` | `false` | `false` → set `true` when ready | User accounts: signing in with a six-digit code sent by e-mail (no password; see `MAIL_PROVIDER`), the licence and the administrator's grants. `false`: the `/auth/*` routes answer `503 ACCOUNTS_DISABLED`, the UI shows nothing new, no file is created. See [User accounts](#user-accounts-accounts_enabled). |
| `PAID_ACCESS_ENABLED` | `false` | `false` → `true` when the offer opens | The paid offer: reading stays free; every modification (edit mode, SQL console writes, the assistant's fixes, the Change Studio, the Network Studio, project import) needs an account whose licence runs. Needs `ACCOUNTS_ENABLED=true` and a mail provider (`MAIL_PROVIDER`): production refuses to start without them. `false` (the open model): everything is open and nothing is sold. See [The paid offer](#the-paid-offer-paid_access_enabled). |
| `ADMIN_EMAILS` | empty | the operator's own address(es) | The operator's addresses, comma-separated: once the address is verified by a sign-in code, the account holds every right, without an end and without a per-account AI cap (the server-wide budget still holds). |
| `TRIAL_DAYS` | `14` | `14` (the owner's decision) | The free trial of the licence: once per mailbox, ever (`POST /gtfs/billing/trial`; a « + » suffix and Gmail's dots count as one address, throwaway domains are refused with `403 TRIAL_EMAIL_REFUSED`). Everything can be tried, but the modified network never leaves during the trial: the exports, the delivery package, a plan's change list, share links and the SQL CSV of a copy changed under the trial answer `402 TRIAL_NO_DELIVERY` until the licence is taken (the work is kept). `0`: no trial. |
| `LICENCE_PRICE_EUR_YEAR` | `4900` | `4900` (the owner's price, 2026-10-08) | The yearly licence price, in euros excluding VAT, the offer shows (« 4 900 € HT par an ») and a quote request carries. **Indicative**: what is charged online is the payment provider's price, which must match it (`STRIPE_PRICE_PRO`). |
| `MAIL_PROVIDER` | `log` (compose) | `brevo` | How the sign-in codes and the quote requests are sent: `brevo` (Brevo's transactional HTTP API, EU), `log` (the message, code included, written to the API's log: development, the lab, staging), `memory` (kept in the process, read through `GET /gtfs/admin/mail/outbox` with the admin token: tests and e2e). Unset: `log` outside production; **nothing in production**, where signing in answers `503 MAIL_UNAVAILABLE` and, with `PAID_ACCESS_ENABLED=true`, the API refuses to start. |
| `MAIL_API_KEY` / `MAIL_FROM` | empty | the Brevo API key / a sender Brevo has verified | Required with `brevo` (with the paid offer on, production refuses to start without either). The key lives in `.env.production.local` only, never in the repository or a log. |
| `MAIL_FROM_NAME` | `GTFS Express` | same | The sender's name on the messages. |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | empty | the live keys, in `.env.production.local` only | The secret key creates Checkout and Customer Portal sessions server side; the webhook secret verifies every event sent to `/api/gtfs/billing/webhook`. Never in the repository, never in a log. |
| `LICENCE_PRICE_EUR_MONTH` | `590` | `590` (the owner's decision, 2026-10-08) | The same licence billed by the month, in euros excluding VAT: without commitment, paid online only (no quote). Shown beside the yearly price; sold only when `STRIPE_PRICE_PRO_MONTHLY` (with the secret key) or `STRIPE_CHECKOUT_URL_PRO_MONTHLY` is set. |
| `STRIPE_PRICE_PRO_MONTHLY` / `STRIPE_CHECKOUT_URL_PRO_MONTHLY` | empty | the monthly price's id (`price_…`) | The licence's monthly recurring price (equal to `LICENCE_PRICE_EUR_MONTH`), or its payment link without the secret key. `POST /gtfs/billing/checkout { plan: "pro", period: "month" }` answers `503 BILLING_UNAVAILABLE` without it. |
| `STRIPE_PRICE_PRO` / `STRIPE_PRICE_TEAM` | empty | the licence's price id (`price_…`) in `STRIPE_PRICE_PRO` | `STRIPE_PRICE_PRO`: the licence's price, recurring yearly, equal to `LICENCE_PRICE_EUR_YEAR` (4 900 € HT); under the paid offer Checkout sells only it. `STRIPE_PRICE_TEAM` only recognises an older subscription's events. The open model sells nothing and shows the same one price. |
| `BILLING_RETURN_URL` | the request's allowed `Origin` | `https://$DOMAIN` | Where the payment provider sends the person back (`?billing=` success, cancel or portal). |
| `PROJECTS_DIR` | `/app/projects` | `/app/projects`, pinned (volume `projects_data`) | Directory of `projects.db`, the accounts' own SQLite file (WAL, `_meta.schema_version`), and of the studio projects (`p/`). Outside the uploads: the session sweeper never touches it. To back up. |
| `WORKSPACE_DIR` | `<PROJECTS_DIR>/workspace` | `/app/projects/workspace`, pinned (volume `projects_data`) | The workspace: `workspace.db` and, per project, its frozen version zips, documents and delivery packages (24 h). To back up. |
| `CLIENT_TOKEN_SECRET` / `WORKSPACE_ENABLED` | fixed dev value / on | required / on | See `CLIENT_TOKEN_SECRET` above: without it the workspace is off in production (`503 WORKSPACE_DISABLED`). `WORKSPACE_ENABLED=false` keeps the projects in the browser only. |
| `PROJECTS_RETENTION_DAYS` / `ACCOUNT_PROJECTS_RETENTION_DAYS` | `30` / `365` | same (the owner's decision) | Days a project is kept after its last write, without and with an account; enforced by the workspace's daily purge and announced on screen and in the terms from these same values. |
| `WORKSPACE_MAX_PROJECTS` / `WORKSPACE_MAX_VERSIONS` / `WORKSPACE_MAX_VERSION_BYTES` | `50` / `10` / `209715200` (200 MB) | same | Caps of a browser's workspace without an account (projects per browser token; versions and their bytes per project — the oldest version neither the reference nor delivered goes first). |
| `SNAPSHOT_EDITS` / `SNAPSHOT_IDLE_MINUTES` / `WORKSPACE_RATE_LIMIT_MAX` | `20` / `10` / `300` | same | A working copy is frozen as a version after that many edits or idle minutes; the workspace's writes per IP and window. |
| `SHARES_DIR` / `SHARE_TTL_DAYS` | beside the uploads / `90` | `/app/shares`, pinned (volume `shares_data`) / `90` | The public shares (read-only snapshots behind a token) and their lifetime, swept every 6 hours. To back up. |
| `SUPPORT_EMAIL` / `REQUEST_ACCESS_URL` | empty | the owner's address | Where a person asks for an access: `REQUEST_ACCESS_URL` (a `mailto:` or `https:` URL) when set, else `mailto:<SUPPORT_EMAIL>`, else the web shows no "request access" link. A quote request (`POST /gtfs/billing/quote`) is mailed to `PLAN_CONTACT_EMAIL`, else `SUPPORT_EMAIL` (`503 QUOTE_UNAVAILABLE` without either, or without a mail provider). |
| `MODEL_PROVIDER_NAME` | empty | the processor's name | The model provider the web names before a document is sent to the assistant, and the privacy page names as a processor; empty: the web says "the assistant", the privacy page names the provider `LLM_PROVIDER` selects. |
| `LEGAL_PUBLISHER` / `LEGAL_STATUS` / `LEGAL_ADDRESS` / `LEGAL_REGISTRATION` / `LEGAL_VAT` / `LEGAL_DIRECTOR` / `LEGAL_EMAIL` / `LEGAL_PHONE` / `LEGAL_HOST` | empty | the publisher's and the host's facts, **before the offer opens** | The legal notice the page `/conditions` shows (LCEN art. 6-III): the publisher's name, legal form and capital, registered office, RCS or SIREN, VAT number, the publication's director, e-mail (default `SUPPORT_EMAIL`) and phone, and the host's name, address and phone on one line. Never in the code (it is public). Unset: the page says the operator has not given it (`legal.missing` in `GET /gtfs/config/features`). |
| `SOURCE_CODE_URL` | the public repository | same, or the fork this server runs | Where the source of the running version is offered (AGPL §13), linked from the legal notice; https only. |
| `TRUST_PROXY_HOPS` | `1` | `2` (the stack's own two proxies) — check it on the server | How many proxies the API trusts along `X-Forwarded-For` for the client's address (per-IP rate limits, hashed addresses in the logs). See [Client addresses behind the proxies](#client-addresses-behind-the-proxies-trust_proxy_hops). |
| `LOG_RETENTION_DAYS` | `365` | `365` (the owner's decision) | Days the API's JSONL logs keep a line (events, uploads, AI use, and the retired access codes' use log until it ages out), swept daily; `0` keeps everything. See [Logs](#logs). |
| `NL2SQL_DAILY_BUDGET_TOTAL` / `BETA_NL2SQL_DAILY_LIMIT_PER_CODE` | `500` / `200` | same (the owner's decision) | The server-wide AI requests per 24 h and one licensed account's own (the `BETA_*` variables keep the names of the retired codes). The first is checked before the second: see [AI budget and per-account quotas](#ai-budget-and-per-account-quotas). |
| `AI_TURN_MAX_WEIGHTED_TOKENS` | `1000000` | same (the owner's decision) | What one turn of a model (the direct mode's agent and reviewer together, the Network Studio's planner) may spend, in input-token equivalents (an output token counts five, a cache write 1.25, a cache read 0.1: the price ratios of every model generation). Past it the turn gets one closing call without tools and ends incomplete, never ready. The default is about 2 USD on Sonnet 5.5 and 4 USD on Opus 5.5; a usual turn spends 80 000 to 300 000. `0` turns the ceiling off. See [AI budget and per-account quotas](#ai-budget-and-per-account-quotas). |
| `PDF_OCR_ENABLED` / `PDF_OCR_MAX_PAGES` | `true` / `20` | same | A PDF brief without a text layer (a scan) is read by OCR at ingestion (`services/network/pdfTextWorker.mjs`: tesseract.js, French and English, the language data in `GTFS-EXPRESS-API/tessdata/`, nothing fetched), so its quotes can be checked and its sentences measured like a text layer's; the model still receives the PDF itself. About a second a page, in the ingestion's child process; the pages past the bound keep their empty text. `false` or `0` turns it off. |
| `GTFS_VALIDATOR_JAVA_XMX` / `GTFS_VALIDATOR_MAX_CONCURRENT` | `512m` / computed | same | The heap of each validator JVM (a Java size: `512m`, `1g`; a national feed may need `1g`), and how many run at once: by default what the container's memory leaves beside the API's heap and a 256 MB margin, one at least, two at most (`[validator] memory budget` in the api logs at the first validation); set the second to force it (1 to 4). See [Memory budget](#memory-budget). |
| `RATE_LIMIT_MAX_AUTH` | default 10 | same | Sign-in code requests and checks per IP per 15 min window (`429` beyond). Besides, an address gets one code a minute and six an hour; a code allows five tries and is valid ten minutes. |

> Prod configuration is more restrictive: fewer uploads/h, fewer in-RAM sessions, shorter TTL. These are the defaults in `docker-compose.prod.yml`.

---

## 1. Local deployment (Windows / macOS / Linux)

### Install Docker

1. Download [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows / macOS) or install `docker-ce` + `docker-compose-plugin` (Linux)
2. Start the Docker engine

### Launch

```powershell
cd <path-to-project>
docker compose up -d --build
```

First build: 2-3 minutes (pulling images, `npm ci`, React build). Subsequent builds are near-instant (Docker cache).

### Verification

```powershell
docker compose ps
# → gtfs-frontend   Up (healthy)   0.0.0.0:80->80/tcp
# → gtfs-api        Up (healthy)   3004/tcp (internal)
```

Open **http://localhost** → the application is ready.

### Useful commands

| Action | Command |
|---|---|
| Real-time logs | `docker compose logs -f` |
| Logs for one service | `docker compose logs -f api` |
| Stop | `docker compose down` |
| Stop + remove uploads | `docker compose down -v` |
| Rebuild after change | `docker compose up -d --build` |

### Development without Docker (hot-reload)

```powershell
# Terminal 1 — API
cd GTFS-EXPRESS-API
copy .env.example .env
npm install
npm run dev                  # → http://localhost:3004

# Terminal 2 — Frontend
cd GTFS-EXPRESS-WEB
npm install
npm start                    # → http://localhost:3000 (proxies /gtfs → :3004)
```

> **Deliveries need the canonical validator.** The Change Studio's commit, the GTFS export, the share (creation and new versions), the Network Studio's build and a version's package all run the MobilityData validator and refuse with `503 VALIDATOR_UNAVAILABLE` when it is not installed; previews and measurement keep working. The Docker images ship it (and the API refuses to boot in production without it). Outside Docker, point `GTFS_CANONICAL_VALIDATOR_JAR` at the JAR (and `JAVA_BIN` at `java` when it is not on the PATH), as described in [`GTFS-EXPRESS-API/CANONICAL_VALIDATOR_INTEGRATION.md`](GTFS-EXPRESS-API/CANONICAL_VALIDATOR_INTEGRATION.md#operational-toggles).

---

## 2. Production deployment (OVH VPS / Linux server)

### Step 1 — Order a VPS

| Resource | Minimum viable | Recommended | Comfortable |
|-----------|----------------|------------|-------------|
| OS | Ubuntu 22.04 / Debian 12 | Ubuntu 24.04 / Debian 13 | Ubuntu 24.04 LTS |
| RAM | **4 GB** | **6 GB** | **8 GB** |
| CPU | 2 vCores | 2 vCores | 4 vCores |
| Disk | 30 GB SSD | 40 GB SSD | 80 GB SSD |

> **Sizing warning**: the sum of memory limits across the 4 containers = **2.64 GB** (api 2G + frontend 256M + caddy 256M + goaccess 128M). A 2 GB RAM VPS will trigger OOM-kills on the first large GTFS session (a national network can occupy 200-500 MB/session in RAM). Plan for at least 4 GB + swap.

> **Memory budget** <a id="memory-budget"></a>: inside the api container's 2 GB live the API's own heap (`--max-old-space-size=1800` in `GTFS-EXPRESS-API/Dockerfile`) and the validator JVMs it spawns, one per validation. Each JVM gets an explicit heap (`GTFS_VALIDATOR_JAVA_XMX`, 512 MB; without it the JVM would take a quarter of the container, whatever the API needs), and the API runs as many at once as the container leaves beside its heap and a 256 MB margin, at most two: with 2 GB that is one at a time (1 800 + 256 + 512 = 2 568 MB > 2 048); two need 3 080 MB, so a 3.5 GB limit. Raise the container's limit when the validations of two people must not wait for each other; the API says its decision at the first validation (`[validator] memory budget …` in `gtfs logs api`).

Retrieve the server IP and the root password from the OVH email.

### Step 2 — Connect to the server

```bash
# From PowerShell or any SSH terminal
ssh root@<SERVER_IP>
```

### Step 3 — Harden the server

```bash
# Update the system
apt update && apt upgrade -y

# Create a dedicated user (do not work as root)
adduser deploy
usermod -aG sudo deploy

# Set up SSH key authentication (recommended)
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys

# Disable password login for root
sed -i 's/^PermitRootLogin yes/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/^#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart sshd

# Configure the firewall
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status

# (Optional but strongly recommended): fail2ban
apt install -y fail2ban
systemctl enable --now fail2ban
```

> From this point on, reconnect as the `deploy` user:
>
> ```bash
> ssh deploy@<SERVER_IP>
> ```

### Step 4 — Install Docker

```bash
# Install prerequisites
sudo apt install -y ca-certificates curl gnupg

# Add the official Docker repository (auto-detects Ubuntu or Debian)
DISTRO=$(. /etc/os-release && echo "$ID")
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/$DISTRO/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/$DISTRO $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker + Compose
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Allow the deploy user to run Docker
sudo usermod -aG docker deploy

# Reconnect to apply group membership
exit
ssh deploy@<SERVER_IP>

# Verify
docker --version
docker compose version
```

### Step 5 — Configure the DNS domain

At your registrar (OVH, Cloudflare, etc.), create an A record:

| Type | Name | Value | TTL |
|------|-----|--------|-----|
| A | gtfs.your-domain.com | `<SERVER_IP>` | 3600 |

> Wait for DNS propagation:
>
> ```bash
> dig gtfs.your-domain.com +short
> # → must return your server IP
> ```

### Step 6 — Configure secrets

**Generate the stats-password hash** (required for GoAccess and `/api/gtfs/upload-stats`):

```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext YOUR_PASSWORD
# → $2a$14$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234
```

**Clone the project and prepare `.env.production.local`**:

```bash
git clone <REPO_URL> /opt/gtfs-express
cd /opt/gtfs-express

cp .env.production.example .env.production.local
nano .env.production.local
```

Minimal example:

```env
DOMAIN=gtfs.your-domain.com

STATS_USER=admin
# ⚠️ Double every $ in the hash (Docker Compose v2 interpolates $ in --env-file files)
STATS_HASH=$$2a$$14$$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234

# Three distinct secrets, `openssl rand -hex 32` each. The API exits at boot in
# production without IP_HASH_SECRET; without CLIENT_TOKEN_SECRET the workspace
# is off (503 WORKSPACE_DISABLED). Never rotate CLIENT_TOKEN_SECRET.
ADMIN_TOKEN=
IP_HASH_SECRET=
CLIENT_TOKEN_SECRET=

# The values below are the docker-compose.prod.yml defaults.
# Override only for precise tuning.
RATE_LIMIT_WINDOW_MS=3600000
RATE_LIMIT_MAX_REQUESTS=500
RATE_LIMIT_MAX_UPLOADS=10
SESSION_CLEANUP_AGE_MS=3600000
MAX_SESSIONS=20
```

> **Absolute rule**: always pass `--env-file .env.production.local` to **every** `docker compose` command, otherwise `${DOMAIN}` will be empty and Caddy + CORS will fail.

### Step 7 — Start the stack

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production.local up -d --build
```

The first build takes 3-5 minutes. Caddy automatically obtains a Let's Encrypt SSL certificate (ACME HTTP-01, requires DNS + port 80 to be reachable).

### Step 8 — Verify the deployment

```bash
# Status of the 4 containers
docker compose -f docker-compose.prod.yml --env-file .env.production.local ps

# NAME            STATUS           PORTS
# gtfs-caddy      Up               0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
# gtfs-frontend   Up (healthy)     80/tcp (internal only)
# gtfs-api        Up (healthy)     3004/tcp (internal only)
# gtfs-goaccess   Up               (no healthcheck — waits for access.log)

# Frontend healthcheck (reachable through Caddy)
curl -s https://gtfs.your-domain.com/nginx-health
# → ok

# Verify SSL certificate + HSTS preload
curl -sI https://gtfs.your-domain.com | head -8
# → HTTP/2 200
# → strict-transport-security: max-age=31536000; includeSubDomains; preload
# → ...

# Verify Helmet security headers (injected by the Express API on /api/gtfs/*)
curl -sI https://gtfs.your-domain.com/api/gtfs/health | grep -iE "x-content|x-frame|content-security|referrer"
```

Open **https://gtfs.your-domain.com** → application live in production.

> The `/stats/` and `/api/gtfs/upload-stats` endpoints require basic_auth credentials (`STATS_USER` / password). The GoAccess page is generated only after the first traffic (Caddy must have written `access.log`).

---

## 3. Day-to-day operations

### Recommended alias

Add to `~/.bashrc`:

```bash
alias gtfs='cd /opt/gtfs-express && docker compose -f docker-compose.prod.yml --env-file .env.production.local'
source ~/.bashrc

# Usage:
gtfs ps
gtfs logs -f
gtfs restart
```

### Maintenance commands

| Action | Command |
|---|---|
| Container status | `gtfs ps` |
| All logs (real-time) | `gtfs logs -f` |
| API logs only | `gtfs logs -f api` |
| Caddy logs (access + errors) | `gtfs logs -f caddy` |
| GoAccess logs (sidecar) | `gtfs logs -f goaccess` |
| Restart a service | `gtfs restart api` |
| Full stop | `gtfs down` |
| Stop + delete **every** volume (accounts, projects, shares, certificates — never in production) | `gtfs down -v` |
| Rebuild | `gtfs up -d --build` |
| Docker disk usage | `docker system df` |
| Prune unused images | `docker system prune -f` |
| Real-time CPU/RAM stats | `docker stats --no-stream` |

### Maintenance mode

Serve a static "We'll be right back" page (HTTP 503 + `Retry-After`, crawler-safe) on every route while you work, without touching the app containers:

```bash
# Enable
sed -i 's/^MAINTENANCE=.*/MAINTENANCE=true/' .env.production.local || echo "MAINTENANCE=true" >> .env.production.local
gtfs up -d caddy        # recreates only the Caddy container (~2 s)

# Disable
sed -i 's/^MAINTENANCE=.*/MAINTENANCE=false/' .env.production.local
gtfs up -d caddy
```

TLS/ACME is unaffected. Typical update flow: enable maintenance → pull + rebuild → smoke-test → disable.

### User accounts (`ACCOUNTS_ENABLED`)

Off by default and inert while off. With `ACCOUNTS_ENABLED=true` a person signs in with a **six-digit code sent by e-mail** (`POST /api/gtfs/auth/code`, then `POST /api/gtfs/auth/code/verify`): no password; the first verified code creates the account and verifies its address. A code is valid ten minutes and allows five tries; an address gets one code a minute and six an hour, an IP ten requests or checks per 15 minutes (`RATE_LIMIT_MAX_AUTH`). The server keeps only a keyed hash of the code, never the code. The message goes through `MAIL_PROVIDER`: without a provider in production, signing in answers `503 MAIL_UNAVAILABLE`. Accounts live in `projects.db` on the `projects_data` volume (`/app/projects`), never in the feed sessions; events carry a hashed email only.

**Reading** stays free and needs no account. In the open model (`PAID_ACCESS_ENABLED` off, the default) every modification stays open, with or without an account; only the AI that changes a network (the direct mode, the Network Studio's planner) wants the `studio` right of a licence while the accounts are on. Under the paid offer every modification needs the account's **licence** (see [The paid offer](#the-paid-offer-paid_access_enabled)). The licence comes from four sources (`services/accounts/store.js`, `licenceOf`), the strongest one shown to the person:

- **the operator's own addresses**, `ADMIN_EMAILS` (comma-separated): every right, no end, no per-account AI cap, once the address is verified by a code;
- **an online subscription** (Stripe, see [The paid offer](#the-paid-offer-paid_access_enabled)), until the end of its paid period, plus three days of grace;
- **the administrator's grant**, with an optional end date: the licence bought on a quote (below);
- **the free trial**: `TRIAL_DAYS` (14 by default, `0` for none), once per verified address, ever, even after the account is deleted (`POST /api/gtfs/billing/trial`).

A quote request (`POST /api/gtfs/billing/quote`: organisation, name, e-mail, seats, message) is mailed to the operator (`PLAN_CONTACT_EMAIL`, else `SUPPORT_EMAIL`), the requester as reply-to. The yearly price the offer shows and the request carries is `LICENCE_PRICE_EUR_YEAR`: indicative only, a placeholder (3,000) until the owner sets it; what an online payment charges is the payment provider's price.

**The beta access codes are retired** (2026-10-08): `beta/codes.json`, the `X-Beta-Code` header, `/auth/register`, `/auth/login`, `/auth/beta-code`, the passwords and `BETA_GATE_DISABLED` are gone. The first time the API opens an existing `projects.db` (schema version 3, additive), an account that held a beta code with the `edit` right gets the administrator's grant for thirty days from that moment (`grant_until`); past that date it needs a licence like any other. An account made with a password simply signs in with a code sent to its address.

**Enable** (three steps, in order):

```bash
# 1. The image creates /app/projects owned by the non-root API user, and a new named volume
#    inherits that ownership on its first mount. Only a volume created by an older image (or a
#    bind mount) may be root-owned: then hand it over once. Harmless to re-run. A root-owned
#    directory shows as SQLITE_CANTOPEN / EACCES on projects.db in the api logs.
gtfs run --rm --no-deps --user root api chown appuser:appgroup /app/projects

# 2. A way to send the sign-in codes and your own address, in .env.production.local (never
#    committed): MAIL_PROVIDER=brevo, MAIL_API_KEY=<the Brevo API key>, MAIL_FROM=<a sender
#    Brevo has verified>, ADMIN_EMAILS=<your address>. Then flip the flag and recreate the API
sed -i 's/^ACCOUNTS_ENABLED=.*/ACCOUNTS_ENABLED=true/' .env.production.local || echo "ACCOUNTS_ENABLED=true" >> .env.production.local
gtfs up -d api

# 3. Check
set -a; . ./.env.production.local; set +a
curl -sS https://$DOMAIN/api/gtfs/config/features | grep -o '"accounts":{[^}]*}'
# → "accounts":{"enabled":true,"signedIn":false,"entitlements":[]}
curl -sS -X POST https://$DOMAIN/api/gtfs/auth/code -H 'Content-Type: application/json' -d '{"email":"<your address>"}'
# → {"sent":true,…} and a code in your mailbox; 503 MAIL_UNAVAILABLE: no mail provider (step 2)
```

Then, a minute later (one code a minute per address), sign in on the site with your `ADMIN_EMAILS` address: the account menu shows the unlimited licence.

**Grant a licence** (admin token, header `X-Admin-Token`; the person must have signed in once, which creates the account). After a quote, the administrator's grant **is** the licence, until the end of the period it pays:

```bash
set -a; . ./.env.production.local; set +a

# List the accounts (never a hash): id, email, display_name, email_verified, entitlements (held now),
# licence (source, until, …), subscription, granted (the administrator's own grant), grant_until,
# trial_until, last_login_at, disabled
curl -sS -H "X-Admin-Token: $ADMIN_TOKEN" https://$DOMAIN/api/gtfs/admin/users

# The licence bought on a quote: both rights until a date ("YYYY-MM-DD": the end of that day, UTC)
USER_ID=<id from the list>
curl -sS -H "X-Admin-Token: $ADMIN_TOKEN" -H "Content-Type: application/json" \
     -d '{"edit": true, "studio": true, "until": "2027-10-31"}' \
     https://$DOMAIN/api/gtfs/admin/users/$USER_ID/entitlements
# → { "user": { "id": "…", "email": "…", "entitlements": ["edit", "studio"],
#      "licence": { "active": true, "source": "admin", "until": "2027-10-31T23:59:59.999Z", … },
#      "granted": ["edit", "studio"], "grant_until": "2027-10-31T23:59:59.999Z", … } }

# Renewed: the same call with the new date. {"until": null}: no end (a partner, a tester).
# Left out, "until" keeps the grant's end as it is.
# Revoke: {"edit": false, "studio": false}. {"disabled": true} locks the account out and ends its sessions.
```

Past `grant_until` the grant stops counting by itself (the rights stay listed under `granted`, inactive). The person sees the new licence at the next `GET /auth/me` (the web refreshes it when the account dialog opens). Client-side flow (cookie jar, the account's payload): [`GTFS-EXPRESS-API/docs/INTEGRATION.md`](GTFS-EXPRESS-API/docs/INTEGRATION.md#7-accounts-and-access-levels).

**Disable**: `ACCOUNTS_ENABLED=false` + `gtfs up -d api`. The routes answer 503 again, the UI hides the account entry, and `projects.db` stays untouched on the volume for the next time.

### The paid offer (`PAID_ACCESS_ENABLED`)

Off by default. With `PAID_ACCESS_ENABLED=true` (and `ACCOUNTS_ENABLED=true`) reading stays free for everyone, without an account: exploring, validating, sharing, the coherence report, the public feeds. **Editing** the open network (edit mode, every change, SQL console writes, the assistant's fixes, importing a project, delivering the edited GTFS) and the **Studios** (the Change Studio and the Network Studio, by hand or with the assistant, the workspace project's versions and delivery package) need an account whose **licence** runs: the operator's own address (`ADMIN_EMAILS`), an active (or trialing, or past-due) subscription, the administrator's grant until its end, or the free trial — see [User accounts](#user-accounts-accounts_enabled). The rule is checked on every request (`services/paidAccess.js`): `401 NOT_SIGNED_IN` without an account, `402 SUBSCRIPTION_REQUIRED` without the licence; the web opens the offer (the free trial, paying online, a quote) instead of an error. A licence that ends closes editing and the studios on the next request; the projects are kept. Since signing in is a code sent by e-mail, production refuses to start with the paid offer on and no working mail provider (`MAIL_PROVIDER=brevo` with `MAIL_API_KEY` and `MAIL_FROM`).

**Stripe** (dashboard, test mode first):

1. Products → the licence, two prices: recurring yearly (4 900 € HT, the same as `LICENCE_PRICE_EUR_YEAR`) → its id into `STRIPE_PRICE_PRO`; recurring monthly (590 € HT, `LICENCE_PRICE_EUR_MONTH`) → its id into `STRIPE_PRICE_PRO_MONTHLY`.
2. Developers → API keys → the secret key into `STRIPE_SECRET_KEY`.
3. Developers → Webhooks → endpoint `https://$DOMAIN/api/gtfs/billing/webhook`, events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` → its signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Settings → Billing → Customer portal: allow cancelling (at the end of the period), switching between the two prices, and updating the payment method and the invoices' details.
5. `BILLING_RETURN_URL=https://$DOMAIN`.

```bash
# In .env.production.local (never committed), then recreate the API
PAID_ACCESS_ENABLED=true
MAIL_PROVIDER=brevo
MAIL_API_KEY=xkeysib-...
MAIL_FROM=no-reply@your-domain.example
ADMIN_EMAILS=you@your-domain.example
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO=price_...
BILLING_RETURN_URL=https://$DOMAIN
gtfs up -d api

# Check: the offer is announced, the paid routes are closed to an anonymous caller
curl -sS https://$DOMAIN/api/gtfs/config/plans | grep -o '"model":"[a-z]*","checkout":"[a-z]*"'
# → "model":"paid","checkout":"stripe"
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://$DOMAIN/api/gtfs/network/compile -H 'Content-Type: application/json' -d '{}'
# → 401
```

The webhook is the only writer of a subscription (`subscriptions` in `projects.db`): the return from Checkout grants nothing by itself, each event is applied once (`billing_events`), and a signature that does not match is refused (`400`). Without `STRIPE_SECRET_KEY`, the payment links `STRIPE_CHECKOUT_URL_PRO` / `_TEAM` are used with the account's id as `client_reference_id` (configure the same webhook); without either, the plans fall back to the operator's address (`SUPPORT_EMAIL` / `REQUEST_ACCESS_URL`). An account whose subscription still renews cannot be deleted (`409 ACCOUNT_SUBSCRIPTION_ACTIVE`): it is cancelled from the portal first; the account's export carries its subscription (plan, status, period, never the provider's ids).

### The rights of the persons (« Mes données »)

With the accounts on, the account menu has **« Mes données »** (`MyDataDialog`), so a person exercises their rights in the app, without writing to you:

- **Download my data** (`GET /api/gtfs/auth/me/export`, rights of access and portability): a JSON file with the profile and accesses, the dates of the account's sign-ins, the projects it holds or is a member of (names, its role, retention), and the journal lines, reviews, acknowledgements and contract decisions it signed in them. No hash, password, code or token, nothing of another person beyond the project names.
- **Delete my account** (`DELETE /api/gtfs/auth/me`, right to erasure), the account's e-mail typed to confirm. A project the account holds and shares with others is never deleted under its team: the server refuses (`409 ACCOUNT_PROJECTS_SHARED`) and the dialog lists those projects with « Confier le projet » to one of their members (`POST /api/gtfs/workspace/projects/:id/owner`), in place. Then: every session of the account ends, the projects it holds are deleted with their versions, documents and the public share link their delivery published, its name in the journals, reviews, acknowledgements and contracts of the other projects is replaced by « compte supprimé » (the facts — what, when, which clause — stay), and the account row goes. Immediate, not reversible.

What the deletion does **not** reach, for your register and your answer to a person who asks: the backups taken before it (`projects_YYYYMMDD.tar.gz`, kept 30 days, see [Backups](#backups)), the pseudonymous log lines that name the account by its id or its hashed e-mail (`_events.jsonl`, kept `LOG_RETENTION_DAYS`), a working copy open at that moment (its journal holds the account's name until the copy expires, 1–2 h), and a name typed by hand in another project under another spelling than the account's own name or e-mail (the server cannot know it was this person). A project the account was removed from is anonymised too: the workspace remembers its former members.

### Shared projects

A project is the journey's own (Home « Mes travaux », the five steps), kept by the workspace for everyone; with `ACCOUNTS_ENABLED=true` its owner shares it with other accounts at a role (reader, contributor, approver) and a shared project's version is delivered only once approved, at step ⑤ (submit, approve, reject — named and commented), as « Tout le paquet »: the version's frozen GTFS validated again, its coherence report as a workbook and a PDF, the summary note and a `manifest.json` (SHA-256 of every file). The roles and reviews live in `workspace.db` (schema version 2, added by itself on first open: `project_members`, `project_reviews`), the packages under `WORKSPACE_DIR/<project>/packages/` for 24 hours. The account menu's « Mes travaux » leads to Home; an old `?tab=project` link lands there too.

### Update the application

Full procedure, run in order. Every command is non-destructive up to `gtfs up -d --build`.

#### a) Pre-deployment (1 min)

```bash
cd /opt/gtfs-express   # or /opt/gtfs-interpreter depending on your historical install

# 1. Snapshot the current commit for fast rollback
git rev-parse HEAD > /tmp/gtfs-prev-sha.txt
echo "Rollback SHA: $(cat /tmp/gtfs-prev-sha.txt)"

# 2. Verify your .env.production.local — ALL these vars must be present and non-empty
grep -E '^(DOMAIN|ADMIN_TOKEN|IP_HASH_SECRET|CLIENT_TOKEN_SECRET|STATS_HASH|ANTHROPIC_API_KEY)=' \
  .env.production.local | grep -v '^#'
# If CLIENT_TOKEN_SECRET is missing, the workspace is off (503 WORKSPACE_DISABLED):
#   echo "CLIENT_TOKEN_SECRET=$(openssl rand -hex 32)" >> .env.production.local
# Its own secret, never rotated with ADMIN_TOKEN / IP_HASH_SECRET (the projects
# kept without an account would be orphaned).
# With LLM_PROVIDER=bedrock or vertex, ANTHROPIC_API_KEY stays empty: check
# LLM_PROVIDER and its settings instead (section 9, Model provider).
# If IP_HASH_SECRET is missing (the API exits(1) at boot in prod without it):
#   echo "IP_HASH_SECRET=$(openssl rand -hex 32)" >> .env.production.local
# IP_HASH_SECRET must be DISTINCT from ADMIN_TOKEN (each secret rotates on its own).

# 3. Disk space (the validation engine ships OpenJDK 17 + JAR ~38 MB)
df -h /
docker system df

# 4. Preview what's changing (the files; each release of the public main is one commit of its own)
git fetch origin
git log --oneline -1 origin/main
git diff --stat HEAD origin/main | tail -5

# 5. Tag the running images: the fastest rollback (section d) needs no rebuild
docker tag gtfs-interpreter-api gtfs-interpreter-api:rollback-$(date +%Y%m%d)
docker tag gtfs-interpreter-frontend gtfs-interpreter-frontend:rollback-$(date +%Y%m%d)
```

The image names follow the checkout directory (`gtfs-interpreter-…` for `/opt/gtfs-interpreter`, `gtfs-express-…` for `/opt/gtfs-express`; `docker image ls` lists them).

#### b) Update + rebuild + restart

```bash
# Take the published main as it is: each release replaces it with a single commit, so a pull
# (which expects one history to extend the other) refuses; fetch and reset instead. Files git
# ignores (.env.production.local, GTFS-EXPRESS-API/beta/) are left as they are.
git checkout main
git fetch origin
git reset --hard origin/main

# Rebuild + restart (the --build downloads the MobilityData JAR during the API
# image's build stage when the Dockerfile version changed). 3-6 min the first
# time after a version bump, ~30 s otherwise.
gtfs up -d --build

# Watch boot (Ctrl+C once "Server is running" appears)
gtfs logs -f --tail=50 api
```

#### c) Post-deployment checks (acceptance — stop at the first failure)

```bash
# 1. Canonical validator boot guard → must log "ready"
gtfs logs api 2>&1 | grep -E "canonicalValidator|FATAL|Server is running"
# Expected:
#   [canonicalValidator] ready (jar=/opt/gtfs-validator-cli.jar, java=java)
#   Server is running on port 3004 [production]
# If you see "FATAL: ..." → stop immediately, read the message (typically IP_HASH_SECRET or missing JAR)

# 2. Embedded MobilityData JAR version
docker exec gtfs-api unzip -p /opt/gtfs-validator-cli.jar META-INF/MANIFEST.MF \
  | grep Implementation-Version
# Expected: Implementation-Version: <version pinned in GTFS-EXPRESS-API/Dockerfile>

# 3. Load DOMAIN into the shell (otherwise curl https://${DOMAIN}/... fails)
set -a; . ./.env.production.local; set +a
echo "DOMAIN=$DOMAIN"

# 4. Health endpoint
docker inspect -f "{{.State.Health.Status}}" gtfs-api     # healthy (the container's own /health)
curl -fsS https://$DOMAIN/api/gtfs/config/features | head -c 200; echo   # the API through Caddy and the frontend's proxy
# Expected: healthy, then the features JSON ({"access":…). /api/health answers the web page: Caddy hands
# everything to the frontend, whose Nginx passes only /api/gtfs/ to the API.

# 5. E2E upload of the sample feed shipped in the image
docker cp gtfs-api:/app/sample /tmp/sample-files
( cd /tmp/sample-files && zip -q -r /tmp/sample.zip *.txt )
curl -s -o /tmp/upload-test.json \
  -w "Upload: %{http_code} %{time_total}s\n" \
  -X POST -F "gtfsZip=@/tmp/sample.zip;type=application/zip" \
  https://$DOMAIN/api/gtfs/upload
grep -o '"engine":"[^"]*"' /tmp/upload-test.json
# Expected:
#   Upload: 200 ~3-6s
#   "engine":"mobilitydata-canonical"
# If you see "engine":"stub-no-jar" → prod is running with NODE_ENV != production. Investigate.

# 6. Visual check (the most informative): open https://$DOMAIN/ in a browser,
#    confirm the frontend renders (upload page, footer).
```

#### First deploy of the branch `further` on an existing server — what moves

The update above keeps every existing volume: `uploads_data`, `projects_data`, `caddy_*`, `goaccess_html` and the host's `GTFS-EXPRESS-API/beta/` are mounted again as they were. What changes:

- **A new named volume, `shares_data`** (`/app/shares`), is created empty and owned by the API user (the image creates the mount point). The public shares used to live in the container itself, outside any volume, and were lost at each rebuild. `main` has no shares, so a server that ran `main` has nothing to move. Only a server that already ran a build of `further` holds shares in its **current** container: copy them out **before** `gtfs up -d --build` (which replaces the container), and back in afterwards:

  ```bash
  # before the rebuild (no-op when the folder does not exist)
  docker exec gtfs-api test -d /app/shares \
    && docker cp gtfs-api:/app/shares /opt/backups/shares-before-volume
  # after the rebuild
  [ -d /opt/backups/shares-before-volume ] \
    && docker cp /opt/backups/shares-before-volume/. gtfs-api:/app/shares/ \
    && gtfs exec --user root api chown -R appuser:appgroup /app/shares
  ```

- **The workspace** (`workspace.db`, the frozen version zips, the documents) is created inside the existing `projects_data` volume (`/app/projects/workspace`) the first time it is used — once `CLIENT_TOKEN_SECRET` is set. Nothing is moved; `projects.db` is untouched. A `projects_data` volume created by an older image may be root-owned: the `chown` of [User accounts](#user-accounts-accounts_enabled) step 1 fixes it.
- **Docker's own logs** are rotated from now on (5 × 10 MB per container): the containers are recreated by the rebuild, so the old unrotated `*-json.log` files go with the old containers.
- **The API's JSONL logs** (`_events.jsonl`, `_upload_stats.jsonl` on `uploads_data`, `usage.jsonl` and `chat-usage.jsonl` in `beta/`) stay where they are; a minute after boot the daily retention sweep removes their lines older than `LOG_RETENTION_DAYS` (365 by default). Back them up first if you want their whole history (see [Backups](#backups)).
- **The images no longer carry `beta/`'s files.** The API image is built from this checkout, whose `GTFS-EXPRESS-API/beta/` is the live folder: until now `.dockerignore` kept out only `codes.json` and `usage.jsonl`, so every image built on the server also copied `chat-usage.jsonl` and the admin reset's `*.bak.jsonl` archives into its layers, beyond the retention sweep and the backups. It now keeps every file of `beta/` out. The images built before still hold those copies: once the new stack runs and the rollback window has passed, remove them (`docker image ls` lists them; `docker image prune` removes the dangling ones, those no container uses and no tag names):

  ```bash
  docker image ls | grep -E 'gtfs|<none>'
  docker image prune -f
  ```

  The build cache holds the same copies: `docker builder prune -f` empties it, at the cost of a full rebuild next time.

- **The beta access codes are retired.** `beta/codes.json` is no longer read (keep it in a backup or delete it), `BETA_GATE_DISABLED` no longer exists (remove it from `.env.production.local`), and the accounts that held a code with the `edit` right get a thirty-day grant at the first open of `projects.db` (see [User accounts](#user-accounts-accounts_enabled)). Signing in needs a mail provider from now on: set `MAIL_PROVIDER` before turning the accounts on.
- **Settings the stack did not pass before** now reach the API (`CLIENT_TOKEN_SECRET`, the retention and caps of the workspace and shares, `SUPPORT_EMAIL`, `MODEL_PROVIDER_NAME`, `SCHOOL_HOLIDAYS_FETCH_ENABLED`…): a value already written in `.env.production.local` but ignored until now takes effect at this deploy. Read your env file before deploying.

#### d) Express rollback

If a check fails or a user reports broken behaviour:

```bash
cd /opt/gtfs-express
# Fastest: the images tagged before the update (a) 5.), no rebuild
D=<the date of the tag>
docker tag gtfs-interpreter-api:rollback-$D gtfs-interpreter-api
docker tag gtfs-interpreter-frontend:rollback-$D gtfs-interpreter-frontend
gtfs up -d --no-build
# Or rebuild the previous code, still in the checkout's git objects after a reset
git checkout $(cat /tmp/gtfs-prev-sha.txt)
gtfs up -d --build
gtfs logs -f --tail=30 api   # reconfirm "Server is running"
```
Restore the `.env.production.local` copied before the update too when a new setting is what failed.

#### Operational notes

- **Downtime**: ~30-60 s during rebuild + restart (Caddy returns 502 while the frontend restarts). For strict zero-downtime, plan a 2nd stack + external load-balancer.
- **Lost active sessions**: in-flight uploads on the `uploads_data` volume survive (named persistent volume), but the in-memory sessions on the API side are lost. If users are mid-edit, they will lose unexported changes. Notify them when applicable. Account sign-ins (`projects_data`) survive a rebuild: the cookie sessions are stored in `projects.db`.
- **Docker cache**: a rebuild that changes neither `Dockerfile` nor `package-lock.json` reuses layers → near-instant. Bumping `GTFS_VALIDATOR_VERSION` in the `Dockerfile` invalidates the `apk add openjdk + curl JAR` layer and re-triggers the JAR download (~38 MB).
- **Schema migration**: if the pulled commit bumps `SCHEMA_VERSION` in [GTFS-EXPRESS-API/src/services/db/schema.js](GTFS-EXPRESS-API/src/services/db/schema.js), existing on-disk sessions are migrated at boot. A `migrationDurability.test.js` test must accompany the bump. No manual deployment action required.

### Backups

**Every durable store of the production stack.** Compose prefixes the volume names with the project name, the checkout directory's (`gtfs-express_…` for `/opt/gtfs-express`, `gtfs-interpreter_…` for `/opt/gtfs-interpreter`; `docker volume ls` lists them). The commands below reach the volumes through the containers (`--volumes-from`), so they never need that prefix.

| Store | Where | Contents | Backup criticality |
|---|---|---|---|
| `caddy_data` | volume, Caddy `/data` | **Let's Encrypt TLS certificates** + ACME state | 🔴 **CRITICAL** — otherwise reissued at restart (LE rate-limit 50/week/domain) |
| `projects_data` | volume, API `/app/projects` | `projects.db` (**user accounts**: emails, granted rights and their end, free-trial ends, subscriptions, sign-in sessions, the pending sign-in codes and the addresses that had their free trial, both as keyed hashes; the studio projects' tables) and `p/<project>/` (their documents, frozen versions, deliverables); `workspace/workspace.db` (**the journey's projects, for everyone**: contract, scenarios, versions, journal, acknowledgements, members, reviews) and `workspace/<project>/` (**the frozen version zips**, v0 included, the documents, the delivery packages kept 24 h) | 🔴 **CRITICAL** as soon as `CLIENT_TOKEN_SECRET` is set (the workspace) or `ACCOUNTS_ENABLED=true` — not regenerable |
| `shares_data` | volume, API `/app/shares` | The public shares: a feed's read-only snapshot per token, kept `SHARE_TTL_DAYS` (90) days | 🟠 High — links already given to third parties stop working |
| `GTFS-EXPRESS-API/beta/` | host folder, bind-mounted on `/app/beta` | `chat-usage.jsonl` (AI use), `usage.jsonl` (the retired access codes' use log: no longer written, swept until it ages out) | 🟡 keep (see [Logs](#logs)) |
| `uploads_data` | volume, API `/app/uploads` | The feed sessions (swept after `SESSION_CLEANUP_AGE_MS`, a snapshot of their edits taken first by the workspace), and **the API's logs** `_events.jsonl` and `_upload_stats.jsonl` (the admin dashboard's history) | 🟢 sessions: ephemeral · 🟡 the two logs: keep |
| `caddy_logs` | volume, Caddy `/logs` | The access log, rotated (see [Logs](#logs)) | 🟡 Medium — post-hoc audit |
| `goaccess_html` / `caddy_config` | volumes | `/stats/` dashboard / Caddy runtime config | 🟢 Low — regenerated |

`CLIENT_TOKEN_SECRET` itself (in `.env.production.local`) belongs with the backups: a restored workspace whose secret was lost leaves every project kept without an account unreachable. Keep a copy of `.env.production.local` somewhere safe (it holds every secret), never in `/opt/backups` on the same disk alone.

**Daily automation** (`/etc/cron.daily/gtfs-backup`; adapt `APP` to your checkout):

```bash
#!/bin/sh
# Every durable store of GTFS Express, once a day, kept 30 days. Each step runs even if another failed.
set -u
APP=/opt/gtfs-express            # the checkout holding docker-compose.prod.yml
B=/opt/backups
D=$(date +%Y%m%d)
mkdir -p "$B"

# 1. TLS certificates and ACME state
docker run --rm --volumes-from gtfs-caddy:ro -v "$B":/backup alpine \
  tar czf /backup/caddy_data_$D.tar.gz -C /data .

# 2. Consistent snapshots of the two SQLite databases (WAL mode: never trust a raw copy of a live file)
docker exec gtfs-api node -e '
const fs = require("fs"), Database = require("better-sqlite3");
(async () => {
  for (const f of ["/app/projects/projects.db", "/app/projects/workspace/workspace.db"]) {
    if (!fs.existsSync(f)) continue;
    const db = new Database(f, { readonly: true });
    await db.backup(f.replace(/\.db$/, ".backup.db"));
    db.close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });'

# 3. The whole projects volume: the snapshots above, the frozen version zips, the documents, the
#    studio projects' files. (The live .db files come along too; a restore uses the .backup.db.)
docker run --rm --volumes-from gtfs-api:ro -v "$B":/backup alpine \
  tar czf /backup/projects_$D.tar.gz -C /app projects
docker exec gtfs-api rm -f /app/projects/projects.backup.db /app/projects/workspace/workspace.backup.db

# 4. The public shares
docker run --rm --volumes-from gtfs-api:ro -v "$B":/backup alpine \
  tar czf /backup/shares_$D.tar.gz -C /app shares

# 5. beta/ on the host: the AI use log and the retired access codes' use log
tar czf "$B/beta_$D.tar.gz" -C "$APP/GTFS-EXPRESS-API" beta

# 6. The API's event and upload logs (on the uploads volume)
docker run --rm --volumes-from gtfs-api:ro -v "$B":/backup alpine sh -c \
  "cd /app/uploads && if ls _*.jsonl >/dev/null 2>&1; then tar czf /backup/api_logs_$D.tar.gz _*.jsonl; fi"

# 7. Caddy's access logs (security audit)
docker run --rm --volumes-from gtfs-caddy:ro -v "$B":/backup alpine \
  tar czf /backup/caddy_logs_$D.tar.gz -C /logs .

# Keep 30 days. The backups hold personal data too (accounts, names in the journals, hashed
# addresses): their retention is the owner's decision, like the stores'.
find "$B" -maxdepth 1 -type f -name '*_[0-9]*.tar.gz' -mtime +30 -delete
find "$B" -maxdepth 1 -type f -name 'projects_[0-9]*.db' -mtime +30 -delete   # the copies of the previous version of this script
```

```bash
chmod +x /etc/cron.daily/gtfs-backup
sudo /etc/cron.daily/gtfs-backup && ls -la /opt/backups   # run it once by hand and look
```

**Restore** (stop the service that writes the store first; `YYYYMMDD` is the backup's date):

```bash
# TLS certificates
gtfs stop caddy
docker run --rm --volumes-from gtfs-caddy -v /opt/backups:/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/caddy_data_YYYYMMDD.tar.gz -C /data'
gtfs start caddy

# Accounts, workspace and studio projects: the archive, then each database from its consistent snapshot
gtfs stop api
docker run --rm --volumes-from gtfs-api -v /opt/backups:/backup alpine sh -c '
  rm -rf /app/projects/* && tar xzf /backup/projects_YYYYMMDD.tar.gz -C /app && cd /app/projects &&
  for f in projects workspace/workspace; do
    if [ -f "$f.backup.db" ]; then rm -f "$f.db" "$f.db-wal" "$f.db-shm" && mv "$f.backup.db" "$f.db"; fi
  done'

# The public shares
docker run --rm --volumes-from gtfs-api -v /opt/backups:/backup alpine \
  sh -c 'rm -rf /app/shares/* && tar xzf /backup/shares_YYYYMMDD.tar.gz -C /app'

# The restored files are root-owned: hand them back to the API user, then start it
gtfs run --rm --no-deps --user root api chown -R appuser:appgroup /app/projects /app/shares
gtfs start api

# beta/ (on the host)
tar xzf /opt/backups/beta_YYYYMMDD.tar.gz -C /opt/gtfs-express/GTFS-EXPRESS-API
```

### Logs

| Log | Where | Contents | Rotation and retention |
|---|---|---|---|
| `_events.jsonl` | `uploads_data` | The typed event log: uploads, sessions, validations, edit mode, exports, SQL, workspace actions, the chat's feedback — hashed addresses (HMAC under `IP_HASH_SECRET`), hashed codes and emails, user agents | Lines older than `LOG_RETENTION_DAYS` removed once a day |
| `_upload_stats.jsonl` | `uploads_data` | One line per uploaded feed (agencies, counts) | same |
| `beta/usage.jsonl` | host `beta/` | The retired access codes' use log, **no longer written** since the codes were retired (2026-10-08) and still read by the admin statistics: every code attempt, with the action, the hashed code (a refused attempt: the refusal), the account id when an account passed, the hashed address (HMAC under `IP_HASH_SECRET`, the event log's), the user agent; see the note below for its oldest lines | same, until its last line ages out |
| `beta/chat-usage.jsonl` | host `beta/` | Every AI turn (model, tokens) | same |
| `*.<stamp>.bak.jsonl` | beside each log | What the admin dashboard's "reset" archived | same; an archive left empty is deleted |
| Docker logs of each container | `/var/lib/docker/containers/` | Each container's output: the API's console, the frontend's Nginx access lines, Caddy's errors | `json-file`, 5 files × 10 MB per container (`x-logging` in the compose files); a recreated container starts afresh |
| Caddy `access.log` | `caddy_logs` | Every request with the **full client address** and user agent; read by GoAccess | Rolled at 10 MB, 5 rolled files kept, none older than 90 days (`roll_keep_for 2160h`, Caddy's default written out in the `Caddyfile`); the live file is bounded by its size only |

**`LOG_RETENTION_DAYS`** (default `365`, `0` keeps everything) is the owner's decision — a trade-off between the audit trail and the privacy of pseudonymous data; whatever the figure, the privacy policy must announce the same one (the legal texts are the owner's). My recommendation: keep 365 days for these four logs (they hold hashes, not addresses — but read the next paragraph), and if the access log's full addresses must not outlive a shorter announced period, lower Caddy's `roll_keep_for` to it — the size-based rotation alone can keep the live file for months on a quiet site. The sweep logs what it removed (`gtfs logs api | grep "log retention"`); a line whose date cannot be read is kept.

**The log's oldest lines.** At first, `beta/usage.jsonl` received the visitor's address and the code holder's e-mail **in clear** (`"ip"`, `"email"`), then for a while the e-mail's hash (`"email_hash"`); the later lines hold only `ip_hash` (the same HMAC under `IP_HASH_SECRET` as the event log), `code_hash` and the account id, and since the codes were retired nothing is written to it. The older lines keep their values until the sweep removes them, up to `LOG_RETENTION_DAYS` after they were written. To rewrite them now, run `scripts/rewrite-beta-usage.js` **once**, after the deploy, inside the API container (it refuses to run without `IP_HASH_SECRET`: hashed under another salt, the addresses would not match the event log's). Without a file name it takes `beta/usage.jsonl` and the admin reset's archives beside it (`usage.<stamp>.bak.jsonl`); every other field, the line order and the file's mode stay; a line it cannot read is kept as it is. The dry run writes nothing and prints counts only, never a value of the log:

```bash
gtfs exec api node scripts/rewrite-beta-usage.js --dry-run
# usage.jsonl: 1840 line(s), 1212 with an address in clear, 1612 with an e-mail, 0 unreadable (kept) → 1612 to rewrite (dry run, nothing written)
gtfs exec api node scripts/rewrite-beta-usage.js
# Then: nothing in clear and no e-mail hash is left.
grep -lE '"(ip|email|email_hash)":' /opt/gtfs-express/GTFS-EXPRESS-API/beta/usage*.jsonl || echo "no clear address or e-mail left"
```

Run twice, it rewrites nothing the second time. The backups taken before the rewrite (`beta_YYYYMMDD.tar.gz`, see [Backups](#backups)) still hold the old lines until they rotate out: delete those older than the rewrite if they must not outlive it.

```bash
docker inspect gtfs-api --format '{{json .HostConfig.LogConfig}}'
# → {"Type":"json-file","Config":{"max-file":"5","max-size":"10m"}}
gtfs exec api sh -c 'ls -la /app/uploads/*.jsonl /app/beta/*.jsonl'
gtfs exec caddy ls -la /logs
```

### Third-party calls from the browser

The site serves its own code, styles and **fonts** (Inter is part of the build since this version: `GTFS-EXPRESS-WEB/src/assets/fonts/inter`, SIL OFL 1.1; `npm run build` fails if a page or a stylesheet names a font CDN — `scripts/third-party-check.js`). Before it, every page load asked `fonts.googleapis.com` and `fonts.gstatic.com`, sending each visitor's address to Google. The calls the visitor's browser still makes to other sites, for your register of processing (the privacy page, `/conditions/confidentialite`, names them from this build's and the server's settings):

| Recipient | When | What it receives | How to remove it |
|---|---|---|---|
| The basemap provider — **OpenFreeMap** (`tiles.openfreemap.org`, the default without a key), **CARTO** (`basemaps.cartocdn.com`, with `VITE_CARTO_API_KEY`) or **MapTiler** (`api.maptiler.com`, with `VITE_MAPTILER_KEY`) | Whenever a map is shown (explorer, steps ③ and ④, shapes) | The visitor's address and user agent, the site's origin (`Referrer-Policy: strict-origin-when-cross-origin`: the origin only, never the page's path), the tiles requested (so the area and the zoom looked at), the style, its icons and its label fonts, the API key in the URL when one is set | Self-host vector tiles (e.g. an OpenFreeMap or OpenMapTiles instance) and point the style at it; nothing is sent while no map is open |
| **OpenStreetMap** (`tile.openstreetmap.org`) | When the person picks the « OpenStreetMap » basemap, and as the fallback when the provider's vector style fails to load | Same as above, raster tiles | Remove the choice and the fallback from `GTFS-EXPRESS-WEB/src/components/map/basemapConfig.js` |
| **Esri** (`server.arcgisonline.com`) | Only when the person picks the satellite basemap and the provider has no imagery of its own (MapTiler serves its own) | Same as above, imagery tiles | Use MapTiler's satellite (keyed), or remove the choice |

The Content-Security-Policy (`GTFS-EXPRESS-WEB/security-headers.conf`) allows exactly these hosts and fonts from `'self'` only: a new third-party call needs a line there, and a line in this table. Server-side calls carry no visitor address: the catalogue (transport.data.gouv.fr, MobilityData), the geocoder, the OSRM `OSRM_URL` of the studios and of the shape editor (POST /gtfs/edit/route) and the school calendar receive the place names, coordinates or feed URLs a person typed; the model provider receives what [section 9](#9-model-provider) says.

### Client addresses behind the proxies (`TRUST_PROXY_HOPS`)

The API counts its per-IP limits (requests, uploads, sign-in attempts, the AI's free trial) and hashes the visitor's address in its logs from `req.ip`, which Express reads `TRUST_PROXY_HOPS` hops back along `X-Forwarded-For`. In this repository's production stack a request already crosses **two** proxies before the API: Caddy, then the frontend's Nginx (`/api/gtfs/` → `api:3004`), each appending the address it received the request from. A proxy on the host in front of Caddy adds one more — but only if Caddy trusts it: by default Caddy replaces an `X-Forwarded-For` coming from a source it does not trust by that source's address, so the visitor's address stops at Caddy.

The API's own default is `1`, what it always did; `docker-compose.prod.yml` sets `2`, the two proxies this stack puts in front of the API (Caddy, then the frontend's Nginx, which forwards Caddy's `X-Forwarded-For` and `X-Forwarded-Proto`). With `1` behind them, `req.ip` would be the address of Caddy's container for every visitor: one rate-limit bucket shared by everybody (500 requests an hour for the whole site), one hashed address in the logs. Too high is worse: a visitor then picks their own address by sending `X-Forwarded-For`. A proxy of the host in front of Caddy adds a hop, and Caddy must then trust it. **Read the value on the server, do not guess it:**

```bash
# From your own computer (not from the server), with the ADMIN_TOKEN of .env.production.local:
curl -sS -H "X-Admin-Token: $ADMIN_TOKEN" https://$DOMAIN/api/gtfs/admin/client-address
# → {"ip":"172.18.0.5","trust_proxy_hops":1,"forwarded_for":["203.0.113.7","172.18.0.5"],
#    "chain":[{"hops":0,"ip":"::ffff:172.18.0.4"},{"hops":1,"ip":"172.18.0.5"},{"hops":2,"ip":"203.0.113.7"}],…}
```

1. Know your own public address (your router's status page, your provider's account).
2. In `chain`, take the **smallest** `hops` whose `ip` is yours: that is the value (`2` in the example above).
3. If your address is nowhere in `chain`, a proxy in front of the stack drops it: typically Caddy not trusting the host's proxy. Fix that first (Caddy's global option `servers { trusted_proxies static <the host proxy's address as Caddy sees it> }`, an owner's change since it depends on the server), never by raising the setting past the chain.
4. Set it, recreate the API, and check both that `ip` is yours and that a forged header does not change it:

```bash
sed -i 's/^TRUST_PROXY_HOPS=.*/TRUST_PROXY_HOPS=2/' .env.production.local || echo "TRUST_PROXY_HOPS=2" >> .env.production.local   # the value read above
gtfs up -d api
# from your computer again:
curl -sS -H "X-Admin-Token: $ADMIN_TOKEN" https://$DOMAIN/api/gtfs/admin/client-address | grep -o '"ip":"[^"]*"' | head -1
curl -sS -H "X-Admin-Token: $ADMIN_TOKEN" -H "X-Forwarded-For: 198.51.100.1" \
  https://$DOMAIN/api/gtfs/admin/client-address | grep -o '"ip":"[^"]*"' | head -1
# both → your own address, never 198.51.100.1
```

The staging stack has one proxy (the frontend's Nginx; the SSH tunnel is not one): its default `1` is right. Check again after any change in front of the stack (a CDN, a load balancer, a host proxy).

### AI budget and per-account quotas

The AI requests are capped three ways (`services/aiCostLimiter.js`): a **server-wide** budget over 24 h (`NL2SQL_DAILY_BUDGET_TOTAL`, 500), checked first and never overridden; a **per-account** daily quota — `BETA_NL2SQL_DAILY_LIMIT_PER_CODE` (200, a fair use since 2026-10-08) for an account whose licence holds the `studio` right, counted under its own key (`user:<id>`; the `BETA_*` variables keep the names of the retired codes), `TRIAL_AI_DAILY_LIMIT` (30) for an account on the free trial, `NL2SQL_DAILY_LIMIT_PER_CODE` (100) for a request without a licence in the open model; and an hourly cap (`BETA_NL2SQL_RATE_LIMIT`, 60, for a licensed account; `NL2SQL_RATE_LIMIT` and `NL2SQL_CHAT_RATE_LIMIT`, 30, without one). The calls nobody pays for — the trials and, under the paid offer, the free messages when they are on — also draw on a share of the server-wide budget (`NL2SQL_DAILY_BUDGET_UNPAID`, 100): once it is spent they get `BUDGET_EXHAUSTED`, and the rest of the day's budget stays the paying accounts'. On top of the counts, each licensed account draws on an **envelope in euros** summed from what every model call really cost (the tokens the provider reported, priced in `services/llm/prices.js`, kept in `projects.db` so that a restart does not reset it): `TRIAL_AI_BUDGET_EUR` (5) over the whole free trial, `LICENCE_AI_BUDGET_EUR_MONTH` (100) per calendar month for a licence; spent, the AI routes answer `AI_ALLOWANCE_EXHAUSTED` (402 for the trial, 429 for a licence), and a planner turn is cut to what is left. The admin's « Comptes et licences » shows each account's cost this month and in all. Under the paid offer no AI is served without an account by default (`NL2SQL_FREE_MESSAGES_PER_SESSION=0`). The operator's own accounts (`ADMIN_EMAILS`) have no per-account cap: only the server-wide budget holds them. The API compares these figures, at boot (`[ai budget] …` in `gtfs logs api`) and in the admin counters:

```bash
curl -sS -H "X-Admin-Token: $ADMIN_TOKEN" https://$DOMAIN/api/gtfs/admin/ai-usage | grep -o '"budget":{[^}]*}'
# → "budget":{"global_daily":500,"per_code_daily":100,"licensed_daily":200,"unpaid_daily":100,"consistent":true,"warnings":[]}
```

`per_code_daily` is the quota without a licence, `licensed_daily` a licensed account's, `unpaid_daily` the share the trials and free messages may take. The defaults are consistent. A quota above the budget is reported (`consistent: false`, a warning naming the setting): one account alone would then spend the server's day and the AI would stop for every customer until the oldest request is 24 h old; an unpaid share at or above the budget is reported too (the paying accounts would have nothing kept).

The values are the owner's. Two consistent choices: **(a) the budget is the wallet's ceiling** — keep `NL2SQL_DAILY_BUDGET_TOTAL` and lower `BETA_NL2SQL_DAILY_LIMIT_PER_CODE` to at most it, ideally a fraction so that one account cannot starve the others; **(b) the quotas are a promise** — raise `NL2SQL_DAILY_BUDGET_TOTAL` to at least the quota, better to the number of licensed accounts active on the same day × their quota, with a spend limit set at the model provider as well. The defaults follow (a): an account's quota is two fifths of the budget, the unpaid share a fifth. Whatever the figures, set a monthly spend limit at the model provider as well: it is the wallet's last guard, outside the code.

The budget counts **calls**, and a turn (the direct mode's, the Network Studio planner's) is one call while it may run dozens of model rounds: its cost varies twentyfold (0.2 to 1.75 USD per Change Studio turn of the planner on the 2026-09-28 campaign). `AI_TURN_MAX_WEIGHTED_TOKENS` (1 000 000) bounds one turn in input-token equivalents (`services/llm/turnBudget.js`): past it the model is asked to close with what it has, the turn ends `incomplete` (a `budget` event, the plan never ready) and the person continues in another turn. A round whose stream is cut (a reset, an overloaded upstream, a proxy) is sent again on its own up to three times before the turn fails (`services/llm/streamRound.js`: a `retry` event each time), so a cut no longer costs the whole turn.

### Basic monitoring

```bash
# Are all containers healthy?
gtfs ps --format "table {{.Name}}\t{{.Status}}"

# Memory + CPU per container
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"

# Restart counter (crash loop?)
for c in gtfs-caddy gtfs-frontend gtfs-api gtfs-goaccess; do
  echo "$c → $(docker inspect $c --format='{{.RestartCount}}')"
done

# Recent accesses (Caddy JSON)
gtfs exec caddy cat /logs/access.log | tail -20
```

For external monitoring (HTTP ping): UptimeRobot / Better Uptime against `https://gtfs.your-domain.com/nginx-health`.

### Statistics — GoAccess

GoAccess is a sidecar that continuously parses `caddy_logs/access.log` (JSON format) and produces a real-time HTML dashboard at `https://your-domain.com/stats/` (Caddy basic_auth).

**What GoAccess shows**:
- Unique visitors per day / hour
- Most visited pages
- Visitor country of origin (IP geolocation)
- Browsers and operating systems
- HTTP status codes (200, 404, 500…)
- Bandwidth used

**Technical notes**:
- Real-time WebSocket mode (`wss://${DOMAIN}:443/stats/`) behind the same basic_auth
- GoAccess waits for `/logs/access.log` to exist before starting (2s loop). First traffic required for initialisation.

---

## 4. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ERR_CONNECTION_REFUSED` | Containers stopped | `gtfs up -d` |
| `ERR_SSL_PROTOCOL_ERROR` | DNS not propagated, or port 443 blocked | `dig <domain> +short` + `ufw status` |
| Invalid / missing SSL cert | Caddy could not reach Let's Encrypt | `gtfs logs caddy` — check DNS + port 80 open + ACME HTTP-01 |
| `CORS error` in the browser | `DOMAIN` empty (`--env-file` forgotten) or wrong | Verify `.env.production.local` + always pass `--env-file` |
| Container restart loop | Application error | `gtfs logs <service>` |
| Frontend build fails | `package-lock.json` desynced | `cd GTFS-EXPRESS-WEB && npm install` locally, commit, redeploy |
| Upload rejected 413 | File > 50 MB (multer cap) | 50 MB is the hard limit. Nginx allows 55 MB (multipart-headers margin) |
| Upload rejected 429 | `RATE_LIMIT_MAX_UPLOADS` exhausted (10/h) | Wait 1h or raise the value in `.env.production.local` |
| Non-upload request rejected 429 | Global rate limit (500 req/h in prod) | Same |
| `/stats/` → persistent 401 | `STATS_HASH` poorly escaped | Verify each `$` of the hash is doubled (`$$`) in `.env.production.local` |
| `/stats/` → 502 or blank page | GoAccess not ready (no access.log yet) | `curl https://<domain>/` to generate traffic, wait 10s |
| "Waiting for access.log..." line stuck | Caddy hasn't logged anything | Same ↑ — first traffic required |
| `Bad Gateway` on `/` | Frontend DOWN/unhealthy | `gtfs ps` + `gtfs logs frontend` |
| API container OOM-killed | GTFS session too large vs 1800 MB heap, or the validator JVMs beside it | Reduce `MAX_SESSIONS`, increase VPS RAM, raise the container's limit (see [Memory budget](#memory-budget)), or edit `--max-old-space-size` in `GTFS-EXPRESS-API/Dockerfile` |
| Disk full | Stale Docker images + orphan volumes | `docker system prune -af --volumes` (⚠️ **never** on a system whose volumes you care about) |
| `docker-compose` ignores `.env.production.local` | `--env-file` flag missing | Every prod command must include `--env-file .env.production.local` |
| Build fails with `failed to fetch anonymous token: ... lookup auth.docker.io on 127.0.0.53:53: server misbehaving` | Broken systemd-resolved on the VPS | `sudo systemctl restart systemd-resolved` then rerun the build. If the issue recurs, create `/etc/docker/daemon.json` with `{ "dns": ["1.1.1.1", "8.8.8.8"] }` then `sudo systemctl restart docker` (Cloudflare/Google DNS, independent of the local resolver) |
| `curl: (6) Could not resolve host: api` or (5) during post-deploy checks | `${DOMAIN}` is undefined in your shell (Compose reads it from `.env`, not the shell) | `set -a; . ./.env.production.local; set +a` BEFORE the `curl https://$DOMAIN/...`. Or substitute the domain literally in the command. |
| `FATAL: [canonicalValidator] GTFS_CANONICAL_VALIDATOR_JAR is not set` | Env var lost (custom image override?) | Verify the official `Dockerfile` sets `ENV GTFS_CANONICAL_VALIDATOR_JAR=/opt/gtfs-validator-cli.jar`. The boot guard refuses to start in prod without it. |
| `engine:"stub-no-jar"` in the prod upload response | `NODE_ENV` not set to `production` (the stub should only be active in dev/test) | `gtfs exec api node -e 'console.log(process.env.NODE_ENV)'` must print `production`. Otherwise `docker-compose.prod.yml` is misread — confirm `--env-file` and the `api.environment.NODE_ENV=production` service entry. |
| `503 ACCOUNTS_DISABLED` on `/api/gtfs/auth/*`, no account entry in the header | `ACCOUNTS_ENABLED` is not `true` | Intended while the flag is off. To enable: [User accounts](#user-accounts-accounts_enabled). |
| `SQLITE_CANTOPEN` / `EACCES … /app/projects/projects.db` in the api logs, `500` on sign-in | The `projects_data` volume is root-owned (mount point absent from the image) | `gtfs run --rm --no-deps --user root api chown appuser:appgroup /app/projects` then `gtfs restart api`. |
| `503 MAIL_UNAVAILABLE` when asking for a sign-in code | No `MAIL_PROVIDER` (production sends nothing by default) | Set `MAIL_PROVIDER=brevo` with `MAIL_API_KEY` and `MAIL_FROM` in `.env.production.local`, then `gtfs up -d api`. A `502 MAIL_PROVIDER_ERROR` means Brevo refused or could not be reached: `gtfs logs api` says why (a wrong key, a sender Brevo has not verified). |
| `FATAL: [mail] MAIL_PROVIDER is not set` (or `MAIL_API_KEY`, `MAIL_FROM`) at boot, the API restarts in a loop | `PAID_ACCESS_ENABLED=true` without a working mail provider: nobody could sign in | Same fix as above. |
| `429` on sign-in | `RATE_LIMIT_MAX_AUTH` exhausted (10 code requests or checks / 15 min / IP), or `LOGIN_CODE_TOO_SOON` (one code a minute per address), or `LOGIN_CODE_LOCKED` (five wrong tries) | Wait 15 min or raise `RATE_LIMIT_MAX_AUTH`; for one address, wait a minute or ask for a new code. |
| `429` for many visitors at once, or one hashed address for everybody in the admin statistics | `req.ip` is a proxy's address: `TRUST_PROXY_HOPS` lower than the proxies in front of the API | Read the value with `GET /api/gtfs/admin/client-address`: [Client addresses behind the proxies](#client-addresses-behind-the-proxies-trust_proxy_hops). |
| `503 WORKSPACE_DISABLED` on `/api/gtfs/workspace/*`, the web says the projects are not saved on the server | `CLIENT_TOKEN_SECRET` empty in production | `echo "CLIENT_TOKEN_SECRET=$(openssl rand -hex 32)" >> .env.production.local` then `gtfs up -d api`. Never change it afterwards. |
| `[ai budget] … is above the server-wide budget` in the api logs; the AI stops for everyone in the afternoon | A per-account daily quota above `NL2SQL_DAILY_BUDGET_TOTAL` | The owner's choice: [AI budget and per-account quotas](#ai-budget-and-per-account-quotas). |
| `401 NOT_SIGNED_IN` from a script although sign-in succeeded | The cookie was not sent back (`-b jar.txt`), or it was set `Secure` and the call is plain http | Use a cookie jar over https, see INTEGRATION.md §7. |

---

## 5. Pre-production checklist

- [ ] DNS domain configured and propagated (`dig` returns the server IP)
- [ ] Ports 80 and 443 open (`ufw status`)
- [ ] `deploy` user created, SSH-key-only login (password disabled)
- [ ] `fail2ban` installed and active (optional but recommended)
- [ ] `.env.production.local` configured with `DOMAIN`, `STATS_USER`, `STATS_HASH` (with doubled dollars)
- [ ] `docker compose -f docker-compose.prod.yml --env-file .env.production.local ps` → **4 containers** (1 `Up`, 2 `Up (healthy)`, goaccess `Up`)
- [ ] `https://<domain>` reachable + valid SSL cert (HSTS preload present)
- [ ] GTFS upload tested (.zip → validation → schedules + map shown)
- [ ] `/stats/` reachable (basic_auth) after first traffic
- [ ] `/api/gtfs/upload-stats` reachable (basic_auth)
- [ ] Security headers verified (`curl -sI https://<domain>`)
- [ ] `CLIENT_TOKEN_SECRET` set (`openssl rand -hex 32`, its own secret) — without it the workspace answers `503 WORKSPACE_DISABLED`
- [ ] Daily cron job `/etc/cron.daily/gtfs-backup` configured and run once by hand: certificates, `projects_data` (accounts, workspace, frozen versions), `shares_data`, `beta/` (the AI use log), the API's logs (see [Backups](#backups)); a copy of `.env.production.local` kept safe elsewhere
- [ ] `TRUST_PROXY_HOPS` read on the server with `GET /api/gtfs/admin/client-address` (see [Client addresses behind the proxies](#client-addresses-behind-the-proxies-trust_proxy_hops))
- [ ] `LOG_RETENTION_DAYS`, the workspace's and shares' retention, and the AI budget against the per-account quotas decided (see [Logs](#logs), [AI budget and per-account quotas](#ai-budget-and-per-account-quotas))
- [ ] Accounts: `ACCOUNTS_ENABLED` left `false` until the `projects_data` volume has been handed to `appuser` and a mail provider is set (`MAIL_PROVIDER=brevo`, `MAIL_API_KEY`, `MAIL_FROM`), your own address in `ADMIN_EMAILS` (see [User accounts](#user-accounts-accounts_enabled))
- [ ] Paid offer: `TRIAL_DAYS` and the shown `LICENCE_PRICE_EUR_YEAR` (4 900 € HT by default, the owner's price of 2026-10-08) confirmed before `PAID_ACCESS_ENABLED=true`, and the Stripe yearly price (`STRIPE_PRICE_PRO`) equal to it
- [ ] Legal notice filled before the offer opens: `LEGAL_PUBLISHER`, `LEGAL_STATUS`, `LEGAL_ADDRESS`, `LEGAL_REGISTRATION`, `LEGAL_VAT`, `LEGAL_DIRECTOR`, `LEGAL_EMAIL` (or `SUPPORT_EMAIL`), `LEGAL_PHONE`, `LEGAL_HOST`; `https://<domain>/conditions/mentions-legales` shows no « non renseigné » (`legal.missing` empty in `GET /api/gtfs/config/features`), and the terms of sale and privacy read by the owner's counsel
- [ ] External monitoring set up on `/nginx-health` (UptimeRobot or equivalent)
- [ ] VPS RAM ≥ 4 GB (containers + OS + swap for large GTFS spikes)
- [ ] Road routing: `OSRM_URL` points to a self-hosted OSRM with a bus profile, not the public demo (see [Road routing for buses](#8-road-routing-for-buses))
- [ ] AI with EU processing required: `LLM_PROVIDER` set to `bedrock` (EU region) or `vertex` (`eu`), the model enabled in that region, `MODEL_PROVIDER_NAME` naming the processor (see [Model provider](#9-model-provider))

---

## 6. Security & best practices

- **HSTS preload**: the `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` header is sent by Caddy. The domain can be submitted to [hstspreload.org](https://hstspreload.org) for inclusion in the Chromium/Firefox/Safari list — **be aware: HTTPS commitment on the domain + every subdomain, irreversible for 1-2 years**.
- **CSP / X-Frame / X-Content-Type**: injected by Helmet (API) and by `security-headers.conf` (Nginx frontend).
- **Rate limiting**: express-rate-limit limiters in `app.js` (global, uploads, samples, SQL, revalidation, demand, auth, workspace, coverage, offer sheets, coherence exports…). Counted per IP — an account whose licence runs per account (`user:<id>`), with the higher `BETA_*` caps; the sign-in limiter always per IP — where the IP is `req.ip`, read `TRUST_PROXY_HOPS` hops back along `X-Forwarded-For`: with too few hops every visitor shares a proxy's bucket, see [Client addresses behind the proxies](#client-addresses-behind-the-proxies-trust_proxy_hops).
- **CORS**: strict on `https://${DOMAIN}` only in prod. Any cross-origin request is rejected.
- **CSRF**: an **Origin check**, no token and no double-submit cookie (`app.js`). Every `POST`, `PUT`, `PATCH` and `DELETE` whose `Origin` header is not in `ALLOWED_ORIGINS` is refused with `403`; a request without `Origin` passes (curl, scripts, server-to-server calls: no browser is involved, since a browser sends `Origin` on every cross-site state-changing request). CORS answers only `ALLOWED_ORIGINS` and allows credentials only with `ACCOUNTS_ENABLED=true`. The accounts' session cookie is `HttpOnly` and `SameSite=Lax`, so a cross-site form does not carry it; its `Secure` flag follows `req.secure`: the frontend's Nginx forwards Caddy's `X-Forwarded-Proto` (`https`) instead of its own scheme, so the cookie is `Secure` in production; HSTS adds the rest. The other credentials are headers (`X-Client-Token`, `X-Admin-Token`) that a cross-site page cannot set without a CORS preflight the allow-list refuses. This holds as long as no `GET` route changes state.
- **Prepared statements only**: no interpolation of user values into SQL (better-sqlite3 with `?`).
- **Non-root Docker**: the API runs as `appuser:appgroup` (non-root) inside the container.
- **`no-new-privileges:true`**: every prod container blocks runtime privilege escalation.
- **Network isolation**: only Caddy exposes ports on the host. API and frontend are unreachable from outside.

For an in-depth audit: see [SECURITY.md](SECURITY.md).

---

## 7. Full uninstall

```bash
cd /opt/gtfs-express
gtfs down -v  # stops + removes every volume (⚠️ TLS certificates, accounts, projects, shares lost)

# Remove built Docker images
docker images | grep gtfs-express | awk '{print $3}' | xargs docker rmi -f

# Remove source code and backups
sudo rm -rf /opt/gtfs-express /opt/backups

# Remove the dedicated firewall rules
sudo ufw delete allow 80/tcp
sudo ufw delete allow 443/tcp
```

---

## 8. Road routing for buses

The Network Studio and the Change Studio draw new line sections along the roads and time them from the road distance: the API calls an OSRM `route` endpoint (`OSRM_URL`, server-side, one request per direction or per new leg). Without routing (`NETWORK_ROUTING_ENABLED=false`, or a router that does not answer) new sections are straight lines × 1.3, flagged as such.

### Why the public OSRM demo is not for production

- **It routes a car.** `router.project-osrm.org` only runs the car profile: it does not know bus-only streets (`access=no` + `bus=yes` / `psv=yes`, bus gates), busways (`highway=busway`) or contraflow bus lanes (`oneway:bus=no`), and it ignores height and weight limits. Without an approach side it reaches a stop from whichever side is faster — a U-turn round the block for a stop on the other side, a detour round a one-way system. Measured on the libéA network (Albi): 7 of 20 directions came out 13–64 % longer than the real bus shapes (line 118: 13 km routed for 8.2 km).
- **It is a fair-use demo.** No SLA, rate-limited, may block heavy users; designing a 20-line network sends hundreds of requests, and every preview of a change plan routes its new legs again.
- **What the application does meanwhile.** A leg routed over twice the straight distance and over 300 m is flagged (`suspicious` in the router output; in the Change Studio a warning "the road route between A and B is 2.4× the straight distance: check the path in the Shape Studio"). Its path is kept for review, but its running time uses the straight distance × 1.3, never the doubtful route.

### Self-host OSRM with a bus profile

Everything below runs with the official image `ghcr.io/project-osrm/osrm-backend` (pin the version you tested). Extraction needs roughly 5–10× the size of the `.pbf` in RAM: extract on a bigger machine if needed and copy the `*.osrm*` files to the server.

1. **A regional OpenStreetMap extract** ([Geofabrik](https://download.geofabrik.de/)) covering the networks you serve, with some margin:

   ```bash
   sudo mkdir -p /opt/osrm && cd /opt/osrm
   wget https://download.geofabrik.de/europe/france/midi-pyrenees-latest.osm.pbf
   ```

2. **A bus profile adapted from `car.lua`.** Copy the car profile and its library from the image, then edit `bus.lua`:

   ```bash
   docker run --rm -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend sh -c "cp /opt/car.lua /data/bus.lua && cp -r /opt/lib /data/lib"
   ```

   | In `bus.lua` (car.lua field) | Car value | Bus value | Why |
   |---|---|---|---|
   | `access_tag_whitelist` | `yes, motorcar, motor_vehicle, vehicle, permissive, designated, hov` | add `bus`, `psv` | bus-only streets and bus gates (`access=no` + `bus=yes` / `psv=yes`) become routable |
   | `access_tags_hierarchy` | `motorcar, motor_vehicle, vehicle, access` | `bus, psv, motor_vehicle, vehicle, access` | a bus-specific tag wins (`motor_vehicle=no` + `psv=yes` is open to buses; `motorcar=no` no longer blocks them) |
   | `restrictions` | `motorcar, motor_vehicle, vehicle` | `bus, psv, motor_vehicle, vehicle` | turn restrictions for buses (`restriction:bus=*`, `except=psv`) |
   | `speeds.highway` | — | add `busway = 40` | `highway=busway` (dedicated bus roads, BRT) is routable |
   | oneway handling | `oneway` | read `oneway:bus` / `oneway:psv` before `oneway` | contraflow bus lanes (`oneway:bus=no`) |
   | `vehicle_height`, `vehicle_width`, `vehicle_length`, `vehicle_weight` | 2.0 m, 1.9 m, 4.8 m, 2 t | 3.5 m, 2.55 m, 12 m, 19 t (articulated: 18 m, 29 t) | `maxheight` / `maxwidth` / `maxweight` limits apply to buses |
   | `u_turn_penalty` | 20 | 60 or more | a 12 m bus rarely turns round in the street |
   | `continue_straight_at_waypoint` | `true` | keep `true` | no U-turn at a stop (the API does not send `continue_straight`: the profile decides) |

   Bus lanes (`busway=lane`, `lanes:bus`, `lanes:psv`) can also get a small speed bonus in the way handler so the route prefers them. Check the result on a few real lines of the network (the Shape Studio overlays the feed's shapes).

3. **Build and run** (MLD pipeline):

   ```bash
   cd /opt/osrm
   docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-extract -p /data/bus.lua /data/midi-pyrenees-latest.osm.pbf
   docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-partition /data/midi-pyrenees-latest.osrm
   docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-customize /data/midi-pyrenees-latest.osrm
   docker run -d --name osrm-bus --restart unless-stopped -v "$PWD:/data" \
     ghcr.io/project-osrm/osrm-backend osrm-routed --algorithm mld /data/midi-pyrenees-latest.osrm
   # Reachable by the API on the stack's internal network only (never published on the host):
   docker network connect "$(docker network ls --format '{{.Name}}' | grep '_internal$')" osrm-bus
   ```

   Rebuild every month or so (OpenStreetMap moves: roadworks, new bus lanes).

4. **Point the API at it** in `.env.production.local`, then restart the API:

   ```bash
   OSRM_URL=http://osrm-bus:5000/route/v1/driving   # osrm-routed ignores the profile word in the path
   NETWORK_ROUTING_ENABLED=true
   NETWORK_ROUTING_CURB=true                        # see below
   ```

   Check: `docker compose -f docker-compose.prod.yml --env-file .env.production.local exec api node -e "fetch(process.env.OSRM_URL + '/1.4436,43.6045;1.4530,43.6070').then(r => r.json()).then(j => console.log(j.code, j.routes[0].distance))"` prints `Ok` and a distance in metres.

### Curb approaches

`NETWORK_ROUTING_CURB=true` sends `approaches=curb` for every stop: the vehicle reaches each stop on the side of the road it serves (the right in right-hand traffic; `left_hand_driving` in the profile flips it). It removes most wrong-side U-turns — when each direction has its own stop, the usual GTFS practice in France. Leave it `false` (the default) when stops are shared by both directions (one pole for both ways, a stop in the middle of a square): one direction would otherwise loop round the block at each such stop. Either way, doubtful legs remain flagged.

---

## 9. Model provider

The assistant, the direct mode's agent and reviewer, the Network Studio's planner and the brief reader reach the model through one client, chosen by `LLM_PROVIDER` (`GTFS-EXPRESS-API/src/services/llm/provider.js`). The direct API stays the default. On the direct API, `inference_geo` offers only `us` or `global`: processing in the EU means **Amazon Bedrock in an EU region** or **Google Vertex AI in the `eu` multi-region**.

| Variable | Provider | What it does |
|---|---|---|
| `LLM_PROVIDER` | all | Empty or `anthropic`: the direct API. `bedrock`: Amazon Bedrock (its Messages endpoint, `https://bedrock-mantle.<region>.api.aws/anthropic`). `vertex`: Google Vertex AI. Any other value stops the API at boot in production (`FATAL: [llm] LLM_PROVIDER "…" is not one of anthropic, bedrock, vertex`) and turns the AI off elsewhere, with a warning. |
| `ANTHROPIC_API_KEY` | `anthropic` | The key of the direct API. Never sent by the two others: leave it empty there. |
| `LLM_AWS_REGION` | `bedrock` | Required, no default: `eu-west-3` (Paris) or `eu-central-1` (Frankfurt). `AWS_REGION` is never used in its place. |
| `LLM_VERTEX_PROJECT_ID` | `vertex` | Required: the Google Cloud project. |
| `LLM_VERTEX_REGION` | `vertex` | Default `eu`, the EU multi-region (`aiplatform.eu.rep.googleapis.com`); or one region where the model is offered. |
| `MODEL_PROVIDER_NAME` | all | The processor the web names before a document goes to the assistant, e.g. `Amazon Web Services (Bedrock, Paris)`. Empty: the web says "the assistant". |

A provider selected without its setting leaves the AI off: `/config/features` answers `"chat":{"enabled":false,…}`, the studios say the assistant is unavailable, the AI routes answer `503` naming what is missing, and the API logs it at boot (`[llm] LLM_AWS_REGION is missing (LLM_PROVIDER=bedrock): the AI features are off until it is set.`).

**What the provider receives, and what it never receives.** The brief and its documents (unless the person kept one from the assistant at ①), the conversation, the feed's data the tools read (lines, stops, timetables) and the contract's clauses. Never a person's name or e-mail: the contract says « decided by a named person », the chat's SQL tool cannot read the journal (`_edit_log`) nor the acknowledgements, and every request goes through a last filter (`GTFS-EXPRESS-API/src/services/llm/personalData.js`) that replaces the names and e-mails the request knows — the signed-in account, the acknowledgement name the browser declares, the contract's deciders, the working copy's journal and acknowledgements, the project's members — by a stable pseudonym (`[person-1a2b3c]`) wherever they appear, a document's text and title, an attachment's file name or the person's own message included. Two limits to say in your register: a name the server does not know (a third person named inside a brief) is sent as written, and a stop or a street that bears exactly a registered person's name is pseudonymised too.

**Credentials.** The provider's SDK resolves them at the first request; the API never logs them.

- Bedrock: the AWS default chain — `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (and `AWS_SESSION_TOKEN` for temporary ones), a profile (`AWS_PROFILE`, with `~/.aws` mounted), or the instance or task role on AWS. Outside AWS (the VPS of section 2), create an IAM user for the API alone, allowed to invoke the model on Bedrock in that region and nothing else, and put its key pair in `.env.production.local`. A Bedrock API key in `AWS_BEARER_TOKEN_BEDROCK`, when present in the API's environment, is used instead of the chain.
- Vertex: Google application default credentials — the service account attached to the machine on Google Cloud; elsewhere a service-account key file mounted read-only into the container (readable by its non-root user), with `GOOGLE_APPLICATION_CREDENTIALS` set to its path inside the container. The service account needs the Vertex AI User role on the project.

The compose files pass the four `LLM_*` variables and these credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `GOOGLE_APPLICATION_CREDENTIALS`) to the API container, empty unless set. The Vertex key file needs a mount of its own, for instance in a `docker-compose.override.prod.yml` added with a second `-f`:

```yaml
services:
  api:
    volumes:
      - /opt/gtfs-express/secrets/vertex-sa.json:/run/secrets/vertex-sa.json:ro
```

with `GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/vertex-sa.json` in `.env.production.local`.

**Enable the model first.** The model must be enabled in the cloud console, in the chosen region, before use: Bedrock's model access in that region, Vertex AI Model Garden for the project. Until it is, every AI request fails upstream and the studios say the assistant could not answer.

**Model ids.** Keep the first-party ids in `NL2SQL_MODEL`, `NL2SQL_CHAT_MODEL`, `NETWORK_PLANNER_MODEL`, `DIRECT_AGENT_MODEL`, `DIRECT_REVIEWER_MODEL` and `PLANNER_FREE_MODEL` (e.g. `claude-opus-5-5`). On Bedrock the API sends `anthropic.claude-opus-5-5`; an id already prefixed (`anthropic.…`, a cross-region `eu.anthropic.…`, an inference-profile ARN) is sent as is. Vertex takes the first-party ids unchanged. `NETWORK_PLANNER_EFFORT` reaches the same models whatever the form of the id (an ARN excepted: no effort is sent to it).

**What changes, what does not.** Prompt caching, tools, streaming, adaptive thinking and effort work the same on Bedrock and Vertex, as do the PDF briefs. The server-side `fallbacks` parameter (a direct-API option) is not used by GTFS Express. Prices and quotas are the cloud provider's; the AI caps (`NL2SQL_DAILY_BUDGET_TOTAL` and the per-account limits) count requests and apply unchanged.

**Check.**

```bash
gtfs exec api node -e "const c = require('./src/config'); console.log(c.LLM_PROVIDER, c.LLM_CONFIGURED)"
# → bedrock true
set -a; . ./.env.production.local; set +a
curl -sS https://$DOMAIN/api/gtfs/config/features | grep -o '"chat":{[^}]*}'
# → "chat":{"enabled":true,…}   (with NL2SQL_CHAT_ENABLED=true)
```

Then send one message to the assistant: the first request is the one that resolves the credentials and reaches the model.
