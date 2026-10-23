import React, { Suspense, lazy, useState, useEffect } from "react";
import { Button, CircularProgress, Tooltip } from "@mui/material";
import { useDestructiveGuard } from "../../contexts/DestructiveGuardContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import { useKeyboardShortcut } from "../../contexts/ShortcutsContext";
import { licenceLockOf, openPaywall, useFeatures } from "../../utils/featuresApi";
import { getDraftSession } from "../../utils/sessionManager";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import { ENTER_EDIT_MODE_EVENT, EXPORT_PREFLIGHT_CLOSED_EVENT, OPEN_DECISION_EVENT, OPEN_EXPORT_PREFLIGHT_EVENT, REVIEW_ERRORS_EVENT } from "../../utils/appEvents";
// The export preflight (the validation viewer behind it) loads when it opens: never in the app's first chunk.
const ExportPreflightDialog = lazy(() => import("./ExportPreflightDialog"));

/**
 * The edit-mode controls of the status bar, with the testids the e2e suite drives: `EditModeToggle` (« Éditer » in
 * reading; undo, redo and leave while editing, text buttons, never icon-only: RGAA 11.9) and `DeliverButton`
 * (« Livrer… », the delivery preflight while editing). Without the licence, entering opens the offer, at once from
 * `access` or on the server's 402 / 401 refusal (PAYWALL_EVENT).
 */

const barButton = { textTransform: "none", fontWeight: 600, fontSize: "0.78rem", minWidth: 0, px: 1, py: 0.25, lineHeight: 1.4, whiteSpace: "nowrap" };

