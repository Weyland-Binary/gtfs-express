import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Snackbar, Alert, Slide, Button, IconButton } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import API_BASE_URL from "../config";
import { fetchWithSession, getSessionId, PAYWALL_EVENT } from "../utils/sessionManager";
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
import { humanError } from "../utils/humanError";
import { refusalOf } from "../utils/refusalToAction";
import { resolveDelivery } from "../utils/projectStore";

const EditModeContext = createContext(null);

/**
 * The delivered file's name: `<network>_v<N>_<date>.zip`, as the server
 * names it (Content-Disposition); when the header is missing, the same
 * shape without the network's name. Never "gtfs-edited-<timestamp>".
 */
const deliveredFileName = (res, { version = 1, suffix = "" } = {}) => {
  const header = res?.headers?.get?.("content-disposition") || "";
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  if (m && m[1]) return decodeURIComponent(m[1].trim());
  return `reseau_v${version}_${new Date().toISOString().slice(0, 10)}${suffix}.zip`;
};

/** Trigger the browser's download of a blob under the given name. */
const downloadBlob = (blob, name) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

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
 *   exportGTFS()      — triggers the ZIP download → { ok: true } | { ok: false, refusal }
 *                       (the refusal is rendered in place by the caller, never a snackbar)
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
  // Number of data changes (edits, undos, redos, jumps) since the last
  // explicit save (.gtfsproj) or GTFS export. Drives the unsaved-changes
  // guard. Deliberately separate from `pendingEdits`, which is the undo
  // depth and never decreases on save — using it made the "Discard
  // changes?" dialog and the browser leave-page prompt fire forever after
  // a successful save.
  const [unsavedChanges, setUnsavedChanges] = useState(0);
  // Inside a project kept on the server, the edits frozen in a version (a
  // snapshot, D38 — GTFSApp's session poll or "Figer en version") are no
  // longer lost with the tab: the close guard stands down until the next edit.
  useEffect(() => {
    const handler = () => setUnsavedChanges(0);
    window.addEventListener("gtfs:work-frozen", handler);
    return () => window.removeEventListener("gtfs:work-frozen", handler);
  }, []);
  // Entities modified since the last validation report, keyed
  // "type:id" (e.g. "stop:S12", "stop_time:T1:4"). The validation page dims
  // their findings ("probably fixed") and GTFSApp schedules a background
  // re-validation. Cleared by clearTouchedEntities() when a fresh report
  // arrives. Undo / redo / jump touch "history:*" (we don't know what they
  // reverted) which still marks the report as stale.
  const [touchedEntities, setTouchedEntities] = useState({});
  const markTouched = useCallback((entity, entityId) => {
    const key = `${entity || "unknown"}:${entityId ?? "*"}`;
    setTouchedEntities((prev) => (prev[key] ? prev : { ...prev, [key]: Date.now() }));
  }, []);
  // `beforeTs` (optional): only forget entities touched at or before that
  // instant — a validation run only vouches for edits made before it
  // started; anything edited while it ran stays flagged for the next run.
  const clearTouchedEntities = useCallback((beforeTs = null) => {
    setTouchedEntities((prev) => {
      if (beforeTs == null) return {};
      const next = {};
      for (const [k, ts] of Object.entries(prev)) if (ts > beforeTs) next[k] = ts;
      return next;
    });
  }, []);
  const [dataVersion, setDataVersion] = useState(0);
  // A hold on edit mode (the reader looking at a simulated draft, « Après »: a draft is never edited, its operations
  // are): while held, entering edit mode is refused in place — whoever asks (the toggle, the palette, an apply, a
  // repair) — with the reason the holder gives (an i18n key), and the toggle says it.
  const [editHold, setEditHold] = useState(null);
  const editHoldRef = useRef(null);
  editHoldRef.current = editHold;
  const holdEditing = useCallback((reason = "lens.editHold") => setEditHold(reason || "lens.editHold"), []);
  const releaseEditing = useCallback(() => setEditHold(null), []);
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
  const [undoing, setUndoing] = useState(false);
  const [redoing, setRedoing] = useState(false);
  const [toast, setToast] = useState(null); // { message, severity }
  // Project: metadata + auto-save state
  const [projectMeta, setProjectMeta] = useState(null); // { project_id, updated_at, ... }
  const [savingProject, setSavingProject] = useState(false);
  const [openingProject, setOpeningProject] = useState(false);
  const [lastAutoSaveAt, setLastAutoSaveAt] = useState(null);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true);
  // `autoSaveInFlight` is exposed as state so consumers (e.g. ProjectMenu
  // in the Header) can render a spinner while a snapshot is being captured.
  // The ref below is kept in parallel for the synchronous reentrancy guard
  // inside the auto-save effect (state updates are async — the ref provides
  // an immediate read after `triggerIfNeeded` is invoked twice in a row).
  const [autoSaveInFlight, setAutoSaveInFlight] = useState(false);
  // Change counter since the last auto-save, stored in a ref to
  // avoid unnecessary rerenders on bump.
  const editsSinceSnapshotRef = useRef(0);
  const autoSaveInFlightRef = useRef(false);

  // `action` (optional): { label, onClick } rendered as a button inside the
  // snackbar — used for the inline "Undo" on every successful edit.
  const showToast = useCallback((message, severity = "success", action = null) => {
    setToast({ message, severity, action, key: Date.now() });
  }, []);

  const closeToast = useCallback(() => setToast(null), []);

  // Every failure of the backend is said in the reader's language, through
  // humanError: the API envelope (any of its forms), the HTTP status or a
  // thrown fetch error become one sentence, never a raw English fallback.
  const said = useCallback(
    (err, status = null) => {
      const source = err && typeof err === "object" ? { ...err, ...(status != null ? { status } : {}) } : { message: err ? String(err) : "", ...(status != null ? { status } : {}) };
      return humanError(source, t)?.message || t("error.human.unknown");
    },
    [t],
  );

  /**
   * Switches to edit mode.
   *
   * Under the paid offer the server wants the licence's "edit" (the account
   * cookie): its refusal (402 SUBSCRIPTION_REQUIRED, 401 NOT_SIGNED_IN
   * marked `paid`) opens the offer by itself (sessionManager's
   * PAYWALL_EVENT), so no snackbar repeats it.
   *
   * Structured return (not a boolean):
   *   • success                             → { ok: true }
   *   • the licence is wanted               → { ok: false, errorCode: "SUBSCRIPTION_REQUIRED" | "NOT_SIGNED_IN", paywall: true }
   *   • other answer of the server          → { ok: false, errorCode: body.code ?? body.error, status, body, message }
   *   • no answer (network)                 → { ok: false, errorCode: "NETWORK_ERROR", status: null, message }
   *
   * `quiet`: the caller renders the refusal in place (ApplyDialog's
   * RefusalNotice), so no error snackbar says it a second time (§10: never a
   * snackbar for a refusal).
   */
  const enterEditMode = useCallback(async (options = {}) => {
    const quiet = Boolean(options && options.quiet === true);
    if (editHoldRef.current) return { ok: false, errorCode: "DRAFT_VIEW_READ_ONLY", hold: editHoldRef.current };
    setEntering(true);
    setError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/enter`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The paid offer's refusal: the offer is already open (PAYWALL_EVENT), nothing to add here.
        if (res.status === 402 || (res.status === 401 && body.paid === true)) {
          return { ok: false, errorCode: body.error || null, status: res.status, paywall: true, message: body.message || null };
        }
        const message = said(body, res.status);
        setError(message);
        if (!quiet) showToast(message, "error");
        return { ok: false, errorCode: body.code ?? body.error ?? null, status: res.status, body, message };
      }
      setEditing(true);
      setCounts(body.counts || null);
      setPendingEdits(0);
      setUnsavedChanges(0);
      // No toast: the status bar says « Édition » (§3.2, §10 — a state is told by the status bar, never by a toast).
      return { ok: true };
    } catch (err) {
      console.error("enterEditMode:", err);
      const message = said(err);
      setError(message);
      if (!quiet) showToast(message, "error");
      return { ok: false, errorCode: "NETWORK_ERROR", status: null, message };
    } finally {
      setEntering(false);
    }
  }, [showToast, said]);

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
    setUnsavedChanges(0);
    setStopOverrides({});
    setProjectMeta(null);
    setLastAutoSaveAt(null);
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
        const msg = said(body, res.status);
        setError(msg);
        showToast(msg, "error");
        backendOk = false;
      }
    } catch (err) {
      console.warn("exitEditMode:", err);
      const msg = said(err);
      setError(msg);
      showToast(msg, "warning");
      backendOk = false;
    }
    // We ALWAYS reset local state, even if the backend failed.
    // Worst case: the UI says "off" while the backend is "on" — less harmful
    // than the reverse (false "on" that makes the user think changes are protected).
    // The next `refreshStatus` (or any backend request)
    // will resynchronise anyway.
    resetEditStateLocal();
    if (backendOk) showToast(t("edit.toast.closed"), "info");
  }, [showToast, resetEditStateLocal, t, said]);

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

  // `expectedEntryId` (optional): only undo if that log entry is still the
  // latest one. Inline "Undo" buttons (toasts, AI repair chip) pass the id
  // of the change they belong to, so a click never reverts a *later* edit.
  const undoLast = useCallback(async (expectedEntryId = null) => {
    if (undoing) return false; // prevent concurrent undo calls
    setUndoing(true);
    setError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/undo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          Number.isFinite(Number(expectedEntryId)) && expectedEntryId !== null
            ? { expectedEntryId: Number(expectedEntryId) }
            : {},
        ),
      });
      const body = await res.json();
      if (res.status === 409 && body.error === "UNDO_TARGET_NOT_LATEST") {
        showToast(t("edit.toast.undoNotLatest"), "warning");
        return false;
      }
      if (!res.ok) {
        const msg = said(body, res.status);
        setError(msg);
        showToast(msg, "warning");
        return false;
      }
      setPendingEdits((n) => Math.max(0, n - 1));
      setUndoneEdits((n) => n + 1);
      setUnsavedChanges((n) => n + 1);
      markTouched("history", "*");
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
      const label = undone?.description || t("edit.toast.changeReverted");
      showToast(t("edit.toast.undone", { label }), "info");
      scheduleCountsRefresh();
      return true;
    } catch (err) {
      console.error("undoLast:", err);
      const msg = said(err);
      setError(msg);
      showToast(msg, "error");
      return false;
    } finally {
      setUndoing(false);
    }
  }, [showToast, undoing, scheduleCountsRefresh, t, markTouched, said]);

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
        const msg = said(body, res.status);
        setError(msg);
        showToast(msg, "warning");
        return false;
      }
      setPendingEdits((n) => n + 1);
      setUndoneEdits((n) => Math.max(0, n - 1));
      setUnsavedChanges((n) => n + 1);
      markTouched("history", "*");
      setDataVersion((v) => v + 1);
      // Mirror the undo path: drop stale per-edit validation badge.
      setLastValidationResult(null);
      // After redo, overrides may diverge from DB — clear to let refetch drive
      setStopOverrides({});
      const label = body.redone?.description || t("edit.toast.changeReapplied");
      showToast(t("edit.toast.redone", { label }), "info");
      scheduleCountsRefresh();
      return true;
    } catch (err) {
      console.error("redoLast:", err);
      const msg = said(err);
      setError(msg);
      showToast(msg, "error");
      return false;
    } finally {
      setRedoing(false);
    }
  }, [showToast, redoing, scheduleCountsRefresh, t, markTouched, said]);

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
          const msg = said(body, res.status);
          setError(msg);
          showToast(msg, "error");
          return false;
        }
        setPendingEdits(body.pending_edits ?? 0);
        setUndoneEdits(body.undone_edits ?? 0);
        setUnsavedChanges((n) => n + 1);
        markTouched("history", "*");
        setDataVersion((v) => v + 1);
        setStopOverrides({});
        // History jump invalidates any per-edit validation badge.
        setLastValidationResult(null);
        showToast(t("edit.toast.jumped", { id: targetId }), "info");
        scheduleCountsRefresh();
        return true;
      } catch (err) {
        console.error("jumpToHistory:", err);
        const msg = said(err);
        setError(msg);
        showToast(msg, "error");
        return false;
      }
    },
    [showToast, scheduleCountsRefresh, t, markTouched, said],
  );

  // The two deliveries answer `{ ok: true }` or `{ ok: false, refusal }` (refusalOf: the server's code,
  // the status read on the response): the preflight renders a refusal in place (RefusalNotice: Try
  // again · Notify the administrator), never a snackbar (target design §7.2, §10) — 503
  // VALIDATOR_FAILED when the validator times out, 422 VALIDATION_NEW_ERRORS when the network changed
  // after the preflight's report, 503 for a NeTEx converter that is not installed.
  const refused = useCallback(
    (body, status) => {
      setError(said(body, status));
      return { ok: false, refusal: refusalOf(body, status) };
    },
    [said],
  );

  // NeTEx France export — same download dance as exportGTFS against the
  // /edit/export/netex endpoint (server-side gtfs2netexfr conversion).
  // 503 means the converter is not installed on this server; 422 mirrors
  // the GTFS export gate (blocking findings remain).
  const exportNetex = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/export/netex`);
      if (!res.ok) return refused(await res.json().catch(() => ({})), res.status);
      const blob = await res.blob();
      // The NeTEx deliverable carries the same stamp as the GTFS one, marked as NeTEx.
      downloadBlob(blob, deliveredFileName(res, { suffix: "_netex" }));
      showToast(t("edit.toast.netexExported"), "success");
      return { ok: true };
    } catch (err) {
      console.error("exportNetex:", err);
      return refused(err, null);
    }
  }, [showToast, t, refused]);

  const exportGTFS = useCallback(async ({ changelog = false } = {}) => {
    setError(null);
    try {
      // `changelog=1` ships the AI release notes generated in the preflight
      // dialog as CHANGELOG.md inside the zip. `version=N`: the project's
      // version this file delivers (D46, D50) — the one it marks delivered,
      // a new one when retouches stand after the last — so the file's name
      // and the project agree.
      const delivery = await resolveDelivery();
      // A shared project's version is delivered only approved (D19): refused in place, nothing downloaded.
      if (delivery?.blocked) return refused({ error: delivery.blocked.code, n: delivery.blocked.n }, 409);
      const query = new URLSearchParams();
      if (changelog) query.set("changelog", "1");
      if (Number.isInteger(delivery?.n) && delivery.n > 0) query.set("version", String(delivery.n));
      const res = await fetchWithSession(`${API_BASE_URL}/edit/export${query.toString() ? `?${query}` : ""}`);
      if (!res.ok) return refused(await res.json().catch(() => ({})), res.status);
      const blob = await res.blob();
      // `<network>_v<N>_<date>.zip`: the server names the delivered file after
      // the network and the version; the fallback keeps the same shape.
      const filename = deliveredFileName(res);
      downloadBlob(blob, filename);
      // The exported ZIP is a durable copy of the work: nothing is unsaved
      // any more from the user's point of view.
      setUnsavedChanges(0);
      // A Studio project's network is delivered only through its package (⑤, « Tout le paquet » then « Marquer
      // livrée »: the owner's rule of 2026-10-05) — this download marks no version delivered; said so in the toast.
      // A network no project owns keeps its event (no project records it).
      if (delivery) {
        showToast(t("edit.toast.exportedProject"), "info");
        return { ok: true, delivered: false };
      }
      window.dispatchEvent(new CustomEvent("gtfs:delivered", { detail: { filename, delivery } }));
      showToast(t("delivery.done"), "success");
      return { ok: true };
    } catch (err) {
      console.error("exportGTFS:", err);
      return refused(err, null);
    }
  }, [showToast, t, refused]);

  const recordEdit = useCallback(
    (message, validationBlock = null, opts = {}) => {
      setPendingEdits((n) => n + 1);
      // Any new mutation wipes the redo stack server-side → mirror locally
      setUndoneEdits(0);
      setUnsavedChanges((n) => n + 1);
      setDataVersion((v) => v + 1);
      // Bump auto-save counter (useAutoSaveProject effect polls this ref).
      editsSinceSnapshotRef.current += 1;
      if (opts.entity) markTouched(opts.entity, opts.entityId);

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

      // Every successful mutation offers an inline Undo — the cheapest way
      // to recover from a mis-click without hunting for the header button.
      const undoAction = opts.noUndoAction
        ? null
        : { label: t("app.undo"), onClick: () => undoLast() };
      if (findingCount > 0) {
        const suffix = t("validation.inline.foundIssues", {
          count: findingCount,
        });
        const composed = message ? `${message} — ${suffix}` : suffix;
        showToast(composed, "warning", undoAction);
      } else if (message) {
        showToast(message, "success", undoAction);
      }
      // Keep the per-table row counts in sync with the mutation that was
      // just recorded (debounced — see scheduleCountsRefresh).
      scheduleCountsRefresh();
    },
    [showToast, t, scheduleCountsRefresh, undoLast, markTouched],
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
        showToast(said(result.error), "error");
        return false;
      }
      editsSinceSnapshotRef.current = 0;
      setUnsavedChanges(0);
      setLastAutoSaveAt(Date.now());
      showToast(t("project.savedToast", { filename: result.filename }), "success");
      // Refresh metadata (updated_at changed on the DB side)
      refreshProjectMeta();
      return true;
    } catch (err) {
      console.error("saveProject:", err);
      showToast(said(err), "error");
      return false;
    } finally {
      setSavingProject(false);
    }
  }, [savingProject, showToast, refreshProjectMeta, t, said]);

  /**
   * Opens a .gtfsproj file (the `/edit/project/import` endpoint wants the
   * licence under the paid offer: the account cookie rides along).
   *
   * Returns a structured object (see `enterEditMode`) rather than a boolean.
   */
  const openProject = useCallback(
    async (file, onProgress) => {
      if (openingProject) return { ok: false, errorCode: null };
      setOpeningProject(true);
      setError(null);
      try {
        const result = await openProjectFromFile(file, onProgress);
        if (!result.ok) {
          const errCode = result.errorCode || null;
          // The paid offer's refusal: the XHR is no fetchWithSession call, so the offer is opened here.
          if (errCode === "SUBSCRIPTION_REQUIRED" || errCode === "NOT_SIGNED_IN") {
            window.dispatchEvent(new CustomEvent(PAYWALL_EVENT, { detail: { entitlement: "edit", state: errCode === "NOT_SIGNED_IN" ? "sign_in_required" : "subscription_required" } }));
            return { ok: false, errorCode: errCode, paywall: true, message: result.error };
          }
          const msg = said({ code: errCode, message: result.error });
          showToast(msg, "error");
          setError(msg);
          return { ok: false, errorCode: null, message: msg };
        }
        // The DB was replaced on the server → we switch to edit mode
        // in the UI (if not already there) and force a global refetch.
        setEditing(true);
        setCounts(result.counts || null);
        setPendingEdits(result.pending_edits || 0);
        setUndoneEdits(0);
        setUnsavedChanges(0);
        setStopOverrides({});
        setProjectMeta(result.meta || null);
        setDataVersion((v) => v + 1);
        setTouchedEntities({});
        editsSinceSnapshotRef.current = 0;
        // The session now holds a different feed: every consumer of the
        // previous validation report (badge, dashboard, page, AI context)
        // must drop it — see GTFSApp's "gtfs:feed-replaced" handler.
        window.dispatchEvent(new CustomEvent("gtfs:feed-replaced", { detail: { source: "project" } }));
        showToast(t("project.openedToast"), "success");
        return { ok: true };
      } catch (err) {
        console.error("openProject:", err);
        const msg = said(err);
        showToast(msg, "error");
        setError(msg);
        return { ok: false, errorCode: "NETWORK_ERROR", message: msg };
      } finally {
        setOpeningProject(false);
      }
    },
    [openingProject, showToast, t, said],
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
      // The shape editor owns Ctrl+Z / Ctrl+Shift+Z while a shape is open
      // (local vertex history). Without this guard a single keypress would
      // undo a vertex AND the last saved edit on the server.
      if (window.__gtfsShapeEditorActive) return;
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
        unsavedChanges,
        touchedEntities,
        clearTouchedEntities,
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
        // The hold on edit mode (the reader's « Après »)
        editHold,
        holdEditing,
        releaseEditing,
      }}
    >
      {children}
      <Snackbar
        key={toast?.key}
        open={Boolean(toast)}
        autoHideDuration={toast?.action ? 6000 : 3500}
        onClose={closeToast}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        // Above the status bar, never over it: its controls (« Quitter l'édition », « Annuler », « Livrer… ») stay in
        // reach while a message shows — a pointer resting on a message keeps it open.
        sx={{ bottom: { xs: 112, sm: 96 } }}
        TransitionComponent={SlideUp}
      >
        {toast ? (
          <Alert
            onClose={closeToast}
            severity={toast.severity}
            variant="filled"
            action={
              toast.action ? (
                <>
                  <Button
                    color="inherit"
                    size="small"
                    onClick={() => {
                      closeToast();
                      toast.action.onClick();
                    }}
                    sx={{ fontWeight: 700, textTransform: "none" }}
                  >
                    {toast.action.label}
                  </Button>
                  <IconButton
                    size="small"
                    color="inherit"
                    aria-label={t("app.cancel")}
                    onClick={closeToast}
                  >
                    <CloseIcon fontSize="inherit" />
                  </IconButton>
                </>
              ) : undefined
            }
            sx={{
              minWidth: 280,
              boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
              fontWeight: 600,
              alignItems: "center",
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
