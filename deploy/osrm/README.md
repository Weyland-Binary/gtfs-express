# Road routing for buses: a self-hosted OSRM

The shape editor and the change engine draw new sections along the roads through the API's `POST /edit/route`, which
asks the OSRM at `OSRM_URL`. By default that is the public demo, which routes a car: on Albi's network 7 directions out
of 20 came out 13 to 64 % longer than the real bus shapes (DEPLOYMENT.md § 8, « Road routing for buses »). This folder
holds what the document describes, ready to run.

| File | What |
|---|---|
| `derive-bus-profile.js` | Writes `bus.lua` from the image's `car.lua`: bus-only streets and gates (`bus=yes`, `psv=yes`), busways, a bus's height, width, length and weight, a U-turn penalty of 60; `restrictions` starting with `bus` and `psv` also makes the library read `oneway:bus` and `restriction:bus` first (contraflow bus lanes, turn restrictions for buses). Each change is applied to a line it expects: a `car.lua` of another version stops it rather than giving a silent car profile. |
| `build.sh` | Downloads a Geofabrik extract, derives the profile, runs `osrm-extract`, `osrm-partition` and `osrm-customize` (the MLD pipeline), and writes `<data>/.env` for the compose file. |
| `docker-compose.osrm.yml` | The `osrm-bus` service on the stack's internal network, read-only data, a health check. |

## On the production server

```bash
# 1. The graph (extraction needs 5 to 10 times the extract's size in RAM; build elsewhere and copy *.osrm* if short).
bash deploy/osrm/build.sh europe/france/hauts-de-france /opt/osrm

# 2. The router, beside the stack.
docker compose --env-file /opt/osrm/.env -f deploy/osrm/docker-compose.osrm.yml up -d

# 3. The API points at it (.env.production.local), then restarts.
OSRM_URL=http://osrm-bus:5000/route/v1/driving
NETWORK_ROUTING_ENABLED=true
```

Several regions: build each extract into its own folder and run one `osrm-bus-<region>` each, or merge the extracts
with `osmium merge` before `build.sh`. Rebuild every month or so: OpenStreetMap moves (roadworks, new bus lanes).

## In the lab

The lab's `docker-compose.override.yml` (ignored by git) declares the same `osrm-bus` service in the lab's own compose
project (the graph folder mounted read-only, `build.sh <region> <folder>` having built it) and sets
`OSRM_URL=http://osrm-bus:5000/route/v1/driving` on the API; `OSRM_URL=` empty in the shell puts the public demo back.
Check the result on a few real lines of the network: in the Shape Studio, re-route a section and compare with the
feed's own shape.
