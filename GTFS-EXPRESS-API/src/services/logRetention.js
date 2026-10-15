/**
 * logRetention.js — the daily retention sweep of the API's own JSONL logs.
 *
 * The API appends one JSON object per line to four logs, each dated by its
 * first field: the typed event log (`_events.jsonl`, eventLogger — uploads,
 * sessions, validations, edits, exports, workspace actions, the chat's
 * feedback), the legacy upload log (`_upload_stats.jsonl`, uploadService,
 * dated by `date`), the use log of the retired beta codes (beta/usage.jsonl,
 * no longer written, swept until it ages out) and
 * the AI use log (beta/chat-usage.jsonl, the chat). The admin dashboard's
 * "reset" renames a log to `<name>.<stamp>.bak.jsonl` beside it: those
 * archives are logs too. Every one of them holds pseudonymous personal data
 * (hashed addresses, codes and emails, user agents; the lines beta/usage.jsonl
 * received before its writer hashed them still carry the address and the
 * email in clear, until this sweep removes them or the one-off rewrite of
 * DEPLOYMENT.md's "Logs" section, scripts/rewrite-beta-usage.js, hashes the
 * address and drops the e-mail), so none is kept forever: once a
 * day, the lines older than LOG_RETENTION_DAYS (default 365; 0 keeps
 * everything) are removed, an archive left empty is
 * deleted.
 *
 * Why line by line and not by file: the logs are append-only and never
 * rotated, so a whole file is as old as the service; the sweep keeps what is
 * recent and drops what is not. A line whose date cannot be read is kept
 * (never lose what cannot be judged) and counted.
 *
 * The rewrite is crash-safe and leaves the writers alone: the kept lines go
 * to a temporary file beside the log, given the log's permissions (and its
 * owner when the sweep runs as root), the bytes appended while the sweep
 * read the file are copied after them, and the temporary file replaces the
 * log by a rename — synchronously, so no write of this process lands in
 * between (a write already in flight in the thread pool at that very moment
 * may be lost: these are best-effort logs, as their writers say).
 *
 *   logFiles()              the logs and their archives that exist now
 *   sweepFile(file, cutoff) one file → { kept, dropped, undated, removed }
 *   sweep({ now, days })    every log → { days, files: [...] }, or null when days is 0
 *   start()                 the daily timer (never in tests), first run a minute after boot
 */

"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const config = require("../config");

const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK_BYTES = 1024 * 1024;

/** The logs the API writes, as their writers name them (logRetention.test.js holds every `.jsonl` of src/ to this list). */
const LOGS = () => [
  path.join(config.GTFS_UPLOAD_DIR, "_events.jsonl"),
  path.join(config.GTFS_UPLOAD_DIR, "_upload_stats.jsonl"),
  config.BETA_USAGE_PATH,
  config.NL2SQL_CHAT_USAGE_PATH,
];

/** The archives the admin "reset" left beside a log: `<base>.<stamp>.bak.jsonl`. */
const archivesOf = (file) => {
  const dir = path.dirname(file);
  const base = path.basename(file, ".jsonl");
  try {
    return fs.readdirSync(dir).filter((name) => name.startsWith(`${base}.`) && name.endsWith(".bak.jsonl")).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
};

/** Every log and archive that exists now, without duplicates. */
const logFiles = () => {
  const files = new Set();
  for (const file of LOGS()) {
    if (fs.existsSync(file)) files.add(file);
    for (const archive of archivesOf(file)) files.add(archive);
  }
  return [...files];
};

/** The line's date in ms (its `ts`, or `date` for the upload log), or null when it cannot be read. */
const lineTime = (line) => {
  try {
    const entry = JSON.parse(line);
    const at = Date.parse(entry && (entry.ts || entry.date));
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
};

/** Copy the bytes [from, to) of `src` to the end of the open descriptor `outFd`, synchronously. */
const copyRangeSync = (src, from, to, outFd) => {
  if (to <= from) return;
  const inFd = fs.openSync(src, "r");
  try {
    const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, to - from));
    for (let pos = from; pos < to; ) {
      const n = fs.readSync(inFd, buf, 0, Math.min(buf.length, to - pos), pos);
      if (n <= 0) break;
      fs.writeSync(outFd, buf, 0, n);
      pos += n;
    }
  } finally {
    fs.closeSync(inFd);
  }
};

