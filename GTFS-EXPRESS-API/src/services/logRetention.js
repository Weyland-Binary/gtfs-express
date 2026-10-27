/**
 * The daily retention sweep of the API's own JSONL logs and the archives the admin "reset" leaves beside them.
 * They hold pseudonymous personal data, so none is kept forever: lines older than LOG_RETENTION_DAYS (0 keeps
 * everything) are removed line by line, since the logs are append-only and never rotated. A line whose date cannot
 * be read is kept and counted. The kept lines go to a temporary file, the bytes appended meanwhile are copied after
 * them, then a rename replaces the log, synchronously so no write of this process lands in between (one already in
 * flight may be lost: these logs are best effort).
 */

"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const config = require("../config");

const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK_BYTES = 1024 * 1024;

/** logRetention.test.js holds every `.jsonl` of src/ to this list. */
const LOGS = () => [
  path.join(config.GTFS_UPLOAD_DIR, "_events.jsonl"),
  path.join(config.GTFS_UPLOAD_DIR, "_upload_stats.jsonl"),
  // No longer written; swept until its older lines, some with an address in clear, age out.
  config.BETA_USAGE_PATH,
  config.NL2SQL_CHAT_USAGE_PATH,
];

/** `<base>.<stamp>.bak.jsonl` */
const archivesOf = (file) => {
  const dir = path.dirname(file);
  const base = path.basename(file, ".jsonl");
  try {
    return fs.readdirSync(dir).filter((name) => name.startsWith(`${base}.`) && name.endsWith(".bak.jsonl")).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
};

const logFiles = () => {
  const files = new Set();
  for (const file of LOGS()) {
    if (fs.existsSync(file)) files.add(file);
    for (const archive of archivesOf(file)) files.add(archive);
  }
  return [...files];
};

/** `date` for the upload log, `ts` for the others. */
const lineTime = (line) => {
  try {
    const entry = JSON.parse(line);
    const at = Date.parse(entry && (entry.ts || entry.date));
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
};

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

/** The rename leaves the log's mode and owner as they were, so a host-managed bind mount stays readable by the host. */
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
 * Rewrites a log line by line: `judge(line)` answers DROP, a new line, or null to keep it. Only whole lines are
 * judged: a last line still being written is carried over with what was appended after it.
 */
const DROP = Symbol("drop");
// One rewrite at a time in this process (the daily sweep, an account's pseudonymisation): two would share the
// temporary file, and the later rename would undo the other's work.
let rewriting = Promise.resolve();
const rewriteFile = (file, judge) => {
  const run = rewriting.then(() => rewriteNow(file, judge));
  rewriting = run.catch(() => {});
  return run;
};
const rewriteNow = async (file, judge) => {
  const result = { file, kept: 0, dropped: 0, changed: 0, removed: false };
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
          const verdict = judge(line);
          if (verdict === DROP) {
            result.dropped++;
          } else if (typeof verdict === "string") {
            result.kept++;
            result.changed++;
            fs.writeSync(out, `${verdict}\n`);
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
    if (result.dropped === 0 && result.changed === 0) {
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

const sweepFile = async (file, cutoffMs) => {
  let undated = 0;
  const { changed, ...result } = await rewriteFile(file, (line) => {
    const at = lineTime(line);
    if (at == null) undated++;
    return at != null && at < cutoffMs ? DROP : null;
  });
  void changed;
  return { ...result, undated };
};

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
const start = () => {
  if (timer || process.env.NODE_ENV === "test" || !(config.LOG_RETENTION_DAYS > 0)) return;
  const run = () =>
    sweep()
      .then((report) => {
        const dropped = report ? report.files.reduce((n, f) => n + (f.dropped || 0), 0) : 0;
        const failed = report ? report.files.filter((f) => f.error) : [];
        if (dropped) console.info(`log retention: ${dropped} line(s) older than ${report.days} days removed`);
        for (const f of failed) console.warn(`log retention: ${path.basename(f.file)} not swept: ${f.error}`);
      })
      .catch((err) => console.warn("log retention failed:", err.message));
  timer = setInterval(run, DAY_MS);
  timer.unref();
  setTimeout(run, 60 * 1000).unref();
};

module.exports = { logFiles, archivesOf, rewriteFile, DROP, sweepFile, sweep, start, _internals: { LOGS, lineTime } };
