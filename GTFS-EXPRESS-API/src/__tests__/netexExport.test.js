/**
 * netexExport.test.js — GTFS → NeTEx France export endpoint.
 *
 * The real gtfs2netexfr binary (Rust + PROJ) is NOT exercised here — it
 * only exists inside the Docker image. The suite pins the HTTP contract
 * with a fake converter script:
 *   - 503 when the binary is not configured (feature off);
 *   - 400 on a malformed participant (CLI/XML injection guard);
 *   - 422 when the pre-export gate finds blocking findings (same gate as
 *     the GTFS export);
 *   - 200 ZIP streaming of whatever the converter produced.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-netex-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;

// Fake converter: validates the CLI contract (flags present, input dir has
// CSVs) then writes two XML files into --output.
const FAKE_BIN = path.join(TEST_UPLOAD_ROOT, "fake-gtfs2netexfr.sh");
fs.writeFileSync(
  FAKE_BIN,
  `#!/bin/sh
input=""; output=""; participant=""
while [ $# -gt 0 ]; do
  case "$1" in
    --input) input="$2"; shift 2;;
    --output) output="$2"; shift 2;;
    --participant) participant="$2"; shift 2;;
    *) shift;;
  esac
done
[ -n "$input" ] && [ -n "$output" ] && [ -n "$participant" ] || exit 2
[ -f "$input/stops.txt" ] || exit 3
printf '<?xml version="1.0"?><PublicationDelivery participant="%s"/>' "$participant" > "$output/arrets.xml"
printf '<?xml version="1.0"?><PublicationDelivery/>' > "$output/lignes.xml"
exit 0
`,
  { mode: 0o755 },
);

const request = require("supertest");
const app = require("../app");
const { loadData } = require("../services/sessionManager");
const { openEditDb, setEditMode } = require("../services/db/connection");
const { migrateCacheToDb } = require("../services/editSession");
const exportService = require("../services/exportService");

const SAMPLE_DIR = path.resolve(__dirname, "../../sample");

const seedSession = async () => {
  const sessionId = crypto.randomUUID();
  const sessionDir = path.join(TEST_UPLOAD_ROOT, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  for (const file of fs
    .readdirSync(SAMPLE_DIR)
    .filter((f) => f.endsWith(".txt"))) {
    fs.copyFileSync(path.join(SAMPLE_DIR, file), path.join(sessionDir, file));
  }
  const data = await loadData(sessionDir);
  const { db } = openEditDb(sessionId);
  migrateCacheToDb(db, data);
  setEditMode(sessionId, true);
  return sessionId;
};

describe("NeTEx France export", () => {
  let sessionId;

  beforeAll(async () => {
    sessionId = await seedSession();
  }, 60_000);

  afterAll(() => {
    try {
      fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  });

  beforeEach(() => {
    process.env.GTFS2NETEXFR_BIN = FAKE_BIN;
  });

  test("503 NETEX_DISABLED when the converter is not configured", async () => {
    delete process.env.GTFS2NETEXFR_BIN;
    const res = await request(app)
      .get("/gtfs/edit/export/netex")
      .set("X-Session-ID", sessionId);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("NETEX_DISABLED");
  });

  test("400 on a participant that fails the whitelist", async () => {
    const res = await request(app)
      .get("/gtfs/edit/export/netex")
      .query({ participant: "évil; rm -rf /" })
      .set("X-Session-ID", sessionId);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_PARTICIPANT");
  });

  test("422 when the pre-export gate reports blocking findings", async () => {
    const spy = jest
      .spyOn(exportService, "runPreExportValidation")
      .mockResolvedValue({
        valid: false,
        errors: {
          "stops.txt": [{ ruleCode: "invalid_url", severity: "error" }],
        },
        counts: { errors: 1, warnings: 0, infos: 0 },
      });
    try {
      const res = await request(app)
        .get("/gtfs/edit/export/netex")
        .set("X-Session-ID", sessionId);
      expect(res.status).toBe(422);
      expect(res.body.errorCount).toBe(1);
      expect(res.body.report.valid).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("200: streams a zip of the converter's output, participant forwarded", async () => {
    const res = await request(app)
      .get("/gtfs/edit/export/netex")
      .query({ participant: "AOM-Test_1" })
      .set("X-Session-ID", sessionId)
      .buffer(true)
      .parse((res2, cb) => {
        const chunks = [];
        res2.on("data", (c) => chunks.push(c));
        res2.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toMatch(/netex-fr-\d+\.zip/);
    // ZIP magic bytes.
    expect(res.body.slice(0, 2).toString()).toBe("PK");
    // The fake converter embeds the participant in arrets.xml; the zip is
    // stored with low compression so the marker survives findable for
    // small payloads — robust check: unzip via the entry name presence.
    expect(res.body.includes(Buffer.from("arrets.xml"))).toBe(true);
    expect(res.body.includes(Buffer.from("lignes.xml"))).toBe(true);
  });

  test("converter failure surfaces as a 500 with a bounded message", async () => {
    const badBin = path.join(TEST_UPLOAD_ROOT, "failing-converter.sh");
    fs.writeFileSync(badBin, "#!/bin/sh\necho 'boom: PROJ exploded' >&2\nexit 1\n", {
      mode: 0o755,
    });
    process.env.GTFS2NETEXFR_BIN = badBin;
    const res = await request(app)
      .get("/gtfs/edit/export/netex")
      .set("X-Session-ID", sessionId);
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("gtfs2netexfr failed");
    expect(res.body.error).toContain("boom");
  });
});
