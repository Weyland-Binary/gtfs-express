// Session ids never in clear in a log line.
const { sessionTag } = require("../utils/sessionTag");
const sessionOwner = require("./sessionOwner");
const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const os = require("os");
const crypto = require("crypto");
const zlib = require("zlib");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { openArchive } = require("../utils/zipDirectory");
const canonicalValidator = require("./canonicalValidatorService");

// The boot guard in app.js refuses to start production without the JAR and a JRE: no silent fallback here.
const runValidation = (gtfsPath, options = {}) => canonicalValidator.validateWithCanonical(gtfsPath, options);
const { describeDir } = require("./feedFingerprint");
const { unreadableFeed } = require("./db/feedDoor");
const { missingFilesOf, isFeedFileName } = require("./db/feedParse");
const { refusal } = require("./refusal");

// The scope a feed's validator report is kept in (validationCache): the one given (a published feed's url), the demo
// for everyone, else the account, else the address.
const validationCacheOf = (req, source, described, scope = null) => {
  const content = described?.validationKey;
  if (!content) return null;
  if (scope) return { content, scope };
  if (source === "sample") return { content, scope: "demo" };
  const user = sessionOwner.userIdOf(req);
  if (user) return { content, scope: `user:${user}` };
  return req ? { content, scope: require("./aiCostLimiter").anonymousKey(req) } : null;
};

// The opening's verdict, kept for the session it opens too: an exit of that session that writes these very files
// (the same bytes, the same country, the same day) reads it (validatorGate.keepFor).
const validateOpening = (sessionId, checkPath, described, options) => {
  const gate = require("./validatorGate");
  return gate.keepFor(described?.validationKey, { scope: gate.ofSession(sessionId).scope, countryCode: options.countryCode || null }, () => runValidation(checkPath, options));
};
const { takeBlankRows } = require("./csvUtils");
const { refreshDemoDates } = require("./demoFeedDates");
const { soloFrequencyWindows } = require("./demoFeedFrequencies");
const {
  validateSessionId,
  clearSessionCache,
  getActiveSessionsCount,
  GTFS_UPLOAD_DIR,
  MAX_SESSIONS,
  sessionCapFor,
  markUploadStarted,
  markUploadFinished,
  isUploadInProgress,
} = require("./sessionManager");
const {
  hasEditDb,
  hasEditDbOnDisk,
  openEditDb,
  closeEditDb,
} = require("./db/connection");
const { reporterOf } = require("./importProgress");
const timetables = require("./timetablesLoading");
const { UPLOAD_MAX_MB, UPLOAD_MAX_UNPACKED_BYTES } = require("../config");
// Lazy: editSession → exportService → … → uploadService is a require cycle.
let _migrateUploadToDb = null;
const getMigrateUploadToDb = () => {
  if (!_migrateUploadToDb) _migrateUploadToDb = require("./editSession").migrateUploadToDb;
  return _migrateUploadToDb;
};

const { recordEvent, extractReqMeta } = require("./eventLogger");

/** Every file of `dir` in a folder of its own (links, else copies), or null when it holds a folder: { dir, release }. */
const filesApart = async (dir) => {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  if (entries.some((e) => !e.isFile())) return null;
  const target = await fsp.mkdtemp(path.join(os.tmpdir(), "gtfs-opening-"));
  const release = () => fsp.rm(target, { recursive: true, force: true }).catch(() => {});
  try {
    for (const e of entries) {
      const from = path.join(dir, e.name);
      const to = path.join(target, e.name);
      await fsp.link(from, to).catch(() => fsp.copyFile(from, to));
    }
  } catch (err) {
    console.warn("The feed's files could not be set apart for the validator:", err.message);
    await release();
    return null;
  }
  return { dir: target, release };
};

/**
 * A feed's import started while the validator reads it. The validator is given the feed's files in a folder of their
 * own (`checkPath`): the import writes its database and journals beside the originals, which the validator would
 * name files of the feed. The opening says the check until it ends (`checked`), then where the load stands.
 * `result()` is the import's promise, awaited where the import used to start; `settled()` never rejects. Without a
 * folder apart the import starts at `result()`, after the check.
 *
 * With `staged`, a large feed's stop times are loaded apart (db/feedImporter onStaged): `first()` then resolves as
 * soon as the network can be read without them, { partial: true, ms, summary, encoding }, the session held as
 * loading (timetablesLoading) from that moment; for any other feed it is `result()`. `kept` ({ fingerprint, write })
 * names the content for the store of built databases (importCache): read by every opening, written by a published
 * feed's only.
 */
const loadWhileChecking = async (sessionId, uploadPath, progress, { staged = false, kept = null } = {}) => {
  const apart = await filesApart(uploadPath).catch(() => null);
  let reached = null;
  const stage = new Promise((resolve) => (reached = resolve));
  const start = () =>
    getMigrateUploadToDb()(sessionId, {
      onProgress: (step, done, total) => {
        progress.counts(step, done, total);
        if (step === "write") timetables.progress(sessionId, done, total);
      },
      ...(kept ? { kept } : {}),
      ...(staged
        ? {
            onStaged: (partial) => {
              timetables.begin(sessionId, { progressId: progress.id });
              reached({ ...partial, partial: true });
            },
          }
        : {}),
    });
  let loading = apart ? start() : null;
  // Awaited later: a refusal must not count as unhandled meanwhile.
  if (loading) loading.catch(() => {});
  return {
    checkPath: apart ? apart.dir : uploadPath,
    // The import beside the check, or after it where the files could not be set apart.
    beside: Boolean(apart),
    result: () => {
      if (!loading) loading = start();
      return loading;
    },
    first() {
      return Promise.race([stage, this.result()]);
    },
    settled: async () => {
      if (loading) await loading.catch(() => {});
    },
    // Once the validator has read them: the files set apart go.
    released: async () => {
      if (apart) await apart.release();
    },
  };
};

/**
 * The validator's run of an opening: its report, or an unverified one when it failed or is not installed. Never
 * rejects, and releases the files set apart when it ends. Where the import could not start beside it, it ends first.
 */
const verdictOf = (loading, run, { sessionId, what, onDone = null, sayNotInstalled = false }) => {
  const started = Date.now();
  return (async () => {
    try {
      const report = await run();
      console.info(`🔎 ${what} validation for ${sessionTag(sessionId)} took ${Date.now() - started}ms (valid=${report && report.valid})`);
      if (onDone) onDone(report);
      // No validator installed reads like a validator that failed; neither proves anything: never reported as valid.
      if (sayNotInstalled && report && report.unverified) return unverifiedReport("The canonical validator is not installed on this server.");
      return report || unverifiedReport("validator failed");
    } catch (err) {
      console.error(`${what} validation engine error for ${sessionTag(sessionId)} (non-fatal):`, err.message);
      return unverifiedReport(err.message || "validator failed", err.validatorReason);
    } finally {
      await loading.released();
    }
  })();
};

// The report of a network whose verdict is still coming: no verdict yet, and it says so.
const pendingReport = () => ({ ...unverifiedReport("The validator is still reading this network.", "pending"), pending: true });

/**
 * The opening's verdict, in its answer when it is there within a moment, else kept when it comes (openingValidation):
 * `settle(report)` makes a report the session's (its baseline, its report) and resolves to the one kept, null when
 * the session is gone meanwhile; `after` runs on the one that came late. → { report, pending }
 */
const verdictNowOrLater = async ({ sessionId, validating, settle, of = null, after = null, later = false }) => {
  const opening = require("./openingValidation");
  // `later`: what settles the verdict is not there yet (a network read before its stop times are in).
  const early = later ? null : await opening.within(validating);
  if (early) return { report: await settle(early), pending: false };
  opening.follow(sessionId, async (still) => {
    const report = await validating;
    // The session opened again, or gone: this verdict is of a network no longer there.
    if (!still() || !fs.existsSync(path.join(GTFS_UPLOAD_DIR, sessionId))) return null;
    const kept = await settle(report);
    if (kept && kept.unverified) opening.failed(sessionId, { of, reason: kept.engineReason || null, message: kept.engineError || "" });
    if (after) await after(kept);
    return kept;
  });
  return { report: pendingReport(), pending: true };
};
const { saveReport: saveValidationReport, saveBaseline: saveValidationBaseline } = require("./validationReportStore");

/**
 * Whether an opening asks to be answered before a large feed's stop times are in (X-Read-Before-Timetables: 1). The
 * reader asks: every request it then makes names the session in its header, which the gate reads. An opening that
 * does not ask is answered whole: a caller that later names the session in a request's body would read it half loaded.
 */
const readsFirst = (req) => Boolean(req && req.headers && req.headers["x-read-before-timetables"] === "1");

/** What an import that failed answers: { status, body, retryAfterSec }, the upload's own refusals. */
const importRefusalOf = (err) => {
  if (err && (err.code === "FEED_TOO_LARGE" || err.code === "SERVER_BUSY")) {
    return { status: err.status, body: { error: err.code, message: err.message, csv_mb: err.csv_mb, needed_mb: err.needed_mb, retryAfterSec: err.retryAfterSec }, retryAfterSec: err.retryAfterSec || null };
  }
  if (err && err.type === "REQUIRED_FIELDS_MISSING") {
    return { status: 400, body: { type: "REQUIRED_FIELDS_MISSING", error: "GTFS feed rejected: one or more rows are missing GTFS-Required fields.", summary: err.summary, errors: err.errors } };
  }
  if (err && typeof err.code === "string" && err.status >= 400 && err.status < 500) return { status: err.status, body: { error: err.code, message: err.message, ...(err.details || {}) } };
  return { status: 500, body: { error: "MIGRATION_FAILED", type: "MIGRATION_FAILED", message: `The feed could not be loaded: ${String((err && err.message) || err).slice(0, 300)}` } };
};

/** The database a large feed's stop times were loaded into takes the place of the one read meanwhile. */
const putWholeInPlace = (sessionId) => {
  const { dbPathFor, nextDbPathFor } = require("./db/connection");
  closeEditDb(sessionId, { removeFile: false });
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(dbPathFor(sessionId) + suffix, { force: true });
  fs.renameSync(nextDbPathFor(sessionId), dbPathFor(sessionId));
  fs.rmSync(path.join(GTFS_UPLOAD_DIR, sessionId, "_importing"), { force: true });
  require("./sessionManager").dropReadCaches(sessionId);
};

/**
 * The end of an opening answered before its stop times were in. Resolves to the import's whole result once the full
 * database is in place (`onWhole(result)` run first), or to null when the load failed or the session went meanwhile:
 * the session is then closed, its folder removed, and the refusal kept for whoever asks next (timetablesLoading).
 */
const finishStaged = ({ sessionId, uploadPath, loading, progress, sourceName = null, onWhole = null, kept = null }) =>
  require("../utils/pendingWork").track(
    (async () => {
      try {
        const whole = await loading.result();
        // Kept as the import's child closed it, before it takes the place of the database read meanwhile.
        if (kept && kept.write) await require("./importCache").keep(kept.fingerprint, require("./db/connection").nextDbPathFor(sessionId), require("./editSession").answerKept(whole));
        if (!(await timetables.settle(sessionId, () => putWholeInPlace(sessionId)))) throw Object.assign(new Error("The network was closed before its stop times were in."), { gone: true });
        require("./editSession").nameWorkingCopy(sessionId, whole, sourceName);
        if (onWhole) await onWhole(whole);
        progress.stage("done");
        return whole;
      } catch (err) {
        // Closed or opened again meanwhile: whoever did holds the folder now.
        if (err.gone) return null;
        console.error(`The stop times of ${sessionTag(sessionId)} could not be loaded:`, err.message);
        const { status, body } = importRefusalOf(err);
        timetables.fail(sessionId, { status, body });
        try {
          closeEditDb(sessionId, { removeFile: true });
        } catch (_) {
          /* best effort */
        }
        clearSessionCache(sessionId);
        await fsp.rm(uploadPath, { recursive: true, force: true }).catch(() => {});
        progress.stage("failed");
        return null;
      }
    })(),
  );

