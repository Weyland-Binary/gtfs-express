# ── API runtime ──────────────────────────────────────────────────────────────
FROM node:24-alpine

WORKDIR /app

# TLS verification stays on for npm. Behind a TLS-intercepting corporate proxy, build with
# NPM_STRICT_SSL=false (the root .env, read by docker-compose.yml), never in CI or in
# production: the validator JAR is checksummed, npm's packages would not be (review of 2026-10-09).
ARG NPM_STRICT_SSL=true
RUN npm config set strict-ssl "${NPM_STRICT_SSL}"

# Official MobilityData GTFS validator (Java JAR). Pinned to a specific
# release for reproducibility — bump GTFS_VALIDATOR_VERSION when MD ships
# new rule logic we want to track. Adds ~80 MB JRE + ~38 MB JAR to the
# final image. Required at runtime: the API exits at boot in production
# when GTFS_CANONICAL_VALIDATOR_JAR is missing (no in-house fallback).
#
# Apache 2.0 §4(a) requires that recipients of the Object form receive
# a copy of the License. The JAR built by MobilityData does not embed
# a LICENSE file in META-INF, so we fetch it from the same release tag
# and ship it next to the JAR. See THIRD_PARTY_LICENSES.md at the repo
# root for the full notice and our compliance summary.
ARG GTFS_VALIDATOR_VERSION=8.0.0
# The JAR's SHA-256, checked after the download: with CURL_INSECURE (a proxy
# that breaks TLS) nothing else would prove the file is MobilityData's, and a
# substituted validator would vouch for every delivered feed. Bump it with the
# version (sha256sum of the release's gtfs-validator-<version>-cli.jar).
ARG GTFS_VALIDATOR_SHA256=8f9fff72057dcd7e1e6009fd065c2c274a9427aac7272c536f9acd2f58b71fe7
ARG CURL_INSECURE=false
ARG APK_INSECURE=false
RUN if [ "$APK_INSECURE" = "true" ]; then \
      sed -i 's|https://dl-cdn.alpinelinux.org|http://dl-cdn.alpinelinux.org|g' /etc/apk/repositories; \
    fi
RUN apk add --no-cache openjdk17-jre-headless curl \
 && if [ "$CURL_INSECURE" = "true" ]; then CURL_FLAGS="-fLk"; else CURL_FLAGS="-fL"; fi \
 && curl $CURL_FLAGS -o /opt/gtfs-validator-cli.jar \
      "https://github.com/MobilityData/gtfs-validator/releases/download/v${GTFS_VALIDATOR_VERSION}/gtfs-validator-${GTFS_VALIDATOR_VERSION}-cli.jar" \
 && echo "${GTFS_VALIDATOR_SHA256}  /opt/gtfs-validator-cli.jar" | sha256sum -c - \
 && curl $CURL_FLAGS -o /opt/gtfs-validator-LICENSE \
      "https://raw.githubusercontent.com/MobilityData/gtfs-validator/v${GTFS_VALIDATOR_VERSION}/LICENSE" \
 && apk del curl
ENV GTFS_CANONICAL_VALIDATOR_JAR=/opt/gtfs-validator-cli.jar

# Copy dependency files
COPY package.json package-lock.json ./

# Install only production dependencies, without their install scripts: the
# lockfile marks better-sqlite3 13 hasInstallScript (it has a binding.gyp), so
# `npm ci` ran `node-gyp rebuild`, which fails on Alpine without Python; the
# package ships its prebuilt binaries (linuxmusl-x64/arm64) and declares
# gypfile: false. The only other install script of the production tree is
# @scarf/scarf's telemetry. dockerInstallScripts.test.js keeps that list
# closed: a new dependency that needs its script must be looked at here.
RUN npm ci --omit=dev --ignore-scripts

# Copy source code
COPY src/ ./src/

# Copy OpenAPI spec (required at runtime by app.js)
COPY docs/ ./docs/
# The OCR language data a scanned PDF brief is read with (tessdata/README.md).
COPY tessdata/ ./tessdata/

# Copy sample GTFS dataset
COPY sample/ ./sample/

# The owner's one-off maintenance script, run in the container where
# IP_HASH_SECRET is the server's (DEPLOYMENT.md, Logs): it hashes the
# beta-code use log lines written before the « hashes only » rule.
COPY scripts/rewrite-beta-usage.js ./scripts/rewrite-beta-usage.js

# Create the mount points of the API's durable data, owned by the API user
# below so that a new named volume mounted there inherits that ownership on
# its first mount: the uploads (sessions, swept after idle time, and the
# event and upload logs), the projects (accounts, the workspace and its
# frozen versions: projects_data), the public shares (90 days:
# shares_data) and beta/, the AI use logs' folder bind-mounted from the host
# (nothing of it is copied: it is not in git, so a fresh clone builds as is).
RUN mkdir -p /app/uploads /app/projects /app/shares /app/beta

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3004

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3004/health || exit 1

CMD ["node", "--max-old-space-size=1800", "src/app.js"]
