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
import { useLanguage } from "./LanguageContext";
import { humanError } from "../utils/humanError";
import { refusalOf } from "../utils/refusalToAction";
import { resolveDelivery } from "../utils/projectStore";
import { BEFORE_EDIT_EVENT, DELIVERED_EVENT, WORK_FROZEN_EVENT } from "../utils/appEvents";

const EditModeContext = createContext(null);
// Its own context so that a toast re-renders the snackbar only, never the useEditMode() consumers.
const ToastContext = createContext(null);

/** The server's Content-Disposition name (`<network>_v<N>_<date>.zip`), else the same shape without the network. */
const deliveredFileName = (res, { version = 1, suffix = "" } = {}) => {
  const header = res?.headers?.get?.("content-disposition") || "";
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  if (m && m[1]) return decodeURIComponent(m[1].trim());
  return `reseau_v${version}_${new Date().toISOString().slice(0, 10)}${suffix}.zip`;
};

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
 * Global edit mode state. `dataVersion` bumps after each mutation (put it in the deps of editable data's
 * fetches); `recordEdit()` is called after every client-side mutation (rule #17); `stopOverrides` are
 * live stop patches from the schedule grid, shown without a refetch.
 */

function SlideUp(props) {
  return <Slide {...props} direction="up" />;
}

export function ToastProvider({ children }) {
  const { t } = useLanguage();
  const [toast, setToast] = useState(null); // { message, severity, action, key }

  // `action`: { label, onClick }, a button inside the snackbar (the inline "Undo").
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
        // Above the status bar so its controls stay in reach while a message shows.
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
  // undefined until the backend's status is known: a skeleton, not a false "off" that flashes after a reload.
  const [editing, setEditing] = useState(undefined);
  const [statusReady, setStatusReady] = useState(false);
  const [entering, setEntering] = useState(false);
  const [counts, setCounts] = useState(null);
  const [pendingEdits, setPendingEdits] = useState(0);
  const [undoneEdits, setUndoneEdits] = useState(0);
  // Data changes (edits, undos, redos, jumps) since the last export or frozen version, for the unsaved-changes
  // guard; unlike `pendingEdits` (the undo depth) it goes back to zero.
  const [unsavedChanges, setUnsavedChanges] = useState(0);
  // Edits frozen in a version of a server-kept project are not lost with the tab: the guard stands down.
  useEffect(() => {
    const handler = () => setUnsavedChanges(0);
    window.addEventListener(WORK_FROZEN_EVENT, handler);
    return () => window.removeEventListener(WORK_FROZEN_EVENT, handler);
  }, []);
  // Entities modified since the last validation report, keyed "type:id". Undo, redo and jump touch
  // "history:*": what they reverted is unknown, yet the report is stale.
  const [touchedEntities, setTouchedEntities] = useState({});
  const markTouched = useCallback((entity, entityId) => {
    const key = `${entity || "unknown"}:${entityId ?? "*"}`;
    setTouchedEntities((prev) => (prev[key] ? prev : { ...prev, [key]: Date.now() }));
  }, []);
  // `beforeTs`: a validation run vouches only for edits made before it started.
  const clearTouchedEntities = useCallback((beforeTs = null) => {
    setTouchedEntities((prev) => {
      if (beforeTs == null) return {};
      const next = {};
      for (const [k, ts] of Object.entries(prev)) if (ts > beforeTs) next[k] = ts;
      return next;
    });
  }, []);
  const [dataVersion, setDataVersion] = useState(0);
  // While held (where the draft's screen is not retouched), entering edit mode is refused with the holder's
  // reason, an i18n key.
  const [editHold, setEditHold] = useState(null);
  const editHoldRef = useRef(null);
  editHoldRef.current = editHold;
  const holdEditing = useCallback((reason = "draft.hold.before") => setEditHold(reason || "draft.hold.before"), []);
  const releaseEditing = useCallback(() => setEditHold(null), []);
  const [stopOverrides, setStopOverrides] = useState({});
  const [error, setError] = useState(null);
  // The latest `validation` block an edit endpoint returned, with the entity it belongs to; cleared on undo,
  // redo, jump and exit.
  const [lastValidationResult, setLastValidationResult] = useState(null);
  const [undoing, setUndoing] = useState(false);
  const [redoing, setRedoing] = useState(false);

  const said = useCallback(
    (err, status = null) => {
      const source = err && typeof err === "object" ? { ...err, ...(status != null ? { status } : {}) } : { message: err ? String(err) : "", ...(status != null ? { status } : {}) };
      return humanError(source, t)?.message || t("error.human.unknown");
    },
    [t],
  );

  /**
   * Returns { ok, errorCode?, status?, message?, paywall?, moved? }. A paid-offer refusal opens the offer by itself
   * (PAYWALL_EVENT), so nothing repeats it. `quiet`: the caller shows the refusal in place.
   * `overrideHold`: applying or delivering a change writes the working copy by its own act, past a hold.
   * Every modification happens in a draft: `gtfs:before-edit` may take the person there first (`moved`),
   * and nothing is entered here then.
   */
  const enterEditMode = useCallback(async (options = {}) => {
    const quiet = Boolean(options && options.quiet === true);
    const override = Boolean(options && options.overrideHold === true);
    if (!override) {
      const asked = new CustomEvent(BEFORE_EDIT_EVENT, { detail: {} });
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
      // No toast: the status bar tells the state.
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

  // `counts` are kept: they describe the database, which exists outside edit mode too, and clearing them
  // would empty their consumers until refreshStatus answers.
  const resetEditStateLocal = useCallback(() => {
    setEditing(false);
    setPendingEdits(0);
    setUndoneEdits(0);
    setUnsavedChanges(0);
    setStopOverrides({});
    setLastValidationResult(null);
    setDataVersion((v) => v + 1);
  }, []);

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
    // Reset even when the backend failed: a false "off" is less harmful than a false "on" that makes the person
    // think the changes are protected; the next refreshStatus resyncs.
    resetEditStateLocal();
    if (backendOk && !quiet) showToast(t("edit.toast.closed"), "info");
  }, [showToast, resetEditStateLocal, t, said]);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/status`);
      const body = await res.json();
      // `counts` come even when not editing; null means no feed yet.
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
      // At boot, leave the skeleton rather than stay stuck on it.
      setEditing((prev) => (prev === undefined ? false : prev));
    } finally {
      setStatusReady(true);
    }
  }, []);

  // The per-table row counts, resynced after mutations (else a successful INSERT still shows "feed_info 0");
  // debounced so a burst of grid edits makes one /edit/status call.
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

  // `expectedEntryId`: undo only if that log entry is still the latest, so an inline "Undo" never reverts a
  // later edit.
  const undoLast = useCallback(async (expectedEntryId = null) => {
    if (undoing) return false;
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
      setLastValidationResult(null);
      const undone = body.undone;
      if (undone?.entity === "stop" && undone?.entity_id) {
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
        // A route's undo (a cascade delete above all) may restore stops: let the refetch drive.
        setStopOverrides({});
      }
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
      setLastValidationResult(null);
      // Overrides may diverge from the database after a redo: let the refetch drive.
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

  // A delivery refusal is returned for the preflight to show in place, never a snackbar.
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
      // `changelog=1` adds the preflight's release notes as CHANGELOG.md; `version=N` makes the file's name agree
      // with the project's version it delivers.
      const delivery = await resolveDelivery();
      // A shared project's version is delivered only once approved.
      if (delivery?.blocked) return refused({ error: delivery.blocked.code, n: delivery.blocked.n }, 409);
      const query = new URLSearchParams();
      if (changelog) query.set("changelog", "1");
      if (Number.isInteger(delivery?.n) && delivery.n > 0) query.set("version", String(delivery.n));
      const res = await fetchWithSession(`${API_BASE_URL}/edit/export${query.toString() ? `?${query}` : ""}`);
      if (!res.ok) return refused(await res.json().catch(() => ({})), res.status);
      const blob = await res.blob();
      const filename = deliveredFileName(res);
      downloadBlob(blob, filename);
      // The exported ZIP is a durable copy of the work.
      setUnsavedChanges(0);
      // A project's network is delivered only through its package: this download marks no version delivered.
      if (delivery) {
        showToast(t("edit.toast.exportedProject"), "info");
        return { ok: true, delivered: false };
      }
      window.dispatchEvent(new CustomEvent(DELIVERED_EVENT, { detail: { filename, delivery } }));
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
      // A new mutation wipes the server's redo stack.
      setUndoneEdits(0);
      setUnsavedChanges((n) => n + 1);
      setDataVersion((v) => v + 1);
      if (opts.entity) markTouched(opts.entity, opts.entityId);

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
      scheduleCountsRefresh();
    },
    [showToast, t, scheduleCountsRefresh, undoLast, markTouched],
  );

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
      // The open shape editor owns Ctrl+Z for its vertex history: else one key would also undo the last saved edit.
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

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // One object per actual change of a field, so the grid, maps and panels reading useEditMode() re-render only then.
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
      lastValidationResult,
      clearValidationResult,
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