const STATS_FILE = path.join(GTFS_UPLOAD_DIR, "_upload_stats.jsonl");

const SAMPLE_DIR = path.join(__dirname, "..", "..", "sample");

// ZIP bomb guard.
const MAX_DECOMPRESSED_SIZE = UPLOAD_MAX_UNPACKED_BYTES;

// The .txt/.geojson files written: a feed has about thirty. Folders and Finder's __MACOSX twins do not count, else a
// Finder zip of a full feed is refused.
const MAX_ZIP_ENTRIES = 50;
// Every entry, read or not: empty entries inflate the table of contents without the decompressed size (the inflate
// cap stays the real guard), and the scan must end.
const MAX_ZIP_SCANNED_ENTRIES = 10000;
// The bytes of the directories read, the outer archive's and the inner one's together, before a name of them is: a
// record's name may hold 64 KiB that the reader decodes and tests, while 10 000 entries named as tools name them take
// 1 to 2 MB (the largest directory of 343 real feeds: 2.5 KB).
const MAX_DIRECTORY_BYTES = 4 * 1024 * 1024;
// What the archive's reader inflates: an entry stored, or deflated.
const READ_METHODS = new Set([0, 8]);
const METHOD_NAMES = { 9: "Deflate64", 12: "bzip2", 14: "LZMA", 93: "Zstandard", 95: "XZ", 98: "PPMd" };
// The longest file name a volume takes, in bytes; a volume stricter than that refuses the name when the file is opened.
const MAX_NAME_BYTES = 255;
const NAME_ERRORS = new Set(["ENAMETOOLONG", "EILSEQ", "ERR_INVALID_ARG_VALUE"]);
// The one character no volume takes in a name; any other a volume refuses is refused when its file is opened.
const NUL = /\0/;
// The one archive an archive may hold in place of its files, kept beside them while it is read.
const INNER_ARCHIVE = "gtfs-inner.zip";
// The most names a refusal says: a sentence carries a few, not an archive's whole table of contents.
const MAX_NAMED = 10;

// An entry's name as it is said back: on one line, short enough for a sentence, and a copy of its own, since a slice
// keeps the whole name it was cut from alive.
const shownName = (name) => {
  const text = String(name);
  const shown = (text.length > 60 ? text.slice(0, 57) : text).replace(/\p{Cc}/gu, "?");
  return Buffer.from(text.length > 60 ? `${shown}...` : shown).toString();
};

// A missing file named in any language: « calendar.txt or calendar_dates.txt » reads « calendar.txt / calendar_dates.txt ».
const gtfsFileNames = (name) => String(name).replace(/ or /g, " / ");

/** The files without which the folder is not a GTFS feed (feedParse missingFilesOf); [] when complete. */
const missingGtfsFiles = async (dir) => missingFilesOf(new Set(await fsp.readdir(dir)));

const appendUploadStat = async (entry) => {
  try {
    await fsp.mkdir(path.dirname(STATS_FILE), { recursive: true });
    await fsp.appendFile(STATS_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.warn("Could not write upload stat:", err.message);
  }
};

// A per-session summary for the admin dashboard, read without reopening the database; written aside, then
// renamed, so a poll never reads it truncated.
const TOP_CODES_LIMIT = 5;

// A report of the feed as opened: its findings on rows the import kept aside name them (asideId), and only as many
// duplicate_key findings as exact duplicates the import folded are resolved.
const settleReportWithImport = (sessionId, report, importAdjustments) => {
  if (!report) return;
  const { applyImportAdjustments, tagAsideFindings } = require("./canonicalValidatorService");
  try {
    tagAsideFindings(report, openEditDb(sessionId).db);
  } catch (err) {
    console.warn(`Could not name the rows kept aside for ${sessionTag(sessionId)}:`, err.message);
  }
  if (importAdjustments) applyImportAdjustments(report, importAdjustments);
};

// The rows the import loaded without the empty cells they held past their header, by file.
const trailingCellsOf = (details) => Object.fromEntries(Object.entries(details || {}).filter(([, d]) => Number(d?.trailing_cells) > 0).map(([table, d]) => [`${table}.txt`, Number(d.trailing_cells)]));

/**
 * The validator refuses a row longer than its header, and what leaving such rows out brings stands in its report of
 * the files as uploaded; where the import loaded them (their cells past the header empty), the network loaded and the
 * files validated differ. The report kept, and the baseline every delivery is measured against (G1), are then the
 * loaded network's, `import_settled` saying what the import removed. Null when nothing of the kind was loaded, when
 * the files' report proves nothing, or when that validation fails (the files' report is then kept).
 */
const reportOfLoadedNetwork = async (sessionId, filesReport, details) => {
  const trailing = trailingCellsOf(details);
  if (Object.keys(trailing).length === 0 || !filesReport || filesReport.unverified) return null;
  try {
    const report = await require("./validationService").reportOfWorkingCopy(sessionId);
    if (!report || report.unverified) return null;
    return { ...report, import_settled: { trailing_cells: trailing } };
  } catch (err) {
    console.warn(`Could not validate the network as loaded for ${sessionTag(sessionId)}: ${err.message}`);
    return null;
  }
};

// The report of a network opened without a verdict: why in the validator's words, and by its reason when it names one
// (`engineReason`: out_of_memory), which the delivery gate answers with.
const unverifiedReport = (engineError, engineReason = null) => ({ valid: null, unverified: true, engineError, ...(engineReason ? { engineReason } : {}), errors: {}, counts: { errors: 0, warnings: 0, infos: 0 } });

// The errors an incomplete report found are real; it cannot say the feed complies, the rules that crashed never ran.
const complianceOf = (report) => (!report || report.unverified ? "unverified" : report.valid === false ? "non_compliant" : report.incomplete ? "unverified" : "compliant");

const summarizeValidation = (validationResult) => {
  const counts = (validationResult && validationResult.counts) || {
    errors: 0,
    warnings: 0,
    infos: 0,
  };
  const grouped = (validationResult && validationResult.errors) || {};
  const tally = new Map();
  for (const fileEntries of Object.values(grouped)) {
    if (!Array.isArray(fileEntries)) continue;
    for (const entry of fileEntries) {
      const code = entry && entry.ruleCode ? String(entry.ruleCode) : "(unknown)";
      const severity = entry && entry.severity ? String(entry.severity) : "info";
      const key = `${severity}::${code}`;
      tally.set(key, (tally.get(key) || 0) + 1);
    }
  }
  const top_codes = Array.from(tally.entries())
    .map(([key, count]) => {
      const [severity, code] = key.split("::");
      return { code, severity, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_CODES_LIMIT);
  return {
    errors_count: counts.errors || 0,
    warnings_count: counts.warnings || 0,
    notices_count: counts.infos || 0,
    top_codes,
  };
};

const persistSessionMeta = async (uploadPath, payload) => {
  const finalPath = path.join(uploadPath, "_session_meta.json");
  const tmpPath = `${finalPath}.tmp`;
  try {
    await fsp.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    await fsp.rename(tmpPath, finalPath);
  } catch (err) {
    console.warn(
      `Could not persist session meta for ${sessionTag(payload.session_id)}:`,
      err.message,
    );
    fsp.rm(tmpPath, { force: true }).catch(() => {});
  }
};

// ── HTTP handlers

// Resolved once `stream` holds no file: whoever removes its folder next finds it free.
const closed = (stream) => (stream.closed ? Promise.resolve() : new Promise((resolve) => stream.once("close", resolve)));

/**
 * An entry's bytes (the streams `content()` opens, the last one giving them unpacked) written to `file`,
 * `count(bytes)` told each block (false stops the write), held to the CRC-32 and the size the directory gives them
 * (`expected`: { crc, uncompressedSize }), never unpacked past that size. Resolves to null once the file is whole, else
 * to what stopped the write, `damaged` when its bytes are not the ones the directory says; what the archive's own bytes
 * fail with is thrown. No file stays open either way.
 */
const writeEntry = async (content, file, count, expected) => {
  let out;
  try {
    out = fs.createWriteStream(file);
  } catch (err) {
    return err;
  }
  const held = [out];
  // The first stream to fail is the cause: the others are then closed with its error.
  let cause = null;
  const blame = (side) => () => (cause = cause || side);
  let size = 0;
  let crc = 0;
  const damaged = () => {
    blame("damaged")();
    return new Error("a file is not the bytes its archive says");
  };
  const meter = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      if (size > expected.uncompressedSize) return done(damaged());
      if (!count(chunk.length)) {
        blame("write")();
        return done(new Error("decompressed size over the limit"));
      }
      crc = zlib.crc32(chunk, crc);
      return done(null, chunk);
    },
    flush(done) {
      done(size === expected.uncompressedSize && crc === expected.crc ? null : damaged());
    },
  });
  try {
    const source = content();
    held.push(...source.filter((stream) => stream instanceof fs.ReadStream));
    out.once("error", blame("write"));
    for (const stream of source) stream.once("error", blame("archive"));
    await pipeline([...source, meter, out]);
    return null;
  } catch (err) {
    if (cause === "write") return err;
    if (cause === "damaged") return Object.assign(err, { damaged: true });
    throw err;
  } finally {
    out.destroy();
    await Promise.all(held.map(closed));
  }
};

/**
 * Only .txt and .geojson files are kept (extension case-insensitive, written lower-cased), flattened, an entry name
 * written with backslashes (a Windows tool's) being a path like any other; a basename met twice (stops.txt in two
 * folders, Stops.txt and stops.txt) is reported in `duplicateNames`, the first one written.
 * Both the declared sizes and the bytes really written count against `maxBytes`: an archive may lie about its sizes.
 *
 * The archive is read by its directory (utils/zipDirectory), which is listed whole before anything is written. One
 * that holds no file of a feed but one archive is read as that archive (a feed published as the zip of a zip), its
 * bytes and its entries counted with the outer one's against the same ceilings, one level deep: archives that are not
 * opened (several, or one inside the one inside) are named in `nested`. What cannot be read is named and never
 * inflated: `encrypted`, `unsupported` (their `methods`), and `unwritable` for a name no file can take; a file that
 * is not the bytes its directory says is named in `damaged`. A name starting with `_` is the session's own (its
 * sidecar files), never an entry's.
 */
