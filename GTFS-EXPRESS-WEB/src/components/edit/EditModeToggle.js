import React, { Suspense, lazy, useState, useEffect } from "react";
import { Box, Button, CircularProgress, Popover, Tooltip, Typography } from "@mui/material";
import { useDestructiveGuard } from "../../contexts/DestructiveGuardContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import { useKeyboardShortcut } from "../../contexts/ShortcutsContext";
import { openPaywall, paidLockOf, useFeatures } from "../../utils/featuresApi";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
// The export preflight (the validation viewer behind it) loads when it opens: never in the app's first chunk.
const ExportPreflightDialog = lazy(() => import("./ExportPreflightDialog"));

/**
 * EditModeToggle — the edit-mode controls, rendered in the status bar.
 *
 * The status bar (common/StatusBar.js) is the one place that tells the
 * state of the work and offers to act on it (§3.2, D40). This file gives it
 * two of its cases, with the testids the e2e suite drives:
 *
 *   EditModeToggle (default)  the "Mode" case: "Éditer" (`edit-mode-enter`)
 *                             in reading; "Annuler" (`edit-undo`), "Rétablir"
 *                             (`edit-redo`) and "Quitter l'édition"
 *                             (`edit-mode-exit`) in editing — text buttons,
 *                             no icon-only control (RGAA 11.9).
 *   DeliverButton             the "Livrer" case: "Livrer…" (`edit-export`)
 *                             opens the delivery preflight in editing; in
 *                             reading, it opens a panel in place that says
 *                             what delivering takes and offers the two ways
 *                             there (modify the network, or edit it).
 *
 * Entering edit mode asks nothing of its own (the beta access codes were
 * retired on 2026-10-08): under the open model « Éditer » just enters; under
 * the paid offer a person without the licence's "edit" gets the offer, either
 * at once (the features' `access` already says so) or from the server's
 * refusal (402 / 401 `paid`, PAYWALL_EVENT). The shortcuts (Ctrl+E deliver,
 * Ctrl+H history) and the command palette's events (`gtfs:enter-edit-mode`,
 * `gtfs:open-export-preflight`) keep working.
 */

// A status-bar button: text, compact, never upper-cased.
const barButton = { textTransform: "none", fontWeight: 600, fontSize: "0.78rem", minWidth: 0, px: 1, py: 0.25, lineHeight: 1.4, whiteSpace: "nowrap" };

