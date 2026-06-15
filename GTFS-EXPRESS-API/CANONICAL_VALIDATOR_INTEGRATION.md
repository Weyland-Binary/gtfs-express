# MobilityData Canonical Validator Integration

## Why

GTFS Express delegates GTFS validation to the official
[MobilityData GTFS validator](https://github.com/MobilityData/gtfs-validator).
This guarantees that a feed accepted by GTFS Express is byte-for-byte
the same verdict as the validator the rest of the GTFS ecosystem trusts:
no drift on rule codes, no drift on severity, no drift on triggers,
thresholds, or processing pipeline.

The previous in-house validator (~6,000 lines under
`utils/gtfsValidator/`) has been removed entirely: validation is now
delegated to the canonical engine alone, so there is a single source
of truth and no risk of drift between two validators.

## What runs where

| Pipeline | Engine |
|---|---|
| Upload (POST /gtfs/upload) | MobilityData canonical validator (Java JAR) — required at boot in production |
| Re-validate (POST /gtfs/edit/validate) | same |
| Export gate (GET /gtfs/edit/export) | same |
| Edit handlers (`services/edit/*EditService.js`) | local `fieldValidators` only — sub-100ms response, no JAR call |

The boot guard in `app.js` calls
`canonicalValidatorService.assertReadyForProduction()` before binding
the listening port; in production the API exits(1) if the JAR is
missing or Java is not invokable. Non-production environments
(NODE_ENV=test, dev) keep a soft-warn behaviour so unit tests run
without Java.

Edit mode is intentionally not gated by per-edit canonical validation.
The JAR has a ~1.5 s JVM cold-start per invocation, which would make
the editor unusable. Edits commit through the existing
`logEdit` + `syncCacheEntry` transaction; canonical validation runs on
demand (re-validate button) or implicitly before export.

## Licensing

The MobilityData GTFS validator JAR is distributed under the
Apache License 2.0 (© MobilityData). Our redistribution obligations
(Apache 2.0 §4) and the full license text live in
[`THIRD_PARTY_LICENSES.md`](../THIRD_PARTY_LICENSES.md) at the repo
root. The Dockerfile additionally fetches the upstream `LICENSE`
file at the same pinned release tag and stores it at
`/opt/gtfs-validator-LICENSE` inside the API image — this is the
copy of the License that travels with the binary distribution
(Apache 2.0 §4(a)).

## Architecture

```
                 ┌──────────────────────┐
   POST /upload  │  uploadService.js    │
   POST /validate│  validationService.js├──┐
   GET  /export  │  exportService.js    │  │  runValidation(path, opts)
                 └──────────────────────┘  │
                                           ▼
                          ┌────────────────────────────────────┐
                          │ canonicalValidator                 │
                          │   .validateWithCanonical()         │
                          │ → spawn java -jar gtfs-validator   │
                          │ → parse report.json                │
                          └────────────────────────────────────┘
                                            │
                                            ▼
                            applyMdCanonicalFilter()  (defense-in-depth:
                                            │         strips any rule code
                                            │         not in rules.json)
                                            ▼
                                  applyProfileToReport()
                                            ▼
                                   applyLocaleToReport()
                                            ▼
                                          report

Non-production fallback (NODE_ENV != "production" + JAR unset):
  validateWithCanonical() returns a deterministic stub
  { valid: true, errors: {}, engine: "stub-no-jar" } and logs a loud
  warning. Production never reaches this branch — the boot guard
  exits(1) at startup if the JAR or JRE is missing.
```

## Container changes

Already merged into [`Dockerfile`](Dockerfile):

```Dockerfile
ARG GTFS_VALIDATOR_VERSION=8.0.0
RUN apk add --no-cache openjdk17-jre-headless curl \
 && curl -fL -o /opt/gtfs-validator-cli.jar \
      "https://github.com/MobilityData/gtfs-validator/releases/download/v${GTFS_VALIDATOR_VERSION}/gtfs-validator-${GTFS_VALIDATOR_VERSION}-cli.jar" \
 && apk del curl
ENV GTFS_CANONICAL_VALIDATOR_JAR=/opt/gtfs-validator-cli.jar
```

Image size impact: ~+118 MB (~80 MB JRE-headless, ~38 MB JAR). The
`curl` package is removed in the same layer to keep the image clean.

To bump the validator version, change the `GTFS_VALIDATOR_VERSION`
build arg:

```bash
docker build --build-arg GTFS_VALIDATOR_VERSION=8.1.0 ./GTFS-EXPRESS-API
```

## Operational toggles

| Variable | Default (after build) | Effect when unset / empty |
|---|---|---|
| `GTFS_CANONICAL_VALIDATOR_JAR` | `/opt/gtfs-validator-cli.jar` | In production the boot guard exits(1). In dev/test, validation routes return the `engine: "stub-no-jar"` no-op envelope and log a loud warning. |
| `JAVA_BIN` | `java` (PATH) | Override if multiple JREs are installed. |

To run the API locally without Java installed:

```bash
unset GTFS_CANONICAL_VALIDATOR_JAR && npm run dev
# Validation routes return the stub envelope; install Java + the JAR
# (or use `docker compose up`) to exercise the real engine end-to-end.
```

## Output shape contract

`canonicalValidatorService.parseReport()` returns:

```js
{
  valid: boolean,                 // true iff zero ERROR
  errors: { "<file>": [ { ruleCode, severity, lineNumber, field,
                         message, entityType, entityId, aggregate? } ]},
  counts: { errors, warnings, infos },
  profile: "canonical",
  engine: "mobilitydata-canonical"
}
```

The `engine` field lets callers (admin dashboards, tests) distinguish
between the real engine, the dev stub (`stub-no-jar`), and any future
backend.

## Truncation handling

MD's `report.json` truncates each rule to 5 sample notices and
exposes `totalNotices`. We expand the 5 samples into 5 individual
findings, then add one `aggregate: true` marker per file with the
remaining count so the UI shows truthful totals without us re-running
with `--sample_size 1000000`.

## Performance

- Cold start: ~1.5s JVM boot per spawn (no daemon mode).
- Validation of a 50k-row feed: ~5 s wall-clock on the 1-vCPU prod box.
- Validation of a 500k-row feed (RATP scale): ~30 s.

These numbers are observed in batch contexts (upload, export). Edit
mode never invokes the JAR — see the architecture section above.

## In-house engine removal

The former in-house validator (~6,000 lines under
`utils/gtfsValidator/`) and the 15 house-specific rules have been
removed; the dispatcher in `uploadService.js`, `validationService.js`
and `exportService.js` is gone, and those services call
`canonicalValidatorService.validateWithCanonical()` directly. The
catalogue is now 178 rules, all MobilityData-aligned. The per-edit
`respondWithValidation()` helper returns a deterministic
`{ items: [], skipped: true, reason: ... }` envelope so the
~50 edit-handler call sites stay backwards-compatible.
