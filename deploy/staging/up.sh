#!/usr/bin/env sh
# deploy/staging/up.sh — build and start the staging stack (project
# gtfs-staging) after the read-only preflight. Touches only gtfs-staging_*
# containers, volumes and its network; never production's, never Caddy,
# never an image prune.
#
#   sh deploy/staging/up.sh
set -eu
cd "$(dirname "$0")/../.."
sh deploy/staging/preflight.sh
exec docker compose -p gtfs-staging -f deploy/staging/docker-compose.staging.yml --env-file deploy/staging/.env.staging up -d --build
