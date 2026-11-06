#!/usr/bin/env sh
# deploy/staging/down.sh — stop and remove the staging containers and their
# network (project gtfs-staging only). The staging data volumes are KEPT
# unless you pass --volumes, which removes gtfs-staging_staging_uploads,
# gtfs-staging_staging_projects, gtfs-staging_staging_shares and
# gtfs-staging_staging_beta and nothing else. Never prunes images,
# volumes or the system.
#
#   sh deploy/staging/down.sh            # stop, keep the staging data
#   sh deploy/staging/down.sh --volumes  # stop and delete the staging data
set -eu
cd "$(dirname "$0")/../.."
if [ "${1:-}" = "--volumes" ]; then
  exec docker compose -p gtfs-staging -f deploy/staging/docker-compose.staging.yml --env-file deploy/staging/.env.staging down --volumes
fi
exec docker compose -p gtfs-staging -f deploy/staging/docker-compose.staging.yml --env-file deploy/staging/.env.staging down
