import React, { useState, useEffect, useMemo } from "react";
import {
  Button,
  IconButton,
  Tooltip,
  Badge,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  CircularProgress,
  Box,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Typography,
  Alert,
  Fade,
} from "@mui/material";
import { useDestructiveGuard } from "../../contexts/DestructiveGuardContext";
import { alpha, useTheme, keyframes } from "@mui/material/styles";
import EditIcon from "@mui/icons-material/Edit";
import PersonIcon from "@mui/icons-material/Person";
import UndoIcon from "@mui/icons-material/Undo";
import RedoIcon from "@mui/icons-material/Redo";
import HistoryIcon from "@mui/icons-material/History";
import DownloadIcon from "@mui/icons-material/Download";
import CloseIcon from "@mui/icons-material/Close";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import ExportPreflightDialog from "./ExportPreflightDialog";
import BetaGateDialog from "./BetaGateDialog";

/**
 * Recognises a "beta gate" error in the structured return of `enterEditMode`.
 * Covers the 4 typed codes (`BETA_CODE_REQUIRED`, `INVALID_BETA_CODE`,
 * `BETA_REVOKED`, `BETA_CONFIG_ERROR`).
 */
const BETA_GATE_ERROR_CODES = new Set([
  "BETA_CODE_REQUIRED",
  "INVALID_BETA_CODE",
  "BETA_REVOKED",
  "BETA_CONFIG_ERROR",
]);

const isBetaGateError = (result) =>
  Boolean(
    result &&
      result.ok === false &&
      result.errorCode &&
      BETA_GATE_ERROR_CODES.has(result.errorCode),
  );

/**
 * Displayed in the Header.
 *
 * Outside edit mode: a single "Edit mode" button (pencil icon).
 * In edit mode: a compact control group
 *     [chip pending] [Undo] [Export] [Exit]
 */
