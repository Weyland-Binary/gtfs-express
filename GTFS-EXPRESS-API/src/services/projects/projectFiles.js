/**
 * projects/projectFiles.js — where a project's files live. Every path is
 * built here from ids the store generated (24 hex characters), never from
 * what a client sent:
 *
 *   <PROJECTS_DIR>/p/<project>/documents/<document>.<ext>      the upload
 *   <PROJECTS_DIR>/p/<project>/documents/<document>.txt        its text
 *   <PROJECTS_DIR>/p/<project>/versions/<version>.sqlite       a frozen feed
 *   <PROJECTS_DIR>/p/<project>/deliverables/<deliverable>.<ext>
 *
 * The directory sits beside projects.db, outside the uploads directory: the
 * session sweeper never reaches it. The store records paths RELATIVE to the
 * project's directory (rel), so moving PROJECTS_DIR, or the database from one
 * system to another, keeps every file reachable; inside() resolves them.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../../config");

const ID_RE = /^[0-9a-f]{24}$/;
const EXT_RE = /^[a-z0-9]{1,8}$/;

const assertId = (id) => {
  if (!ID_RE.test(String(id || ""))) throw Object.assign(new Error("Invalid id."), { status: 400, code: "INVALID_ID" });
  return String(id);
};

const root = () => path.join(config.PROJECTS_DIR, "p");
const projectDir = (projectId) => path.join(root(), assertId(projectId));
const ensureDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const extOf = (name) => {
  const ext = path.extname(String(name || "")).slice(1).toLowerCase();
  return EXT_RE.test(ext) ? ext : "bin";
};

const documentPath = (projectId, documentId, name) => path.join(ensureDir(path.join(projectDir(projectId), "documents")), `${assertId(documentId)}.${extOf(name)}`);
const documentTextPath = (projectId, documentId) => path.join(ensureDir(path.join(projectDir(projectId), "documents")), `${assertId(documentId)}.txt`);
const versionPath = (projectId, versionId) => path.join(ensureDir(path.join(projectDir(projectId), "versions")), `${assertId(versionId)}.sqlite`);
const deliverablePath = (projectId, deliverableId, ext) => path.join(ensureDir(path.join(projectDir(projectId), "deliverables")), `${assertId(deliverableId)}.${EXT_RE.test(ext) ? ext : "bin"}`);
const scratchDir = (projectId) => fs.mkdtempSync(path.join(ensureDir(path.join(projectDir(projectId), "tmp")), "w-"));

/** The path the store records: relative to the project's directory, with forward slashes. */
const rel = (projectId, file) => path.relative(projectDir(projectId), file).split(path.sep).join("/");

/** A path the store recorded (relative, or absolute from an older row), checked to lie inside the project's directory. */
const inside = (projectId, file) => {
  const dir = path.resolve(projectDir(projectId));
  const given = String(file || "");
  const abs = path.isAbsolute(given) ? path.resolve(given) : path.resolve(dir, ...given.split("/"));
  if (!abs.startsWith(dir + path.sep)) throw Object.assign(new Error("Path outside the project."), { status: 400, code: "INVALID_PATH" });
  return abs;
};

const sha256File = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const removeQuietly = (file) => {
  try {
    fs.rmSync(file, { force: true, recursive: true });
  } catch {
    /* already gone */
  }
};

module.exports = { assertId, rel, projectDir, documentPath, documentTextPath, versionPath, deliverablePath, scratchDir, inside, sha256File, sha256, removeQuietly, extOf };
