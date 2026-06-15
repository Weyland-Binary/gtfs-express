import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Snackbar, Alert, Slide } from "@mui/material";
import API_BASE_URL from "../config";
import { fetchWithSession, getSessionId } from "../utils/sessionManager";
import {
  saveProjectToFile,
  openProjectFromFile,
  fetchProjectMeta,
} from "../utils/projectFile";
import {
  captureAndStoreSnapshot,
  AUTO_SAVE_IDLE_MS,
} from "../utils/projectAutoSave";
import { useLanguage } from "./LanguageContext";

const EditModeContext = createContext(null);

/**
 * Global edit mode state.
 *
 *   editing           — bool: are we currently in edit mode?
 *   entering          — bool: CSV→SQLite migration in progress (loader)
 *   counts            — { agency, routes, stops, ... } of migrated tables
 *   pendingEdits      — number of entries in _edit_log not undone
 *   dataVersion       — counter incremented after each successful mutation
 *                       (add to fetch useEffect deps for refresh)
 *   error             — last error surfaced by the backend
 *
 *   stopOverrides     — { [stop_id]: stopPatch }: live patches applied
 *                       to stops by the schedule grid without a refetch
 *
 *   enterEditMode()   — switches to edit mode (lazy migrate on API side)
 *   exitEditMode()    — exits and discards changes
 *   refreshStatus()   — resyncs the status
 *   undoLast()        — calls POST /edit/undo
 *   exportGTFS()      — triggers the ZIP download
 *   recordEdit(msg)   — call after a successful mutation: bump + toast
 *   patchStop(stop)   — registers a live override for a stop (name, etc.)
 *   showToast(msg, s) — shows a snackbar (success | error | info | warning)
 */

function SlideUp(props) {
  return <Slide {...props} direction="up" />;
}

