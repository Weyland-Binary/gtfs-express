/**
 * uploadZipEntryCap.test.js — guards CLAUDE.md punch-list P3-#13.
 *
 * Anti-abuse complement to the existing zip-bomb guard (decompressed-size
 * cap): empty entries inflate the ZIP table-of-contents without inflating
 * the decompressed payload, so MAX_DECOMPRESSED_SIZE alone wouldn't catch
 * an archive padded with thousands of zero-byte files. uploadService.js
 * caps the entry count at MAX_ZIP_ENTRIES (50) and returns 400 above it.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-zipcap-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;
process.env.IP_HASH_SECRET = "test-zip-cap";

const request = require("supertest");
const archiver = require("archiver");
const app = require("../app");

const buildZipBuffer = (entryCount) =>
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

describe("upload — ZIP entry cap (P3-#13)", () => {
  afterAll(() => {
    try {
      fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  });

  test("ZIP with 51 entries is rejected with 400", async () => {
    const buf = await buildZipBuffer(51);
    const r = await request(app)
      .post("/gtfs/upload")
      .attach("gtfsZip", buf, { filename: "too-many.zip", contentType: "application/zip" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/too many entries/i);
  });
});
