/**
 * canonicalValidator.integration.test.js — exercises the real
 * MobilityData canonical validator JAR via spawn(java).
 *
 * Skipped automatically when GTFS_CANONICAL_VALIDATOR_JAR is not set,
 * which is the default for fast unit-test runs (covered by
 * canonicalValidatorService.test.js with the test stub).
 *
 * The dedicated `canonical-integration` CI job sets the env var, so
 * this file is the only one that proves the JAR + JVM + report.json
 * shape contract is intact end-to-end against the published
 * MobilityData artefact.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const archiver = require("archiver");

const {
  validateWithCanonical,
  isEnabled,
} = require("../canonicalValidatorService");

const SAMPLE_DIR = path.resolve(__dirname, "..", "..", "..", "sample");

// Skip the whole suite when the JAR is not wired in.
const describeIfEnabled = isEnabled() ? describe : describe.skip;

const zipSampleFeed = async () => {
  const zipPath = path.join(
    os.tmpdir(),
    `gtfs-canon-${crypto.randomBytes(6).toString("hex")}.zip`,
  );
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    const a = archiver("zip");
    out.on("close", resolve);
    a.on("error", reject);
    a.pipe(out);
    a.directory(SAMPLE_DIR, false);
    a.finalize();
  });
  return zipPath;
};

describeIfEnabled("canonicalValidator — real JAR integration", () => {
  let zipPath;

  beforeAll(async () => {
    zipPath = await zipSampleFeed();
  }, 30_000);

  afterAll(() => {
    if (zipPath && fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  });

  test("validates the bundled sample feed end-to-end", async () => {
    const report = await validateWithCanonical(zipPath, { timeoutMs: 60_000 });
    expect(report).toMatchObject({
      profile: "canonical",
      engine: "mobilitydata-canonical",
    });
    expect(typeof report.valid).toBe("boolean");
    expect(report.counts).toMatchObject({
      errors: expect.any(Number),
      warnings: expect.any(Number),
      infos: expect.any(Number),
    });
    expect(report.errors).toBeInstanceOf(Object);
    // The sample feed is intentionally clean modulo MD's "unknown_file"
    // info notice on the meta sidecar; no ERROR-level findings should
    // surface, otherwise a regression has crept into our exporter or the
    // sample fixture.
    expect(report.counts.errors).toBe(0);
  }, 120_000);
});