const extractGtfsZip = async (zipPath, dir, { maxBytes = MAX_DECOMPRESSED_SIZE } = {}) => {
  let declared = 0;
  let written = 0;
  let entryCount = 0;
  let scanned = 0;
  let bombDetected = false;
  let tooManyEntries = false;
  let writeFailed = false;
  let nested = [];
  const seen = new Set();
  const duplicateNames = [];
  const encrypted = [];
  const unsupported = [];
  const methods = [];
  const unwritable = [];
  const damaged = [];
  let directoryBytes = 0;
  const innerPath = path.join(dir, INNER_ARCHIVE);

  const count = (bytes) => {
    written += bytes;
    if (written > maxBytes) bombDetected = true;
    return !bombDetected;
  };
  // Once a write failed the folder goes with the refusal: nothing more is written to it.
  const stopped = () => bombDetected || tooManyEntries || writeFailed || damaged.length > 0;
  const holdsFeedFile = () => [...seen].some(isFeedFileName);
  // Why the reader cannot inflate an entry, read from the directory before a byte of it is: null when it can.
  const unreadableOf = (entry) => {
    if (entry.flags & 1) return { encrypted: true };
    if (READ_METHODS.has(entry.method)) return null;
    return { method: METHOD_NAMES[entry.method] || `method ${entry.method}` };
  };
  const nameUnreadable = (label, why) => {
    if (why.encrypted) encrypted.push(label);
    else {
      unsupported.push(label);
      if (!methods.includes(why.method)) methods.push(why.method);
    }
  };

  // The files to write and the first archives met (a refusal names no more). Of an entry's name, 64 KiB at most, only a
  // file's own and what a refusal says are kept.
  const list = async (archive) => {
    const files = [];
    const archives = [];
    for await (const entry of archive.entries()) {
      scanned += 1;
      if (scanned > MAX_ZIP_SCANNED_ENTRIES) {
        tooManyEntries = true;
        break;
      }
      const entryPath = entry.name.replace(/\\/g, "/");
      const entryName = path.posix.basename(entryPath).toLowerCase();
      // Finder's resource forks (__MACOSX/._stops.txt) are not feed files.
      const junk = /(^|\/)__macosx\//i.test(entryPath) || entryName.startsWith("._");
      const isFile = !entry.directory && !junk;
      const isGtfsFile = isFile && !entryName.startsWith("_") && (entryName.endsWith(".txt") || entryName.endsWith(".geojson"));
      const isArchive = isFile && entryName.endsWith(".zip");
      if (!isGtfsFile && !isArchive) continue;
      // What the door may write counts against the ceiling as declared; an entry it leaves is never inflated.
      declared += entry.uncompressedSize;
      if (declared > maxBytes) {
        bombDetected = true;
        break;
      }
      const label = shownName(path.posix.basename(entryPath));
      const place = { flags: entry.flags, method: entry.method, crc: entry.crc, compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize, offset: entry.offset };
      if (isArchive) {
        if (archives.length < MAX_NAMED) archives.push({ label, place: archives.length === 0 ? place : null });
        continue;
      }
      entryCount += 1;
      if (entryCount > MAX_ZIP_ENTRIES) {
        tooManyEntries = true;
        break;
      }
      if (NUL.test(entryName) || Buffer.byteLength(entryName) > MAX_NAME_BYTES) unwritable.push(label);
      else if (unreadableOf(entry)) nameUnreadable(label, unreadableOf(entry));
      else if (!seen.has(entryName)) {
        seen.add(entryName);
        files.push({ label, name: entryName, place });
      } else if (!duplicateNames.includes(entryName)) duplicateNames.push(entryName);
    }
    return { files, archives };
  };

  // True once the entry is a whole file; what kept it from being one is named, or counted as the server's failure.
  const write = async (archive, { label, place }, file) => {
    const failure = await writeEntry(await archive.contentOf(place), file, count, place);
    if (!failure) return true;
    if (bombDetected) return false;
    if (failure.damaged) damaged.push(label);
    else if (NAME_ERRORS.has(failure.code)) unwritable.push(label);
    else {
      writeFailed = true;
      console.error(`A file of an archive could not be written: ${failure.code || "write failed"}`);
    }
    return false;
  };

  const read = async (archivePath, { inner }) => {
    const archive = await openArchive(archivePath);
    let within = false;
    try {
      directoryBytes += archive.directoryBytes;
      if (directoryBytes > MAX_DIRECTORY_BYTES) {
        tooManyEntries = true;
        return;
      }
      const { files, archives } = await list(archive);
      for (const item of files) {
        if (stopped()) break;
        await write(archive, item, path.join(dir, item.name));
      }
      // An archive that holds a file of a feed is the feed: the archives it holds are left as any foreign entry is.
      if (stopped() || archives.length === 0 || holdsFeedFile()) return;
      const [only] = archives;
      if (inner || archives.length > 1) nested = archives.map((item) => item.label);
      else if (unreadableOf(only.place)) nameUnreadable(only.label, unreadableOf(only.place));
      else within = await write(archive, only, innerPath);
    } finally {
      await archive.close();
    }
    if (within) await read(innerPath, { inner: true });
  };

  try {
    await read(zipPath, { inner: false });
  } finally {
    await fsp.rm(innerPath, { force: true }).catch(() => {});
  }
  return { tooManyEntries, bombDetected, duplicateNames, writeFailed: writeFailed && !bombDetected, unwritable, encrypted, unsupported, methods, nested, damaged };
};

/** What an archive `extractGtfsZip` could not read as a feed's files is refused with, or null. */
const archiveRefusalOf = (x) => {
  if (x.tooManyEntries) return refusal(400, "TOO_MANY_FILES", `ZIP archive has too many entries (max ${MAX_ZIP_ENTRIES} GTFS files allowed).`, { max: MAX_ZIP_ENTRIES });
  if (x.bombDetected) return refusal(400, "ZIP_TOO_LARGE_UNPACKED", "The archive unpacks to more than the allowed size.", { max_mb: Math.round(MAX_DECOMPRESSED_SIZE / 1048576) });
  const named = (names) => names.slice(0, MAX_NAMED);
  if (x.damaged.length > 0) return refusal(400, "ZIP_UNREADABLE", `The archive is damaged: ${named(x.damaged).join(", ")} is not the bytes the archive recorded.`, { reason: "file_damaged", files: named(x.damaged) });
  if (x.encrypted.length > 0) return refusal(422, "ZIP_ENCRYPTED", `The archive is protected by a password: ${named(x.encrypted).join(", ")} cannot be read.`, { files: named(x.encrypted) });
  if (x.unsupported.length > 0) {
    const method = x.methods.join(", ");
    return refusal(422, "ZIP_METHOD_UNSUPPORTED", `The archive is compressed with a method that is not read (${method}): compress it with Deflate, a zip's usual method.`, { method, files: named(x.unsupported) });
  }
  if (x.unwritable.length > 0) {
    return refusal(422, "ZIP_ENTRY_NAME", `The archive holds a file whose name cannot be kept (a NUL character in it, more than ${MAX_NAME_BYTES} bytes, or a name the server's disk refuses): ${named(x.unwritable).join(", ")}.`, { files: named(x.unwritable) });
  }
  if (x.writeFailed) return refusal(500, "EXTRACT_FAILED", "Error writing extracted files.");
  if (x.nested.length > 0) return refusal(422, "ZIP_NESTED", `The archive holds other archives in place of the files of a feed: ${named(x.nested).join(", ")}.`, { files: named(x.nested) });
  // Two files of one name (two folders, or a case variant): which one is the feed is the sender's call, not ours.
  if (x.duplicateNames.length > 0) {
    return refusal(422, "DUPLICATE_FILES", `The zip holds the same file more than once: ${x.duplicateNames.join(", ")}.`, { type: "DUPLICATE_FILES", duplicates: x.duplicateNames, files: x.duplicateNames });
  }
  return null;
};

/**
 * The door's reading of an archive, an upload's and a published feed's alike: unpacked into `dir`, then removed (left
 * beside the feed, the validator would report it as a file of the feed, unknown_file). Throws the refusal of one that
 * is not a feed the server can load: no required file, no feed, no session.
 */
const unpackAtDoor = async (zipPath, dir) => {
  let extracted;
  try {
    extracted = await extractGtfsZip(zipPath, dir);
  } catch (err) {
    // The server's own failure to read its file is no fault of the archive.
    if (err && err.syscall) throw err;
    // A file named .zip that is no archive, or a damaged one: the sender's file, not a fault of the server.
    throw refusal(400, "ZIP_UNREADABLE", "The ZIP archive cannot be read: it is damaged or not a ZIP archive.");
  } finally {
    await fsp.rm(zipPath, { force: true }).catch(() => {});
  }
  const refused = archiveRefusalOf(extracted);
  if (refused) throw refused;
  const missing = await missingGtfsFiles(dir);
  if (missing.length > 0) throw refusal(422, "NOT_GTFS", `The zip is not a GTFS feed: ${missing.join(", ")} missing.`, { type: "NOT_GTFS", missing, files: missing.map(gtfsFileNames) });
  // A file that cannot be read as its table is said by its cause, before anything is validated or imported.
  const unreadable = unreadableFeed(dir);
  if (unreadable) throw unreadable;
  const noRoom = await require("./diskRoom").roomRefusal(dir);
  if (noRoom) throw noRoom;
};

// A refusal of the upload: its code for the web to word, the server's sentence, and what the web may show of it.
const refuse = (res, status, code, message, details = {}) => res.status(status).json({ error: code, message, ...details });

