import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Snackbar, Alert, Slide, Button, IconButton } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import API_BASE_URL from "../config";
import { fetchWithSession } from "../utils/sessionManager";
// The draft's undo and redo (the panel « Modifications » takes back or puts back its last retouche).
import { useLanguage } from "./LanguageContext";
import { humanError } from "../utils/humanError";
import { refusalOf } from "../utils/refusalToAction";
import { resolveDelivery } from "../utils/projectStore";

const EditModeContext = createContext(null);
// The snackbar's own context (ToastProvider below): a toast shown or closed
// re-renders the snackbar only, never the useEditMode() consumers.
const ToastContext = createContext(null);

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
 *
 * The value is memoized (one object per actual change of a field), and the
 * snackbar lives in its own provider (ToastProvider): every edit toasts, and
 * a toast must not re-render the grid, the maps and the panels that read
 * useEditMode(). `showToast` stays on useEditMode() (stable); useToast()
 * gives it without subscribing to the edit state.
 */

function SlideUp(props) {
  return <Slide {...props} direction="up" />;
}

/**
 * The snackbar of the edit session: its state (`toast`) is held here, so
 * showing or closing one re-renders this provider and its Snackbar only —
 * `children` is the same element from one toast to the next, and the
 * context value ({ showToast, closeToast }) never changes.
 */
