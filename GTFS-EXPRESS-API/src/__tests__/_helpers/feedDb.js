/**
 * feedDb.js — a GTFS directory (or zip) as an in-memory SQLite database
 * with the application's schema, for the transformation tests: the same
 * tables the edit engine works on, without a session.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Database = require("better-sqlite3");
const { applySchema } = require("../../services/db/schema");

const parseLine = (line) => {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
};

const loadDir = (dir) => {
  const db = new Database(":memory:");
  applySchema(db);
  db.pragma("foreign_keys = OFF");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".txt"))) {
    const table = file.replace(/\.txt$/, "");
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!exists) continue;
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const text = fs.readFileSync(path.join(dir, file), "utf8").replace(/^﻿/, "");
    const lines = text.split(/\r?\n/).filter((l) => l.length);
    if (!lines.length) continue;
    const header = parseLine(lines[0]).map((h) => h.trim());
    const use = header.map((h, i) => [h, i]).filter(([h]) => cols.includes(h));
    if (!use.length) continue;
    const stmt = db.prepare(`INSERT OR IGNORE INTO ${table} (${use.map(([h]) => h).join(", ")}) VALUES (${use.map(() => "?").join(", ")})`);
    db.transaction(() => {
      for (let i = 1; i < lines.length; i++) {
        const cells = parseLine(lines[i]);
        stmt.run(use.map(([, j]) => (cells[j] === undefined || cells[j] === "" ? null : cells[j])));
      }
    })();
  }
  return db;
};

const loadZip = (zipPath) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feeddb-"));
  execFileSync("unzip", ["-q", "-o", "-j", zipPath, "*.txt", "-d", dir]);
  try {
    return loadDir(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const SAMPLE_DIR = path.resolve(__dirname, "../../../sample");
const loadSample = () => loadDir(SAMPLE_DIR);

// Real open-data feeds (see fixtures/real/README.md for sources and licences).
const REAL_DIR = path.resolve(__dirname, "../fixtures/real");
const REAL = { albi: "albi-libea-urbain.zip", vernon: "vernon-sngo.zip" };
const _real = new Map();
/** A real feed as a fresh in-memory database (parsed once per process, then copied). */
const loadReal = (name) => {
  if (!REAL[name]) throw new Error(`unknown real feed ${name}`);
  if (!_real.has(name)) _real.set(name, loadZip(path.join(REAL_DIR, REAL[name])).serialize());
  const db = new Database(_real.get(name));
  db.pragma("foreign_keys = OFF");
  return db;
};

module.exports = { loadDir, loadZip, loadSample, loadReal, SAMPLE_DIR, REAL_DIR };