/** `silent`: on a project's steps nothing is drawn, but the `gtfs:enter-edit-mode` listener must stay mounted. */
function EditModeToggle({ silent = false } = {}) {
  const {
    editing,
    entering,
    pendingEdits,
    undoneEdits,
    enterEditMode,
    exitEditMode,
    undoLast,
    redoLast,
    clearError,
    editHold = null,
  } = useEditMode();
  const { t } = useLanguage();
  const { openPanel } = useDetailPanel();
  const { guard } = useDestructiveGuard();

  const [undoing, setUndoing] = useState(false);
  const [redoing, setRedoing] = useState(false);
  const { features: serverFeatures } = useFeatures();
  // Without the licence « Éditer » opens the offer instead of a refusal.
  const editLock = licenceLockOf(serverFeatures?.access);
  const editPaid = editLock === "sign_in_required" || editLock === "subscription_required";

  useKeyboardShortcut({
    id: "edit.history",
    keys: ["mod+h"],
    description: t("editHistory.openTooltip"),
    category: "navigation",
    when: () => editing,
    handler: (e) => {
      e.preventDefault();
      openPanel("edit_history", "history");
    },
  });

  // The palette and the delivery panel dispatch `gtfs:enter-edit-mode` to follow this same path. enterEditMode asks
  // `gtfs:before-edit` first, which puts the network open here in its modify project (a network outside its
  // project's draft goes to the draft), synchronously. While held (a simulated draft on screen) nothing is entered
  // and the button says why.
  const handleEnterClick = () => {
    clearError();
    if (editHold) return;
    if (editPaid) {
      // Once the licence runs, edit mode is asked again by the same path.
      openPaywall("edit", editLock, () => window.dispatchEvent(new CustomEvent(ENTER_EDIT_MODE_EVENT)));
      return;
    }
    doEnter();
  };
  useEffect(() => {
    if (editing) return;
    const handler = () => handleEnterClick();
    window.addEventListener(ENTER_EDIT_MODE_EVENT, handler);
    return () => window.removeEventListener(ENTER_EDIT_MODE_EVENT, handler);
    // handleEnterClick reads only stable context callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, editPaid, editHold]);

  /** A refusal is already shown: a toast, or the offer opened by itself. */
  const doEnter = async () => {
    if (entering) return;
    await enterEditMode();
  };

  // Leaving goes through the destructive guard (Cancel / Discard); with nothing dirty `guard()` just runs it.
  const handleExitClick = () => {
    clearError();
    guard(() => exitEditMode(), { reason: "exitEditMode" });
  };

  const handleUndo = async () => {
    setUndoing(true);
    try {
      await undoLast();
    } finally {
      setUndoing(false);
    }
  };

  const handleRedo = async () => {
    setRedoing(true);
    try {
      await redoLast();
    } finally {
      setRedoing(false);
    }
  };

  // Silent: the listeners above stay, nothing is drawn (the hooks all ran: #18).
  if (silent) return null;

  if (!editing) {
    const enterButton = (
      <Button size="small" variant="outlined" color="warning" onClick={handleEnterClick} disabled={entering || Boolean(editHold)} data-testid="edit-mode-enter" data-held={editHold ? "true" : undefined} data-locked={editPaid ? "true" : undefined} startIcon={entering ? <CircularProgress size={12} color="inherit" /> : editPaid ? <LockOutlinedIcon sx={{ fontSize: "14px !important" }} /> : null} sx={barButton}>
        {t("status.mode.enter")}
      </Button>
    );
    return editHold ? (
      <Tooltip title={t(editHold)}>
        <span>{enterButton}</span>
      </Tooltip>
    ) : (
      enterButton
    );
  }

  return (
    <>
      <Tooltip title="Ctrl+Z" arrow>
        <span>
          <Button size="small" color="success" onClick={handleUndo} disabled={!(pendingEdits > 0) || undoing} data-testid="edit-undo" startIcon={undoing ? <CircularProgress size={12} color="inherit" /> : null} sx={barButton}>
            {t("status.mode.undo")}
          </Button>
        </span>
      </Tooltip>
      <Tooltip title="Ctrl+Shift+Z" arrow>
        <span>
          <Button size="small" color="info" onClick={handleRedo} disabled={!undoneEdits || redoing} data-testid="edit-redo" startIcon={redoing ? <CircularProgress size={12} color="inherit" /> : null} sx={barButton}>
            {t("status.mode.redo")}
          </Button>
        </span>
      </Tooltip>
      <Button size="small" color="inherit" onClick={handleExitClick} data-testid="edit-mode-exit" sx={barButton}>
        {t("status.mode.exit")}
      </Button>
    </>
  );
}

export function DeliverButton({ silent = false } = {}) {
  const { editing, exportGTFS } = useEditMode();
  const { t } = useLanguage();
  const [exporting, setExporting] = useState(false);
  const [preflightOpen, setPreflightOpenState] = useState(false);
  // A draft is not a version: on its own session, « Livrer » opens its decision (apply it first), never an export.
  const openPreflight = () => {
    if (getDraftSession()) window.dispatchEvent(new CustomEvent(OPEN_DECISION_EVENT));
    else setPreflightOpenState(true);
  };
  // Closing is announced, for a delivery that entered edit mode only to export.
  const setPreflightOpen = (open) => {
    setPreflightOpenState(open);
    if (!open) window.dispatchEvent(new CustomEvent(EXPORT_PREFLIGHT_CLOSED_EVENT));
  };

  useEffect(() => {
    if (!editing) return undefined;
    const handler = () => openPreflight();
    window.addEventListener(OPEN_EXPORT_PREFLIGHT_EVENT, handler);
    return () => window.removeEventListener(OPEN_EXPORT_PREFLIGHT_EVENT, handler);
  }, [editing]);

  useKeyboardShortcut({
    id: "edit.export",
    keys: ["mod+e"],
    description: t("status.deliver"),
    category: "edit",
    when: () => editing,
    handler: (e) => {
      e.preventDefault();
      openPreflight();
    },
  });

  // The preflight stays open while the delivery runs and closes on success only: a refusal of the export itself
  // (503 VALIDATOR_FAILED, 422 VALIDATION_NEW_ERRORS…) is rendered in place (RefusalNotice), never in a snackbar.
  const handlePreflightConfirm = async (_format = "gtfs", options = {}) => {
    setExporting(true);
    try {
      const result = await exportGTFS(options);
      if (result?.ok) setPreflightOpen(false);
      return result;
    } finally {
      setExporting(false);
    }
  };

  const handlePreflightReviewErrors = () => {
    setPreflightOpen(false);
    window.dispatchEvent(new CustomEvent(REVIEW_ERRORS_EVENT));
  };

  // Silent: no button, but the delivery step's « Livrer » opens the preflight through the event above.
  if (silent)
    return editing && preflightOpen ? (
      <Suspense fallback={null}>
        <ExportPreflightDialog open={preflightOpen} onClose={() => setPreflightOpen(false)} onConfirmExport={handlePreflightConfirm} onReviewErrors={handlePreflightReviewErrors} />
      </Suspense>
    ) : null;

  // In reading there is nothing to deliver.
  if (!editing) return null;

  return (
    <>
      <Tooltip title="Ctrl+E" arrow>
        <span>
          <Button size="small" variant="contained" color="success" disableElevation onClick={openPreflight} disabled={exporting} data-testid="edit-export" startIcon={exporting ? <CircularProgress size={12} color="inherit" /> : null} sx={barButton}>
            {t("status.deliver")}
          </Button>
        </span>
      </Tooltip>
      {preflightOpen && (
        <Suspense fallback={null}>
          <ExportPreflightDialog open={preflightOpen} onClose={() => setPreflightOpen(false)} onConfirmExport={handlePreflightConfirm} onReviewErrors={handlePreflightReviewErrors} />
        </Suspense>
      )}
    </>
  );
}

export default EditModeToggle;
