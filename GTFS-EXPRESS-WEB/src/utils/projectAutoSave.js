/**
 * projectAutoSave.js — Periodic project save to IndexedDB
 * to allow recovery after crash / accidental close.
 *
 * Mental model: we save a `.gtfsproj` blob (produced by the backend)
 * to IndexedDB every N modifications. On reload, if we detect an
 * orphaned snapshot (session_id does not match any active DB), we
 * offer the user to restore it.
 *
 * Why IndexedDB and not localStorage?
 *   • Native Blob support (localStorage only stores text)
 *   • No 5-10 MB quota: several tens/hundreds of MB are possible
 *   • Async: does not block the UI thread for 40MB of data
 *
 * This module imports NO application modules other than config/API
 * to remain independently testable.
 */

import API_BASE_URL from "../config";
import { fetchWithSession } from "./sessionManager";

// IndexedDB name kept as "gtfs-interpreter" for backward compatibility:
// existing users have local snapshots stored under this name and renaming
// would orphan their data. New stores can use the gtfs-express prefix.
const DB_NAME = "gtfs-interpreter";
const DB_VERSION = 1;
const STORE = "project_snapshots";
const META_STORE = "meta";

// Idle timer fallback. Triggered if the user keeps the tab open without
// switching away. visibilitychange (in EditModeContext) catches the common
// case (tab switch / window close) before this fires.
export const AUTO_SAVE_IDLE_MS = 5 * 60 * 1000; // 5 min
// One snapshot per session is enough for crash recovery — undo covers all
// in-session rollback needs.
const MAX_SNAPSHOTS_PER_SESSION = 1;
// Hard cap across all sessions to bound IndexedDB usage.
const MAX_SNAPSHOTS_GLOBAL = 5;
// Stale snapshots are auto-deleted on next save / list call.
const MAX_SNAPSHOT_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// ── IndexedDB boilerplate ──────────────────────────────────────────────────

const openDb = () =>
  new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable in this browser"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("by_session", "session_id");
        store.createIndex("by_session_ts", ["session_id", "ts"]);
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const txPromise = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

// ── Compression helpers ────────────────────────────────────────────────────

// Feature-detected gzip compression (Chromium 80+, Firefox 113+, Safari 16.4+).
// Falls back gracefully to uncompressed storage on older browsers / failures.
const compressBlob = async (blob) => {
  if (typeof CompressionStream === "undefined") return { blob, compressed: false };
  try {
    const stream = blob.stream().pipeThrough(new CompressionStream("gzip"));
    const compressed = await new Response(stream).blob();
    return { blob: compressed, compressed: true };
  } catch {
    return { blob, compressed: false }; // Defensive: never block save on compression failure
  }
};

const decompressBlob = async (blob) => {
  if (typeof DecompressionStream === "undefined") return blob;
  try {
    const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).blob();
  } catch {
    return blob; // Treat as uncompressed if decompression fails
  }
};

// ── API publique ────────────────────────────────────────────────────────────

/**
 * Write a snapshot blob + metadata to IndexedDB. The blob is expected to be
 * gzipped via `CompressionStream` when available.
 * Purges old snapshots from the same session (FIFO) and applies
 * a global cap across all sessions to limit IndexedDB usage.
 */
