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
| Ingest (POST /gtfs/upload, GET /gtfs/load-sample, POST /gtfs/network/catalog/open, POST /gtfs/share/{token}/open, the Network Studio build) | MobilityData canonical validator (Java JAR) — required at boot in production. The verified report is stored once as the session's modification baseline (`validationReportStore.saveBaseline`, `_validation_baseline.json`) |
| Re-validate (POST /gtfs/edit/validate) | same |
| Preview of a change plan with `validate: true` (POST /gtfs/transform/preview) | same, through `services/validatorGate.js` (measurement: a report that proves nothing blocks the gate, never reads as valid) |
| Every delivery gate — POST /gtfs/transform/commit, GET /gtfs/edit/export, GET /gtfs/edit/export/netex, POST /gtfs/share, POST /gtfs/share/{token}/versions, POST /gtfs/network/compile, the Project Studio approval and GTFS deliverable | same, through `services/validatorGate.js`: the one façade every delivery path calls (see "The delivery gate" below) |
| Edit handlers (`services/edit/*EditService.js`) | local `fieldValidators` only — sub-100ms response, no JAR call |

The boot guard in `app.js` calls
`canonicalValidatorService.assertReadyForProduction()` before binding
the listening port; in production the API exits(1) if the JAR is
missing or Java is not invokable. Non-production environments
(NODE_ENV=test, dev) keep a soft-warn behaviour at boot so unit tests
run without Java — but a delivery never goes through on a report the
validator did not produce: without the JAR, the unit tests
(NODE_ENV=test) get a deterministic stub, any other environment gets
an UNVERIFIED report, and every delivery path refuses it with 503
(previews and measurement keep working).

Per-edit CRUD is intentionally not gated by canonical validation.
The JAR has a ~1.5 s JVM cold-start per invocation, which would make
the editor unusable. Edits commit through the existing
`logEdit` + `syncCacheEntry` transaction; canonical validation runs on
demand (re-validate button) and before every delivery. A change
plan's commit (POST /gtfs/transform/commit) IS a delivery: the
validator runs on the feed as the plan would leave it and on the feed
as it is (or ran with the preview when `validate: true` was asked),
and the commit is refused when it cannot answer or finds a new error.

## The delivery gate (`services/validatorGate.js`)

Every path that delivers a GTFS reads the validator through one
façade, `validatorGate`, and never through a raw report:

- `validateDb(db, countryCode)` / `validateDir(dir, countryCode)` run
  the canonical validator (a SQLite feed is dumped to CSV first) and
  return the report only when it is VERIFIED: `valid` set, numeric
  `counts.errors`, no `unverified` flag. Otherwise they throw a typed
  refusal: `503 VALIDATOR_FAILED { validator_error }` when the engine
  ran and crashed (`engineError`, a timeout, a throw), `503
  VALIDATOR_UNAVAILABLE { reason: "not_installed" | "unverified" }` when
  the JAR is missing or the report is the unverified envelope. The
  caller writes nothing; there is no "unavailable, let it through"
  branch anywhere.
- `assertNoNewErrors(baseline, report)` compares the ERROR-severity
  findings by rule code with the session's baseline — the verified
  report of the feed as loaded, written once by
  `validationReportStore.saveBaseline` (never for an unverified
  report) — and throws `409 VALIDATION_NEW_ERRORS { new_errors: [{
  code, before, after }], preexisting }` when a rule counts more than
  it did. The two exports re-state it as 422 (their historical
  status) with the full `report`.
- `assertCreationValid(report)` throws `409 VALIDATION_ERRORS { errors,
  warnings, by_rule }` on any error: a creation (a Network Studio
  build, a share or a Project Studio deliverable without a baseline)
  carries none.
- Neither refusal can be acknowledged or forced: the admin `?force=true`
  export bypass is removed (`400 INVALID_INPUT`, audited as
  `export.force_refused`), and `acknowledge.validation` is ignored.
  Pre-existing errors are delivered announced: `X-GTFS-Validation:
  preexisting-errors=<n>` on the exports, `validation.preexisting_errors`
  on a share card, `validation.preexisting` on a deliverable.