/**
 * Give the temporary file the log's permission bits, and its owner when this process may (root): the rename then
 * leaves the log as it was, so a host-managed bind mount (beta/) stays readable by the host's operator. Best effort:
 * a refused chown keeps this process's own user.
 */
const keepAccess = (fd, stat) => {
  fs.fchmodSync(fd, stat.mode & 0o7777);
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    try {
      fs.fchownSync(fd, stat.uid, stat.gid);
    } catch {
      /* keep root's ownership */
    }
  }
};

/**
 * Remove the lines of `file` dated before `cutoffMs`. Only whole lines are judged: a last line still being
 * written (no newline yet) is carried over untouched with whatever was appended after it.
 */
const sweepFile = async (file, cutoffMs) => {
  const result = { file, kept: 0, dropped: 0, undated: 0, removed: false };
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return result;
  }
  const size = stat.size;
  if (size === 0) return result;
  const tmp = `${file}.retention-${process.pid}.tmp`;
  const out = fs.openSync(tmp, "w", 0o600);
  let judgedBytes = 0;
  try {
    keepAccess(out, stat);
    let rest = Buffer.alloc(0);
    const handle = await fsp.open(file, "r");
    try {
      const buf = Buffer.allocUnsafe(CHUNK_BYTES);
      for (let pos = 0; pos < size; ) {
        const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, size - pos), pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        let data = Buffer.concat([rest, buf.subarray(0, bytesRead)]);
        let nl;
        while ((nl = data.indexOf(0x0a)) !== -1) {
          const raw = data.subarray(0, nl + 1);
          data = data.subarray(nl + 1);
          judgedBytes += raw.length;
          const line = raw.toString("utf8").trim();
          if (!line) continue;
          const at = lineTime(line);
          if (at == null) result.undated++;
          if (at != null && at < cutoffMs) {
            result.dropped++;
          } else {
            result.kept++;
            fs.writeSync(out, raw);
          }
        }
        rest = Buffer.from(data);
      }
    } finally {
      await handle.close();
    }
    if (result.dropped === 0) {
      fs.closeSync(out);
      fs.rmSync(tmp, { force: true });
      return result;
    }
    // From here on, synchronous: no write of this process can land between the tail copy and the rename.
    const now = fs.statSync(file).size;
    copyRangeSync(file, judgedBytes, now, out);
    fs.closeSync(out);
    if (result.kept === 0 && now === judgedBytes) {
      fs.rmSync(file, { force: true });
      fs.rmSync(tmp, { force: true });
      result.removed = true;
    } else {
      fs.renameSync(tmp, file);
    }
    return result;
  } catch (err) {
    try {
      fs.closeSync(out);
    } catch {
      /* already closed */
    }
    fs.rmSync(tmp, { force: true });
    throw err;
  }
};

/** One pass over every log. `days` 0 (or less) keeps everything and does nothing. */
const sweep = async ({ now = Date.now(), days = config.LOG_RETENTION_DAYS } = {}) => {
  if (!(days > 0)) return null;
  const cutoff = now - days * DAY_MS;
  const files = [];
  for (const file of logFiles()) {
    try {
      files.push(await sweepFile(file, cutoff));
    } catch (err) {
      files.push({ file, error: err.message });
    }
  }
  return { days, cutoff: new Date(cutoff).toISOString(), files };
};

let timer = null;
/** The daily sweep, started once by the server (src/app.js), never under Jest. */
const start = () => {
  if (timer || process.env.NODE_ENV === "test" || !(config.LOG_RETENTION_DAYS > 0)) return;
  const run = () =>
    sweep()
      .then((report) => {
        const dropped = report ? report.files.reduce((n, f) => n + (f.dropped || 0), 0) : 0;
        const failed = report ? report.files.filter((f) => f.error) : [];
        if (dropped) console.log(`log retention: ${dropped} line(s) older than ${report.days} days removed`);
        for (const f of failed) console.warn(`log retention: ${path.basename(f.file)} not swept: ${f.error}`);
      })
      .catch((err) => console.warn("log retention failed:", err.message));
  timer = setInterval(run, DAY_MS);
  timer.unref();
  setTimeout(run, 60 * 1000).unref();
};

module.exports = { logFiles, sweepFile, sweep, start, _internals: { LOGS, lineTime } };