const uploadGTFSFile = async (req, res) => {
  if (!req.files || !req.files.gtfsZip) {
    return refuse(res, 400, "NO_FILE", "No file was uploaded. Please select a ZIP archive containing your GTFS files.");
  }

  const gtfsZip = req.files.gtfsZip;

  if (gtfsZip.size > UPLOAD_MAX_MB * 1024 * 1024) {
    return refuse(res, 413, "FILE_TOO_LARGE", `File too large. Max: ${UPLOAD_MAX_MB} MB. Received: ${Math.round(gtfsZip.size / 1024 / 1024)} MB`, { max_mb: UPLOAD_MAX_MB });
  }

  // Each session is a memory-heavy database: keyless uploads get a smaller pool so anonymous traffic never starves
  // the licence holders.
  const activeSessions = getActiveSessionsCount();
  const sessionCap = sessionCapFor(req);
  if (activeSessions >= sessionCap) {
    return refuse(res, 503, "AT_CAPACITY", `Server at capacity (${sessionCap} sessions). Please try again later.`);
  }

  const sessionId = req.headers["x-session-id"] || crypto.randomUUID();

  // Path traversal guard.
  if (!validateSessionId(sessionId)) {
    return refuse(res, 400, "INVALID_SESSION", "Invalid session ID.");
  }

  // A second upload on the session would remove the folder the first one is unpacking into.
  if (isUploadInProgress(sessionId)) {
    return refuse(res, 409, "UPLOAD_IN_PROGRESS", "A network is already being opened in this session: wait for it to open.");
  }

  console.info(
    `📎 Upload GTFS for session: ${sessionTag(sessionId)} (Active sessions: ${activeSessions}/${MAX_SESSIONS})`,
  );

  // The edits lost are counted before the handle closes, so the client can say so.
  let editSessionDropped = false;
  let pendingEditsLost = 0;
  if (hasEditDb(sessionId) || hasEditDbOnDisk(sessionId)) {
    try {
      const { db } = openEditDb(sessionId);
      const row = db
        .prepare("SELECT COUNT(*) AS c FROM _edit_log WHERE undone = 0")
        .get();
      pendingEditsLost = row?.c || 0;
      editSessionDropped = true;
    } catch (probeErr) {
      console.warn(
        `Could not probe edit DB for ${sessionTag(sessionId)}:`,
        probeErr.message,
      );
      editSessionDropped = true;
    }
    // Releases the Windows lock; the folder's removal below deletes the file.
    closeEditDb(sessionId, { removeFile: false });
  }
  clearSessionCache(sessionId);

  const uploadPath = path.join(GTFS_UPLOAD_DIR, sessionId);

  // An upload made signed in belongs to the account: only its requests reach the session from now on. A session that
  // already belongs to an account keeps it: a member replacing a project's copy does not take it over.
  const ownerUserId = sessionOwner.ownerOf(sessionId) || (req.user && req.user.id != null ? String(req.user.id) : null);
  sessionOwner.rememberOwner(sessionId, ownerUserId);

  // The door's place is held until the upload's work ends, whether its sender waits for the answer or not.
  const leave = req.holdInFlight ? req.holdInFlight() : () => {};
  if (!leave) return refuse(res, 503, "SERVER_BUSY", "Too many files are being received at once. Try again in a few seconds.", { retryAfterSec: 5 });
  markUploadStarted(sessionId);
  const progress = reporterOf(req);
  let uploadCommitted = false;
  let loading = null;
  try {
    const existingEntry = await fsp.lstat(uploadPath).catch(() => null);
    if (existingEntry) {
      if (existingEntry.isSymbolicLink()) {
        return res
          .status(500)
          .json({ error: "Security error: invalid upload path." });
      }
      await fsp.rm(uploadPath, { recursive: true, force: true });
    }

    await fsp.mkdir(uploadPath, { recursive: true, mode: 0o700 });

    recordEvent("session.created", {
      session: sessionId,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      data: { source: "upload" },
    });

    const zipFilePath = path.join(uploadPath, "gtfs.zip");
    try {
      // Received on disk (the route's parser), the archive is moved, not copied; a caller that holds it in memory writes it.
      if (gtfsZip.tempFilePath) await gtfsZip.mv(zipFilePath);
      else await fsp.writeFile(zipFilePath, gtfsZip.data);
    } catch (writeErr) {
      console.error(
        `Upload write error for ${sessionTag(sessionId)}:`,
        writeErr.message,
      );
      return res.status(500).json({ error: "Error saving the uploaded file." });
    }

    progress.stage("unpack");
    try {
      await unpackAtDoor(zipFilePath, uploadPath);
    } catch (refused) {
      if (!refused || !refused.status || typeof refused.code !== "string") throw refused;
      return refuse(res, refused.status, refused.code, refused.message, refused.details || {});
    }

    // Edit mode initialises _project_meta.source_feed_name from it.
    let sourceName = "";
    try {
      const safeName = (gtfsZip.name || "")
        .replace(/\.zip$/i, "")
        .replace(/[^a-zA-Z0-9._\- ]/g, "_")
        .trim()
        .slice(0, 120);
      if (safeName) {
        // Written only after validation: a sidecar beside the .txt files would raise an unknown_file notice.
        sourceName = safeName;
      }
    } catch (srcErr) {
      console.warn("Could not persist source name:", srcErr.message);
    }

    // A validator that fails opens the network unverified, as a published feed and the demo do: reading is free and
    // only a delivery needs the verdict (G1). Its rejection is caught here: escaping this handler it would crash the
    // process.
    const described = await describeDir(uploadPath);
    const fingerprint = described?.fingerprint || null;
    // A person's file is never written to the store of built databases; the same content as a published feed is read from it.
    loading = await loadWhileChecking(sessionId, uploadPath, progress, { staged: readsFirst(req), kept: fingerprint ? { fingerprint, write: false } : null });
    if (!loading.beside) progress.stage("validate");
    // Not awaited: the network is read as soon as its import is done, the verdict follows.
    const validating = verdictOf(
      loading,
      async () => {
        const report = await validateOpening(sessionId, loading.checkPath, described, { allowIncomplete: true, cache: validationCacheOf(req, "upload", described) });
        if (sourceName) {
          try {
            fs.writeFileSync(path.join(uploadPath, "_source_name.txt"), sourceName, "utf8");
          } catch (srcErr) {
            console.warn("Could not persist source name:", srcErr.message);
          }
        }
        return report;
      },
      {
        sessionId,
        what: "Upload",
        // A feed with errors is still accepted, marked non-compliant: a broken feed to fix is what the product is for;
        // only the export gates on errors.
        onDone: (report) => {
          if (report && report.valid === false) console.info(`🛟 Rescue upload for ${sessionTag(sessionId)}: feed has ${(report.counts && report.counts.errors) || "?"} canonical error(s) — session created as non-compliant`);
        },
      },
    );
    if (!loading.beside) await validating;

    // The import (the CSVs parsed, the database built in a child process) fails the upload when it fails: without
    // gtfs.db every read answers 4xx, and the folder would count toward the session cap until the sweep. A feed too
    // large for the memory is 413, a structural REQUIRED_FIELDS_MISSING 400 with its (bounded) row-level errors, a
    // file that cannot be read as a table its own refusal, anything else 500.
    let migrationMs = 0;
    let importAdjustments = {};
    let importAdjustmentDetails = {};
    let encoding = { bomStripped: [], encodingFallbacks: [] };
    let importResult = {};
    try {
      // A large feed answers here before its stop times are in (`partial`); they follow below, after the answer.
      importResult = await loading.first();
      migrationMs = importResult.ms;
      if (importResult.importAdjustments) importAdjustments = importResult.importAdjustments;
      if (importResult.importAdjustmentDetails) importAdjustmentDetails = importResult.importAdjustmentDetails;
      if (importResult.encoding) encoding = importResult.encoding;
    } catch (migrateErr) {
      const refused = importRefusalOf(migrateErr);
      if (refused.status === 500) console.error(`Upload migration to SQLite failed for ${sessionTag(sessionId)}:`, migrateErr.message);
      // Releases the Windows lock so the folder can be removed below.
      if (!(migrateErr && (migrateErr.code === "FEED_TOO_LARGE" || migrateErr.code === "SERVER_BUSY"))) {
        try {
          closeEditDb(sessionId, { removeFile: true });
        } catch (_) {
          /* best effort */
        }
      }
      if (refused.retryAfterSec) res.set("Retry-After", String(refused.retryAfterSec));
      return res.status(refused.status).json(refused.body);
    }
    const partial = Boolean(importResult.partial);
    // Resolves once the whole network is in place: true, or false when its stop times could not be loaded.
    let wholeIn = null;
    const whole = partial ? new Promise((resolve) => (wholeIn = resolve)) : null;
    // The blank lines are told by the import once it has read every file.
    const blankRows = partial ? {} : importResult.blankRows || takeBlankRows(uploadPath);

    // The import folded the exact duplicate rows: their findings are resolved before the report is kept, so no repair is
    // asked for rows that are gone; the rows it kept aside are named. A report of the network as loaded needs neither.
    const settle = async (report) => {
      // What the import folded and kept aside is known once every file is read.
      if (whole && !(await whole)) return null;
      let settled = report;
      const loaded = await reportOfLoadedNetwork(sessionId, settled, importAdjustmentDetails);
      if (loaded) settled = loaded;
      else settleReportWithImport(sessionId, settled, importAdjustments);
      // The feed as uploaded is the baseline every delivery of a modified feed is measured against (G1).
      saveValidationBaseline(sessionId, settled);
      saveValidationReport(sessionId, settled, { of: fingerprint });
      return settled;
    };
    const verdictMeta = (report) => ({ validation: { ...summarizeValidation(report), ...(report.unverified ? { unverified: true } : {}) }, compliance: complianceOf(report) });
    let sessionMeta = null;
    if (!partial) require("./qualityAuditService").warmAudit(sessionId);
    const verdict = await verdictNowOrLater({ sessionId, validating, settle, of: fingerprint, later: partial, after: (report) => (sessionMeta && report ? persistSessionMeta(uploadPath, { ...sessionMeta, ...verdictMeta(report) }) : null) });
    const validationResult = verdict.report;
    // No verdict, or none yet: neither way is one.
    const unverified = Boolean(validationResult.unverified);

    const summary = importResult.summary || { agencies: [], routes: 0, stops: 0, trips: 0, stop_times: 0 };
    const agencies = summary.agencies;
    const agencyNames = agencies
      .map((a) => a.agency_name || a.agency_id || "unknown")
      .filter(Boolean)
      .join(", ");
    const agencyIds = agencies
      .map((a) => a.agency_id || "")
      .filter(Boolean)
      .join(", ");
    const agencyUrls = agencies
      .map((a) => a.agency_url || "")
      .filter(Boolean)
      .join(", ");
    const hasShapes = fs.existsSync(path.join(uploadPath, "shapes.txt"));
    const sizeKb = parseFloat((gtfsZip.size / 1024).toFixed(1));

    sessionMeta = {
      session_id: sessionId,
      owner_user_id: ownerUserId,
      created_at: new Date().toISOString(),
      source: "upload",
      source_name: sourceName || null,
      fingerprint,
      size_kb: sizeKb,
      agency: {
        names: agencyNames,
        ids: agencyIds,
        urls: agencyUrls || null,
        count: agencies.length,
      },
      counts: {
        routes: summary.routes,
        stops: summary.stops,
        trips: summary.trips,
        has_shapes: hasShapes,
      },
      ...verdictMeta(validationResult),
    };
    await persistSessionMeta(uploadPath, sessionMeta);

    // The opening's progress goes on after this answer, to the stop times' last row.
    req.openingContinues = partial;
    res.json({
      // Null when not validated; the upload succeeded either way.
      valid: unverified ? null : validationResult.valid !== false,
      validationReport: validationResult,
      sessionId,
      // The content fingerprint (feedFingerprint): the same files opened again, whatever their zip, give the same one.
      fingerprint,
      migration_ms: migrationMs,
      // Kept for the clients that read them: a failed migration is now a 4xx/5xx, never a session.
      migrationFailed: false,
      migrationError: null,
      // The network is read while its stop times load: `progress` names the opening GET /import/progress/:id follows.
      ...(partial ? { timetables: { loading: true, progress: progress.id } } : {}),
      // Duplicate-key rows skipped at import (first kept), per table.
      importAdjustments,
      // Per table: { duplicate_key, invalid_value, invalid_samples }, the rows a constraint refused counted apart.
      importAdjustmentDetails,
      editSessionDropped,
      pendingEditsLost,
      meta: {
        bomStripped: encoding.bomStripped || [],
        encodingFallbacks: encoding.encodingFallbacks || [],
        // Blank lines dropped at parse, per table.
        blankRows,
      },
    });
    // The response is sent: a later stat-logging failure must not delete the folder.
    uploadCommitted = true;

    try {
      const statEntry = {
        date: new Date().toISOString(),
        session: sessionId,
        agency_names: agencyNames,
        agency_ids: agencyIds,
        agency_urls: agencyUrls || null,
        agency_count: agencies.length,
        routes_count: summary.routes,
        stops_count: summary.stops,
        trips_count: summary.trips,
        has_shapes: hasShapes,
        size_kb: sizeKb,
      };
      console.info(
        `📊 [UPLOAD] session=${sessionTag(sessionId)} | agencies="${agencyNames}" | urls="${agencyUrls}" | routes=${summary.routes} | stops=${summary.stops} | trips=${summary.trips} | shapes=${hasShapes} | size=${statEntry.size_kb}KB`,
      );
      await appendUploadStat(statEntry);
      recordEvent("upload", {
        ...extractReqMeta(req),
        is_sample: false,
        size_kb: statEntry.size_kb,
        agency_ids: agencyIds,
        agency_names: agencyNames,
        agency_urls: agencyUrls || null,
        agency_count: agencies.length,
        routes_count: summary.routes,
        stops_count: summary.stops,
        trips_count: summary.trips,
        has_shapes: hasShapes,
      });
    } catch (logErr) {
      console.warn("Could not log agency stats:", logErr.message);
    }

    // No cache warm-up after the response: every read is SQL, and re-parsing would double the feed in memory.
    if (partial) {
      const loaded = await finishStaged({
        sessionId,
        uploadPath,
        loading,
        progress,
        sourceName,
        onWhole: (result) => {
          importAdjustments = result.importAdjustments || {};
          importAdjustmentDetails = result.importAdjustmentDetails || {};
          timetables.whole(sessionId, { importAdjustments, importAdjustmentDetails, blankRows: result.blankRows || {}, counts: result.counts || {} });
          require("./qualityAuditService").warmAudit(sessionId);
        },
      });
      wholeIn(Boolean(loaded));
    }
  } finally {
    if (loading) await loading.settled();
    if (!uploadCommitted) {
      await fsp
        .rm(uploadPath, { recursive: true, force: true })
        .catch((rmErr) =>
          console.warn(
            `Cleanup of failed upload ${sessionTag(sessionId)} failed:`,
            rmErr.message,
          ),
        );
      clearSessionCache(sessionId);
    }
    markUploadFinished(sessionId);
    if (leave) leave();
  }
};

