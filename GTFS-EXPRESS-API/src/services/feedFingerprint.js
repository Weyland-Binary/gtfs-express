/**
 * A feed's content fingerprint: the sha256 of its files' names and sha256s, a JSON list in name order. The zip around
 * them (its compression, its entries' order, its folders) changes nothing; one byte of one file changes it, and no
 * file name can pass for another's line.
 */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { GTFS_UPLOAD_DIR, validateSessionId } = require("./sessionManager");

// The files a feed is made of, as a version's zip holds them (versionFiles): never a session's `_` sidecars.
const isFeedFile = (name) => !name.startsWith("_") && (name.endsWith(".txt") || name === "locations.geojson");
// A file the validator reads whole; any other in the folder it names only (unknown_file).
const isReadFile = (name) => name.endsWith(".txt") || name.endsWith(".geojson");

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

const hashOfFile = (file) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (c) => hash.update(c)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
  });

// [[name, sha256], …] in name order, as JSON: a name holding a tab or a newline stays one name.
const fingerprintOfFiles = (files) => sha256(JSON.stringify(files));

/**
 * The folder described: `fingerprint` the feed's files, `validationKey` everything the validator reads there (the
 * fingerprint, then every other file's name and, when it reads it whole, its sha256). Null when the folder holds no
 * feed file or cannot be read.
 */
const describeDir = async (dir) => {
  try {
    const names = (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name).sort();
    const feed = [];
    const others = [];
    for (const name of names) {
      if (isFeedFile(name)) feed.push([name, await hashOfFile(path.join(dir, name))]);
      else others.push([name, isReadFile(name) ? await hashOfFile(path.join(dir, name)) : null]);
    }
    if (!feed.length) return null;
    const fingerprint = fingerprintOfFiles(feed);
    return { fingerprint, validationKey: sha256(JSON.stringify([fingerprint, others])) };
  } catch {
    return null;
  }
};

const fingerprintOfDir = async (dir) => (await describeDir(dir))?.fingerprint || null;

/**
 * The fingerprint a session was opened with, while it still holds that network: null once an edit changed it, or
 * when it was never recorded.
 */
const sessionFingerprintOf = (sessionId, { db = null } = {}) => {
  if (!validateSessionId(sessionId)) return null;
  let fingerprint = null;
  try {
    fingerprint = JSON.parse(fs.readFileSync(path.join(GTFS_UPLOAD_DIR, sessionId, "_session_meta.json"), "utf8"))?.fingerprint || null;
  } catch {
    return null;
  }
  if (!fingerprint || !db) return fingerprint;
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM _edit_log WHERE undone = 0").get().n > 0 ? null : fingerprint;
  } catch {
    return fingerprint;
  }
};

module.exports = { describeDir, fingerprintOfDir, sessionFingerprintOf, isFeedFile, _internals: { fingerprintOfFiles } };
