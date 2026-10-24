/**
 * The traffic dashboard's figures, folded in memory from the append-only logs (_events.jsonl, the older
 * _upload_stats.jsonl, the retired beta codes' use log) and the upload folder, cached 30 s to absorb burst clicks.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const os = require("os");
const readline = require("readline");
const { GTFS_UPLOAD_DIR } = require("../config");
const config = require("../config");
const { EVENTS_FILE } = require("./eventLogger");
const { getActiveSessionsCount, isUploadInProgress } = require("./sessionManager");

const STATS_FILE = path.join(GTFS_UPLOAD_DIR, "_upload_stats.jsonl");

const CACHE_TTL_MS = 30 * 1000;
let _cache = { ts: 0, payload: null, key: null };

// Read line by line, never the whole log as one string; `keep` may shrink a line to what the figures read of it.
const readJsonl = async (file, keep = (line) => line) => {
  if (!fs.existsSync(file)) return [];
  const out = [];
  try {
    const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(keep(JSON.parse(trimmed)));
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  } catch {
    return out;
  }
};

const BETA_SHARING_DAYS = 7;
const BETA_SHARING_ADDRESSES = 3;

/**
 * The retired beta codes' use log, folded per code hash: uses, refusals, distinct accounts and hashed addresses;
 * BETA_SHARING_ADDRESSES or more addresses over BETA_SHARING_DAYS is the code-sharing signal. A refused attempt counts
 * as "refused" whatever hash it carries (older lines hashed the refusal's own string). The log holds hashes only: an
 * address or e-mail a legacy line still carries is never read.
 */
const betaUsageByCode = (lines, now = Date.now()) => {
  const since = now - BETA_SHARING_DAYS * 24 * 60 * 60 * 1000;
  const byCode = new Map();
  for (const e of lines) {
    if (!e || typeof e !== "object") continue;
    const key = e.ok === false ? "refused" : e.code_hash || (e.account ? "account" : "refused");
    let row = byCode.get(key);
    if (!row) {
      row = { code: key, count: 0, refused: 0, lastSeen: e.ts || null, accounts: new Set(), addresses: new Set(), recent: new Set() };
      byCode.set(key, row);
    }
    row.count++;
    if (e.ok === false) row.refused++;
    if (e.ts && (!row.lastSeen || e.ts > row.lastSeen)) row.lastSeen = e.ts;
    if (e.account) row.accounts.add(String(e.account));
    if (e.ip_hash) {
      row.addresses.add(e.ip_hash);
      if (Date.parse(e.ts) >= since) row.recent.add(e.ip_hash);
    }
  }
  return [...byCode.values()]
    .map((r) => ({ code: r.code, count: r.count, refused: r.refused, lastSeen: r.lastSeen, accounts: r.accounts.size, addresses: r.addresses.size, addresses7d: r.recent.size, sharing: r.code !== "refused" && r.recent.size >= BETA_SHARING_ADDRESSES }))
    .sort((a, b) => b.count - a.count);
};

const isoToDay = (iso) => (typeof iso === "string" ? iso.slice(0, 10) : null);

const dayKey = (d) => d.toISOString().slice(0, 10);

const parseHour = (iso) => {
  try {
    return new Date(iso).getUTCHours();
  } catch {
    return null;
  }
};

/** Each live session's metadata snapshot, uploads in progress left out; without one, meta: null, so it can still be purged. */
const getActiveSessionsDetails = async () => {
  if (!fs.existsSync(GTFS_UPLOAD_DIR)) return [];
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(GTFS_UPLOAD_DIR);
  } catch {
    return out;
  }
  for (const folder of entries) {
    if (isUploadInProgress(folder)) continue;
    const folderPath = path.join(GTFS_UPLOAD_DIR, folder);
    try {
      const stat = await fsp.stat(folderPath);
      if (!stat.isDirectory()) continue;

      let meta = null;
      try {
        const raw = await fsp.readFile(
          path.join(folderPath, "_session_meta.json"),
          "utf8",
        );
        meta = JSON.parse(raw);
      } catch {
        /* no meta or malformed → meta: null */
      }
      const dbStat = await fsp
        .stat(path.join(folderPath, "gtfs.db"))
        .catch(() => null);

      out.push({
        session_id: folder,
        has_db: !!dbStat,
        db_size_kb: dbStat ? Math.round(dbStat.size / 1024) : 0,
        folder_mtime: stat.mtime.toISOString(),
        meta,
      });
    } catch {
      /* skip unreadable entries */
    }
  }
  return out;
};