const getUploadStats = async (req, res) => {
  const escapeHtml = (str) =>
    String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  try {
    let entries = [];
    if (fs.existsSync(STATS_FILE)) {
      const raw = await fsp.readFile(STATS_FILE, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          // A corrupted line is skipped.
        }
      }
    }

    const sampleEntries = entries.filter((e) => e.is_sample);
    const realEntries = entries.filter((e) => !e.is_sample);
    const total = entries.length;
    const sampleCount = sampleEntries.length;
    const uniqueSessions = new Set(entries.map((e) => e.session)).size;
    const totalSizeKb = realEntries.reduce((s, e) => s + (e.size_kb || 0), 0);
    const avgSizeKb =
      realEntries.length > 0 ? Math.round(totalSizeKb / realEntries.length) : 0;

    // A feed's fingerprint: its sorted agency ids.
    const feedMap = {};
    entries.forEach((e) => {
      const ids = e.agency_ids || "unknown";
      const fp = ids.split(", ").sort().join("|");
      if (!feedMap[fp]) {
        feedMap[fp] = {
          label: e.agency_names || ids,
          ids,
          agencies: (e.agency_names || "").split(", ").filter(Boolean),
          agencyCount: e.agency_count || 1,
          urls: (e.agency_urls || "")
            .split(", ")
            .filter((u) => u && u !== "null"),
          uploads: 0,
          sessions: new Set(),
          lastSeen: e.date,
          lastSize: e.size_kb,
          lastRoutes: e.routes_count,
          lastStops: e.stops_count,
          lastTrips: e.trips_count,
          hasShapes: e.has_shapes,
        };
      }
      feedMap[fp].uploads++;
      feedMap[fp].sessions.add(e.session);
      if (e.date > feedMap[fp].lastSeen) {
        feedMap[fp].lastSeen = e.date;
        feedMap[fp].lastSize = e.size_kb;
        if (e.routes_count != null) feedMap[fp].lastRoutes = e.routes_count;
        if (e.stops_count != null) feedMap[fp].lastStops = e.stops_count;
        if (e.trips_count != null) feedMap[fp].lastTrips = e.trips_count;
        if (e.has_shapes != null) feedMap[fp].hasShapes = e.has_shapes;
        if (e.agency_names) {
          feedMap[fp].label = e.agency_names;
          feedMap[fp].agencies = e.agency_names.split(", ").filter(Boolean);
        }
      }
    });
    const feeds = Object.values(feedMap)
      .map((f) => ({ ...f, sessions: f.sessions.size }))
      .sort((a, b) => b.uploads - a.uploads);
    const distinctFeeds = feeds.length;

    const agencyMap = {};
    entries.forEach((e) => {
      const names = e.agency_names ? e.agency_names.split(", ") : ["unknown"];
      const urls = e.agency_urls ? e.agency_urls.split(", ") : [];
      names.forEach((n, i) => {
        if (!agencyMap[n])
          agencyMap[n] = { count: 0, url: null, lastSeen: e.date };
        agencyMap[n].count++;
        if (!agencyMap[n].url && urls[i]) agencyMap[n].url = urls[i];
        if (e.date > agencyMap[n].lastSeen) agencyMap[n].lastSeen = e.date;
      });
    });
    const distinctAgencies = Object.keys(agencyMap).length;

    // ── Shapes coverage ──
    const withShapesData = entries.filter((e) => e.has_shapes != null);
    const shapesYes = withShapesData.filter((e) => e.has_shapes).length;
    const shapesPct =
      withShapesData.length > 0
        ? Math.round((shapesYes / withShapesData.length) * 100)
        : 0;

    // ── Size distribution ──
    const sizeBuckets = {
      "< 1 MB": 0,
      "1–10 MB": 0,
      "10–50 MB": 0,
      "> 50 MB": 0,
    };
    entries.forEach((e) => {
      const mb = (e.size_kb || 0) / 1024;
      if (mb < 1) sizeBuckets["< 1 MB"]++;
      else if (mb < 10) sizeBuckets["1–10 MB"]++;
      else if (mb < 50) sizeBuckets["10–50 MB"]++;
      else sizeBuckets["> 50 MB"]++;
    });
    const maxBucket = Math.max(...Object.values(sizeBuckets), 1);

    // ── Today count ──
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);
    const todayCount = entries.filter(
      (e) => e.date && e.date.startsWith(todayKey),
    ).length;
    const todaySampleCount = sampleEntries.filter(
      (e) => e.date && e.date.startsWith(todayKey),
    ).length;

    // ── Totals for routes/stops/trips (latest per feed only) ──
    const totalRoutes = feeds.reduce((s, f) => s + (f.lastRoutes || 0), 0);
    const totalStops = feeds.reduce((s, f) => s + (f.lastStops || 0), 0);
    const totalTrips = feeds.reduce((s, f) => s + (f.lastTrips || 0), 0);

    // ── 14-day upload trend ──
    const TREND_DAYS = 14;
    const trend = [];
    for (let i = TREND_DAYS - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      trend.push({
        date: key,
        count: entries.filter((e) => e.date && e.date.startsWith(key)).length,
      });
    }
    const maxTrend = Math.max(...trend.map((t) => t.count), 1);
    const trendTotal = trend.reduce((s, t) => s + t.count, 0);

    // ── Hourly heatmap for trend ──
    const hourlyData = new Array(24).fill(0);
    entries.forEach((e) => {
      try {
        const d = new Date(e.date);
        const parisHour = (d.getUTCHours() + 2) % 24; // Approximate CEST
        hourlyData[parisHour]++;
      } catch {}
    });
    const maxHourly = Math.max(...hourlyData, 1);

    const recentEntries = [...entries].reverse().slice(0, 200);

    const fmtSize = (kb) => {
      if (!kb) return "—";
      return kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : kb + " KB";
    };
    const fmtDate = (iso) => {
      try {
        return new Date(iso).toLocaleString("fr-FR", {
          timeZone: "Europe/Paris",
        });
      } catch {
        return String(iso || "—");
      }
    };
    const fmtNum = (n) => (n != null ? n.toLocaleString("fr-FR") : "—");

    const bucketColors = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6"];

    const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Upload Stats · GTFS Express</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#f8fafc;--surface:#ffffff;--surface2:#f1f5f9;
      --border:#e2e8f0;--border2:#cbd5e1;
      --text:#0f172a;--text2:#475569;--text3:#94a3b8;
      --blue:#3b82f6;--green:#10b981;--orange:#f59e0b;--purple:#8b5cf6;--red:#ef4444;--cyan:#06b6d4;
      --shadow:0 1px 3px rgba(0,0,0,.04),0 1px 2px rgba(0,0,0,.06);
      --shadow-md:0 4px 6px -1px rgba(0,0,0,.05),0 2px 4px -2px rgba(0,0,0,.05);
    }
    body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;line-height:1.5;-webkit-font-smoothing:antialiased}

    /* ── Header ── */
    .hdr{background:var(--surface);border-bottom:1px solid var(--border);padding:.85rem 2rem;display:flex;align-items:center;justify-content:space-between;gap:1rem;position:sticky;top:0;z-index:10;backdrop-filter:blur(8px)}
    .hdr-brand{display:flex;align-items:center;gap:.65rem}
    .hdr-logo{width:32px;height:32px;background:var(--blue);border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:.8rem;flex-shrink:0}
    .hdr h1{font-size:.92rem;font-weight:700;color:var(--text);letter-spacing:-.01em}
    .hdr-meta{font-size:.68rem;color:var(--text3);display:flex;align-items:center;gap:.5rem}
    .hdr-actions{display:flex;align-items:center;gap:.5rem}
    .btn{display:inline-flex;align-items:center;gap:.3rem;padding:.35rem .75rem;border-radius:8px;font-size:.72rem;font-weight:500;text-decoration:none;border:1px solid var(--border);background:var(--surface);color:var(--text2);cursor:pointer;transition:all .15s;font-family:inherit}
    .btn:hover{background:var(--surface2);border-color:var(--border2);color:var(--text)}
    .btn-primary{background:var(--blue);border-color:var(--blue);color:#fff}
    .btn-primary:hover{opacity:.9;background:var(--blue);color:#fff}
    #countdown{font-size:.68rem;color:var(--text3);font-variant-numeric:tabular-nums}
    .live-dot{width:6px;height:6px;border-radius:50%;background:var(--green);display:inline-block;animation:pulse 2s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}

    /* ── Layout ── */
    .ctr{max-width:1280px;margin:0 auto;padding:1.5rem 1.5rem 3rem}
    .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
    .grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem}

    /* ── KPI strip ── */
    .kpi-strip{display:grid;grid-template-columns:repeat(5,1fr);gap:.75rem;margin-bottom:1.25rem}
    .kpi{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:.9rem 1rem;box-shadow:var(--shadow)}
    .kpi-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:.35rem}
    .kpi-label{font-size:.65rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text3)}
    .kpi-icon{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:.8rem}
    .kpi-icon.blue{background:#eff6ff;color:var(--blue)}
    .kpi-icon.green{background:#ecfdf5;color:var(--green)}
    .kpi-icon.purple{background:#f5f3ff;color:var(--purple)}
    .kpi-icon.orange{background:#fffbeb;color:var(--orange)}
    .kpi-icon.cyan{background:#ecfeff;color:var(--cyan)}
    .kpi-value{font-size:1.5rem;font-weight:800;line-height:1.1;color:var(--text);letter-spacing:-.02em}
    .kpi-sub{font-size:.64rem;color:var(--text3);margin-top:.2rem}
    .kpi-sub .up{color:var(--green);font-weight:600}
    .kpi-sub .sample-tag{color:var(--purple);font-weight:600}

    /* ── Cards ── */
    .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:1.15rem 1.25rem;box-shadow:var(--shadow);margin-bottom:1rem}
    .card-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;gap:.75rem;flex-wrap:wrap}
    .card-title{font-size:.78rem;font-weight:700;color:var(--text);display:flex;align-items:center;gap:.4rem}
    .pill{background:var(--surface2);color:var(--text2);padding:.15rem .55rem;border-radius:20px;font-size:.65rem;font-weight:500;border:1px solid var(--border)}

    /* ── Trend ── */
    .trend{display:flex;align-items:flex-end;gap:4px;height:100px}
    .t-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0}
    .t-cnt{font-size:.55rem;color:var(--text3);height:14px;display:flex;align-items:center}
    .t-bar{width:100%;border-radius:4px 4px 1px 1px;cursor:default;transition:opacity .15s}
    .t-bar:hover{opacity:.75}
    .t-lbl{font-size:.52rem;color:var(--text3);white-space:nowrap}

    /* ── Hour grid ── */
    .hour-grid{display:flex;align-items:flex-end;gap:2px;height:56px}
    .h-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;min-width:0}
    .h-bar{width:100%;border-radius:3px 3px 0 0;transition:opacity .15s;cursor:default}
    .h-bar:hover{opacity:.7}
    .h-lbl{font-size:.48rem;color:var(--text3)}

    /* ── Size buckets ── */
    .bkt{display:flex;align-items:center;gap:.65rem;margin-bottom:.5rem}
    .bkt-label{min-width:64px;font-size:.72rem;color:var(--text2);text-align:right;font-weight:500}
    .bkt-track{flex:1;background:var(--surface2);border-radius:6px;height:22px;overflow:hidden}
    .bkt-fill{height:100%;border-radius:6px;transition:width .4s ease}
    .bkt-val{min-width:56px;font-size:.7rem;color:var(--text3);font-variant-numeric:tabular-nums}

    /* ── Feed cards ── */
    .feed{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:.75rem .9rem;margin-bottom:.5rem;transition:all .15s}
    .feed:hover{border-color:var(--border2);box-shadow:var(--shadow)}
    .feed-top{display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-bottom:.3rem}
    .feed-name{font-size:.78rem;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
    .feed-tags{display:flex;gap:.3rem;flex-shrink:0;flex-wrap:wrap}
    .tag{display:inline-flex;align-items:center;padding:1px 7px;border-radius:5px;font-size:.6rem;font-weight:600}
    .tag-blue{background:#eff6ff;color:var(--blue)}
    .tag-green{background:#ecfdf5;color:var(--green)}
    .tag-purple{background:#f5f3ff;color:var(--purple)}
    .tag-orange{background:#fffbeb;color:var(--orange)}
    .feed-agencies{font-size:.66rem;color:var(--text3);line-height:1.5}
    .feed-agencies a{color:var(--blue);text-decoration:none}
    .feed-agencies a:hover{text-decoration:underline}
    .feed-meta{display:flex;gap:1rem;margin-top:.3rem;font-size:.65rem;color:var(--text3);flex-wrap:wrap}
    .feed-meta span{display:inline-flex;align-items:center;gap:.2rem}

    /* ── Controls ── */
    .ctrl{display:flex;align-items:center;gap:.5rem}
    .srch{background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:.35rem .7rem;border-radius:8px;font-size:.73rem;width:220px;outline:none;font-family:inherit}
    .srch:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(59,130,246,.1)}
    .srch::placeholder{color:var(--text3)}

    /* ── Table ── */
    .tbl-wrap{overflow-x:auto;margin-top:.25rem}
    table{width:100%;border-collapse:collapse;font-size:.72rem}
    thead th{text-align:left;padding:.5rem .65rem;color:var(--text3);font-weight:600;font-size:.65rem;text-transform:uppercase;letter-spacing:.04em;border-bottom:2px solid var(--border);white-space:nowrap;position:sticky;top:0;background:var(--surface);cursor:pointer;user-select:none}
    thead th:hover{color:var(--text2)}
    thead th.r{text-align:right}
    thead th .si{font-size:.55rem;margin-left:.2rem;opacity:.3}
    thead th.sorted .si{opacity:1;color:var(--blue)}
    tbody td{padding:.45rem .65rem;border-bottom:1px solid var(--border);color:var(--text2);vertical-align:middle}
    tbody tr:hover td{background:#f8fafc}
    .badge{display:inline-block;border-radius:6px;padding:1px 8px;font-size:.65rem;font-weight:600;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis}
    .b-blue{background:#eff6ff;color:var(--blue)}
    .b-multi{background:#f5f3ff;color:var(--purple)}
    .b-sample{background:#ecfdf5;color:var(--green);border:1px dashed #a7f3d0}
    .r{text-align:right}
    .num{font-variant-numeric:tabular-nums}
    .dot{display:inline-block;width:8px;height:8px;border-radius:50%}
    .dot-y{background:var(--green)}
    .dot-n{background:var(--border)}
    .url-cell{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.66rem}
    .url-cell a{color:var(--blue);text-decoration:none}
    .url-cell a:hover{text-decoration:underline}
    .ts{font-size:.66rem;white-space:nowrap;color:var(--text3)}
    .dim{color:var(--text3)}
    .empty{text-align:center;padding:2rem;color:var(--text3);font-size:.82rem}

    /* ── Footer ── */
    footer{text-align:center;color:var(--text3);font-size:.62rem;padding:1.5rem 2rem .5rem;margin-top:.5rem}

    a{color:var(--blue);text-decoration:none}
    a:hover{text-decoration:underline}

    @media(max-width:1024px){
      .kpi-strip{grid-template-columns:repeat(3,1fr)}
      .grid-2,.grid-3{grid-template-columns:1fr}
    }
    @media(max-width:640px){
      .hdr{flex-direction:column;align-items:flex-start;gap:.5rem;padding:.75rem 1rem}
      .ctr{padding:1rem}
      .kpi-strip{grid-template-columns:repeat(2,1fr)}
      .url-cell,.feed-agencies{display:none}
    }
  </style>
</head>
<body>

<div class="hdr">
  <div class="hdr-brand">
    <div class="hdr-logo">GE</div>
    <div>
      <h1>Upload Stats</h1>
      <div class="hdr-meta"><span class="live-dot"></span> Auto-refresh · ${total} events</div>
    </div>
  </div>
  <div class="hdr-actions">
    <span id="countdown"></span>
    <a href="/api/gtfs/upload-stats" class="btn">Actualiser</a>
    <a href="/stats/" class="btn btn-primary">GoAccess</a>
  </div>
</div>

<div class="ctr">

  <!-- KPIs -->
  <div class="kpi-strip">
    <div class="kpi">
      <div class="kpi-top">
        <span class="kpi-label">Uploads</span>
        <span class="kpi-icon blue">📤</span>
      </div>
      <div class="kpi-value">${total - sampleCount}</div>
      <div class="kpi-sub"><span class="up">+${todayCount - todaySampleCount}</span> aujourd'hui · ${uniqueSessions} sessions</div>
    </div>
    <div class="kpi">
      <div class="kpi-top">
        <span class="kpi-label">Sample</span>
        <span class="kpi-icon purple">🎮</span>
      </div>
      <div class="kpi-value">${sampleCount}</div>
      <div class="kpi-sub"><span class="sample-tag">+${todaySampleCount}</span> aujourd'hui</div>
    </div>
    <div class="kpi">
      <div class="kpi-top">
        <span class="kpi-label">Jeux GTFS</span>
        <span class="kpi-icon green">📦</span>
      </div>
      <div class="kpi-value">${distinctFeeds}</div>
      <div class="kpi-sub">${distinctAgencies} agences distinctes</div>
    </div>
    <div class="kpi">
      <div class="kpi-top">
        <span class="kpi-label">Taille moy.</span>
        <span class="kpi-icon orange">⚖️</span>
      </div>
      <div class="kpi-value">${fmtSize(avgSizeKb)}</div>
      <div class="kpi-sub">Total : ${fmtSize(Math.round(totalSizeKb))}</div>
    </div>
    <div class="kpi">
      <div class="kpi-top">
        <span class="kpi-label">Shapes</span>
        <span class="kpi-icon cyan">🗺️</span>
      </div>
      <div class="kpi-value">${shapesPct}%</div>
      <div class="kpi-sub">${shapesYes}/${withShapesData.length} with shapes</div>
    </div>
  </div>

  <!-- Trend + Hourly + Data explored -->
  <div class="grid-3" style="margin-bottom:1rem">
    <div class="card">
      <div class="card-hdr">
        <span class="card-title">📈 14 derniers jours</span>
        <span class="pill">${trendTotal} uploads</span>
      </div>
      <div class="trend">
        ${trend
          .map((t) => {
            const isToday = t.date === todayKey;
            const barH = Math.max(2, Math.round((t.count / maxTrend) * 84));
            const bg = isToday ? "var(--green)" : "var(--blue)";
            return `<div class="t-col" title="${t.date} — ${t.count}">
          <span class="t-cnt">${t.count || ""}</span>
          <div class="t-bar" style="height:${barH}px;background:${bg};opacity:${isToday ? 1 : 0.7}"></div>
          <span class="t-lbl">${t.date.slice(8)}</span>
        </div>`;
          })
          .join("")}
      </div>
    </div>

    <div class="card">
      <div class="card-hdr">
        <span class="card-title">🕐 Hourly activity</span>
        <span class="pill">Paris</span>
      </div>
      <div class="hour-grid">
        ${hourlyData
          .map((c, h) => {
            const barH = Math.max(1, Math.round((c / maxHourly) * 44));
            const opacity = c > 0 ? 0.35 + (c / maxHourly) * 0.65 : 0.08;
            return `<div class="h-col" title="${h}h — ${c}">
          <div class="h-bar" style="height:${barH}px;background:var(--blue);opacity:${opacity.toFixed(2)}"></div>
          <span class="h-lbl">${h % 4 === 0 ? h + "h" : ""}</span>
        </div>`;
          })
          .join("")}
      </div>
    </div>

    <div class="card">
      <div class="card-hdr">
        <span class="card-title">📊 Data explored</span>
        <span class="pill">dernier upload / feed</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:.65rem;padding-top:.3rem">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:.72rem;color:var(--text2);font-weight:500">🚌 Routes</span>
          <span style="font-size:1.05rem;font-weight:800;color:var(--text)">${fmtNum(totalRoutes)}</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:.72rem;color:var(--text2);font-weight:500">📍 Stops</span>
          <span style="font-size:1.05rem;font-weight:800;color:var(--text)">${fmtNum(totalStops)}</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:.72rem;color:var(--text2);font-weight:500">🔄 Voyages</span>
          <span style="font-size:1.05rem;font-weight:800;color:var(--text)">${fmtNum(totalTrips)}</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Size distribution -->
  <div class="card">
    <div class="card-hdr">
      <span class="card-title">📐 Size distribution</span>
      <span class="pill">${total} fichiers</span>
    </div>
    ${Object.entries(sizeBuckets)
      .map(([label, count], i) => {
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        return `<div class="bkt">
      <div class="bkt-label">${label}</div>
      <div class="bkt-track"><div class="bkt-fill" style="width:${Math.max(1, Math.round((count / maxBucket) * 100))}%;background:${bucketColors[i]}"></div></div>
      <div class="bkt-val">${count} (${pct}%)</div>
    </div>`;
      })
      .join("")}
  </div>

  <!-- GTFS feeds -->
  <div class="card">
    <div class="card-hdr">
      <span class="card-title">📦 Jeux GTFS</span>
      <div class="ctrl">
        <input class="srch" id="feedSrch" placeholder="Filtrer…" oninput="filterFeeds(this.value)" autocomplete="off"/>
        <span class="pill" id="feedCount">${feeds.length} jeu${feeds.length !== 1 ? "x" : ""}</span>
      </div>
    </div>
    <div id="feedList">
    ${
      feeds.length === 0
        ? '<p class="empty">Aucun jeu GTFS.</p>'
        : feeds
            .slice(0, 50)
            .map((f) => {
              const mainName =
                f.agencies.length > 3
                  ? f.agencies
                      .slice(0, 3)
                      .map((n) => escapeHtml(n))
                      .join(", ") +
                    ` <span class="dim">+${f.agencies.length - 3}</span>`
                  : f.agencies.map((n) => escapeHtml(n)).join(", ");
              const primaryUrl = f.urls.length > 0 ? f.urls[0] : null;
              return `<div class="feed" data-fq="${escapeHtml((f.label + " " + f.ids).toLowerCase())}">
        <div class="feed-top">
          <div class="feed-name">${primaryUrl ? `<a href="${escapeHtml(primaryUrl)}" target="_blank" rel="noopener noreferrer">${mainName}</a>` : mainName}</div>
          <div class="feed-tags">
            <span class="tag tag-blue">↑${f.uploads}</span>
            <span class="tag tag-green">${f.sessions} sess.</span>
            ${f.agencyCount > 1 ? `<span class="tag tag-purple">${f.agencyCount} ag.</span>` : ""}
            ${f.hasShapes ? '<span class="tag tag-orange">shapes</span>' : ""}
          </div>
        </div>
        ${
          f.agencies.length > 1 && f.agencies.length <= 8
            ? `<div class="feed-agencies">${f.agencies
                .map((a, i) => {
                  const u = f.urls[i];
                  return u
                    ? `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(a)}</a>`
                    : escapeHtml(a);
                })
                .join(" · ")}</div>`
            : ""
        }
        <div class="feed-meta">
          ${f.lastRoutes != null ? `<span>🚌 ${fmtNum(f.lastRoutes)}</span>` : ""}
          ${f.lastStops != null ? `<span>📍 ${fmtNum(f.lastStops)}</span>` : ""}
          ${f.lastTrips != null ? `<span>🔄 ${fmtNum(f.lastTrips)}</span>` : ""}
          <span>💾 ${fmtSize(f.lastSize)}</span>
          <span class="dim">${fmtDate(f.lastSeen)}</span>
        </div>
      </div>`;
            })
            .join("")
    }
    </div>
  </div>

  <!-- Recent table -->
  <div class="card">
    <div class="card-hdr">
      <span class="card-title">📋 Recent uploads</span>
      <div class="ctrl">
        <input class="srch" id="srch" placeholder="Filtrer par agence…" oninput="filterTable(this.value)" autocomplete="off"/>
        <span class="pill" id="rowCount">${recentEntries.length} entr${recentEntries.length !== 1 ? "ies" : "y"}</span>
      </div>
    </div>
    <div class="tbl-wrap">
      <table id="tbl">
        <thead>
          <tr>
            <th data-col="0">Date <span class="si">▼</span></th>
            <th data-col="1">Agence(s) <span class="si">▼</span></th>
            <th>URL</th>
            <th class="r" data-col="3">Taille <span class="si">▼</span></th>
            <th class="r" data-col="4">Routes <span class="si">▼</span></th>
            <th class="r" data-col="5">Stops <span class="si">▼</span></th>
            <th class="r" data-col="6">Voyages <span class="si">▼</span></th>
            <th style="text-align:center">Shapes</th>
            <th class="r" data-col="8">Ag. <span class="si">▼</span></th>
          </tr>
        </thead>
        <tbody id="tbody">
          ${recentEntries
            .map((e) => {
              const isMulti = (e.agency_count || 1) > 1;
              const firstUrl =
                e.agency_urls && e.agency_urls !== "null"
                  ? e.agency_urls.split(", ")[0]
                  : null;
              return `<tr data-q="${escapeHtml((e.agency_names || "").toLowerCase())}" data-s="${e.size_kb || 0}" data-r="${e.routes_count || 0}" data-st="${e.stops_count || 0}" data-tr="${e.trips_count || 0}" data-ac="${e.agency_count || 1}" data-d="${e.date}">
            <td class="ts">${fmtDate(e.date)}</td>
            <td><span class="badge ${e.is_sample ? "b-sample" : isMulti ? "b-multi" : "b-blue"}" title="${escapeHtml(e.agency_names || "—")}">${e.is_sample ? "🎮 " : ""}${escapeHtml(e.agency_names || "—")}</span></td>
            <td class="url-cell">${firstUrl ? `<a href="${escapeHtml(firstUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(firstUrl)}</a>` : '<span class="dim">—</span>'}</td>
            <td class="r num">${fmtSize(e.size_kb)}</td>
            <td class="r num">${e.routes_count != null ? fmtNum(e.routes_count) : '<span class="dim">—</span>'}</td>
            <td class="r num">${e.stops_count != null ? fmtNum(e.stops_count) : '<span class="dim">—</span>'}</td>
            <td class="r num">${e.trips_count != null ? fmtNum(e.trips_count) : '<span class="dim">—</span>'}</td>
            <td style="text-align:center">${e.has_shapes != null ? (e.has_shapes ? '<span class="dot dot-y"></span>' : '<span class="dot dot-n"></span>') : '<span class="dim">—</span>'}</td>
            <td class="r num">${e.agency_count || 1}</td>
          </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  </div>

</div>

<footer>Generated on ${fmtDate(new Date().toISOString())} · ${total - sampleCount} uploads + ${sampleCount} samples · ${distinctFeeds} feeds · ${distinctAgencies} agences</footer>

<script>
  let s=120;const cd=document.getElementById('countdown');
  (function t(){cd.textContent=s+'s';if(--s<0){location.reload();return}setTimeout(t,1000)})();

  function filterTable(v){const q=v.toLowerCase().trim();const rows=document.querySelectorAll('#tbody tr');let n=0;
  rows.forEach(r=>{const ok=!q||(r.getAttribute('data-q')||'').includes(q);r.style.display=ok?'':'none';if(ok)n++});
  document.getElementById('rowCount').textContent=n+(n!==1?' entries':' entry');}

  function filterFeeds(v){const q=v.toLowerCase().trim();const cards=document.querySelectorAll('.feed');let n=0;
  cards.forEach(c=>{const ok=!q||(c.getAttribute('data-fq')||'').includes(q);c.style.display=ok?'':'none';if(ok)n++});
  document.getElementById('feedCount').textContent=n+' jeu'+(n!==1?'x':'');}

  const da={0:'data-d',3:'data-s',4:'data-r',5:'data-st',6:'data-tr',8:'data-ac'};const tc=new Set([1]);
  let sc=null,sa=false;
  document.querySelectorAll('thead th[data-col]').forEach(th=>{
    th.addEventListener('click',function(){
      const c=parseInt(this.getAttribute('data-col'));
      if(sc===c){sa=!sa}else{sc=c;sa=true}
      document.querySelectorAll('thead th').forEach(h=>h.classList.remove('sorted'));
      this.classList.add('sorted');
      this.querySelector('.si').textContent=sa?'▲':'▼';
      const tb=document.getElementById('tbody');const rows=Array.from(tb.querySelectorAll('tr'));
      rows.sort((a,b)=>{let va,vb;
        if(da[c]){va=a.getAttribute(da[c])||'';vb=b.getAttribute(da[c])||'';if(c!==0){va=parseFloat(va)||0;vb=parseFloat(vb)||0}}
        else if(tc.has(c)){va=a.getAttribute('data-q')||'';vb=b.getAttribute('data-q')||''}
        if(va<vb)return sa?-1:1;if(va>vb)return sa?1:-1;return 0});
      rows.forEach(r=>tb.appendChild(r));
    });
  });
</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  } catch (err) {
    console.error("getUploadStats error:", err.message);
    res.status(500).send("Error reading stats.");
  }
};

// ── The sample feed

const loadSample = async (req, res) => {
  if (!fs.existsSync(SAMPLE_DIR)) {
    return res.status(404).json({ error: "Sample GTFS data not available." });
  }

  // The sample is keyless traffic like an upload: it counts against the keyless pool.
  const activeSessions = getActiveSessionsCount();
  const sampleCap = sessionCapFor(req);
  if (activeSessions >= sampleCap) {
    // A typed refusal: its CODE survives the production mask (middleware/serverErrorMask).
    return res.status(503).json({
      error: "AT_CAPACITY",
      message: `Server at capacity (${sampleCap} sessions). Please try again later.`,
    });
  }

  const sessionId = crypto.randomUUID();
  const uploadPath = path.join(GTFS_UPLOAD_DIR, sessionId);

  markUploadStarted(sessionId);
  const progress = reporterOf(req);
  let uploadCommitted = false;
  let loading = null;
  try {
    progress.stage("unpack");
    await fsp.mkdir(uploadPath, { recursive: true });

    const files = await fsp.readdir(SAMPLE_DIR);
    const txtFiles = files.filter((f) => f.endsWith(".txt"));
    if (txtFiles.length === 0) {
      return res.status(500).json({ error: "Sample directory is empty." });
    }

    await Promise.all(
      txtFiles.map((f) =>
        fsp.copyFile(path.join(SAMPLE_DIR, f), path.join(uploadPath, f)),
      ),
    );
    // The demo never expires: its dates are the opening day's year (the bundled files keep theirs for the tests).
    await refreshDemoDates(uploadPath);
    await soloFrequencyWindows(uploadPath);

    console.info(
      `📦 Sample GTFS loaded → session ${sessionTag(sessionId)} (${txtFiles.length} files)`,
    );

    const sampleDescribed = await describeDir(uploadPath);
    const sampleFingerprint = sampleDescribed?.fingerprint || null;
    loading = await loadWhileChecking(sessionId, uploadPath, progress);
    if (!loading.beside) progress.stage("validate");
    // Never rejected on errors: the sample is a trusted fixture that may exercise validator rules on purpose. Not
    // awaited: the network is read as soon as its import is done, the verdict follows.
    const validating = verdictOf(loading, () => validateOpening(sessionId, loading.checkPath, sampleDescribed, { allowIncomplete: true, cache: validationCacheOf(req, "sample", sampleDescribed) }), { sessionId, what: "Sample", sayNotInstalled: true });
    if (!loading.beside) await validating;

    let migrationMs = 0;
    let importAdjustments = {};
    let importAdjustmentDetails = {};
    let encoding = { bomStripped: [], encodingFallbacks: [] };
    let importResult = {};
    try {
      importResult = await loading.result();
      migrationMs = importResult.ms;
      if (importResult.encoding) encoding = importResult.encoding;
      if (importResult.importAdjustments) importAdjustments = importResult.importAdjustments;
      if (importResult.importAdjustmentDetails) importAdjustmentDetails = importResult.importAdjustmentDetails;
    } catch (migrateErr) {
      if (migrateErr && migrateErr.code === "SERVER_BUSY") {
        res.set("Retry-After", String(migrateErr.retryAfterSec));
        return res.status(503).json({ error: migrateErr.code, message: migrateErr.message, retryAfterSec: migrateErr.retryAfterSec });
      }
      if (migrateErr && migrateErr.type === "REQUIRED_FIELDS_MISSING") {
        try {
          closeEditDb(sessionId, { removeFile: true });
        } catch (_) {
          /* best effort */
        }
        return res.status(400).json({
          type: "REQUIRED_FIELDS_MISSING",
          error:
            "Sample feed rejected: one or more rows are missing GTFS-Required fields.",
          summary: migrateErr.summary,
          errors: migrateErr.errors,
        });
      }
      console.error(
        `Sample migration to SQLite failed for ${sessionTag(sessionId)}:`,
        migrateErr.message,
      );
      // Never a session without its database: the folder goes with the answer (finally).
      try {
        closeEditDb(sessionId, { removeFile: true });
      } catch (_) {
        /* best effort */
      }
      return res.status(500).json({
        error: "MIGRATION_FAILED",
        type: "MIGRATION_FAILED",
        message: `The sample could not be loaded: ${String(migrateErr.message || migrateErr).slice(0, 300)}`,
      });
    }
    const blankRows = importResult.blankRows || takeBlankRows(uploadPath);
    const settle = async (report) => {
      if (report.unverified) return report;
      settleReportWithImport(sessionId, report, importResult.importAdjustments);
      saveValidationBaseline(sessionId, report);
      saveValidationReport(sessionId, report, { of: sampleFingerprint });
      return report;
    };
    const verdictMeta = (report) => ({ validation: { ...summarizeValidation(report), ...(report.unverified ? { unverified: true } : {}) }, compliance: complianceOf(report) });
    let sessionMeta = null;
    require("./qualityAuditService").warmAudit(sessionId);
    const verdict = await verdictNowOrLater({ sessionId, validating, settle, of: sampleFingerprint, after: (report) => (sessionMeta && report ? persistSessionMeta(uploadPath, { ...sessionMeta, ...verdictMeta(report) }) : null) });
    const validationReport = verdict.report.unverified ? null : verdict.report;
    const unverified = validationReport ? null : verdict.report;

    const summary = importResult.summary || { agencies: [], routes: 0, stops: 0, trips: 0, stop_times: 0 };
    const agencies = summary.agencies;
    const agencyNames = agencies
      .map((a) => a.agency_name || a.agency_id || "unknown")
      .filter(Boolean)
      .join(", ");
    const agencyIds = agencies
      .map((a) => a.agency_id || "")
      .filter(Boolean)
      .join(", ");
    const agencyUrls = agencies
      .map((a) => a.agency_url || "")
      .filter(Boolean)
      .join(", ");
    const hasShapes = fs.existsSync(path.join(SAMPLE_DIR, "shapes.txt"));

    let sampleSizeBytes = 0;
    try {
      const sampleFiles = await fsp.readdir(SAMPLE_DIR);
      for (const f of sampleFiles) {
        try {
          const st = await fsp.stat(path.join(SAMPLE_DIR, f));
          sampleSizeBytes += st.size;
        } catch {}
      }
    } catch {
      /* size best effort */
    }
    const sampleSizeKb = parseFloat((sampleSizeBytes / 1024).toFixed(1));

    sessionMeta = {
      session_id: sessionId,
      created_at: new Date().toISOString(),
      source: "sample",
      source_name: null,
      fingerprint: sampleFingerprint,
      size_kb: sampleSizeKb,
      agency: {
        names: agencyNames,
        ids: agencyIds,
        urls: agencyUrls || null,
        count: agencies.length,
      },
      counts: {
        routes: summary.routes,
        stops: summary.stops,
        trips: summary.trips,
        has_shapes: hasShapes,
      },
      ...verdictMeta(validationReport || unverified),
    };
    await persistSessionMeta(uploadPath, sessionMeta);

    res.json({
      sessionId,
      fingerprint: sampleFingerprint,
      // Null when not validated; the sample loaded either way.
      valid: unverified ? null : validationReport.valid !== false,
      validationReport: validationReport || unverified,
      migration_ms: migrationMs,
      importAdjustments,
      importAdjustmentDetails,
      meta: {
        bomStripped: encoding.bomStripped || [],
        encodingFallbacks: encoding.encodingFallbacks || [],
        blankRows,
      },
    });
    uploadCommitted = true;

    try {
      await appendUploadStat({
        date: new Date().toISOString(),
        session: sessionId,
        agency_names: agencyNames,
        agency_ids: agencyIds,
        agency_urls: agencyUrls || null,
        agency_count: agencies.length,
        routes_count: summary.routes,
        stops_count: summary.stops,
        trips_count: summary.trips,
        has_shapes: hasShapes,
        size_kb: sampleSizeKb,
        is_sample: true,
      });
      recordEvent("upload", {
        ...extractReqMeta(req),
        is_sample: true,
        size_kb: sampleSizeKb,
        agency_ids: agencyIds,
        agency_names: agencyNames,
        agency_urls: agencyUrls || null,
        agency_count: agencies.length,
        routes_count: summary.routes,
        stops_count: summary.stops,
        trips_count: summary.trips,
        has_shapes: hasShapes,
      });
    } catch (logErr) {
      console.warn("Could not log sample stat:", logErr.message);
    }
  } catch (err) {
    console.error(`loadSample error for ${sessionTag(sessionId)}:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to load sample data." });
    }
  } finally {
    if (loading) await loading.settled();
    if (!uploadCommitted) {
      await fsp
        .rm(uploadPath, { recursive: true, force: true })
        .catch((rmErr) =>
          console.warn(
            `Cleanup of failed sample load ${sessionTag(sessionId)} failed:`,
            rmErr.message,
          ),
        );
      clearSessionCache(sessionId);
    }
    markUploadFinished(sessionId);
  }
};

// ── A folder the server prepared (a catalogue feed, a restored version)
//
// The caller owns `uploadPath` and its cleanup when this throws. `assertReport` runs before anything durable is
// written, so a feed it refuses leaves no trace outside that folder. A copy opened by a signed-in account answers
// that account only, as an upload does; `ownerUserId` null keeps the bearer model.
const ingestPreparedDir = async ({ sessionId, uploadPath, source = "generated", sourceName = null, req = null, ownerUserId = null, countryCode = null, schoolRegion = null, assertReport = null, verdictLater = false, validationScope = null }) => {
  const cc = require("./sessionCountry").normalizeCountryCode(countryCode);
  sessionOwner.rememberOwner(sessionId, ownerUserId);
  markUploadStarted(sessionId);
  const progress = reporterOf(req);
  let committed = false;
  let loading = null;
  let partial = false;
  try {
    const described = await describeDir(uploadPath);
    const fingerprint = described?.fingerprint || null;
    // A reading's opening answers before a large feed's stop times are in; a caller that waits for the verdict does not.
    // A published feed's content is public: its built database is kept for whoever opens the same content next.
    const kept = fingerprint && verdictLater ? { fingerprint, write: source === "catalog" } : null;
    loading = await loadWhileChecking(sessionId, uploadPath, progress, { staged: verdictLater && readsFirst(req), kept });
    if (!loading.beside || !verdictLater) progress.stage("validate");
    const validating = verdictOf(loading, () => validateOpening(sessionId, loading.checkPath, described, { allowIncomplete: true, ...(cc ? { countryCode: cc } : {}), cache: validationCacheOf(req, source, described, validationScope) }), { sessionId, what: `Opening (${source})`, sayNotInstalled: true });
    // A caller that reads the verdict in the answer waits for it; a reading's opening does not.
    if (!loading.beside || !verdictLater) await validating;
    let migrationMs = 0;
    let importResult = await loading.first();
    migrationMs = importResult.ms;
    partial = Boolean(importResult.partial);
    // Resolves once the whole network is in place: true, or false when its stop times could not be loaded.
    let wholeIn = null;
    const whole = partial ? new Promise((resolve) => (wholeIn = resolve)) : null;
    const settle = async (report) => {
      if (whole && !(await whole)) return null;
      if (report.unverified) return report;
      let settled = report;
      const loaded = await reportOfLoadedNetwork(sessionId, settled, importResult.importAdjustmentDetails);
      if (loaded) settled = loaded;
      else settleReportWithImport(sessionId, settled, importResult.importAdjustments);
      saveValidationBaseline(sessionId, settled);
      saveValidationReport(sessionId, settled, { of: fingerprint });
      return settled;
    };
    const verdictMeta = (report) => ({ validation: { ...summarizeValidation(report), ...(report.unverified ? { unverified: true } : {}) }, compliance: complianceOf(report) });
    let sessionMeta = null;
    if (verdictLater && !partial) require("./qualityAuditService").warmAudit(sessionId);
    const verdict = verdictLater
      ? await verdictNowOrLater({ sessionId, validating, settle, of: fingerprint, later: partial, after: (report) => (sessionMeta && report ? persistSessionMeta(uploadPath, { ...sessionMeta, ...verdictMeta(report) }) : null) })
      : { report: await settle(await validating), pending: false };
    const validationReport = verdict.report.unverified ? null : verdict.report;
    const unverified = validationReport ? null : verdict.report;
    if (assertReport) assertReport(validationReport || unverified);
    const blankRows = partial ? {} : importResult.blankRows || takeBlankRows(uploadPath);
    const summary = importResult.summary || { agencies: [], routes: 0, stops: 0, trips: 0, stop_times: 0 };
    const agencies = summary.agencies;
    const agencyNames = agencies.map((a) => a.agency_name || a.agency_id || "unknown").filter(Boolean).join(", ");
    const agencyIds = agencies.map((a) => a.agency_id || "").filter(Boolean).join(", ");
    let sizeBytes = 0;
    try {
      for (const f of await fsp.readdir(uploadPath)) {
        if (f.startsWith("_")) continue;
        sizeBytes += (await fsp.stat(path.join(uploadPath, f))).size;
      }
    } catch {
      /* best effort */
    }
    const sizeKb = parseFloat((sizeBytes / 1024).toFixed(1));
    const hasShapes = fs.existsSync(path.join(uploadPath, "shapes.txt"));
    sessionMeta = {
      session_id: sessionId,
      owner_user_id: ownerUserId,
      created_at: new Date().toISOString(),
      source,
      source_name: sourceName,
      fingerprint,
      ...(cc ? { country_code: cc } : {}),
      ...(typeof schoolRegion === "string" && schoolRegion.trim() ? { school_region: schoolRegion.trim().slice(0, 80) } : {}),
      size_kb: sizeKb,
      agency: { names: agencyNames, ids: agencyIds, urls: null, count: agencies.length },
      counts: { routes: summary.routes, stops: summary.stops, trips: summary.trips, has_shapes: hasShapes },
      ...verdictMeta(validationReport || unverified),
    };
    await persistSessionMeta(uploadPath, sessionMeta);
    committed = true;
    try {
      await appendUploadStat({
        date: new Date().toISOString(),
        session: sessionId,
        agency_names: agencyNames,
        agency_ids: agencyIds,
        agency_count: agencies.length,
        routes_count: summary.routes,
        stops_count: summary.stops,
        trips_count: summary.trips,
        has_shapes: hasShapes,
        size_kb: sizeKb,
        is_sample: false,
        source,
      });
      recordEvent("upload", {
        ...(req ? extractReqMeta(req) : {}),
        is_sample: false,
        source,
        size_kb: sizeKb,
        agency_ids: agencyIds,
        agency_names: agencyNames,
        agency_count: agencies.length,
        routes_count: summary.routes,
        stops_count: summary.stops,
        trips_count: summary.trips,
        has_shapes: hasShapes,
      });
    } catch (logErr) {
      console.warn("Could not log generated-session stat:", logErr.message);
    }
    if (partial) {
      // After the answer: the stop times' last row, the whole network put in place, then the upload counted as done.
      if (req) req.openingContinues = true;
      finishStaged({
        sessionId,
        uploadPath,
        loading,
        progress,
        sourceName,
        kept,
        onWhole: (result) => {
          importResult = result;
          timetables.whole(sessionId, { importAdjustments: result.importAdjustments || {}, importAdjustmentDetails: result.importAdjustmentDetails || {}, blankRows: result.blankRows || {}, counts: result.counts || {} });
          require("./qualityAuditService").warmAudit(sessionId);
        },
      })
        .then((loaded) => wholeIn(Boolean(loaded)))
        .finally(() => markUploadFinished(sessionId));
    }
    return {
      validationReport: validationReport || unverified,
      fingerprint,
      migration_ms: migrationMs,
      ...(partial ? { timetables: { loading: true, progress: progress.id } } : {}),
      importAdjustments: importResult.importAdjustments || {},
      importAdjustmentDetails: importResult.importAdjustmentDetails || {},
      meta: { ...(importResult.encoding || { bomStripped: [], encodingFallbacks: [] }), blankRows },
      counts: { agencies: agencies.length, routes: summary.routes, stops: summary.stops, trips: summary.trips, stop_times: summary.stop_times },
    };
  } finally {
    // Answered before its stop times are in, the import goes on: what ends it counts the upload as done.
    if (!(partial && committed)) {
      if (loading) await loading.settled();
      if (!committed) clearSessionCache(sessionId);
      markUploadFinished(sessionId);
    }
  }
};

module.exports = { uploadGTFSFile, getUploadStats, loadSample, ingestPreparedDir, extractGtfsZip, archiveRefusalOf, unpackAtDoor, missingGtfsFiles, _internals: { loadWhileChecking, validateOpening } };
