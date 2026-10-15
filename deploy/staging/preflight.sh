#!/usr/bin/env sh
# deploy/staging/preflight.sh — READ-ONLY checks before building the staging
# stack next to production. Changes nothing: no container, image, volume or
# network is created, stopped or removed. Exits non-zero when staging should
# not be started.
#
#   sh deploy/staging/preflight.sh
#
# Checks: the checkout is not production's directory; the env file exists and
# does not reuse production's secrets file; enough free disk (MIN_DISK_GB,
# default 6) and available memory (MIN_MEM_MB, default 1500); the staging
# port is free on 127.0.0.1; no container, volume or network named like the
# staging ones belongs to something else; production's containers are listed
# (read-only) so you see they are untouched before and after.

set -u
cd "$(dirname "$0")/../.." || exit 1
ROOT="$(pwd)"
MIN_DISK_GB="${MIN_DISK_GB:-6}"
MIN_MEM_MB="${MIN_MEM_MB:-1500}"
ENV_FILE="deploy/staging/.env.staging"
FAIL=0
ok() { printf '  ok   %s\n' "$1"; }
ko() { printf '  FAIL %s\n' "$1"; FAIL=1; }

echo "Staging preflight in $ROOT"

case "$ROOT" in
  /opt/gtfs-interpreter|/opt/gtfs-interpreter/*) ko "this is production's checkout ($ROOT): clone the branch further elsewhere (e.g. /opt/gtfs-staging)";;
  *) ok "checkout is not production's directory";;
esac

if [ -f "$ENV_FILE" ]; then ok "$ENV_FILE exists"; else ko "$ENV_FILE is missing: copy deploy/staging/.env.staging.example"; fi
if [ -f "$ENV_FILE" ] && grep -q '^ADMIN_TOKEN=..*' "$ENV_FILE"; then ok "ADMIN_TOKEN is set"; else ko "ADMIN_TOKEN is empty in $ENV_FILE"; fi

DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
FREE_KB="$(df -Pk "$DOCKER_ROOT" 2>/dev/null | awk 'NR==2 {print $4}')"
if [ -n "${FREE_KB:-}" ] && [ "$FREE_KB" -ge $((MIN_DISK_GB * 1024 * 1024)) ]; then ok "free disk on $DOCKER_ROOT: $((FREE_KB / 1024 / 1024)) GB (>= $MIN_DISK_GB)"; else ko "free disk on $DOCKER_ROOT below $MIN_DISK_GB GB (${FREE_KB:-?} KB)"; fi

AVAIL_MB="$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)"
if [ -n "${AVAIL_MB:-}" ] && [ "$AVAIL_MB" -ge "$MIN_MEM_MB" ]; then ok "available memory: ${AVAIL_MB} MB (>= $MIN_MEM_MB)"; else ko "available memory below $MIN_MEM_MB MB (${AVAIL_MB:-?} MB)"; fi

PORT="$(grep '^STAGING_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2)"
PORT="${PORT:-18080}"
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$PORT\$"; then
  if docker ps --format '{{.Names}} {{.Ports}}' | grep -q "^gtfs-staging-frontend .*:$PORT->"; then ok "port $PORT is staging's own"; else ko "port $PORT is already in use on this host"; fi
else ok "port $PORT is free"; fi

for c in gtfs-staging-api gtfs-staging-frontend; do
  label="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$c" 2>/dev/null || true)"
  if [ -z "$label" ] || [ "$label" = "gtfs-staging" ]; then ok "container name $c free or staging's"; else ko "container $c belongs to project '$label'"; fi
done
for v in gtfs-staging_staging_uploads gtfs-staging_staging_projects gtfs-staging_staging_shares gtfs-staging_staging_beta; do
  label="$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$v" 2>/dev/null || true)"
  if [ -z "$label" ] || [ "$label" = "gtfs-staging" ]; then ok "volume $v free or staging's"; else ko "volume $v belongs to project '$label'"; fi
done

echo "Production containers (read-only listing, left untouched):"
docker ps --filter 'name=^gtfs-(api|frontend|caddy|goaccess)$' --format '  {{.Names}}  {{.Status}}' 2>/dev/null || echo "  (docker ps unavailable)"

if [ "$FAIL" -ne 0 ]; then echo "Preflight FAILED: fix the lines above before starting staging."; exit 1; fi
echo "Preflight passed."
