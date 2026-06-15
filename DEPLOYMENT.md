# Deployment Guide — GTFS Express

This document covers two scenarios:

1. **Local** — testing on your machine (Windows / macOS / Linux) with Docker Desktop or Docker Engine
2. **Production** — deployment on an OVH VPS (or any Linux server) with automatic HTTPS

> Last reviewed: 2026-04-22 — aligned with `docker-compose.yml`, `docker-compose.prod.yml`, `Caddyfile`, `nginx.conf`, `.env.production.example`, and the `Dockerfile`s.

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
| `IP_HASH_SECRET` | — | required | HMAC salt for IP/beta-code anonymization in audit logs (`openssl rand -hex 32`). API exits at boot in prod when missing/default. |
| `BETA_GATE_DISABLED` | `true` (.env.example) | `true` → set `false` | Beta gate. Keep `false` in prod once `beta/codes.json` is deployed — it gates edit mode AND the AI features. |
| `ANTHROPIC_API_KEY` | — | optional | Claude API key. Without it every AI surface is hidden/disabled. |
| `NL2SQL_ENABLED` | `true` | `true` | One-shot NL2SQL kill switch. |
| `NL2SQL_CHAT_ENABLED` | `false` | `false` → set `true` | AI repair companion (chat FAB + guided repair). |
| `NL2SQL_CHAT_MODEL` | default `claude-sonnet-4-6` | same | Chat model for coded users; anonymous free-trial turns use `NL2SQL_MODEL` (Haiku). |
| `NL2SQL_FREE_MESSAGES_PER_SESSION` | default 5 | same | Anonymous free trial (0 disables). Daily per-IP cap: `NL2SQL_FREE_MESSAGES_PER_IP_DAY` (15). |
| `MAINTENANCE` | — | `false` | `true` → Caddy serves a static 503 maintenance page on every route (see Maintenance mode below). |
| `NETEX_ENABLED` | `true` (build arg) | `true` | Compiles the gtfs2netexfr converter into the API image (NeTEx France export). `false` skips the ~10 min Rust build; the endpoint then answers 503 and the UI hides the option. |

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
| Stop + purge uploads | `gtfs down -v` |
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

### Update the application

Full procedure, run in order. Every command is non-destructive up to `gtfs up -d --build`.

#### a) Pre-deployment (1 min)

```bash
cd /opt/gtfs-express   # or /opt/gtfs-interpreter depending on your historical install

# 1. Snapshot the current commit for fast rollback
git rev-parse HEAD > /tmp/gtfs-prev-sha.txt
echo "Rollback SHA: $(cat /tmp/gtfs-prev-sha.txt)"

# 2. Verify your .env.production.local — ALL these vars must be present and non-empty
grep -E '^(DOMAIN|ADMIN_TOKEN|IP_HASH_SECRET|STATS_HASH|ANTHROPIC_API_KEY)=' \
  .env.production.local | grep -v '^#'
# If IP_HASH_SECRET is missing (the API exits(1) at boot in prod without it):
#   echo "IP_HASH_SECRET=$(openssl rand -hex 32)" >> .env.production.local
# IP_HASH_SECRET must be DISTINCT from ADMIN_TOKEN (CLAUDE.md strict rule #9).

# 3. Disk space (the validation engine ships OpenJDK 17 + JAR ~38 MB)
df -h /
docker system df

# 4. Preview what's changing (commits, modified files)
git fetch origin
git log --oneline HEAD..origin/main | head -20
git diff --stat HEAD..origin/main | tail -5
```

#### b) Pull + rebuild + restart

```bash
# Pull main
git checkout main
git pull --ff-only origin main

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
curl -fsS https://$DOMAIN/api/health && echo
# Expected: {"status":"ok","uptime":...}

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

#### d) Express rollback

If a check fails or a user reports broken behaviour:

```bash
cd /opt/gtfs-express
git checkout $(cat /tmp/gtfs-prev-sha.txt)
gtfs up -d --build
gtfs logs -f --tail=30 api   # reconfirm "Server is running"
```

#### Operational notes

- **Downtime**: ~30-60 s during rebuild + restart (Caddy returns 502 while the frontend restarts). For strict zero-downtime, plan a 2nd stack + external load-balancer.
- **Lost active sessions**: in-flight uploads on the `uploads_data` volume survive (named persistent volume), but the in-memory sessions on the API side are lost. If users are mid-edit, they will lose unexported changes. Notify them when applicable.
- **Docker cache**: a rebuild that changes neither `Dockerfile` nor `package-lock.json` reuses layers → near-instant. Bumping `GTFS_VALIDATOR_VERSION` in the `Dockerfile` invalidates the `apk add openjdk + curl JAR` layer and re-triggers the JAR download (~38 MB).
- **Schema migration**: if the pulled commit bumps `SCHEMA_VERSION` in [GTFS-EXPRESS-API/src/services/db/schema.js](GTFS-EXPRESS-API/src/services/db/schema.js), existing on-disk sessions are migrated at boot. A `migrationDurability.test.js` test must accompany the bump (cf. CLAUDE.md). No manual deployment action required.

### Backups

**Volumes created by the prod stack**:

| Volume | Contents | Backup criticality |
|---|---|---|
| `gtfs-express_caddy_data` | **Let's Encrypt TLS certificates** + ACME state | 🔴 **CRITICAL** — otherwise reissue at restart (LE rate-limit 50/week/domain) |
| `gtfs-express_caddy_logs` | Rotated JSON logs (10 MB × 5) | 🟡 Medium — post-hoc audit |
| `gtfs-express_goaccess_html` | `/stats/` HTML dashboard | 🟢 Low — automatically regenerated |
| `gtfs-express_caddy_config` | Caddy runtime config | 🟢 Low — rebuilt from `Caddyfile` |
| `gtfs-express_uploads_data` | User sessions (TTL 1h) | 🟢 Low — ephemeral data |

**Critical backup (TLS certificates)**:

```bash
docker run --rm \
  -v gtfs-express_caddy_data:/data \
  -v /opt/backups:/backup \
  alpine tar czf /backup/caddy_data_$(date +%Y%m%d).tar.gz -C /data .
