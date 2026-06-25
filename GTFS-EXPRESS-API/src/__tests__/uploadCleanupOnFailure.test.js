/**
 * uploadCleanupOnFailure.test.js — guards CLAUDE.md punch-list item:
 * "live sessions" must reflect uploads that completed validation, not
 * folders left behind by a failed upload pipeline.
 *
 * The handler now wraps everything from `mkdir(uploadPath)` onward in a
 * try / finally that wipes the folder on any non-committed exit. Two
 * orthogonal guarantees are exercised:
 *
 *   1. Failed uploads (corrupt / oversized / over-cap ZIPs, validation
 *      engine errors) leave NO folder on disk afterward.
 *   2. The `markUploadStarted` / `markUploadFinished` tracker excludes
 *      a session from `getActiveSessionsCount()` until the upload
 *      pipeline has successfully completed.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const crypto = require("crypto");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-cleanup-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;
process.env.IP_HASH_SECRET = "test-cleanup";
process.env.BETA_GATE_DISABLED = "true";

const request = require("supertest");
const archiver = require("archiver");
const app = require("../app");
const {
  getActiveSessionsCount,
  markUploadStarted,
  markUploadFinished,
} = require("../services/sessionManager");

const buildOversizeEntryZip = (entryCount) =>
  new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 0 } });
    const chunks = [];
    archive.on("data", (c) => chunks.push(c));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    for (let i = 0; i < entryCount; i++) {
      archive.append("", { name: `file_${i}.txt` });
    }
    archive.finalize();
  });

const listSessionFolders = async () => {
  const entries = await fsp.readdir(TEST_UPLOAD_ROOT);
  const dirs = [];
  for (const e of entries) {
    const st = await fsp.stat(path.join(TEST_UPLOAD_ROOT, e)).catch(() => null);
    if (st && st.isDirectory()) dirs.push(e);
  }
  return dirs;
};

// Express flushes the response as soon as `res.json()` is called, but the
// handler's `finally` block — which performs the cleanup `fsp.rm` and
// `markUploadFinished` — keeps running asynchronously after that. Polling
// the predicate gives the handler time to complete without resorting to a
// fixed sleep that would either flake or slow the suite down.
const waitFor = async (predicate, timeoutMs = 2000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
};

describe("upload cleanup on failure", () => {
  afterAll(() => {
    try {
      fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  });

  test("ZIP with too many entries → 400 + no leftover folder", async () => {
    const before = await listSessionFolders();
    const buf = await buildOversizeEntryZip(60);
    const r = await request(app)
      .post("/gtfs/upload")
      .attach("gtfsZip", buf, {
        filename: "too-many.zip",
        contentType: "application/zip",
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/too many entries/i);
    await waitFor(async () => {
      const after = await listSessionFolders();
      return after.length === before.length;
    });
  });

  test("Garbage payload masquerading as ZIP → no leftover folder", async () => {
    const before = await listSessionFolders();
    const garbage = Buffer.from("not-a-real-zip-archive-at-all");
    const r = await request(app)
      .post("/gtfs/upload")
      .attach("gtfsZip", garbage, {
        filename: "broken.zip",
        contentType: "application/zip",
      });
    // Either the unzipper rejects with 500 or downstream validation rejects.
    // The cleanup contract is the same: no folder must persist.
    expect([400, 500].includes(r.status)).toBe(true);
    await waitFor(async () => {
      const after = await listSessionFolders();
      return after.length === before.length;
    });
  });

  test("Successful /load-sample → folder + _session_meta.json present, count reflects it", async () => {
    const r = await request(app).get("/gtfs/load-sample");
    expect(r.status).toBe(200);
    expect(r.body.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const sessionId = r.body.sessionId;
    const folder = path.join(TEST_UPLOAD_ROOT, sessionId);
    // The handler's `finally` runs `markUploadFinished` after the response
    // has been flushed; until then, the count excludes the folder.
    await waitFor(() =>
      Promise.resolve(getActiveSessionsCount() >= 1),
    );
    expect(fs.existsSync(folder)).toBe(true);

    const metaPath = path.join(folder, "_session_meta.json");
    expect(fs.existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf8"));
    expect(meta.session_id).toBe(sessionId);
    expect(meta.source).toBe("sample");
    expect(meta.agency).toBeDefined();
    expect(typeof meta.agency.count).toBe("number");
    expect(meta.counts).toBeDefined();
    expect(typeof meta.counts.routes).toBe("number");
    expect(meta.validation).toBeDefined();
    expect(typeof meta.validation.errors_count).toBe("number");
    expect(typeof meta.validation.warnings_count).toBe("number");
    expect(typeof meta.validation.notices_count).toBe("number");
    expect(Array.isArray(meta.validation.top_codes)).toBe(true);
  });

  test("uploadInProgress excludes a session from getActiveSessionsCount until released", async () => {
    const fakeSid = crypto.randomUUID();
    const fakeFolder = path.join(TEST_UPLOAD_ROOT, fakeSid);
    await fsp.mkdir(fakeFolder, { recursive: true });
    try {
      const baseline = getActiveSessionsCount();

      markUploadStarted(fakeSid);
      // While "in progress", the folder is NOT counted.
      expect(getActiveSessionsCount()).toBe(baseline - 1);

      markUploadFinished(fakeSid);
      // Once released, the count includes the folder again.
      expect(getActiveSessionsCount()).toBe(baseline);
    } finally {
      await fsp.rm(fakeFolder, { recursive: true, force: true });
    }
  });
});
