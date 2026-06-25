import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
  CircularProgress,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import SaveAltIcon from "@mui/icons-material/SaveAlt";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import CloseIcon from "@mui/icons-material/Close";
import { useEditMode } from "./EditModeContext";
import { useLanguage } from "./LanguageContext";

/**
 * Universal safeguard against destructive actions in edit mode.
 *
 * Any action that may cause unsaved changes to be lost
 * (uploading a new GTFS, reloading the page, closing the tab, opening
 * another project) must go through `guard(action, options)`.
 *
 *   const { guard } = useDestructiveGuard();
 *   onClick={() => guard(() => doDangerousThing(), { reason: "upload" })}
 *
 * If `pendingEdits === 0` AND the shape editor is not dirty, the action is
 * executed immediately. Otherwise, a modal offers the user:
 *   • Save the project (.gtfsproj) and continue
 *   • Discard the changes and continue
 *   • Cancel
 *
 * Also: intercepts `window.beforeunload` to warn the browser when
 * `pendingEdits > 0`. The custom modal cannot be shown from
 * `beforeunload` (browser limitation), only the native prompt can.
 */

const DestructiveGuardContext = createContext(null);

export function DestructiveGuardProvider({ children }) {
  const { editing, pendingEdits, saveProject, savingProject } = useEditMode();
  const { t } = useLanguage();
  const theme = useTheme();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reason, setReason] = useState(null);
  const pendingActionRef = useRef(null);

  const isDirty = useCallback(() => {
    if (!editing) return false;
    const shapeDirty = Boolean(window.__gtfsShapeEditorDirty);
    return pendingEdits > 0 || shapeDirty;
  }, [editing, pendingEdits]);

  const guard = useCallback(
    async (action, options = {}) => {
      if (!isDirty()) {
        return action();
      }
      pendingActionRef.current = action;
      setReason(options.reason || null);
      setDialogOpen(true);
      // Promise resolved/rejected via the dialog buttons; we don't await here
      // because actions like `window.location.reload()` are fire-and-forget.
      return undefined;
    },
    [isDirty],
  );

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    pendingActionRef.current = null;
    setReason(null);
  }, []);

  const proceed = useCallback(async () => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
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

  const handleSaveAndProceed = useCallback(async () => {
    const ok = await saveProject();
    if (ok) {
      await proceed();
    }
    // If save fails, we keep the modal open (error toast
    // already shown by `saveProject`). The user can retry or
    // choisir "Abandonner".
  }, [saveProject, proceed]);

  // Native browser safeguard: prevents tab close or F5.
  // The custom modal cannot be shown from this hook (browser security),
  // so we fall back to the native "Are you sure?" prompt.
  useEffect(() => {
    if (!editing) return undefined;
    const handler = (e) => {
      if (!isDirty()) return undefined;
      e.preventDefault();
      // Legacy compatibility: some browsers read `returnValue`,
      // others the return value, others just `e.preventDefault`.
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [editing, isDirty]);

  const reasonLabel = reason ? t(`guard.reason.${reason}`) : null;

  return (
    <DestructiveGuardContext.Provider value={{ guard, isDirty }}>
      {children}
      <Dialog
        open={dialogOpen}
        onClose={savingProject ? undefined : closeDialog}
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
            disabled={savingProject}
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
                {pendingEdits}
              </Typography>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography
                  variant="body2"
                  fontWeight={600}
                  sx={{ color: "text.primary", lineHeight: 1.3 }}
                >
                  {t("guard.heroLabel", { count: pendingEdits })}
                </Typography>
                <Typography
                  variant="caption"
                  sx={{ color: "text.secondary", display: "block", mt: 0.25 }}
                >
                  {t("guard.heroSubline")}
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
            disabled={savingProject}
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
            disabled={savingProject}
            startIcon={<DeleteSweepIcon />}
          >
            {t("guard.discard")}
          </Button>
          <Button
            onClick={handleSaveAndProceed}
            variant="contained"
            color="primary"
            disableElevation
            disabled={savingProject}
            autoFocus
            startIcon={
              savingProject ? (
                <CircularProgress size={14} color="inherit" />
              ) : (
                <SaveAltIcon />
              )
            }
            sx={{ fontWeight: 600 }}
          >
            {savingProject ? t("guard.saving") : t("guard.saveAndContinue")}
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
