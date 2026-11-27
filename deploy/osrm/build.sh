#!/usr/bin/env bash
# Builds an OSRM graph with the bus profile from an OpenStreetMap extract, ready for docker-compose.osrm.yml.
#
#   bash deploy/osrm/build.sh europe/france/hauts-de-france [/opt/osrm]
#
# The first argument is the Geofabrik path of the extract (no extension); the second the data folder (default
# /opt/osrm). Extraction needs roughly 5 to 10 times the extract's size in RAM: run it where there is room and
# copy the *.osrm* files to the server if need be. DEPLOYMENT.md § 8 says why the public demo is not for production.
set -euo pipefail

REGION="${1:?Geofabrik path, e.g. europe/france/hauts-de-france}"
DATA="${2:-/opt/osrm}"
IMAGE="${OSRM_IMAGE:-ghcr.io/project-osrm/osrm-backend:v5.27.1}"
# The folder of this script, as a Windows path under Git Bash (pwd -W) so Node and Docker read it alike.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && (pwd -W 2>/dev/null || pwd))"
NAME="$(basename "$REGION")-latest"

mkdir -p "$DATA"
cd "$DATA"

if [ ! -f "$NAME.osm.pbf" ]; then
  echo "downloading $REGION"
  curl -fL -o "$NAME.osm.pbf" "https://download.geofabrik.de/$REGION-latest.osm.pbf"
fi

# The car profile and its library from the image, the bus profile derived from it.
docker run --rm -v "$DATA:/data" "$IMAGE" sh -c "cp /opt/car.lua /data/car.lua && cp -r /opt/lib /data/lib"
node "$HERE/derive-bus-profile.js" "$DATA/car.lua" "$DATA/bus.lua"

echo "extracting with the bus profile"
docker run --rm -t -v "$DATA:/data" "$IMAGE" osrm-extract -p /data/bus.lua "/data/$NAME.osm.pbf"
docker run --rm -t -v "$DATA:/data" "$IMAGE" osrm-partition "/data/$NAME.osrm"
docker run --rm -t -v "$DATA:/data" "$IMAGE" osrm-customize "/data/$NAME.osrm"

echo "OSRM_DATA=$DATA" > "$DATA/.env"
echo "OSRM_GRAPH=$NAME.osrm" >> "$DATA/.env"
echo "done: $DATA/$NAME.osrm (see $DATA/.env); start it with docker-compose.osrm.yml"
