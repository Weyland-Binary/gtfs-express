import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  Stack,
  Divider,
  IconButton,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import UndoIcon from "@mui/icons-material/Undo";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import CloseIcon from "@mui/icons-material/Close";
import { useEditMode } from "./EditModeContext";
import { useLanguage } from "./LanguageContext";
import { countWords } from "../utils/countWords";

/**
 * Every action that may lose unsaved edits (a new upload, a reload, the demo) goes through
 * `guard(action, { reason })`: it runs at once when nothing is dirty, else after the person agrees to discard.
 * `reason` names a `guard.reason.*` text; `reasonKey` any text. `scope: "view"` asks only for the work in progress of
 * a view (a shape drawn on the map, in no edit log yet), which a view change loses while the session's edits stay;
 * a view registers it with `setDirty(key, bool)`. A form's unsaved input is registered with `useUnsavedForm`: the
 * detail panel stays open across views, so a view change never asks for it, while what replaces the page or the
 * network does; `scope: "form"` with the form's `key` asks for that form alone, as a dialog closed by Escape does
 * (`useFormClose`), and without a key for any form (what closes or replaces the detail panel drops the one it holds). `onCancel` runs when the person keeps their work. `ask: { count, titleKey, labelKey, acceptKey }`
 * asks for the act itself, whatever is unsaved, in the same dialog with its own figure and words (going back in the
 * journal undoes `count` edits): `labelKey` has a `.one` and a `.many` text.
 */

const DestructiveGuardContext = createContext(null);

export function DestructiveGuardProvider({ children }) {
  const { editing, unsavedChanges } = useEditMode();
  const { t } = useLanguage();
  const theme = useTheme();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reason, setReason] = useState(null);
  // What the dialog counts: the session's edits, the views' work in progress and the forms being filled in.
  const [dirtyCount, setDirtyCount] = useState(0);
  // The words of an act asked for itself; null for the unsaved-changes question.
  const [ask, setAsk] = useState(null);
  const pendingRef = useRef(null);

  // The views' work in progress, by key; `window.__gtfsShapeEditorDirty` is read too for the map editor's older flag.
  // The forms' unsaved input is kept apart: no view change loses it.
  const dirtyViewsRef = useRef(new Map());
  const dirtyFormsRef = useRef(new Map());
  const setDirty = useCallback((key, dirty, scope = "view") => {
    const kept = scope === "form" ? dirtyFormsRef.current : dirtyViewsRef.current;
    if (dirty) kept.set(key, true);
    else kept.delete(key);
  }, []);
  const viewDirtyCount = () => Math.max(dirtyViewsRef.current.size, window.__gtfsShapeEditorDirty ? 1 : 0);
  const formDirtyCount = () => dirtyFormsRef.current.size;
  const isViewDirty = useCallback(() => editing && viewDirtyCount() > 0, [editing]);
  const isFormDirty = useCallback(() => formDirtyCount() > 0, []);

  // Changes since the last export or frozen version (not the undo depth, which never returns to zero),
  // an unsaved shape in the map editor, or a form being filled in.
  const isDirty = useCallback(() => {
    if (!editing) return false;
    return unsavedChanges > 0 || viewDirtyCount() > 0 || formDirtyCount() > 0;
  }, [editing, unsavedChanges]);

  const guard = useCallback(
    async (action, options = {}) => {
      const view = options.scope === "view";
      const form = options.scope === "form";
      const asked = options.ask && options.ask.count > 0 ? options.ask : null;
      const formDirty = () => (options.key == null ? formDirtyCount() > 0 : dirtyFormsRef.current.has(options.key));
      if (!asked && !(form ? formDirty() : view ? isViewDirty() : isDirty())) {
        return action();
      }
      pendingRef.current = { action, onCancel: options.onCancel || null };
      setReason(options.reasonKey || (options.reason ? `guard.reason.${options.reason}` : null));
      setDirtyCount(asked ? asked.count : form ? 1 : view ? viewDirtyCount() : unsavedChanges + viewDirtyCount() + formDirtyCount());
      setAsk(asked);
      setDialogOpen(true);
      // Not awaited: actions like `window.location.reload()` never settle.
      return undefined;
    },
    [isDirty, isViewDirty, unsavedChanges],
  );

  const closeDialog = useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setDialogOpen(false);
    setReason(null);
    pending?.onCancel?.();
  }, []);

  const proceed = useCallback(async () => {
    const action = pendingRef.current?.action;
    pendingRef.current = null;
    setDialogOpen(false);
    setReason(null);
    if (action) {
      try {
        await action();
      } catch (err) {
        console.error("Destructive action failed:", err);
      }
    }
  }, []);

  // A page unload can only show the browser's native prompt, never this dialog.
  useEffect(() => {
    if (!editing) return undefined;
    const handler = (e) => {
      if (!isDirty()) return undefined;
      e.preventDefault();
      // Browsers differ: some read `returnValue`, some the return value, some only preventDefault.
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [editing, isDirty]);

  const reasonLabel = reason ? t(reason) : null;

  // Stable across the dialog's state, so opening it does not re-render every guard() caller.
  const value = useMemo(() => ({ guard, isDirty, isViewDirty, isFormDirty, setDirty }), [guard, isDirty, isViewDirty, isFormDirty, setDirty]);

  return (
    <DestructiveGuardContext.Provider value={value}>
      {children}
      <Dialog
        open={dialogOpen}
        onClose={closeDialog}
        maxWidth="sm"
        fullWidth
        PaperProps={{
          elevation: 8,
          sx: {
            borderTop: `4px solid ${theme.palette.warning.main}`,
            borderRadius: 2,
            overflow: "hidden",
          },
        }}
      >
        <DialogTitle
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1.5,
            pr: 1.5,
            pb: 1.5,
          }}
        >
          <Box
            sx={{
              width: 40,
              height: 40,
              borderRadius: 1.5,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: alpha(theme.palette.warning.main, 0.16),
              color: theme.palette.warning.main,
            }}
          >
            <WarningAmberIcon sx={{ fontSize: 22 }} />
          </Box>
          <Typography
            variant="h6"
            component="span"
            fontWeight={700}
            sx={{ flex: 1, minWidth: 0, lineHeight: 1.2 }}
            noWrap
          >
            {t(ask?.titleKey || "guard.title")}
          </Typography>
          <IconButton
            size="small"
            onClick={closeDialog}
            aria-label={t("app.cancel")}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>
        <Divider />
        <DialogContent sx={{ pt: 2.5, pb: 2.5 }}>
          <Stack spacing={2}>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1.75,
                p: 1.75,
                borderRadius: 1.5,
                background: alpha(theme.palette.warning.main, 0.08),
                border: `1px solid ${alpha(theme.palette.warning.main, 0.28)}`,
              }}
            >
              <Typography
                data-testid="guard-count"
                sx={{
                  fontSize: 32,
                  fontWeight: 700,
                  lineHeight: 1,
                  color: theme.palette.warning.main,
                  fontVariantNumeric: "tabular-nums",
                  minWidth: 36,
                  textAlign: "center",
                }}
              >
                {dirtyCount}
              </Typography>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography
                  variant="body2"
                  fontWeight={600}
                  sx={{ color: "text.primary", lineHeight: 1.3 }}
                >
                  {ask ? countWords(t, ask.labelKey, dirtyCount) : t("guard.heroLabel", { count: dirtyCount })}
                </Typography>
              </Box>
            </Box>
            {reasonLabel && (
              <Box
                sx={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 1,
                  p: 1.25,
                  borderRadius: 1,
                  border: `1px solid ${theme.palette.divider}`,
                  background: alpha(theme.palette.text.primary, 0.02),
                }}
              >
                <InfoOutlinedIcon
                  sx={{
                    fontSize: 18,
                    color: theme.palette.text.secondary,
                    mt: "1px",
                    flexShrink: 0,
                  }}
                />
                <Typography
                  variant="body2"
                  sx={{ color: "text.secondary", lineHeight: 1.5 }}
                >
                  {reasonLabel}
                </Typography>
              </Box>
            )}
          </Stack>
        </DialogContent>
        <Divider />
        <DialogActions
          sx={{
            px: 3,
            py: 2,
            gap: 1,
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            flexWrap: "wrap",
            "& .MuiButton-root": {
              height: 38,
              minWidth: 0,
              px: 2,
              textTransform: "none",
              fontSize: "0.875rem",
              fontWeight: 500,
              borderRadius: 1,
              whiteSpace: "nowrap",
            },
            "& .MuiButton-startIcon": {
              mr: 0.75,
            },
            "& .MuiButton-startIcon > *:nth-of-type(1)": {
              fontSize: 18,
            },
          }}
        >
          <Button
            onClick={closeDialog}
            variant="text"
            autoFocus
            sx={{
              mr: "auto",
              color: "text.secondary",
              "&:hover": { background: alpha(theme.palette.text.primary, 0.06) },
            }}
          >
            {t("app.cancel")}
          </Button>
          <Button
            onClick={proceed}
            variant="outlined"
            color={ask ? "warning" : "error"}
            startIcon={ask ? <UndoIcon /> : <DeleteSweepIcon />}
          >
            {t(ask?.acceptKey || "guard.discard")}
          </Button>
        </DialogActions>
      </Dialog>
    </DestructiveGuardContext.Provider>
  );
}