const scanUploadDir = async () => {
  const out = {
    folderCount: 0,
    totalBytes: 0,
    editDbCount: 0,
    editDbBytes: 0,
    largestFolderBytes: 0,
  };
  if (!fs.existsSync(GTFS_UPLOAD_DIR)) return out;
  try {
    const entries = await fsp.readdir(GTFS_UPLOAD_DIR);
    for (const entry of entries) {
      const full = path.join(GTFS_UPLOAD_DIR, entry);
      try {
        const st = await fsp.stat(full);
        if (!st.isDirectory()) continue;
        out.folderCount++;
        let folderBytes = 0;
        try {
          const inner = await fsp.readdir(full);
          for (const f of inner) {
            try {
              const fst = await fsp.stat(path.join(full, f));
              if (fst.isFile()) {
                folderBytes += fst.size;
                if (f === "gtfs.db") {
                  out.editDbCount++;
                  out.editDbBytes += fst.size;
                }
              }
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* ignore */
        }
        out.totalBytes += folderBytes;
        if (folderBytes > out.largestFolderBytes) {
          out.largestFolderBytes = folderBytes;
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return out;
};

// ── Aggregation ──────────────────────────────────────────────────────────────

/** `days`: whole UTC days ending today (the console's period); null keeps every event. */
const buildStats = async ({ days = null } = {}) => {
  const now = Date.now();
  const span = days ? Math.min(Math.max(Math.trunc(days), 1), 365) : 30;
  const firstDay = new Date(Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`) - (span - 1) * 24 * 3600 * 1000).toISOString().slice(0, 10);
  // Before the period, only the sessions seen and the uploads' sessions are read (the cumulative curve's start, the
  // legacy uploads' dedup): such a line keeps nothing else.
  const before = (day) => Boolean(days) && Boolean(day) && day < firstDay;
  const [uploads, events, betaUsage, diskScan] = await Promise.all([
    readJsonl(STATS_FILE, (u) => (before(isoToDay(u?.date)) ? { date: u.date, session: u.session } : u)),
    readJsonl(EVENTS_FILE, (e) => (before(isoToDay(e?.ts)) ? { ts: e.ts, type: e.type, session: e.session } : e)),
    readJsonl(config.BETA_USAGE_PATH),
    scanUploadDir(),
  ]);

  // Uploads logged only in _upload_stats.jsonl become upload events of the same shape.
  const uploadEvents = uploads.map((u) => ({
    ts: u.date,
    type: "upload",
    session: u.session,
    ip_hash: null,
    ua: null,
    beta_code_hash: null,
    data: {
      is_sample: !!u.is_sample,
      size_kb: u.size_kb,
      agency_ids: u.agency_ids,
      agency_names: u.agency_names,
      agency_urls: u.agency_urls,
      agency_count: u.agency_count,
      routes_count: u.routes_count,
      stops_count: u.stops_count,
      trips_count: u.trips_count,
      has_shapes: u.has_shapes,
      validation: u.validation || null,
    },
  }));

  // Every upload is in both logs: a legacy entry counts only when its session has no native upload event.
  const nativeUploadSessions = new Set(
    events
      .filter((e) => e.type === "upload" && e.session)
      .map((e) => e.session),
  );
  const legacyOnly = uploadEvents.filter(
    (u) => !u.session || !nativeUploadSessions.has(u.session),
  );
  const kept = [...legacyOnly, ...events];
  // Ascending: first/last and the rewind before the window below rely on it.
  kept.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));

  const all = days ? kept.filter((e) => isoToDay(e.ts) >= firstDay) : kept;
  const todayKey = new Date().toISOString().slice(0, 10);
  const day7Cutoff = now - 7 * 24 * 3600 * 1000;
  const day30Cutoff = now - 30 * 24 * 3600 * 1000;

  // ── Buckets per type ──────────────────────────────────────────────────────
  const byType = {};
  for (const e of all) {
    byType[e.type] = (byType[e.type] || 0) + 1;
  }

  // ── Upload-derived metrics ─────────────────────────────────────────────────
  const allUploads = all.filter((e) => e.type === "upload");
  const realUploads = allUploads.filter((e) => !e.data.is_sample);
  const sampleUploads = allUploads.filter((e) => e.data.is_sample);

  const totalSizeKb = realUploads.reduce(
    (s, e) => s + (Number(e.data.size_kb) || 0),
    0,
  );
  const avgSizeKb =
    realUploads.length > 0 ? Math.round(totalSizeKb / realUploads.length) : 0;

  const todayUploads = allUploads.filter((e) => isoToDay(e.ts) === todayKey)
    .length;
  const todaySamples = sampleUploads.filter((e) => isoToDay(e.ts) === todayKey)
    .length;
  const last7Uploads = allUploads.filter(
    (e) => new Date(e.ts).getTime() >= day7Cutoff,
  ).length;
  const last30Uploads = allUploads.filter(
    (e) => new Date(e.ts).getTime() >= day30Cutoff,
  ).length;

  // ── Feed grouping (by sorted agency_ids fingerprint) ──────────────────────
  const feedMap = {};
  for (const e of allUploads) {
    const ids = e.data.agency_ids || "unknown";
    const fp = String(ids).split(", ").sort().join("|");
    if (!feedMap[fp]) {
      feedMap[fp] = {
        fingerprint: fp,
        label: e.data.agency_names || ids,
        ids,
        agencies: String(e.data.agency_names || "")
          .split(", ")
          .filter(Boolean),
        agencyCount: e.data.agency_count || 1,
        urls: String(e.data.agency_urls || "")
          .split(", ")
          .filter((u) => u && u !== "null"),
        uploads: 0,
        samplesIncluded: 0,
        sessions: new Set(),
        firstSeen: e.ts,
        lastSeen: e.ts,
        lastSize: e.data.size_kb,
        lastRoutes: e.data.routes_count,
        lastStops: e.data.stops_count,
        lastTrips: e.data.trips_count,
        hasShapes: e.data.has_shapes,
      };
    }
    const f = feedMap[fp];
    f.uploads++;
    if (e.data.is_sample) f.samplesIncluded++;
    if (e.session) f.sessions.add(e.session);
    if (e.ts < f.firstSeen) f.firstSeen = e.ts;
    if (e.ts > f.lastSeen) {
      f.lastSeen = e.ts;
      f.lastSize = e.data.size_kb;
      if (e.data.routes_count != null) f.lastRoutes = e.data.routes_count;
      if (e.data.stops_count != null) f.lastStops = e.data.stops_count;
      if (e.data.trips_count != null) f.lastTrips = e.data.trips_count;
      if (e.data.has_shapes != null) f.hasShapes = e.data.has_shapes;
      if (e.data.agency_names) {
        f.label = e.data.agency_names;
        f.agencies = String(e.data.agency_names).split(", ").filter(Boolean);
      }
    }
  }
  const feeds = Object.values(feedMap)
    .map((f) => ({ ...f, sessions: f.sessions.size }))
    .sort((a, b) => b.uploads - a.uploads);

  // ── Agency aggregation ────────────────────────────────────────────────────
  const agencyMap = {};
  for (const e of allUploads) {
    const names = String(e.data.agency_names || "")
      .split(", ")
      .filter(Boolean);
    const urls = String(e.data.agency_urls || "")
      .split(", ")
      .filter(Boolean);
    if (names.length === 0) continue;
    names.forEach((n, i) => {
      if (!agencyMap[n]) {
        agencyMap[n] = {
          name: n,
          uploads: 0,
          sessions: new Set(),
          url: null,
          firstSeen: e.ts,
          lastSeen: e.ts,
        };
      }
      const a = agencyMap[n];
      a.uploads++;
      if (e.session) a.sessions.add(e.session);
      if (!a.url && urls[i] && urls[i] !== "null") a.url = urls[i];
      if (e.ts < a.firstSeen) a.firstSeen = e.ts;
      if (e.ts > a.lastSeen) a.lastSeen = e.ts;
    });
  }
  const agencies = Object.values(agencyMap)
    .map((a) => ({ ...a, sessions: a.sessions.size }))
    .sort((a, b) => b.uploads - a.uploads);

  // ── Shapes coverage ───────────────────────────────────────────────────────
  const withShapesData = allUploads.filter((e) => e.data.has_shapes != null);
  const shapesYes = withShapesData.filter((e) => e.data.has_shapes).length;
  const shapesPct =
    withShapesData.length > 0
      ? Math.round((shapesYes / withShapesData.length) * 100)
      : 0;

  // ── Size distribution ─────────────────────────────────────────────────────
  const sizeBuckets = [
    { label: "< 1 MB", count: 0 },
    { label: "1–10 MB", count: 0 },
    { label: "10–50 MB", count: 0 },
    { label: "> 50 MB", count: 0 },
  ];
  for (const e of allUploads) {
    const mb = (Number(e.data.size_kb) || 0) / 1024;
    if (mb < 1) sizeBuckets[0].count++;
    else if (mb < 10) sizeBuckets[1].count++;
    else if (mb < 50) sizeBuckets[2].count++;
    else sizeBuckets[3].count++;
  }

  // ── Hour-of-day distribution (UTC, the consumer can re-shift) ─────────────
  const hourBuckets = new Array(24).fill(0);
  for (const e of all) {
    const h = parseHour(e.ts);
    if (h != null) hourBuckets[h]++;
  }

  // ── Daily trend over the period (split by event type) ─────────────────────
  const trend30 = [];
  const dailyTypes = {};
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = dayKey(d);
    dailyTypes[key] = {
      day: key,
      uploads: 0,
      samples: 0,
      sessions: new Set(),
      validations: 0,
      exports: 0,
      sqlQueries: 0,
      editEntered: 0,
      mutations: 0,
      quickfixes: 0,
    };
    trend30.push(dailyTypes[key]);
  }
  for (const e of all) {
    const key = isoToDay(e.ts);
    const bucket = dailyTypes[key];
    if (!bucket) continue;
    if (e.session) bucket.sessions.add(e.session);
    if (e.type === "upload") {
      if (e.data.is_sample) bucket.samples++;
      else bucket.uploads++;
    } else if (e.type === "validation.run") bucket.validations++;
    else if (e.type === "export.completed") bucket.exports++;
    else if (e.type === "sql.query") bucket.sqlQueries++;
    else if (e.type === "edit.entered") bucket.editEntered++;
    else if (e.type === "mutation.applied") bucket.mutations++;
    else if (e.type === "quickfix.applied") bucket.quickfixes++;
  }
  const trend = trend30.map((b) => ({
    ...b,
    sessions: b.sessions.size,
  }));

  // ── Cumulative growth (sessions ever seen) ────────────────────────────────
  const seenSessions = new Set();
  const dailyCumulative = {};
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    dailyCumulative[dayKey(d)] = 0;
  }
  for (const e of all) {
    if (!e.session) continue;
    if (seenSessions.has(e.session)) continue;
    seenSessions.add(e.session);
    const key = isoToDay(e.ts);
    if (key in dailyCumulative) dailyCumulative[key]++;
  }
  let acc = 0;
  const cumulative = trend30.map((b) => {
    acc += dailyCumulative[b.day] || 0;
    return { day: b.day, total: acc };
  });
  // The cumulative curve starts from the distinct sessions seen before the window.
  let priorUniques = 0;
  const inWindowDays = new Set(trend30.map((b) => b.day));
  const seenBeforeWindow = new Set();
  for (const e of kept) {
    if (!e.session) continue;
    if (inWindowDays.has(isoToDay(e.ts))) break; // sorted ascending: the window starts here
    if (!seenBeforeWindow.has(e.session)) {
      seenBeforeWindow.add(e.session);
      priorUniques++;
    }
  }
  for (const c of cumulative) c.total += priorUniques;

  // ── Heatmap dayOfWeek × hour (UTC) ────────────────────────────────────────
  const heatmap = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const e of all) {
    try {
      const d = new Date(e.ts);
      const dow = d.getUTCDay(); // 0=Sun
      const h = d.getUTCHours();
      heatmap[dow][h]++;
    } catch {
      /* skip */
    }
  }

  // ── Funnel: upload → validation.run → edit.entered → export.completed ────
  const sessionStages = {};
  for (const e of all) {
    if (!e.session) continue;
    if (!sessionStages[e.session]) {
      sessionStages[e.session] = {
        upload: false,
        validation: false,
        edit: false,
        export: false,
        sql: false,
        firstTs: e.ts,
        lastTs: e.ts,
      };
    }
    const s = sessionStages[e.session];
    if (e.ts < s.firstTs) s.firstTs = e.ts;
    if (e.ts > s.lastTs) s.lastTs = e.ts;
    if (e.type === "upload") s.upload = true;
    else if (e.type === "validation.run") s.validation = true;
    else if (e.type === "edit.entered") s.edit = true;
    else if (e.type === "export.completed") s.export = true;
    else if (e.type === "sql.query") s.sql = true;
  }
  const sessionVals = Object.values(sessionStages);
  const funnel = {
    sessions: sessionVals.length,
    uploaded: sessionVals.filter((s) => s.upload).length,
    validated: sessionVals.filter((s) => s.validation).length,
    edited: sessionVals.filter((s) => s.edit).length,
    exported: sessionVals.filter((s) => s.export).length,
    usedSql: sessionVals.filter((s) => s.sql).length,
  };

  // ── AI companion funnel ──────────────────────────────────────────────────
  const aiFunnel = {
    chatTurns: 0,
    anonTurns: 0,
    codedTurns: 0,
    fixPreviews: 0,
    fixApplied: 0,
    upsellShown: 0,
  };
  for (const e of all) {
    if (e.type === "chat.turn") {
      aiFunnel.chatTurns += 1;
      if (e.data && e.data.anon) aiFunnel.anonTurns += 1;
      else aiFunnel.codedTurns += 1;
    } else if (e.type === "chat.fix_previewed") {
      aiFunnel.fixPreviews += 1;
    } else if (
      e.type === "mutation.applied" &&
      e.data &&
      e.data.source === "chat"
    ) {
      aiFunnel.fixApplied += 1;
    } else if (e.type === "chat.upsell_shown") {
      aiFunnel.upsellShown += 1;
    }
  }

  // ── Active users ─────────────────────────────────────────────────────────
  // Counted by distinct session ids, not accounts.
  const sessionsByDay = new Map();
  const sessionsByMonth = new Map();
  for (const e of all) {
    if (!e.session) continue;
    const d = isoToDay(e.ts);
    if (!d) continue;
    if (!sessionsByDay.has(d)) sessionsByDay.set(d, new Set());
    sessionsByDay.get(d).add(e.session);
    const week = d.slice(0, 7); // YYYY-MM
    if (!sessionsByMonth.has(week)) sessionsByMonth.set(week, new Set());
    sessionsByMonth.get(week).add(e.session);
  }
  const dau = (sessionsByDay.get(todayKey) || new Set()).size;
  const wauSet = new Set();
  const mauSet = new Set();
  for (const e of all) {
    if (!e.session) continue;
    const t = new Date(e.ts).getTime();
    if (t >= day7Cutoff) wauSet.add(e.session);
    if (t >= day30Cutoff) mauSet.add(e.session);
  }
  const wau = wauSet.size;
  const mau = mauSet.size;

  // ── Validation aggregates (errors / warnings / infos) ────────────────────
  const validations = all.filter((e) => e.type === "validation.run");
  const validationTotals = validations.reduce(
    (acc2, e) => {
      acc2.runs++;
      acc2.errors += Number(e.data.errors || 0);
      acc2.warnings += Number(e.data.warnings || 0);
      acc2.infos += Number(e.data.infos || 0);
      acc2.totalDurationMs += Number(e.data.duration_ms || 0);
      return acc2;
    },
    { runs: 0, errors: 0, warnings: 0, infos: 0, totalDurationMs: 0 },
  );
  const avgValidationMs =
    validationTotals.runs > 0
      ? Math.round(validationTotals.totalDurationMs / validationTotals.runs)
      : 0;

  // ── Export aggregates ─────────────────────────────────────────────────────
  const exports = all.filter((e) => e.type === "export.completed");
  const exportTotals = exports.reduce(
    (acc2, e) => {
      acc2.runs++;
      acc2.totalDurationMs += Number(e.data.duration_ms || 0);
      acc2.totalSizeKb += Number(e.data.size_kb || 0);
      return acc2;
    },
    { runs: 0, totalDurationMs: 0, totalSizeKb: 0 },
  );
  const avgExportMs =
    exportTotals.runs > 0
      ? Math.round(exportTotals.totalDurationMs / exportTotals.runs)
      : 0;
  const avgExportKb =
    exportTotals.runs > 0
      ? Math.round(exportTotals.totalSizeKb / exportTotals.runs)
      : 0;

  // ── SQL console aggregates ───────────────────────────────────────────────
  const sqlQueries = all.filter((e) => e.type === "sql.query");
  const sqlByKind = sqlQueries.reduce((acc2, e) => {
    const k = e.data.kind || "unknown";
    acc2[k] = (acc2[k] || 0) + 1;
    return acc2;
  }, {});

  // ── Beta usage ────────────────────────────────────────────────────────────
  const betaCodes = betaUsageByCode(betaUsage);

  // ── Mutations aggregation (mutation.applied events) ──────────────────────
  const mutationEvents = all.filter((e) => e.type === "mutation.applied");
  const mutations = {
    total: mutationEvents.length,
    byKind: mutationEvents.reduce((acc2, e) => {
      const k = e.data?.kind || "unknown";
      acc2[k] = (acc2[k] || 0) + 1;
      return acc2;
    }, {}),
    byAction: mutationEvents.reduce((acc2, e) => {
      const a = e.data?.action || "unknown";
      acc2[a] = (acc2[a] || 0) + 1;
      return acc2;
    }, {}),
    byEntity: mutationEvents.reduce((acc2, e) => {
      const ent = e.data?.entity || "unknown";
      acc2[ent] = (acc2[ent] || 0) + (e.data?.count || 1);
      return acc2;
    }, {}),
    totalRows: mutationEvents.reduce((s, e) => s + (e.data?.count || 1), 0),
  };

  // ── Quickfixes aggregation (quickfix.applied events) ─────────────────────
  const quickfixEvents = all.filter((e) => e.type === "quickfix.applied");
  const quickfixes = {
    total: quickfixEvents.length,
    byRule: quickfixEvents.reduce((acc2, e) => {
      const r = e.data?.rule || "unknown";
      acc2[r] = (acc2[r] || 0) + 1;
      return acc2;
    }, {}),
  };

  // ── Top validation errors (folded across all validation.run events) ──────
  const allTopErrors = {};
  for (const e of validations) {
    for (const { rule, count } of e.data?.top_errors || []) {
      allTopErrors[rule] = (allTopErrors[rule] || 0) + count;
    }
  }
  const topValidationErrors = Object.entries(allTopErrors)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([rule, count]) => ({ rule, count }));

  // ── Bounce rate: sessions that uploaded but did nothing else ─────────────
  const bouncedSessions = sessionVals.filter(
    (s) => s.upload && !s.validation && !s.edit && !s.export && !s.sql,
  ).length;
  const sessionsWithUpload = sessionVals.filter((s) => s.upload).length;
  const bounceRate =
    sessionsWithUpload > 0
      ? Math.round((bouncedSessions / sessionsWithUpload) * 100)
      : 0;

  // ── Average session duration (first → last event, ms) ────────────────────
  const sessionDurations = sessionVals
    .filter((s) => s.firstTs && s.lastTs && s.firstTs !== s.lastTs)
    .map((s) => new Date(s.lastTs).getTime() - new Date(s.firstTs).getTime());
  const avgSessionDurationMs =
    sessionDurations.length > 0
      ? Math.round(
          sessionDurations.reduce((a, b) => a + b, 0) / sessionDurations.length,
        )
      : 0;

  // ── Recent activity stream (last 100 events, descending) ─────────────────
  const recent = all
    .slice(-200)
    .reverse()
    .slice(0, 100)
    .map((e) => ({
      ts: e.ts,
      type: e.type,
      session: e.session ? e.session.slice(0, 8) : null,
      ip_hash: e.ip_hash || null,
      summary: summarizeEvent(e),
    }));

  // ── System health ────────────────────────────────────────────────────────
  const mem = process.memoryUsage();
  const system = {
    nodeVersion: process.version,
    uptimeSec: Math.round(process.uptime()),
    memoryRssBytes: mem.rss,
    memoryHeapUsedBytes: mem.heapUsed,
    cpuLoad: os.loadavg(),
    activeSessions: getActiveSessionsCount(),
    disk: diskScan,
    eventsLogged: all.length,
    eventTypes: byType,
  };

  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      totalEvents: all.length,
      totalUploads: allUploads.length,
      realUploads: realUploads.length,
      sampleUploads: sampleUploads.length,
      todayUploads,
      todaySamples,
      last7Uploads,
      last30Uploads,
      uniqueSessions: new Set(all.filter((e) => e.session).map((e) => e.session))
        .size,
      distinctFeeds: feeds.length,
      distinctAgencies: agencies.length,
      totalSizeKb,
      avgSizeKb,
      shapesPct,
      dau,
      wau,
      mau,
    },
    feeds,
    agencies,
    sizeBuckets,
    hourBuckets,
    trend,
    cumulative,
    heatmap,
    funnel: {
      ...funnel,
      bouncedSessions,
      bounceRate,
    },
    validations: {
      ...validationTotals,
      avgDurationMs: avgValidationMs,
    },
    exports: {
      ...exportTotals,
      avgDurationMs: avgExportMs,
      avgSizeKb: avgExportKb,
    },
    sql: {
      total: sqlQueries.length,
      byKind: sqlByKind,
    },
    mutations,
    quickfixes,
    topValidationErrors,
    sessions: {
      avgDurationMs: avgSessionDurationMs,
      avgDurationSec: Math.round(avgSessionDurationMs / 1000),
    },
    beta: {
      total: betaUsage.length,
      codes: betaCodes,
      sharingThreshold: BETA_SHARING_ADDRESSES,
    },
    recent,
    system,
  };
};

const summarizeEvent = (e) => {
  const d = e.data || {};
  switch (e.type) {
    case "upload":
      return `${d.is_sample ? "sample" : "feed"} · ${d.agency_names || "?"} · ${d.size_kb || 0} KB`;
    case "session.created":
      return d.userAgentLabel || "new session";
    case "validation.run":
      return `${d.errors || 0} err / ${d.warnings || 0} warn / ${d.infos || 0} info · ${d.duration_ms || 0} ms`;
    case "edit.entered": {
      // Older lines carry it at d.beta_code_hash or d.beta_code.
      const hash = e.beta_code_hash || d.beta_code_hash || d.beta_code;
      return hash ? `beta_hash=${hash}` : "edit started";
    }
    case "edit.exited":
      return d.duration_ms ? `${Math.round(d.duration_ms / 1000)}s` : "edit ended";
    case "export.completed":
      return `${d.size_kb || 0} KB · ${d.duration_ms || 0} ms`;
    case "sql.query":
      return `${d.kind || "?"} · ${d.row_count != null ? d.row_count + " rows" : ""} · ${d.duration_ms || 0} ms`;
    case "mutation.applied":
      return `${d.entity || "?"} · ${d.action || "?"} · kind=${d.kind || "?"} · ${d.count || 1} row(s)`;
    case "quickfix.applied":
      return `rule=${d.rule || "?"} · ${d.affected || "?"} fixed`;
    default:
      return "";
  }
};

// ── HTTP handler ─────────────────────────────────────────────────────────────

const getAdminStats = async (req, res) => {
  try {
    const noCache = req.query.fresh === "1";
    // Each period (?days=) has its own cache entry.
    const asked = parseInt(req.query.days, 10);
    const days = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), 365) : null;
    const key = `v2:${days || "all"}`;
    if (!noCache && _cache.payload && _cache.key === key && Date.now() - _cache.ts < CACHE_TTL_MS) {
      res.setHeader("X-Cache", "hit");
      return res.json(_cache.payload);
    }
    const payload = await buildStats({ days });
    _cache = { ts: Date.now(), payload, key };
    res.setHeader("X-Cache", "miss");
    res.setHeader("Cache-Control", "no-store");
    return res.json(payload);
  } catch (err) {
    console.error("getAdminStats error:", err);
    return res
      .status(500)
      .json({ error: "Failed to build admin stats: " + err.message });
  }
};

const invalidateCache = () => {
  _cache = { ts: 0, payload: null, key: null };
};

const resetStats = async () => {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const targets = [
    { src: EVENTS_FILE, label: "_events.jsonl" },
    { src: STATS_FILE, label: "_upload_stats.jsonl" },
    { src: config.BETA_USAGE_PATH, label: "beta/usage.jsonl" },
  ];
  const archived = [];
  for (const { src, label } of targets) {
    if (fs.existsSync(src)) {
      const dest = src.replace(/\.jsonl$/, `.${ts}.bak.jsonl`);
      try {
        await fsp.rename(src, dest);
        archived.push({ label, archivedAs: path.basename(dest) });
      } catch (err) {
        archived.push({ label, error: err.message });
      }
    }
  }
  invalidateCache();
  return { ok: true, archivedFiles: archived, ts: new Date().toISOString() };
};

module.exports = {
  getAdminStats,
  buildStats,
  invalidateCache,
  resetStats,
  getActiveSessionsDetails,
  betaUsageByCode,
};