/**
 * `silent`: on a project's steps (UX lot 2, 2026-10-11) the bar shows no toggle — the project's acts are ⑤'s — but
 * the palette's and the steps' events (`gtfs:enter-edit-mode`) must still find their listener: mounted, nothing drawn.
 */
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
  // The paid offer: editing is the subscription's — « Éditer » opens the offer instead of a refusal.
  const editLock = paidLockOf(serverFeatures?.access, "edit");
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

  // Entering edit mode is a single click: every change is undoable and the
  // .gtfsproj / auto-save keep the work safe. The command palette and the
  // status bar's delivery panel dispatch "gtfs:enter-edit-mode" so they
  // follow the same path.
  // Every modification happens in a project (the owner's decision of 2026-10-08: one journal, versions, one delivery):
  // `gtfs:before-edit` lets the app put the network open here in its project first — the one that already works on
  // it, else a new one — synchronously, before edit mode is asked of the same working copy. Held (the reader looking
  // at a simulated draft), nothing is entered: the button says why.
  const handleEnterClick = () => {
    clearError();
    if (editHold) return;
    if (editPaid) {
      openPaywall("edit", editLock);
      return;
    }
    window.dispatchEvent(new CustomEvent("gtfs:before-edit"));
    doEnter();
  };
  useEffect(() => {
    if (editing) return;
    const handler = () => handleEnterClick();
    window.addEventListener("gtfs:enter-edit-mode", handler);
    return () => window.removeEventListener("gtfs:enter-edit-mode", handler);
    // handleEnterClick reads only stable context callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, editPaid, editHold]);

  /** Enter edit mode; a refusal is already said (a toast, or the offer opened by itself). */
  const doEnter = async () => {
    if (entering) return;
    await enterEditMode();
  };

  // Leaving edit mode goes through the unified guard (Cancel / Discard /
  // Save & continue); with nothing dirty, `guard()` runs the action.
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

/**
 * "Livrer…": the delivery preflight in editing (`edit-export`, Ctrl+E, the
 * palette's event); in reading, a panel in place that explains delivering
 * is validating then exporting, with the two ways to get there.
 */
export function DeliverButton({ silent = false } = {}) {
  const { editing, exportGTFS, exportNetex } = useEditMode();
  const { t } = useLanguage();
  const [exporting, setExporting] = useState(false);
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [readAnchor, setReadAnchor] = useState(null);

  // The command palette's "Deliver…" (and Mod+E there) dispatches this event.
  useEffect(() => {
    if (!editing) return undefined;
    const handler = () => setPreflightOpen(true);
    window.addEventListener("gtfs:open-export-preflight", handler);
    return () => window.removeEventListener("gtfs:open-export-preflight", handler);
  }, [editing]);

  useKeyboardShortcut({
    id: "edit.export",
    keys: ["mod+e"],
    description: t("status.deliver"),
    category: "edit",
    when: () => editing,
    handler: (e) => {
      e.preventDefault();
      setPreflightOpen(true);
    },
  });

  // The preflight stays open while the delivery runs: it closes on success only, and a refusal of the
  // export itself (503 VALIDATOR_FAILED, 422 VALIDATION_NEW_ERRORS…) is returned to it and rendered in
  // place (RefusalNotice), never in a snackbar (§7.2, §10).
  const handlePreflightConfirm = async (format = "gtfs", options = {}) => {
    setExporting(true);
    try {
      const result = format === "netex" ? await exportNetex() : await exportGTFS(options);
      if (result?.ok) setPreflightOpen(false);
      return result;
    } finally {
      setExporting(false);
    }
  };

  const handlePreflightReviewErrors = () => {
    setPreflightOpen(false);
    window.dispatchEvent(new CustomEvent("gtfs:review-errors"));
  };

  // Silent (a project's steps, UX lot 2): no button, but ⑤'s « Livrer » opens the preflight by the event above —
  // the dialog alone is mounted, in edit mode.
  if (silent)
    return editing && preflightOpen ? (
      <Suspense fallback={null}>
        <ExportPreflightDialog open={preflightOpen} onClose={() => setPreflightOpen(false)} onConfirmExport={handlePreflightConfirm} onReviewErrors={handlePreflightReviewErrors} />
      </Suspense>
    ) : null;

  if (!editing) {
    const go = (event) => {
      setReadAnchor(null);
      window.dispatchEvent(new CustomEvent(event));
    };
    return (
      <>
        <Button size="small" variant="text" onClick={(e) => setReadAnchor(e.currentTarget)} aria-haspopup="dialog" aria-expanded={Boolean(readAnchor)} data-testid="status-deliver-read" sx={barButton}>
          {t("status.deliver")}
        </Button>
        <Popover
          open={Boolean(readAnchor)}
          anchorEl={readAnchor}
          onClose={() => setReadAnchor(null)}
          anchorOrigin={{ vertical: "top", horizontal: "center" }}
          transformOrigin={{ vertical: "bottom", horizontal: "center" }}
          slotProps={{ paper: { role: "dialog", "aria-labelledby": "status-deliver-read-title", sx: { p: 1.5, maxWidth: 340 } } }}
        >
          <Box data-testid="status-deliver-panel" sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <Typography id="status-deliver-read-title" sx={{ fontWeight: 700, fontSize: "0.85rem" }}>
              {t("status.deliver")}
            </Typography>
            <Typography sx={{ fontSize: "0.8rem", lineHeight: 1.5 }}>{t("status.deliver.read")}</Typography>
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
              <Button size="small" variant="contained" disableElevation onClick={() => go("gtfs:open-change-studio")} sx={{ textTransform: "none", fontWeight: 700 }}>
                {t("delivery.modifyNetwork")}
              </Button>
              <Button size="small" variant="outlined" onClick={() => go("gtfs:enter-edit-mode")} sx={{ textTransform: "none", fontWeight: 700 }}>
                {t("status.mode.enter")}
              </Button>
            </Box>
          </Box>
        </Popover>
      </>
    );
  }

  return (
    <>
      <Tooltip title="Ctrl+E" arrow>
        <span>
          <Button size="small" variant="contained" color="success" disableElevation onClick={() => setPreflightOpen(true)} disabled={exporting} data-testid="edit-export" startIcon={exporting ? <CircularProgress size={12} color="inherit" /> : null} sx={barButton}>
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