export function EditModeProvider({ children }) {
  const { t } = useLanguage();
  // `editing === undefined` ⇒ backend status not yet known (first mount,
  // before `refreshStatus()` has responded). We render a skeleton rather
  // than a false "off" to avoid the visual flash after reload.
  const [editing, setEditing] = useState(undefined);
  const [statusReady, setStatusReady] = useState(false);
  const [entering, setEntering] = useState(false);
  const [counts, setCounts] = useState(null);
  const [pendingEdits, setPendingEdits] = useState(0);
  const [undoneEdits, setUndoneEdits] = useState(0);
  const [dataVersion, setDataVersion] = useState(0);
  const [stopOverrides, setStopOverrides] = useState({});
  const [error, setError] = useState(null);
  // Sprint 9 — incremental validation feedback surfaced inline.
  // `lastValidationResult` is the most-recent `validation` block returned by
  // any edit endpoint (POST /edit/stops, PATCH /edit/routes/:id, …). It
  // includes the entity it belongs to so consumers (status badge, sidebar,
  // re-opening editor) can decide whether they want to react or ignore it.
  // Cleared on undo, redo, jump, exit-edit, and when the user opens a
  // different entity. Shape:
  //   { entity, entityId, items[], skipped, truncated, totalAvailable, timestamp }
  const [lastValidationResult, setLastValidationResult] = useState(null);
  // Beta gate: identity of the current tester (returned by /edit/enter when
  // BETA_GATE_DISABLED=false). `null` = gate disabled OR not yet validated.
  const [betaTester, setBetaTester] = useState(null);
  const [undoing, setUndoing] = useState(false);
  const [redoing, setRedoing] = useState(false);
  const [toast, setToast] = useState(null); // { message, severity }
  // Project: metadata + auto-save state
  const [projectMeta, setProjectMeta] = useState(null); // { project_id, updated_at, ... }
  const [savingProject, setSavingProject] = useState(false);
  const [openingProject, setOpeningProject] = useState(false);
  const [lastAutoSaveAt, setLastAutoSaveAt] = useState(null);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true);
  // `autoSaveInFlight` is exposed as state so consumers (e.g. AutoSaveIndicator
  // in the Header) can render a spinner while a snapshot is being captured.
  // The ref below is kept in parallel for the synchronous reentrancy guard
  // inside the auto-save effect (state updates are async — the ref provides
  // an immediate read after `triggerIfNeeded` is invoked twice in a row).
  const [autoSaveInFlight, setAutoSaveInFlight] = useState(false);
  // Change counter since the last auto-save, stored in a ref to
  // avoid unnecessary rerenders on bump.
  const editsSinceSnapshotRef = useRef(0);
  const autoSaveInFlightRef = useRef(false);

  const showToast = useCallback((message, severity = "success") => {
    setToast({ message, severity, key: Date.now() });
  }, []);

  const closeToast = useCallback(() => setToast(null), []);

  /**
   * Switches to edit mode.
   *
   * If `betaCode` is provided, it is sent in the `X-Beta-Code` header.
   * Otherwise, we attempt to read `localStorage.gtfs_beta_code` (silent auto-renew
   * for returns from an already-authenticated user).
   *
   * Structured return (not a boolean) to allow the caller (BetaGateDialog
   * via EditModeToggle) to differentiate:
   *   • success                             → { ok: true, betaTester }
   *   • beta code rejected                  → { ok: false, errorCode: "INVALID_BETA_CODE" | "BETA_REVOKED" | "BETA_CODE_REQUIRED" | "BETA_CONFIG_ERROR" }
   *   • other error (network, 500…)         → { ok: false, errorCode: "NETWORK_ERROR" | null, message }
   *
   * The activation toast is played ONLY on success (and is NOT played on
   * beta gate error — the modal handles its own inline feedback).
   */
  const enterEditMode = useCallback(async (betaCode = null) => {
    setEntering(true);
    setError(null);
    try {
      const headers = {};
      const code = betaCode ?? (() => {
        try {
          return localStorage.getItem("gtfs_beta_code");
        } catch {
          return null;
        }
      })();
      if (code) headers["X-Beta-Code"] = code;

      const res = await fetchWithSession(`${API_BASE_URL}/edit/enter`, {
        method: "POST",
        headers,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Distinguish 403 beta gate vs other HTTP error.
        // Typed codes returned by the betaGate middleware on the server:
        //   BETA_CODE_REQUIRED, INVALID_BETA_CODE, BETA_REVOKED, BETA_CONFIG_ERROR
        const isBetaError =
          res.status === 403 &&
          (body.error === "BETA_CODE_REQUIRED" ||
            body.error === "INVALID_BETA_CODE" ||
            body.error === "BETA_REVOKED" ||
            body.error === "BETA_CONFIG_ERROR");
        if (isBetaError) {
          // NO toast — the BetaGateDialog modal displays the error inline.
          // Purge stored code if it was rejected → next attempt
          // will force the user to type one.
          if ((body.error === "INVALID_BETA_CODE" || body.error === "BETA_REVOKED") && !betaCode) {
            try {
              localStorage.removeItem("gtfs_beta_code");
            } catch {
              /* ignore */
            }
          }
          return {
            ok: false,
            errorCode: body.error,
            message: body.message || null,
          };
        }
        setError(body.error || "Failed to enter edit mode.");
        showToast(body.error || "Failed to enter edit mode.", "error");
        return { ok: false, errorCode: null, message: body.error || null };
      }
      setEditing(true);
      setCounts(body.counts || null);
      setPendingEdits(0);
      setBetaTester(body.betaTester || null);
      showToast("Edit mode activated", "success");
      return { ok: true, betaTester: body.betaTester || null };
    } catch (err) {
      console.error("enterEditMode:", err);
      setError(err.message || "Network error");
      showToast(err.message || "Network error", "error");
      return {
        ok: false,
        errorCode: "NETWORK_ERROR",
        message: err.message || "Network error",
      };
    } finally {
      setEntering(false);
    }
  }, [showToast]);

  // Atomic reset of all edit state on the frontend.
  // Used after an upload (backend already cleaned up) or as a safety net
  // when `exitEditMode` cannot reach the backend.
  //
  // Post SQL-first refactor: `counts` reflect the DB that always exists
  // since upload, independent of edit mode. We DO NOT reset them otherwise
  // the Browse-files chips (and other counts consumers) become empty
  // during the exit→refreshStatus window. `refreshStatus` will repopulate them
  // anyway — better to keep current values in the meantime.
  const resetEditStateLocal = useCallback(() => {
    setEditing(false);
    setPendingEdits(0);
    setUndoneEdits(0);
    setStopOverrides({});
    setProjectMeta(null);
    setLastAutoSaveAt(null);
    setBetaTester(null);
    setLastValidationResult(null);
    editsSinceSnapshotRef.current = 0;
    setDataVersion((v) => v + 1);
  }, []);

  const exitEditMode = useCallback(async () => {
    setError(null);
    let backendOk = true;
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/exit`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = body.error || "Failed to exit edit mode.";
        setError(msg);
        showToast(msg, "error");
        backendOk = false;
      }
    } catch (err) {
      console.warn("exitEditMode:", err);
      setError(err.message || "Network error");
      showToast(err.message || "Network error", "warning");
      backendOk = false;
    }
    // We ALWAYS reset local state, even if the backend failed.
    // Worst case: the UI says "off" while the backend is "on" — less harmful
    // than the reverse (false "on" that makes the user think changes are protected).
    // The next `refreshStatus` (or any backend request)
    // will resynchronise anyway.
    resetEditStateLocal();
    if (backendOk) showToast("Edit mode closed", "info");
  }, [showToast, resetEditStateLocal]);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/status`);
      const body = await res.json();
      // Post SQL-first refactor: the DB exists from upload time onwards,
      // so `counts` are returned by the backend even when `editing` is false.
      // Always trust the backend's counts payload — null only means "no feed yet".
      if (body.editing) {
        setEditing(true);
        setCounts(body.counts || null);
        setPendingEdits(body.pending_edits || 0);
        setUndoneEdits(body.undone_edits || 0);
      } else {
        setEditing(false);
        setCounts(body.counts || null);
        setPendingEdits(0);
        setUndoneEdits(0);
      }
    } catch (err) {
      console.warn("refreshStatus:", err);
      // On network failure at boot, switch to `false` to avoid staying
      // stuck on the skeleton. An implicit retry will happen on the next
      // mount/action utilisateur.
      setEditing((prev) => (prev === undefined ? false : prev));
    } finally {
      setStatusReady(true);
    }
  }, []);

  // Debounced backend resync of the per-table row counts after any
  // mutation signal. The SQL console "Browse files" chips and schema panel
  // render from `counts`; without this they stay frozen at their
  // upload-time values after a chat-apply or console mutation — the user
  // sees "feed_info 0" right after a successful INSERT and concludes the
  // fix did nothing. One timer collapses bursts (grid edits) into a
  // single /edit/status call.
  const countsRefreshTimer = useRef(null);
  const scheduleCountsRefresh = useCallback(() => {
    if (countsRefreshTimer.current) clearTimeout(countsRefreshTimer.current);
    countsRefreshTimer.current = setTimeout(() => {
      countsRefreshTimer.current = null;
      refreshStatus();
    }, 600);
  }, [refreshStatus]);
  useEffect(
    () => () => {
      if (countsRefreshTimer.current) clearTimeout(countsRefreshTimer.current);
    },
    [],
  );

  const undoLast = useCallback(async () => {
    if (undoing) return false; // prevent concurrent undo calls
    setUndoing(true);
    setError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/undo`, {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Nothing to undo.");
        showToast(body.error || "Nothing to undo.", "warning");
        return false;
      }
      setPendingEdits((n) => Math.max(0, n - 1));
      setUndoneEdits((n) => n + 1);
      setDataVersion((v) => v + 1);
      // Sprint 9 — undo invalidates the prior incremental-validation result
      // (it pertained to a now-reverted state). Wipe it so badges/sidebars
      // do not surface stale findings against the post-undo data.
      setLastValidationResult(null);
      // Selective update: if the undo targets a stop, we replace
      // the override with the current DB state (returned by the backend).
      // This way the grid immediately reflects the post-undo value.
      const undone = body.undone;
      if (undone?.entity === "stop" && undone?.entity_id) {
        // Undo targets a specific stop: update or remove its override
        if (body.currentState) {
          setStopOverrides((prev) => ({
            ...prev,
            [undone.entity_id]: body.currentState,
          }));
        } else {
          setStopOverrides((prev) => {
            const next = { ...prev };
            delete next[undone.entity_id];
            return next;
          });
        }
      } else if (undone?.entity === "route") {
        // Route undo (especially cascade delete) may restore stops/trips:
        // clear all overrides to let refetch provide fresh data
        setStopOverrides({});
      }
      // For non-stop undos, we do NOT clear stop overrides.
      // They remain valid because they reflect edits on a different entity.
      const label = undone?.description || "Change reverted";
      showToast(`Undone: ${label}`, "info");
      scheduleCountsRefresh();
      return true;
    } catch (err) {
      console.error("undoLast:", err);
      setError(err.message || "Network error");
      showToast(err.message || "Network error", "error");
      return false;
    } finally {
      setUndoing(false);
    }
  }, [showToast, undoing, scheduleCountsRefresh]);

  const redoLast = useCallback(async () => {
    if (redoing) return false;
    setRedoing(true);
    setError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/redo`, {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Nothing to redo.");
        showToast(body.error || "Nothing to redo.", "warning");
        return false;
      }
      setPendingEdits((n) => n + 1);
      setUndoneEdits((n) => Math.max(0, n - 1));
      setDataVersion((v) => v + 1);
      // Mirror the undo path: drop stale per-edit validation badge.
      setLastValidationResult(null);
      // After redo, overrides may diverge from DB — clear to let refetch drive
      setStopOverrides({});
      const label = body.redone?.description || "Change re-applied";
      showToast(`Redone: ${label}`, "info");
      scheduleCountsRefresh();
      return true;
    } catch (err) {
      console.error("redoLast:", err);
      setError(err.message || "Network error");
      showToast(err.message || "Network error", "error");
      return false;
    } finally {
      setRedoing(false);
    }
  }, [showToast, redoing, scheduleCountsRefresh]);

  const jumpToHistory = useCallback(
    async (targetId) => {
      setError(null);
      try {
        const res = await fetchWithSession(`${API_BASE_URL}/edit/jump`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetId }),
        });
        const body = await res.json();
        if (!res.ok) {
          setError(body.error || "Failed to jump.");
          showToast(body.error || "Failed to jump.", "error");
          return false;
        }
        setPendingEdits(body.pending_edits ?? 0);
        setUndoneEdits(body.undone_edits ?? 0);
        setDataVersion((v) => v + 1);
        setStopOverrides({});
        // History jump invalidates any per-edit validation badge.
        setLastValidationResult(null);
        showToast(`Jumped to edit #${targetId}`, "info");
        scheduleCountsRefresh();
        return true;
      } catch (err) {
        console.error("jumpToHistory:", err);
        setError(err.message || "Network error");
        showToast(err.message || "Network error", "error");
        return false;
      }
    },
    [showToast, scheduleCountsRefresh],
  );

  // NeTEx France export — same download dance as exportGTFS against the
  // /edit/export/netex endpoint (server-side gtfs2netexfr conversion).
  // 503 means the converter is not installed on this server; 422 mirrors
  // the GTFS export gate (blocking findings remain).
  const exportNetex = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/export/netex`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || "NeTEx export failed.");
        showToast(body.message || body.error || "NeTEx export failed.", "error");
        return false;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      a.download = `netex-fr-${stamp}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast("NeTEx exported successfully", "success");
      return true;
    } catch (err) {
      console.error("exportNetex:", err);
      setError(err.message || "Network error");
      showToast(err.message || "Network error", "error");
      return false;
    }
  }, [showToast]);

  const exportGTFS = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/export`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || "Export failed.");
        showToast(body.error || "Export failed.", "error");
        return false;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      a.download = `gtfs-edited-${stamp}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast("GTFS exported successfully", "success");
      return true;
    } catch (err) {
      console.error("exportGTFS:", err);
      setError(err.message || "Network error");
      showToast(err.message || "Network error", "error");
      return false;
    }
  }, [showToast]);

  const recordEdit = useCallback(
    (message, validationBlock = null, opts = {}) => {
      setPendingEdits((n) => n + 1);
      // Any new mutation wipes the redo stack server-side → mirror locally
      setUndoneEdits(0);
      setDataVersion((v) => v + 1);
      // Bump auto-save counter (useAutoSaveProject effect polls this ref).
      editsSinceSnapshotRef.current += 1;

      // Sprint 9 — surface the per-edit `validation` block returned by every
      // mutation endpoint. Three outcomes:
      //   (a) validationBlock missing or .items empty → behave exactly as
      //       before: success toast.
      //   (b) validationBlock has items → severity=warning, append "(N
      //       finding(s))" suffix. The full list is exposed via
      //       lastValidationResult so a sidebar / status badge can show it.
      //   (c) validationBlock.skipped (timed out) → success toast as in (a),
      //       but consumers can read `skipped` from lastValidationResult and
      //       show a "validation pending" hint if they want to.
      if (validationBlock && (opts.entity || opts.entityId)) {
        setLastValidationResult({
          entity: opts.entity || null,
          entityId: opts.entityId || null,
          items: Array.isArray(validationBlock.items) ? validationBlock.items : [],
          skipped: !!validationBlock.skipped,
          truncated: validationBlock.truncated || 0,
          totalAvailable: validationBlock.totalAvailable || 0,
          elapsedMs: validationBlock.elapsedMs || 0,
          timestamp: Date.now(),
        });
      }

      const findingCount =
        validationBlock && Array.isArray(validationBlock.items)
          ? validationBlock.items.length
          : 0;

      if (findingCount > 0) {
        const suffix = t("validation.inline.foundIssues", {
          count: findingCount,
        });
        const composed = message ? `${message} — ${suffix}` : suffix;
        showToast(composed, "warning");
      } else if (message) {
        showToast(message, "success");
      }
      // Keep the per-table row counts in sync with the mutation that was
      // just recorded (debounced — see scheduleCountsRefresh).
      scheduleCountsRefresh();
    },
    [showToast, t, scheduleCountsRefresh],
  );

  // Public clearer (used by undo/redo/jump and dialog-close handlers that
  // want to wipe the prior finding badge before the user moves on).
  const clearValidationResult = useCallback(() => {
    setLastValidationResult(null);
  }, []);

  // ── Project (.gtfsproj): Save / Open / meta ────────────────────────────

  const refreshProjectMeta = useCallback(async () => {
    try {
      const body = await fetchProjectMeta();
      if (body && body.editing) {
        setProjectMeta(body.meta || null);
      } else {
        setProjectMeta(null);
      }
    } catch (err) {
      console.warn("refreshProjectMeta:", err);
    }
  }, []);

  const saveProject = useCallback(async () => {
    if (savingProject) return false;
    setSavingProject(true);
    try {
      const result = await saveProjectToFile({});
      if (!result.ok) {
        showToast(result.error || "Save failed", "error");
        return false;
      }
      editsSinceSnapshotRef.current = 0;
      setLastAutoSaveAt(Date.now());
      showToast(`Project saved: ${result.filename}`, "success");
      // Refresh metadata (updated_at changed on the DB side)
      refreshProjectMeta();
      return true;
    } catch (err) {
      console.error("saveProject:", err);
      showToast(err.message || "Save failed", "error");
      return false;
    } finally {
      setSavingProject(false);
    }
  }, [savingProject, showToast, refreshProjectMeta]);

  /**
   * Opens a .gtfsproj file. Reads `localStorage.gtfs_beta_code` to
   * send `X-Beta-Code` (the `/edit/project/import` endpoint is gated).
   *
   * Returns a structured object (see `enterEditMode`) rather than a boolean,
   * to allow the caller to show the BetaGateDialog if needed.
   */
  const openProject = useCallback(
    async (file, onProgress, betaCode = null) => {
      if (openingProject) return { ok: false, errorCode: null };
      setOpeningProject(true);
      setError(null);
      try {
        const code = betaCode ?? (() => {
          try {
            return localStorage.getItem("gtfs_beta_code");
          } catch {
            return null;
          }
        })();
        const result = await openProjectFromFile(file, onProgress, code);
        if (!result.ok) {
          // Detect 403 beta gate in the XHR response.
          const errCode = result.errorCode || null;
          const isBetaError =
            errCode &&
            (errCode === "INVALID_BETA_CODE" ||
              errCode === "BETA_REVOKED" ||
              errCode === "BETA_CODE_REQUIRED" ||
              errCode === "BETA_CONFIG_ERROR");
          if (isBetaError) {
            // Purge rejected stored code
            if ((errCode === "INVALID_BETA_CODE" || errCode === "BETA_REVOKED") && !betaCode) {
              try {
                localStorage.removeItem("gtfs_beta_code");
              } catch {
                /* ignore */
              }
            }
            return { ok: false, errorCode: errCode, message: result.error };
          }
          showToast(result.error || "Open failed", "error");
          setError(result.error || "Open failed");
          return { ok: false, errorCode: null, message: result.error };
        }
        // The DB was replaced on the server → we switch to edit mode
        // in the UI (if not already there) and force a global refetch.
        setEditing(true);
        setCounts(result.counts || null);
        setPendingEdits(result.pending_edits || 0);
        setUndoneEdits(0);
        setStopOverrides({});
        setProjectMeta(result.meta || null);
        setBetaTester(result.betaTester || null);
        setDataVersion((v) => v + 1);
        editsSinceSnapshotRef.current = 0;
        showToast("Project opened", "success");
        return { ok: true, betaTester: result.betaTester || null };
      } catch (err) {
        console.error("openProject:", err);
        showToast(err.message || "Open failed", "error");
        setError(err.message || "Open failed");
        return { ok: false, errorCode: "NETWORK_ERROR", message: err.message };
      } finally {
        setOpeningProject(false);
      }
    },
    [openingProject, showToast],
  );

  // Auto-save: capture a snapshot when (a) the page becomes hidden (tab
  // switch / window close — the common loss vector), or (b) after AUTO_SAVE_IDLE_MS
  // of accumulated activity. Both paths require ≥1 edit since last save.
  //
  // Trade-off: a violent crash (kernel panic, kill -9 on the browser) loses
  // up to AUTO_SAVE_IDLE_MS of work. Acceptable for a data editor — DBeaver,
  // MySQL Workbench have the same model. Server cost: ~10× fewer VACUUM INTO
  // calls than the previous "every 25 edits or 2 min" trigger.
  useEffect(() => {
    if (!editing || !autoSaveEnabled) return undefined;
    let cancelled = false;
    const triggerIfNeeded = async () => {
      if (cancelled || autoSaveInFlightRef.current) return;
      if (editsSinceSnapshotRef.current === 0) return;
      autoSaveInFlightRef.current = true;
      setAutoSaveInFlight(true);
      try {
        const sessionId = getSessionId();
        const result = await captureAndStoreSnapshot(sessionId, projectMeta);
        if (!cancelled && result.ok) {
          editsSinceSnapshotRef.current = 0;
          setLastAutoSaveAt(Date.now());
        } else if (!cancelled) {
          console.warn("Auto-save failed:", result.error);
        }
      } catch (err) {
        if (!cancelled) console.warn("Auto-save error:", err);
      } finally {
        autoSaveInFlightRef.current = false;
        if (!cancelled) setAutoSaveInFlight(false);
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) triggerIfNeeded();
    };
    // `pagehide` fires more reliably than `visibilitychange` for the
    // "user closes the tab / window / kills the browser" case, including
    // when the page is evicted from the back-forward cache. Both
    // listeners coexist: visibilitychange catches tab switches (back-foreground
    // navigation), pagehide catches terminal exits.
    const onPageHide = () => triggerIfNeeded();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    const interval = setInterval(triggerIfNeeded, AUTO_SAVE_IDLE_MS);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      clearInterval(interval);
    };
  }, [editing, autoSaveEnabled, projectMeta]);

  // Refresh metadata on edit mode entry
  useEffect(() => {
    if (editing) {
      refreshProjectMeta();
    } else {
      setProjectMeta(null);
      setLastAutoSaveAt(null);
      editsSinceSnapshotRef.current = 0;
    }
  }, [editing, refreshProjectMeta]);

  const patchStop = useCallback((stop) => {
    if (!stop || !stop.stop_id) return;
    setStopOverrides((prev) => ({
      ...prev,
      [stop.stop_id]: { ...(prev[stop.stop_id] || {}), ...stop },
    }));
  }, []);

  const clearError = useCallback(() => setError(null), []);

  // Global Ctrl+Z / Cmd+Z (undo) and Ctrl+Shift+Z / Cmd+Shift+Z (redo).
  // Does NOT intercept when focus is inside an input / textarea / select.
  useEffect(() => {
    const handler = (e) => {
      const tag = document.activeElement?.tagName;
      const isEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        document.activeElement?.isContentEditable;
      if (isEditable) return;
      if (!editing) return;
      const isZ = e.key === "z" || e.key === "Z";
      const isY = e.key === "y" || e.key === "Y";
      if ((e.ctrlKey || e.metaKey) && isZ && !e.shiftKey) {
        e.preventDefault();
        undoLast();
      } else if (
        ((e.ctrlKey || e.metaKey) && isZ && e.shiftKey) ||
        ((e.ctrlKey || e.metaKey) && isY && !e.shiftKey)
      ) {
        e.preventDefault();
        redoLast();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editing, undoLast, redoLast]);

  // Restore edit state on mount (e.g. after page refresh)
  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  return (
    <EditModeContext.Provider
      value={{
        editing,
        statusReady,
        entering,
        counts,
        pendingEdits,
        undoneEdits,
        dataVersion,
        stopOverrides,
        undoing,
        redoing,
        error,
        enterEditMode,
        exitEditMode,
        resetEditStateLocal,
        refreshStatus,
        undoLast,
        redoLast,
        jumpToHistory,
        exportGTFS,
        exportNetex,
        recordEdit,
        patchStop,
        showToast,
        clearError,
        // Sprint 9 — incremental validation feedback
        lastValidationResult,
        clearValidationResult,
        // .gtfsproj project
        projectMeta,
        savingProject,
        openingProject,
        lastAutoSaveAt,
        autoSaveInFlight,
        autoSaveEnabled,
        setAutoSaveEnabled,
        saveProject,
        openProject,
        refreshProjectMeta,
        // Beta gate
        betaTester,
      }}
    >
      {children}
      <Snackbar
        key={toast?.key}
        open={Boolean(toast)}
        autoHideDuration={3500}
        onClose={closeToast}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        TransitionComponent={SlideUp}
      >
        {toast ? (
          <Alert
            onClose={closeToast}
            severity={toast.severity}
            variant="filled"
            sx={{
              minWidth: 280,
              boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
              fontWeight: 600,
            }}
          >
            {toast.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </EditModeContext.Provider>
  );
}

export function useEditMode() {
  const ctx = useContext(EditModeContext);
  if (!ctx)
    throw new Error("useEditMode must be used within an EditModeProvider");
  return ctx;
}
