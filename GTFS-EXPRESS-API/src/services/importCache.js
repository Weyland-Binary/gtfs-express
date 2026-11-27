/**
 * The database built from a published feed, kept so that opening the same content again copies it instead of
 * importing it: a public network is opened by many, and one import runs at a time. Only a feed opened from the
 * catalogue is written here, its content being public; any opening of the same content reads it, an upload too. A
 * file a person sent is never kept past its session by this.
 *
 * The key is the content's fingerprint (feedFingerprint) and the version of what builds a database: this API's own
 * sources, the schema and SQLite, so another build never reads this one's. The entries are files of the uploads
 * folder, where a file is no session: kept-<key>.db, the database as the import's child closed it, before anything
 * names it a working copy, and kept-<key>.json, what the import answered. They hold within IMPORT_CACHE_MAX_MB
 * (2048 by default, 0 keeps nothing), the one read longest ago removed first.
 */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { GTFS_UPLOAD_DIR } = require("../config");
const { SCHEMA_VERSION } = require("./db/schema");

const ENTRY = /^kept-([0-9a-f]{64})\.db$/;
const STALE_PART_MS = 60 * 60 * 1000;

const budgetBytes = () => {
  const raw = process.env.IMPORT_CACHE_MAX_MB;
  const mb = raw === undefined || raw === "" || !Number.isFinite(Number(raw)) || Number(raw) < 0 ? 2048 : Number(raw);
  return Math.floor(mb * 1024 * 1024);
};

const sourcesIn = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourcesIn(full, out);
    else if (/\.(js|json)$/.test(entry.name)) out.push(full);
  }
  return out;
};

// What builds a database, as one hash, read once: any change of this API's sources is another version.
let version = null;
const builder = {
  version() {
    if (version) return version;
    const root = path.join(__dirname, "..");
    const hash = crypto.createHash("sha256");
    for (const file of sourcesIn(root).sort()) hash.update(path.relative(root, file)).update(fs.readFileSync(file));
    hash.update(`schema ${SCHEMA_VERSION} sqlite ${process.versions.sqlite || ""} better-sqlite3 ${require("better-sqlite3/package.json").version}`);
    version = hash.digest("hex");
    return version;
  },
};

const keyOf = (fingerprint) => crypto.createHash("sha256").update(`${builder.version()}\n${fingerprint}`).digest("hex");
const filesOf = (fingerprint) => {
  const base = path.join(GTFS_UPLOAD_DIR, `kept-${keyOf(fingerprint)}`);
  return { db: `${base}.db`, answer: `${base}.json` };
};
const forget = async ({ db, answer }) => {
  await fsp.rm(db, { force: true }).catch(() => {});
  await fsp.rm(answer, { force: true }).catch(() => {});
};

/**
 * The database of the content `fingerprint` copied to `sessionDir` as its gtfs.db: → what its import answered, with
 * `kept: true` and the copy's time, or null when none is kept (or it cannot be read: the feed is then imported).
 */
const take = async (fingerprint, sessionDir) => {
  if (!fingerprint || budgetBytes() <= 0) return null;
  const files = filesOf(fingerprint);
  const started = Date.now();
  let answer = null;
  try {
    answer = JSON.parse(await fsp.readFile(files.answer, "utf8"));
  } catch {
    return null;
  }
  const part = path.join(sessionDir, "gtfs.db.kept");
  try {
    // A clone where the volume can (the blocks shared until one of the two changes), a copy elsewhere.
    await fsp.copyFile(files.db, part, fs.constants.COPYFILE_FICLONE);
    await fsp.rename(part, path.join(sessionDir, "gtfs.db"));
  } catch (err) {
    await fsp.rm(part, { force: true }).catch(() => {});
    if (err.code !== "ENOENT") console.warn(`[import cache] a kept database could not be copied: ${err.message}`);
    return null;
  }
  // Read now: the last to go when room is needed.
  const now = new Date();
  await fsp.utimes(files.db, now, now).catch(() => {});
  return { ...answer, ms: Date.now() - started, kept: true };
};

/** The entries kept, oldest read first: [{ db, answer, bytes, readAt }]. */
const entries = async () => {
  const out = [];
  for (const name of await fsp.readdir(GTFS_UPLOAD_DIR).catch(() => [])) {
    const full = path.join(GTFS_UPLOAD_DIR, name);
    if (ENTRY.test(name)) {
      const stat = await fsp.stat(full).catch(() => null);
      if (stat) out.push({ db: full, answer: full.replace(/\.db$/, ".json"), bytes: stat.size, readAt: stat.mtimeMs });
    } else if (/^kept-[0-9a-f]{64}\.(db|json)\.part-/.test(name)) {
      // A copy a stopped server left half written.
      const stat = await fsp.stat(full).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > STALE_PART_MS) await fsp.rm(full, { force: true }).catch(() => {});
    }
  }
  return out.sort((a, b) => a.readAt - b.readAt);
};

const prune = async () => {
  const kept = await entries();
  let total = kept.reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of kept) {
    if (total <= budgetBytes()) break;
    await forget(entry);
    total -= entry.bytes;
  }
};

/**
 * Keeps `dbFile`, a database just imported from the content `fingerprint` and closed, with `answer`, what its import
 * answered. Never throws: a database that cannot be kept is imported again next time.
 */
const keep = async (fingerprint, dbFile, answer) => {
  if (!fingerprint || budgetBytes() <= 0) return false;
  const files = filesOf(fingerprint);
  const suffix = `.part-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    if ((await fsp.stat(dbFile)).size > budgetBytes()) return false;
    await fsp.copyFile(dbFile, files.db + suffix, fs.constants.COPYFILE_FICLONE);
    await fsp.writeFile(files.answer + suffix, JSON.stringify(answer));
    await fsp.rename(files.db + suffix, files.db);
    await fsp.rename(files.answer + suffix, files.answer);
    await prune();
    return true;
  } catch (err) {
    console.warn(`[import cache] a database could not be kept: ${err.message}`);
    await fsp.rm(files.db + suffix, { force: true }).catch(() => {});
    await fsp.rm(files.answer + suffix, { force: true }).catch(() => {});
    return false;
  }
};

module.exports = { take, keep, _internals: { builder, entries, prune, filesOf, budgetBytes, resetVersion: () => (version = null) } };