function EditModeToggle() {
  const {
    editing,
    entering,
    pendingEdits,
    undoneEdits,
    error,
    enterEditMode,
    exitEditMode,
    undoLast,
    redoLast,
    exportGTFS,
    exportNetex,
    clearError,
    betaTester,
  } = useEditMode();
  const { t } = useLanguage();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const pulse = useMemo(
    () => keyframes`
      0%   { box-shadow: 0 0 0 0   ${alpha(theme.palette.success.main, 0.5)}; }
      70%  { box-shadow: 0 0 0 8px ${alpha(theme.palette.success.main, 0)};   }
      100% { box-shadow: 0 0 0 0   ${alpha(theme.palette.success.main, 0)};   }
    `,
    [theme.palette.success.main],
  );
  const { openPanel, entity: currentPanel } = useDetailPanel();
  const { guard } = useDestructiveGuard();

  const [confirmEnter, setConfirmEnter] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [redoing, setRedoing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [preflightOpen, setPreflightOpen] = useState(false);
  // Anchor element for the SplitButton's overflow menu (Redo + History).
  const [moreAnchor, setMoreAnchor] = useState(null);
  // Beta gate dialog: opened when the server responds 403 BETA_*
  // (no code in localStorage OR invalid/revoked code).
  const [betaGateOpen, setBetaGateOpen] = useState(false);
  const [betaGateInitialError, setBetaGateInitialError] = useState(null);

  // Listen for the custom event dispatched by CommandPalette (Mod+E shortcut)
  useEffect(() => {
    if (!editing) return;
    const handler = () => setPreflightOpen(true);
    window.addEventListener("gtfs:open-export-preflight", handler);
    return () => window.removeEventListener("gtfs:open-export-preflight", handler);
  }, [editing]);

  const handleEnterClick = () => {
    clearError();
    setConfirmEnter(true);
  };

  /**
   * Attempts to enter edit mode. The `enterEditMode` context automatically
   * reads `localStorage.gtfs_beta_code` if no code is provided.
   *
   * On 403 BETA_* → close the confirmation modal and open
   * the BetaGateDialog with the pre-filled error.
   */
  const doEnter = async () => {
    setConfirmEnter(false);
    const result = await enterEditMode();
    if (isBetaGateError(result)) {
      setBetaGateInitialError({
        code: result.errorCode,
        message: result.message,
      });
      setBetaGateOpen(true);
    }
  };

  /**
   * BetaGateDialog submit handler. The code is passed explicitly to
   * `enterEditMode` (not via localStorage — the modal handles its own
   * persistence after success, see BetaGateDialog.handleSubmit).
   */
  const handleBetaSubmit = async (code) => {
    const result = await enterEditMode(code);
    if (result?.ok) {
      setBetaGateInitialError(null);
      return { ok: true };
    }
    return {
      ok: false,
      errorCode: result?.errorCode || "INVALID_BETA_CODE",
      message: result?.message,
    };
  };

  // Exiting edit mode: goes through the unified `useDestructiveGuard` modal
  // (Cancel / Discard / Save & continue). When nothing is dirty,
  // `guard()` executes the action directly.
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

  const handleExport = () => {
    setPreflightOpen(true);
  };

  const handlePreflightConfirm = async (format = "gtfs") => {
    setPreflightOpen(false);
    setExporting(true);
    try {
      if (format === "netex") await exportNetex();
      else await exportGTFS();
    } finally {
      setExporting(false);
    }
  };

  const handlePreflightReviewErrors = () => {
    setPreflightOpen(false);
    window.dispatchEvent(new CustomEvent("gtfs:review-errors"));
  };

  // ── Outside edit mode: a single button ──────────────────────────────────────────────────
  if (!editing) {
    return (
      <>
        <Tooltip title={t("edit.enterTooltip")} arrow>
          <span>
            <IconButton
              onClick={handleEnterClick}
              disabled={entering}
              size="small"
              data-testid="edit-mode-enter"
              aria-label={t("edit.enterTooltip")}
              sx={{
                padding: 1,
                borderRadius: 2.5,
                backgroundColor: alpha(
                  theme.palette.warning.main,
                  isDark ? 0.15 : 0.1,
                ),
                color: theme.palette.warning.main,
                "&:hover": {
                  backgroundColor: alpha(
                    theme.palette.warning.main,
                    isDark ? 0.25 : 0.18,
                  ),
                  transform: "scale(1.05)",
                },
                transition: "all 0.2s ease-in-out",
              }}
            >
              {entering ? (
                <CircularProgress size={18} color="inherit" />
              ) : (
                <EditIcon sx={{ fontSize: 20 }} />
              )}
            </IconButton>
          </span>
        </Tooltip>

        <Dialog
          open={confirmEnter}
          onClose={() => setConfirmEnter(false)}
          maxWidth="xs"
          fullWidth
          PaperProps={{
            sx: {
              borderTop: `3px solid ${theme.palette.warning.main}`,
              borderRadius: 2,
            },
          }}
        >
          <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
            <Box
              sx={{
                width: 36,
                height: 36,
                borderRadius: 1.5,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: alpha(theme.palette.warning.main, 0.14),
                color: theme.palette.warning.main,
              }}
            >
              <EditIcon sx={{ fontSize: 20 }} />
            </Box>
            <Typography variant="h6" fontWeight={700}>
              {t("edit.confirmEnterTitle")}
            </Typography>
          </DialogTitle>
          <DialogContent>
            <Typography variant="body2" color="text.secondary">
              {t("edit.confirmEnterBody")}
            </Typography>
            {error && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {error}
              </Alert>
            )}
          </DialogContent>
          <DialogActions sx={{ px: 3, py: 1.5 }}>
            <Button
              onClick={() => setConfirmEnter(false)}
              color="inherit"
              disabled={entering}
            >
              {t("app.cancel")}
            </Button>
            <Button
              onClick={doEnter}
              variant="contained"
              color="warning"
              disabled={entering}
              data-testid="edit-mode-enter-confirm"
              startIcon={
                entering ? <CircularProgress size={14} color="inherit" /> : null
              }
            >
              {entering ? t("edit.migrating") : t("edit.enterAction")}
            </Button>
          </DialogActions>
        </Dialog>

        <BetaGateDialog
          open={betaGateOpen}
          onClose={() => setBetaGateOpen(false)}
          onSubmit={handleBetaSubmit}
          initialError={betaGateInitialError}
        />
      </>
    );
  }

  // ── In edit mode: compact control group ────────────────────────────────────────────────────────
  // Layout (left → right):
  //   [edit-status: pencil + numeric Badge + identity tooltip]
  //   [Undo · ▼-chevron → Menu(Redo, History)]
  //   [Export]  [Exit]
  // Avoids two large Chips and three separate IconButtons (Undo/Redo/History)
  // — saves ~300 px vs. the old layout while keeping every action reachable.
  const hasPending = pendingEdits > 0;

  // Tooltip body for the status indicator: pending count (or "Editing")
  // on line 1, beta-tester identity on line 2 when applicable.
  const statusTooltip = (
    <Box>
      <Typography
        variant="caption"
        sx={{ fontWeight: 700, display: "block", lineHeight: 1.4 }}
      >
        {hasPending
          ? t("edit.pendingTooltip", { count: pendingEdits })
          : t("edit.editingBadge")}
      </Typography>
      {betaTester && (
        <Typography
          variant="caption"
          sx={{
            opacity: 0.9,
            display: "block",
            mt: 0.25,
            lineHeight: 1.4,
          }}
        >
          {t("beta.identityTooltip", {
            email: betaTester.email || "",
            label: betaTester.label || "",
          })}
        </Typography>
      )}
    </Box>
  );

  const closeMore = () => setMoreAnchor(null);

  return (
    <>
      <Fade in timeout={220}>
        <Box
          display="flex"
          alignItems="center"
          gap={0.25}
          sx={{
            px: 0.75,
            py: 0.25,
            borderRadius: 2.5,
            background: alpha(theme.palette.success.main, isDark ? 0.14 : 0.07),
            border: `1px solid ${alpha(
              theme.palette.success.main,
              isDark ? 0.38 : 0.24,
            )}`,
            boxShadow: isDark
              ? `0 0 0 1px ${alpha(theme.palette.success.main, 0.07)} inset`
              : "none",
            transition: "all 0.25s ease",
          }}
        >
          {/* Status indicator — non-interactive, pulses while there are pending edits */}
          <Tooltip title={statusTooltip} arrow>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 28,
                height: 28,
                borderRadius: 1.5,
                color: theme.palette.success.main,
                cursor: "default",
                animation: hasPending
                  ? `${pulse} 2.2s ease-out infinite`
                  : "none",
              }}
            >
              <Badge
                badgeContent={hasPending ? pendingEdits : null}
                color="warning"
                max={99}
                overlap="circular"
                sx={{
                  "& .MuiBadge-badge": {
                    fontSize: "0.62rem",
                    fontWeight: 700,
                    minWidth: 16,
                    height: 16,
                    padding: "0 4px",
                    right: 2,
                    top: 2,
                  },
                }}
              >
                <PersonIcon sx={{ fontSize: 18 }} />
              </Badge>
            </Box>
          </Tooltip>

          {/* Undo — primary action of the SplitButton pair */}
          <Tooltip title={`${t("edit.undoTooltip")} · Ctrl+Z`} arrow>
            <span>
              <IconButton
                size="small"
                onClick={handleUndo}
                disabled={!hasPending || undoing}
                data-testid="edit-undo"
                aria-label={t("edit.undoTooltip")}
                sx={{
                  color: theme.palette.success.main,
                  transition: "transform 0.15s ease",
                  "&:hover:not(.Mui-disabled)": {
                    transform: "rotate(-15deg)",
                    background: alpha(theme.palette.success.main, 0.12),
                  },
                }}
              >
                {undoing ? (
                  <CircularProgress size={16} color="inherit" />
                ) : (
                  <UndoIcon sx={{ fontSize: 18 }} />
                )}
              </IconButton>
            </span>
          </Tooltip>

          {/* Chevron — opens the overflow menu (Redo + History). Visually
              attached to the Undo button by negative left margin so the pair
              reads as a single SplitButton. Dot badge signals available redo. */}
          <Tooltip title={t("edit.moreActionsTooltip")} arrow>
            <IconButton
              size="small"
              onClick={(e) => setMoreAnchor(e.currentTarget)}
              aria-label={t("edit.moreActionsTooltip")}
              sx={{
                ml: -0.5,
                padding: "2px",
                color: theme.palette.text.secondary,
                "&:hover": {
                  background: alpha(theme.palette.success.main, 0.1),
                  color: theme.palette.success.main,
                },
              }}
            >
              <Badge
                variant="dot"
                color="info"
                invisible={!undoneEdits}
                sx={{ "& .MuiBadge-dot": { width: 6, height: 6, minWidth: 6 } }}
              >
                <ArrowDropDownIcon sx={{ fontSize: 18 }} />
              </Badge>
            </IconButton>
          </Tooltip>

          <Tooltip title={`${t("edit.exportTooltip")} · Ctrl+E`} arrow>
            <span>
              <IconButton
                size="small"
                onClick={handleExport}
                disabled={exporting}
                data-testid="edit-export"
                aria-label={t("edit.exportTooltip")}
                sx={{
                  color: theme.palette.success.main,
                  transition: "transform 0.15s ease",
                  "&:hover:not(.Mui-disabled)": {
                    transform: "translateY(1px)",
                    background: alpha(theme.palette.success.main, 0.12),
                  },
                }}
              >
                {exporting ? (
                  <CircularProgress size={16} color="inherit" />
                ) : (
                  <DownloadIcon sx={{ fontSize: 18 }} />
                )}
              </IconButton>
            </span>
          </Tooltip>

          <Tooltip title={t("edit.exitTooltip")} arrow>
            <IconButton
              size="small"
              onClick={handleExitClick}
              data-testid="edit-mode-exit"
              aria-label={t("edit.exitTooltip")}
              sx={{
                color: theme.palette.text.secondary,
                transition: "transform 0.15s ease",
                "&:hover": {
                  transform: "rotate(90deg)",
                  color: theme.palette.error.main,
                  background: alpha(theme.palette.error.main, 0.08),
                },
              }}
            >
              <CloseIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Fade>

      <Menu
        anchorEl={moreAnchor}
        open={Boolean(moreAnchor)}
        onClose={closeMore}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        MenuListProps={{ dense: true }}
      >
        <MenuItem
          onClick={async () => {
            closeMore();
            await handleRedo();
          }}
          disabled={!undoneEdits || redoing}
        >
          <ListItemIcon>
            {redoing ? (
              <CircularProgress size={16} />
            ) : (
              <RedoIcon
                fontSize="small"
                sx={{ color: theme.palette.info.main }}
              />
            )}
          </ListItemIcon>
          <ListItemText
            primary={t("edit.redoTooltip")}
            secondary="Ctrl+Shift+Z"
            secondaryTypographyProps={{ sx: { fontSize: "0.68rem", opacity: 0.55 } }}
          />
        </MenuItem>
        <MenuItem
          onClick={() => {
            closeMore();
            openPanel("edit_history", "history");
          }}
        >
          <ListItemIcon>
            <HistoryIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("editHistory.openTooltip")}</ListItemText>
        </MenuItem>
      </Menu>

      <ExportPreflightDialog
        open={preflightOpen}
        onClose={() => setPreflightOpen(false)}
        onConfirmExport={handlePreflightConfirm}
        onReviewErrors={handlePreflightReviewErrors}
      />

    </>
  );
}

export default EditModeToggle;