export const saveSnapshot = async ({ sessionId, blob, meta }) => {
  if (!sessionId || !blob) return { ok: false, error: "missing args" };
  let db;
  try {
    db = await openDb();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  try {
    const originalSize = blob.size;
    const { blob: storedBlob, compressed } = await compressBlob(blob);

    const tx = db.transaction([STORE], "readwrite");
    const store = tx.objectStore(STORE);
    store.add({
      session_id: sessionId,
      ts: Date.now(),
      blob: storedBlob,
      size: storedBlob.size,
      originalSize,
      compressed,
      meta: meta || null,
    });
    await txPromise(tx);

    // Per-session purge: keep only MAX_SNAPSHOTS_PER_SESSION most recent.
    const tx2 = db.transaction([STORE], "readwrite");
    const st2 = tx2.objectStore(STORE);
    const idx = st2.index("by_session");
    const req = idx.getAll(sessionId);
    await new Promise((resolve, reject) => {
      req.onsuccess = () => {
        const all = (req.result || []).sort((a, b) => a.ts - b.ts);
        const toDelete = all.slice(
          0,
          Math.max(0, all.length - MAX_SNAPSHOTS_PER_SESSION),
        );
        for (const row of toDelete) st2.delete(row.id);
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    await txPromise(tx2);

    // Global cap: keep only the N most recent across ALL sessions.
    const tx3 = db.transaction([STORE], "readwrite");
    const all = await new Promise((resolve, reject) => {
      const req3 = tx3.objectStore(STORE).getAll();
      req3.onsuccess = () => resolve(req3.result || []);
      req3.onerror = () => reject(req3.error);
    });
    const sortedDesc = all.sort((a, b) => b.ts - a.ts);
    const toDeleteGlobal = sortedDesc.slice(MAX_SNAPSHOTS_GLOBAL);
    for (const row of toDeleteGlobal) tx3.objectStore(STORE).delete(row.id);
    await txPromise(tx3);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
};

/**
 * List of available snapshots (all sessions combined), sorted newest
 * to oldest. Useful for displaying "Recover a recent project…".
 */
export const listSnapshots = async () => {
  let db;
  try {
    db = await openDb();
  } catch {
    return [];
  }
  try {
    // Lazy age purge: drop any snapshot older than MAX_SNAPSHOT_AGE_MS.
    const cutoff = Date.now() - MAX_SNAPSHOT_AGE_MS;
    const txPurge = db.transaction([STORE], "readwrite");
    const reqAll = txPurge.objectStore(STORE).getAll();
    await new Promise((resolve, reject) => {
      reqAll.onsuccess = () => {
        for (const row of reqAll.result || []) {
          if (row.ts < cutoff) txPurge.objectStore(STORE).delete(row.id);
        }
        resolve();
      };
      reqAll.onerror = () => reject(reqAll.error);
    });
    await txPromise(txPurge);

    return await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE], "readonly");
      const st = tx.objectStore(STORE);
      const req = st.getAll();
      req.onsuccess = () => {
        const rows = (req.result || [])
          .map((r) => ({
            id: r.id,
            session_id: r.session_id,
            ts: r.ts,
            size: r.size,
            meta: r.meta,
          }))
          .sort((a, b) => b.ts - a.ts);
        resolve(rows);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
};

export const getSnapshotBlob = async (id) => {
  let db;
  try {
    db = await openDb();
  } catch {
    return null;
  }
  try {
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE], "readonly");
      const st = tx.objectStore(STORE);
      const req = st.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!record) return null;
    if (record.compressed === true) {
      return await decompressBlob(record.blob);
    }
    return record.blob;
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
};

export const deleteSnapshot = async (id) => {
  let db;
  try {
    db = await openDb();
  } catch {
    return;
  }
  try {
    const tx = db.transaction([STORE], "readwrite");
    tx.objectStore(STORE).delete(id);
    await txPromise(tx);
  } catch {
    /* ignore */
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
};

/**
 * Triggers a VACUUM INTO + DB stream on the backend, then stores
 * the blob (client-side gzipped) in IndexedDB.
 * Returns { ok, size } or { ok:false, error }.
 *
 * NOTE: calls the server endpoint `/edit/project/export`. The UI throttles
 * the frequency via `AUTO_SAVE_IDLE_MS` + `visibilitychange` (see EditModeContext).
 */
export const captureAndStoreSnapshot = async (sessionId, metaHint) => {
  if (!sessionId) return { ok: false, error: "no session" };
  try {
    const res = await fetchWithSession(
      `${API_BASE_URL}/edit/project/export`,
      { method: "GET" },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    const blob = await res.blob();
    const result = await saveSnapshot({
      sessionId,
      blob,
      meta: metaHint || null,
    });
    return result.ok ? { ok: true, size: blob.size } : result;
  } catch (err) {
    return { ok: false, error: err.message || "Network error" };
  }
};
