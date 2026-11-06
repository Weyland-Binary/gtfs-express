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
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import CloseIcon from "@mui/icons-material/Close";
import { useEditMode } from "./EditModeContext";
import { useLanguage } from "./LanguageContext";

/**
 * Every action that may lose unsaved edits (a new upload, a reload, the demo) goes through
 * `guard(action, { reason })`: it runs at once when nothing is dirty, else after the person agrees to discard.
 * `reason` names a `guard.reason.*` text; `reasonKey` any text. `scope: "view"` asks only for the work in progress of
 * a view (a shape drawn on the map, in no edit log yet), which a view change loses while the session's edits stay;
 * a view registers it with `setDirty(key, bool)`. `onCancel` runs when the person keeps their work.
 */

const DestructiveGuardContext = createContext(null);

export function DestructiveGuardProvider({ children }) {
  const { editing, unsavedChanges } = useEditMode();
  const { t } = useLanguage();
  const theme = useTheme();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reason, setReason] = useState(null);
  // What the dialog counts: the session's edits, and the views' work in progress.
  const [dirtyCount, setDirtyCount] = useState(0);
  const pendingRef = useRef(null);

  // The views' work in progress, by key; `window.__gtfsShapeEditorDirty` is read too for the map editor's older flag.
  const dirtyViewsRef = useRef(new Map());
  const setDirty = useCallback((key, dirty) => {
    if (dirty) dirtyViewsRef.current.set(key, true);
    else dirtyViewsRef.current.delete(key);
  }, []);
  const viewDirtyCount = () => Math.max(dirtyViewsRef.current.size, window.__gtfsShapeEditorDirty ? 1 : 0);
  const isViewDirty = useCallback(() => editing && viewDirtyCount() > 0, [editing]);

  // Changes since the last export or frozen version (not the undo depth, which never returns to zero),
  // or an unsaved shape in the map editor.
  const isDirty = useCallback(() => {
    if (!editing) return false;
    return unsavedChanges > 0 || viewDirtyCount() > 0;
  }, [editing, unsavedChanges]);

  const guard = useCallback(
    async (action, options = {}) => {
      const view = options.scope === "view";
      if (!(view ? isViewDirty() : isDirty())) {
        return action();
      }
      pendingRef.current = { action, onCancel: options.onCancel || null };
      setReason(options.reasonKey || (options.reason ? `guard.reason.${options.reason}` : null));
      setDirtyCount(view ? viewDirtyCount() : unsavedChanges + viewDirtyCount());
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
  const value = useMemo(() => ({ guard, isDirty, isViewDirty, setDirty }), [guard, isDirty, isViewDirty, setDirty]);

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
            fontWeight={700}
            sx={{ flex: 1, minWidth: 0, lineHeight: 1.2 }}
            noWrap
          >
            {t("guard.title")}
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
                  {t("guard.heroLabel", { count: dirtyCount })}
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
            color="error"
            startIcon={<DeleteSweepIcon />}
          >
            {t("guard.discard")}
          </Button>
        </DialogActions>
      </Dialog>
    </DestructiveGuardContext.Provider>
  );
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
