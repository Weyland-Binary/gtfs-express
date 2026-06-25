/**
 * exportLineEnding.test.js — CSV line-ending opt-in (Sprint 8 / B4).
 *
 * GET /gtfs/edit/export accepts a `?lineEnding=crlf` query param. Defaults
 * to LF (spec-aligned). Any unrecognised value silently falls back to LF.
 *
 * Unit-level coverage exercises `_resolveLineEnding`, `_csvLine`, and
 * `_buildLocationsGeojson` directly so we don't have to unzip a full export
 * to verify the EOL switch.
 *
 * One end-to-end check still streams `GET /edit/export?lineEnding=crlf`
 * against a sample session, extracts it via `unzipper`, and re-reads the
 * file bytes from disk to confirm the wiring is real.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const stream = require("stream");
const unzipper = require("unzipper");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-export-eol-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;

const request = require("supertest");
const app = require("../app");
const { loadData } = require("../services/sessionManager");
const { openEditDb, closeEditDb, setEditMode } = require("../services/db/connection");
const { migrateCacheToDb } = require("../services/editSession");
const {
  _resolveLineEnding,
  _csvLine,
  _buildLocationsGeojson,
} = require("../services/exportService");

const SAMPLE_DIR = path.resolve(__dirname, "../../sample");

// ── unit tests ──────────────────────────────────────────────────────────────

describe("exportService line-ending helpers (B4)", () => {
  test("_resolveLineEnding defaults to LF on absent / empty / unknown input", () => {
    expect(_resolveLineEnding(undefined)).toBe("\n");
    expect(_resolveLineEnding(null)).toBe("\n");
    expect(_resolveLineEnding("")).toBe("\n");
    expect(_resolveLineEnding("lf")).toBe("\n");
    expect(_resolveLineEnding("foo")).toBe("\n");
  });

  test("_resolveLineEnding returns CRLF for the documented opt-in spellings", () => {
    expect(_resolveLineEnding("crlf")).toBe("\r\n");
    expect(_resolveLineEnding("CRLF")).toBe("\r\n");
    expect(_resolveLineEnding("  CrLf  ")).toBe("\r\n");
    expect(_resolveLineEnding("rfc4180")).toBe("\r\n");
  });

  test("_csvLine respects the eol parameter and defaults to LF", () => {
    const row = { a: "x", b: "y" };
    expect(_csvLine(row, ["a", "b"])).toBe("x,y\n");
    expect(_csvLine(row, ["a", "b"], "\n")).toBe("x,y\n");
    expect(_csvLine(row, ["a", "b"], "\r\n")).toBe("x,y\r\n");
  });

  test("_csvLine still RFC 4180-quotes embedded commas / quotes / newlines", () => {
    const row = { a: 'has "quote"', b: "has,comma", c: "has\nnewline" };
    expect(_csvLine(row, ["a", "b", "c"], "\r\n")).toBe(
      '"has ""quote""","has,comma","has\nnewline"\r\n',
    );
  });
});

// ── e2e: actual ZIP smoke test ─────────────────────────────────────────────

describe("GET /gtfs/edit/export?lineEnding=crlf (B4 end-to-end)", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    sessionId = crypto.randomUUID();
    const sessionDir = path.join(TEST_UPLOAD_ROOT, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const files = fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith(".txt"));
    for (const f of files) {
      fs.copyFileSync(path.join(SAMPLE_DIR, f), path.join(sessionDir, f));
    }
    const data = await loadData(sessionDir);
    const result = openEditDb(sessionId);
    db = result.db;
    migrateCacheToDb(db, data);
    setEditMode(sessionId, true);
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* noop */ }
    try { fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
  });

  /**
   * Hit /edit/export with the given query suffix, capture the streamed ZIP
   * buffer, extract it to a fresh temp dir, and return that dir's path.
   */
  const exportAndExtract = async (qs = "") => {
    const res = await request(app)
      .get(`/gtfs/edit/export${qs}`)
      .set("X-Session-ID", sessionId)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(Buffer.isBuffer(res.body)).toBe(true);

    const extractDir = path.join(
      TEST_UPLOAD_ROOT,
      `extract-${crypto.randomBytes(4).toString("hex")}`,
    );
    fs.mkdirSync(extractDir, { recursive: true });
    await new Promise((resolve, reject) => {
      stream.Readable.from(res.body)
        .pipe(unzipper.Extract({ path: extractDir }))
        .on("close", resolve)
        .on("error", reject);
    });
    return extractDir;
  };

  test("default LF — exported stops.txt has no \\r before \\n", async () => {
    const dir = await exportAndExtract("");
    const bytes = fs.readFileSync(path.join(dir, "stops.txt"));
    expect(bytes.includes(Buffer.from("\r\n"))).toBe(false);
    expect(bytes.includes(Buffer.from("\n"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  test("?lineEnding=crlf — every newline in stops.txt is \\r\\n", async () => {
    const dir = await exportAndExtract("?lineEnding=crlf");
    const bytes = fs.readFileSync(path.join(dir, "stops.txt"));
    const text = bytes.toString("binary");
    const totalLF = (text.match(/\n/g) || []).length;
    const totalCRLF = (text.match(/\r\n/g) || []).length;
    expect(totalLF).toBeGreaterThan(1);
    // On a clean fixture (no embedded newlines inside quoted cells) every
    // LF should be preceded by a CR.
    expect(totalCRLF).toBe(totalLF);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  test("?lineEnding=garbage falls back to LF without erroring", async () => {
    const dir = await exportAndExtract("?lineEnding=garbage");
    const bytes = fs.readFileSync(path.join(dir, "stops.txt"));
    expect(bytes.includes(Buffer.from("\r\n"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  test("_buildLocationsGeojson trailing newline tracks the eol option", () => {
    const lf = _buildLocationsGeojson(db);
    const crlf = _buildLocationsGeojson(db, { eol: "\r\n" });
    expect(lf.endsWith("\n")).toBe(true);
    expect(lf.endsWith("\r\n")).toBe(false);
    expect(crlf.endsWith("\r\n")).toBe(true);
  });
});
