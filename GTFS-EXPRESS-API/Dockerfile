# ── Stage 1: NeTEx France converter (gtfs2netexfr) ───────────────────────────
# gtfs2netexfr (hove-io/transit_model, AGPL-3.0) converts GTFS to the NeTEx
# France profile — the same converter behind transport.data.gouv.fr. Hove no
# longer publishes public binaries or Docker Hub images, so we build it from
# the pinned source tag. Links dynamically against Alpine's PROJ (crate
# proj 0.31 ⇔ PROJ 9.6, hence -crt-static off).
# NETEX_ENABLED=false skips the heavy Rust build (e.g. behind a corporate
# TLS-intercepting proxy where crates.io is unreachable): the final image
# then ships without the binary and the API answers 503 on /export/netex.
FROM rust:1-alpine AS netex-builder
ARG GTFS2NETEXFR_VERSION=v0.80.3
ARG NETEX_ENABLED=true
ARG APK_INSECURE=false
RUN if [ "$APK_INSECURE" = "true" ]; then \
      sed -i 's|https://dl-cdn.alpinelinux.org|http://dl-cdn.alpinelinux.org|g' /etc/apk/repositories; \
    fi
ENV RUSTFLAGS="-C target-feature=-crt-static"
RUN mkdir -p /out \
 && if [ "$NETEX_ENABLED" = "true" ]; then \
      apk add --no-cache musl-dev build-base pkgconfig proj-dev clang-dev git \
      && git clone --depth 1 --branch ${GTFS2NETEXFR_VERSION} https://github.com/hove-io/transit_model /src \
      && cargo build --release --manifest-path /src/Cargo.toml --package gtfs2netexfr \
      && strip /src/target/release/gtfs2netexfr \
      && cp /src/target/release/gtfs2netexfr /out/gtfs2netexfr \
      && cp /src/LICENSE /out/gtfs2netexfr-LICENSE; \
    fi

# ── Stage 2: API runtime ─────────────────────────────────────────────────────
FROM node:24-alpine

WORKDIR /app

# Bypass corporate SSL proxy during build
RUN npm config set strict-ssl false

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
ARG CURL_INSECURE=false
ARG APK_INSECURE=false
RUN if [ "$APK_INSECURE" = "true" ]; then \
      sed -i 's|https://dl-cdn.alpinelinux.org|http://dl-cdn.alpinelinux.org|g' /etc/apk/repositories; \
    fi
RUN apk add --no-cache openjdk17-jre-headless curl \
 && if [ "$CURL_INSECURE" = "true" ]; then CURL_FLAGS="-fLk"; else CURL_FLAGS="-fL"; fi \
 && curl $CURL_FLAGS -o /opt/gtfs-validator-cli.jar \
      "https://github.com/MobilityData/gtfs-validator/releases/download/v${GTFS_VALIDATOR_VERSION}/gtfs-validator-${GTFS_VALIDATOR_VERSION}-cli.jar" \
 && curl $CURL_FLAGS -o /opt/gtfs-validator-LICENSE \
      "https://raw.githubusercontent.com/MobilityData/gtfs-validator/v${GTFS_VALIDATOR_VERSION}/LICENSE" \
 && apk del curl
ENV GTFS_CANONICAL_VALIDATOR_JAR=/opt/gtfs-validator-cli.jar

# NeTEx France converter (optional — see stage 1). /out is empty when
# NETEX_ENABLED=false: the COPY then adds nothing, the runtime check in
# netexExportService disables the endpoint, and `proj` is not installed.
ARG NETEX_ENABLED=true
COPY --from=netex-builder /out/ /opt/netex/
RUN if [ "$NETEX_ENABLED" = "true" ]; then apk add --no-cache proj; fi
ENV GTFS2NETEXFR_BIN=/opt/netex/gtfs2netexfr

# Copy dependency files
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/

# Copy OpenAPI spec (required at runtime by app.js)
COPY docs/ ./docs/

# Copy sample GTFS dataset
COPY sample/ ./sample/

# Copy beta directory (contains codes.example.json + slot for codes.json
# if BETA_GATE_DISABLED=false in production; usage.jsonl is created at runtime).
# If beta/ does not exist in the context, this COPY only creates the empty folder.
COPY beta/ ./beta/

# Create uploads directory
RUN mkdir -p /app/uploads

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3004

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3004/health || exit 1

CMD ["node", "--max-old-space-size=1800", "src/app.js"]