```

**Restore**:

```bash
gtfs down
docker run --rm \
  -v gtfs-express_caddy_data:/data \
  -v /opt/backups:/backup \
  alpine tar xzf /backup/caddy_data_20260422.tar.gz -C /data
gtfs up -d
```

**Daily automation** (`/etc/cron.daily/gtfs-backup`):

```bash
#!/bin/sh
docker run --rm \
  -v gtfs-express_caddy_data:/data \
  -v /opt/backups:/backup \
  alpine tar czf /backup/caddy_data_$(date +%Y%m%d).tar.gz -C /data .

# Keep 30 days
find /opt/backups -name 'caddy_data_*.tar.gz' -mtime +30 -delete
```

```bash
chmod +x /etc/cron.daily/gtfs-backup
```

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
| API container OOM-killed | GTFS session too large vs 1800 MB heap | Reduce `MAX_SESSIONS`, increase VPS RAM, or edit `--max-old-space-size` in `GTFS-EXPRESS-API/Dockerfile` |
| Disk full | Stale Docker images + orphan volumes | `docker system prune -af --volumes` (⚠️ **never** on a system whose volumes you care about) |
| `docker-compose` ignores `.env.production.local` | `--env-file` flag missing | Every prod command must include `--env-file .env.production.local` |
| Build fails with `failed to fetch anonymous token: ... lookup auth.docker.io on 127.0.0.53:53: server misbehaving` | Broken systemd-resolved on the VPS | `sudo systemctl restart systemd-resolved` then rerun the build. If the issue recurs, create `/etc/docker/daemon.json` with `{ "dns": ["1.1.1.1", "8.8.8.8"] }` then `sudo systemctl restart docker` (Cloudflare/Google DNS, independent of the local resolver) |
| `curl: (6) Could not resolve host: api` or (5) during post-deploy checks | `${DOMAIN}` is undefined in your shell (Compose reads it from `.env`, not the shell) | `set -a; . ./.env.production.local; set +a` BEFORE the `curl https://$DOMAIN/...`. Or substitute the domain literally in the command. |
| `FATAL: [canonicalValidator] GTFS_CANONICAL_VALIDATOR_JAR is not set` | Env var lost (custom image override?) | Verify the official `Dockerfile` sets `ENV GTFS_CANONICAL_VALIDATOR_JAR=/opt/gtfs-validator-cli.jar`. The boot guard refuses to start in prod without it (cf. strict CLAUDE.md rule). |
| `engine:"stub-no-jar"` in the prod upload response | `NODE_ENV` not set to `production` (the stub should only be active in dev/test) | `gtfs exec api node -e 'console.log(process.env.NODE_ENV)'` must print `production`. Otherwise `docker-compose.prod.yml` is misread — confirm `--env-file` and the `api.environment.NODE_ENV=production` service entry. |

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
- [ ] Daily cron job configured for `caddy_data` volume backup
- [ ] External monitoring set up on `/nginx-health` (UptimeRobot or equivalent)
- [ ] VPS RAM ≥ 4 GB (containers + OS + swap for large GTFS spikes)

---

## 6. Security & best practices

- **HSTS preload**: the `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` header is sent by Caddy. The domain can be submitted to [hstspreload.org](https://hstspreload.org) for inclusion in the Chromium/Firefox/Safari list — **be aware: HTTPS commitment on the domain + every subdomain, irreversible for 1-2 years**.
- **CSP / X-Frame / X-Content-Type**: injected by Helmet (API) and by `security-headers.conf` (Nginx frontend).
- **Rate limiting**: two express-rate-limit limiters (global + uploads + samples) visible in `app.js`. Counter is per IP (`X-Forwarded-For` honoured via `trust proxy`).
- **CORS**: strict on `https://${DOMAIN}` only in prod. Any cross-origin request is rejected.
- **CSRF**: double-submit cookie on edit routes (see `SECURITY.md`).
- **Prepared statements only**: no interpolation of user values into SQL (better-sqlite3 with `?`).
- **Non-root Docker**: the API runs as `appuser:appgroup` (non-root) inside the container.
- **`no-new-privileges:true`**: every prod container blocks runtime privilege escalation.
- **Network isolation**: only Caddy exposes ports on the host. API and frontend are unreachable from outside.

For an in-depth audit: see [SECURITY.md](SECURITY.md).

---

## 7. Full uninstall

```bash
cd /opt/gtfs-express
gtfs down -v  # stops + removes every volume (⚠️ TLS certificates lost)

# Remove built Docker images
docker images | grep gtfs-express | awk '{print $3}' | xargs docker rmi -f

# Remove source code and backups
sudo rm -rf /opt/gtfs-express /opt/backups

# Remove the dedicated firewall rules
sudo ufw delete allow 80/tcp
sudo ufw delete allow 443/tcp
```