/**
 * Says a form's unsaved input to the guard for as long as `dirty` lasts, and returns `leave(action)`: `action` (what
 * drops the form) runs once the person agrees, at once when nothing is typed. A form rendered outside the provider
 * says nothing and leaves at once.
 */
export function useUnsavedForm(key, dirty) {
  const ctx = useContext(DestructiveGuardContext);
  const setDirty = ctx?.setDirty;
  const guard = ctx?.guard;
  useEffect(() => {
    if (!setDirty || !dirty) return undefined;
    setDirty(key, true, "form");
    return () => setDirty(key, false, "form");
  }, [setDirty, key, dirty]);
  return useCallback((action) => (guard && dirty ? guard(action, { scope: "form", key, reason: "leaveForm" }) : action()), [guard, dirty, key]);
}

/**
 * The `onClose` of a form dialog: nothing while it is `busy` saving; with something typed, a click outside is ignored
 * and Escape asks first; its own buttons, which call `onClose` themselves, close at once.
 */
export function useFormClose(key, { dirty, busy = false, onClose }) {
  const leave = useUnsavedForm(key, dirty);
  return useCallback(
    (_event, reason) => {
      if (busy) return;
      if (reason === "backdropClick" && dirty) return;
      if (reason === "escapeKeyDown") leave(onClose);
      else onClose();
    },
    [busy, dirty, leave, onClose],
  );
}

const atOnce = (action) => action();
const never = () => false;

/** `guard` where the provider stands; a component rendered alone runs its acts at once. */
export function useGuard() {
  return useContext(DestructiveGuardContext)?.guard || atOnce;
}

/** `isFormDirty()`: whether a form holds unsaved input right now; never, for a component rendered alone. */
export function useFormDirty() {
  return useContext(DestructiveGuardContext)?.isFormDirty || never;
}

export function useDestructiveGuard() {
  const ctx = useContext(DestructiveGuardContext);
  if (!ctx) {
    throw new Error(
      "useDestructiveGuard must be used within a DestructiveGuardProvider",
    );
  }
  return ctx;
}