export function ToastProvider({ children }) {
  const { t } = useLanguage();
  const [toast, setToast] = useState(null); // { message, severity, action, key }

  // `action` (optional): { label, onClick } rendered as a button inside the
  // snackbar — used for the inline "Undo" on every successful edit.
  const showToast = useCallback((message, severity = "success", action = null) => {
    setToast({ message, severity, action, key: Date.now() });
  }, []);

  const closeToast = useCallback(() => setToast(null), []);

  const value = useMemo(() => ({ showToast, closeToast }), [showToast, closeToast]);

  return (
    <ToastContext.Provider value={value}>
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
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider (EditModeProvider includes one)");
  return ctx;
}

// The public provider: the toasts around the edit state, which shows them.
export function EditModeProvider({ children }) {
  return (
    <ToastProvider>
      <EditModeState>{children}</EditModeState>
    </ToastProvider>
  );
}

function EditModeState({ children }) {
  const { t } = useLanguage();
  const { showToast } = useToast();
  // `editing === undefined` ⇒ backend status not yet known (first mount,
  // before `refreshStatus()` has responded). We render a skeleton rather
  // than a false "off" to avoid the visual flash after reload.
  const [editing, setEditing] = useState(undefined);
  const [statusReady, setStatusReady] = useState(false);
  const [entering, setEntering] = useState(false);
  const [counts, setCounts] = useState(null);
  const [pendingEdits, setPendingEdits] = useState(0);
  const [undoneEdits, setUndoneEdits] = useState(0);
  // Number of data changes (edits, undos, redos, jumps) since the last GTFS
  // export or frozen version. Drives the unsaved-changes guard. Deliberately
  // separate from `pendingEdits`, which is the undo depth and never decreases
  // on export.
  const [unsavedChanges, setUnsavedChanges] = useState(0);
  // Inside a project kept on the server, the edits frozen in a version (a
  // snapshot — GTFSApp's session poll or "Figer en version") are not lost
  // with the tab: the close guard stands down until the next edit.
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
  // A hold on edit mode (the draft's screen where it is not retouched: « Avant », a brief draft, a draft applied, a
  // draft still opening): while held, entering edit mode is refused in place — whoever asks (the toggle, the palette,
  // a repair) — with the reason the holder gives (an i18n key), and the toggle says it.
  const [editHold, setEditHold] = useState(null);
  const editHoldRef = useRef(null);
  editHoldRef.current = editHold;
  const holdEditing = useCallback((reason = "draft.hold.before") => setEditHold(reason || "draft.hold.before"), []);
  const releaseEditing = useCallback(() => setEditHold(null), []);
  const [stopOverrides, setStopOverrides] = useState({});
  const [error, setError] = useState(null);
  // Incremental validation feedback surfaced inline.
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
   * RefusalNotice), so no error snackbar says it a second time (never a
   * snackbar for a refusal).
   * `overrideHold`: the application of a change and its delivery write the working copy by their own act — a hold
   * (the reader's « Après », a draft read only) keeps the person's retouches out, never them.
   *
   * Every modification happens in a project's draft: asked on a network outside it (a correction from the validation,
   * a repair of the assistant, « Éditer »), `gtfs:before-edit` takes the person to the draft first (the app's
   * useDraftScreen, which marks the event `moved`) — nothing is entered here then (`{ ok: false, moved: true }`):
   * the draft's screen turns its own edit mode on, and the person repeats the act there.
   */
  const enterEditMode = useCallback(async (options = {}) => {
    const quiet = Boolean(options && options.quiet === true);
    const override = Boolean(options && options.overrideHold === true);
    if (!override) {
      const asked = new CustomEvent("gtfs:before-edit", { detail: {} });
      window.dispatchEvent(asked);
      if (asked.detail.moved) return { ok: false, errorCode: "MOVED_TO_DRAFT", moved: true };
    }
    if (editHoldRef.current && !override) return { ok: false, errorCode: "DRAFT_VIEW_READ_ONLY", hold: editHoldRef.current };
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
      // No toast: the status bar says « Édition » (a state is told by the status bar, never by a toast).
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
  // `counts` reflect the DB, which exists from the upload on, independent
  // of edit mode. We DO NOT reset them, otherwise
  // the Browse-files chips (and other counts consumers) become empty
  // during the exit→refreshStatus window. `refreshStatus` will repopulate them
  // anyway — better to keep current values in the meantime.
  const resetEditStateLocal = useCallback(() => {
    setEditing(false);
    setPendingEdits(0);
    setUndoneEdits(0);
    setUnsavedChanges(0);
    setStopOverrides({});
    setLastValidationResult(null);
    setDataVersion((v) => v + 1);
  }, []);

  // `quiet`: left by the application's own act (a delivery done), no toast.
  const exitEditMode = useCallback(async ({ quiet = false } = {}) => {
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
    if (backendOk && !quiet) showToast(t("edit.toast.closed"), "info");
  }, [showToast, resetEditStateLocal, t, said]);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/status`);
      const body = await res.json();
      // The DB exists from upload time onwards,
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
      // stuck on the skeleton. An implicit retry happens on the next
      // mount or user action.
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
      // Undo invalidates the prior incremental-validation result
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

  // The delivery answers `{ ok: true }` or `{ ok: false, refusal }` (refusalOf: the server's code,
  // the status read on the response): the preflight renders a refusal in place (RefusalNotice: Try
  // again · Notify the administrator), never a snackbar — 503
  // VALIDATOR_FAILED when the validator times out, 422 VALIDATION_NEW_ERRORS when the network changed
  // after the preflight's report.
  const refused = useCallback(
    (body, status) => {
      setError(said(body, status));
      return { ok: false, refusal: refusalOf(body, status) };
    },
    [said],
  );

  const exportGTFS = useCallback(async ({ changelog = false } = {}) => {
    setError(null);
    try {
      // `changelog=1` ships the AI release notes generated in the preflight
      // dialog as CHANGELOG.md inside the zip. `version=N`: the project's
      // version this file delivers — the one it marks delivered,
      // a new one when retouches stand after the last — so the file's name
      // and the project agree.
      const delivery = await resolveDelivery();
      // A shared project's version is delivered only approved: refused in place, nothing downloaded.
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
      // livrée ») — this download marks no version delivered; said so in the toast.
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
      if (opts.entity) markTouched(opts.entity, opts.entityId);

      // Surface the per-edit `validation` block returned by every
      // mutation endpoint. Three outcomes:
      //   (a) validationBlock missing or .items empty → a plain success toast.
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

  // One object per actual change of a field (see the header): the callbacks
  // are useCallback'd above, so the list below is the whole dependency set.
  const value = useMemo(
    () => ({
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
      recordEdit,
      patchStop,
      showToast,
      clearError,
      // Incremental validation feedback
      lastValidationResult,
      clearValidationResult,
      // The hold on edit mode (the reader's « Après »)
      editHold,
      holdEditing,
      releaseEditing,
    }),
    [
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
      recordEdit,
      patchStop,
      showToast,
      clearError,
      lastValidationResult,
      clearValidationResult,
      editHold,
      holdEditing,
      releaseEditing,
    ],
  );

  return <EditModeContext.Provider value={value}>{children}</EditModeContext.Provider>;
}

export function useEditMode() {
  const ctx = useContext(EditModeContext);
  if (!ctx)
    throw new Error("useEditMode must be used within an EditModeProvider");
  return ctx;
}