- `deps.validateDb` / `deps.validateDir` are the only injection points
  of the HTTP-level tests; the engine's `commitPreview` takes
  `validate` for the engine-level tests. The level-0 suites under
  `src/__tests__/guarantees/` run each delivery path against a
  validator that throws, an unverified report and a report with a new
  error, and assert that nothing was written.

The guarantees this gate holds, whatever the model does: every GTFS
delivered is valid by the canonical validator (0 error for a creation,
0 NEW error for a modification — a client's feed may already carry
some); no delivery path bypasses the validator (commit, export, NeTEx,
share, compile, Project Studio approval and deliverable); a validator
that is missing or crashes refuses the delivery. Next to it, the
acknowledgement record (`services/acknowledgement.js`) holds that a
must clause failing or not measurable is delivered only when a NAMED
person accepts it, and the verdict module (`services/verdict.js`) that
the conformance verdict shown is the engine's, not the model's.
Accepted limitation: the comparison is by rule code, so an edit that
removes one occurrence of a rule and adds another of the same rule is
invisible.

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
   deliveries    │  validatorGate.js    │  │  runValidation(path, opts)
   (commit,      │  (assertVerified,    │  │
    export, netex│   assertNoNewErrors, │  │
    share,compile│   assertCreationValid│  │
    approve,     │   — refuses, never   │  │
    deliverable) │   lets through)      │  │
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

No-JAR behaviour (JAR unset):
  NODE_ENV=test: validateWithCanonical() returns a deterministic stub
  { valid: true, errors: {}, engine: "stub-no-jar" } (the unit tests;
  validatorGate.isAvailable() counts it as available there only).
  Any other non-production environment: an UNVERIFIED report
  { valid: null, unverified: true, engine: "unavailable" } and a loud
  warning — the validation routes show the feed as unverified, and
  every delivery path refuses it (503 VALIDATOR_UNAVAILABLE
  { reason: "unverified" }): nothing is delivered on it.
  Production never reaches either branch — the boot guard exits(1)
  at startup if the JAR or JRE is missing, and validateWithCanonical()
  throws (503 VALIDATOR_UNAVAILABLE { reason: "not_installed" }).
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
| `GTFS_CANONICAL_VALIDATOR_JAR` | `/opt/gtfs-validator-cli.jar` | In production the boot guard exits(1). Under the unit tests (NODE_ENV=test) the validation routes return the deterministic `engine: "stub-no-jar"` envelope. In any other environment they return an UNVERIFIED envelope and log a loud warning, and every delivery (commit, export, NeTEx, share, compile, Project Studio approval and deliverable) is refused with 503 VALIDATOR_UNAVAILABLE; previews and measurement keep working. |
| `JAVA_BIN` | `java` (PATH) | Override if multiple JREs are installed. |

To run the API locally without Java installed:

```bash
unset GTFS_CANONICAL_VALIDATOR_JAR && npm run dev
# Validation routes return the unverified envelope and every delivery
# (commit, export, NeTEx, share, compile, project approval and deliverable)
# answers 503 VALIDATOR_UNAVAILABLE; install Java + the JAR (or use
# `docker compose up`) to deliver anything. Jest sets NODE_ENV=test and
# gets the stub instead.
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
between the real engine, the test stub (`stub-no-jar`), and any future
backend. A report that proves nothing has `valid: null` and
`unverified: true` (an `engineError` says why when the engine ran and
failed); `validatorGate.isVerified()` is the one reader of that
distinction, and a delivery is refused on it.

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

These numbers are observed in batch contexts (upload, export). Per-edit
CRUD never invokes the JAR — see the architecture section above; a
change plan's commit runs it twice (the feed as it is, the feed as the
plan leaves it), a share or a version once, a Project Studio approval
or deliverable once per version, so these calls take seconds on big
feeds (the share and project calls queue behind the compute gate,
429 BUSY beyond it).

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
