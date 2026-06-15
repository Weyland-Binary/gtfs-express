import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Divider,
  IconButton,
  Tooltip,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  LinearProgress,
  Alert,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import SaveIcon from "@mui/icons-material/Save";
import RestoreIcon from "@mui/icons-material/Restore";
import CloudDoneIcon from "@mui/icons-material/CloudDone";
import SyncProblemIcon from "@mui/icons-material/SyncProblem";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ArticleOutlinedIcon from "@mui/icons-material/ArticleOutlined";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import { PROJECT_EXT } from "../../utils/projectFile";
import {
  listSnapshots,
  getSnapshotBlob,
  deleteSnapshot,
} from "../../utils/projectAutoSave";
import BetaGateDialog from "./BetaGateDialog";

/**
 * ProjectMenu — Discreet "File" menu displayed in the header next to
 * the edit button. Exposes:
 *   • Save as…        → downloads a .gtfsproj (VACUUM INTO on the server)
 *   • Open…           → file picker → upload .gtfsproj → swap atomique
 *   • Recover recent  → lists IndexedDB snapshots from past sessions
 *
 * Always visible (outside / in edit mode), because "Open" must work
 * even outside edit mode to start a project from a file.
 */
function ProjectMenu() {
  const {
    editing,
    savingProject,
    openingProject,
    projectMeta,
    lastAutoSaveAt,
    saveProject,
    openProject,
    showToast,
  } = useEditMode();
  const { t } = useLanguage();
  const { openPanel } = useDetailPanel();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";

  const [anchorEl, setAnchorEl] = useState(null);
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [snapshots, setSnapshots] = useState([]);
  const [progress, setProgress] = useState(null); // % when opening large file
  const fileInputRef = useRef(null);
  // Beta gate retry state (see GTFSUploader.js — same pattern)
  const [betaGateOpen, setBetaGateOpen] = useState(false);
  const [betaGateInitialError, setBetaGateInitialError] = useState(null);
  const [pendingProjectFile, setPendingProjectFile] = useState(null);

  const open = Boolean(anchorEl);

  const handleOpenMenu = (e) => setAnchorEl(e.currentTarget);
  const handleCloseMenu = () => setAnchorEl(null);

  const handleSaveClick = useCallback(async () => {
    handleCloseMenu();
    await saveProject();
  }, [saveProject]);

  const handleOpenClick = () => {
    handleCloseMenu();
    if (fileInputRef.current) fileInputRef.current.click();
  };

  const handleFileSelected = useCallback(
    async (e) => {
      const file = e.target.files && e.target.files[0];
      // Reset so selecting the same file twice still triggers onChange
      e.target.value = "";
      if (!file) return;
      setProgress(0);
      try {
        const result = await openProject(file, (p) => setProgress(p));
        if (
          !result?.ok &&
          result?.errorCode &&
          (result.errorCode.startsWith("BETA_") ||
            result.errorCode === "INVALID_BETA_CODE")
        ) {
          setPendingProjectFile(file);
          setBetaGateInitialError({
            code: result.errorCode,
            message: result.message,
          });
          setBetaGateOpen(true);
        }
      } finally {
        setProgress(null);
      }
    },
    [openProject],
  );

  const handleBetaSubmitForOpenProject = useCallback(
    async (code) => {
      if (!pendingProjectFile) {
        return { ok: false, errorCode: "INVALID_BETA_CODE" };
      }
      setProgress(0);
      try {
        const result = await openProject(
          pendingProjectFile,
          (p) => setProgress(p),
          code,
        );
        if (result?.ok) {
          setPendingProjectFile(null);
          return { ok: true };
        }
        return {
          ok: false,
          errorCode: result?.errorCode || "INVALID_BETA_CODE",
          message: result?.message,
        };
      } finally {
        setProgress(null);
      }
    },
    [openProject, pendingProjectFile],
  );

  const handleRecoverClick = useCallback(async () => {
    handleCloseMenu();
    try {
      const rows = await listSnapshots();
      setSnapshots(rows);
      setRecoverOpen(true);
    } catch (err) {
      showToast(err.message || "Could not list snapshots", "error");
    }
  }, [showToast]);

  const handleRestoreSnapshot = useCallback(
    async (id) => {
      const blob = await getSnapshotBlob(id);
      if (!blob) {
        showToast(t("project.snapshotMissing") || "Snapshot unavailable", "error");
        return;
      }
      setRecoverOpen(false);
      const file = new File([blob], `recovered-${Date.now()}${PROJECT_EXT}`, {
        type: "application/octet-stream",
      });
      const result = await openProject(file);
      if (
        !result?.ok &&
        result?.errorCode &&
        (result.errorCode.startsWith("BETA_") ||
          result.errorCode === "INVALID_BETA_CODE")
      ) {
        setPendingProjectFile(file);
        setBetaGateInitialError({
          code: result.errorCode,
          message: result.message,
        });
        setBetaGateOpen(true);
      }
    },
    [openProject, showToast, t],
  );

  const handleDeleteSnapshot = useCallback(async (id) => {
    await deleteSnapshot(id);
    setSnapshots((prev) => prev.filter((s) => s.id !== id));
  }, []);

  // Ctrl+S : save project when in edit mode (do not intercept in inputs).
  useEffect(() => {
    if (!editing) return undefined;
    const handler = (e) => {
      const tag = document.activeElement?.tagName;
      const isEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        document.activeElement?.isContentEditable;
      if (isEditable) return;
      const isS = e.key === "s" || e.key === "S";
      if ((e.ctrlKey || e.metaKey) && isS && !e.shiftKey) {
        e.preventDefault();
        saveProject();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editing, saveProject]);

  // Auto-save visual indicator: pulsing green dot (recent) or orange (stale).
  const autoSaveAgeSec = lastAutoSaveAt
    ? Math.floor((Date.now() - lastAutoSaveAt) / 1000)
    : null;
  const autoSaveFresh = autoSaveAgeSec !== null && autoSaveAgeSec < 180;
  const autoSaveStale = autoSaveAgeSec !== null && autoSaveAgeSec >= 180;

  return (
    <>
      <Tooltip title={t("project.menuTooltip") || "Project file"} arrow>
        <IconButton
          size="small"
          onClick={handleOpenMenu}
          sx={{
            padding: 1,
            borderRadius: 2.5,
            color: theme.palette.text.secondary,
            backgroundColor: alpha(
              theme.palette.primary.main,
              isDark ? 0.08 : 0.05,
            ),
            "&:hover": {
              backgroundColor: alpha(
                theme.palette.primary.main,
                isDark ? 0.18 : 0.12,
              ),
            },
            position: "relative",
          }}
        >
          <FolderOpenIcon sx={{ fontSize: 20 }} />
          {autoSaveFresh && (
            <Box
              sx={{
                position: "absolute",
                top: 4,
                right: 4,
                width: 8,
                height: 8,
                borderRadius: "50%",
                backgroundColor: theme.palette.success.main,
                boxShadow: `0 0 0 2px ${theme.palette.background.paper}`,
              }}
            />
          )}
          {autoSaveStale && (
            <Box
              sx={{
                position: "absolute",
                top: 4,
                right: 4,
                width: 8,
                height: 8,
                borderRadius: "50%",
                backgroundColor: theme.palette.warning.main,
                boxShadow: `0 0 0 2px ${theme.palette.background.paper}`,
              }}
            />
          )}
        </IconButton>
      </Tooltip>

      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={handleCloseMenu}
        slotProps={{ paper: { sx: { minWidth: 280 } } }}
      >
        {projectMeta && (
          <Box sx={{ px: 2, py: 1 }}>
            <Typography variant="caption" color="text.secondary">
              {t("project.currentProject") || "Current project"}
            </Typography>
            <Typography
              variant="body2"
              sx={{
                fontWeight: 600,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {projectMeta.source_feed_name || t("project.untitled") || "Untitled"}
            </Typography>
            {projectMeta.updated_at && (
              <Typography variant="caption" color="text.secondary">
                {t("project.lastUpdated") || "Updated"} :{" "}
                {new Date(projectMeta.updated_at).toLocaleString()}
              </Typography>
            )}
          </Box>
        )}
        {projectMeta && <Divider sx={{ my: 0.5 }} />}

        <MenuItem
          onClick={handleSaveClick}
          disabled={!editing || savingProject}
        >
          <ListItemIcon>
            <SaveIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary={t("project.save") || "Save project as…"}
            secondary={editing ? "Ctrl+S" : t("project.needsEdit") || "Enter edit mode first"}
          />
        </MenuItem>

        <MenuItem onClick={handleOpenClick} disabled={openingProject}>
          <ListItemIcon>
            <FolderOpenIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary={t("project.open") || `Open project (${PROJECT_EXT})…`}
            secondary={
              openingProject
                ? t("project.opening") || "Opening…"
                : t("project.openHint") || "Replaces current edit state"
            }
          />
        </MenuItem>

        <Divider sx={{ my: 0.5 }} />

        <MenuItem onClick={handleRecoverClick}>
          <ListItemIcon>
            <RestoreIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary={t("project.recover") || "Recover recent work…"}
            secondary={
              t("project.recoverHint") ||
              "Auto-saved snapshots from previous sessions"
            }
          />
        </MenuItem>

        {/* ── Metadata section ── */}
        <Divider sx={{ my: 0.5 }} />
        <Box sx={{ px: 2, pt: 0.75, pb: 0.25 }}>
          <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 10, fontWeight: 700 }}>
            {t("project.metadataSection") || "Metadata"}
          </Typography>
        </Box>
        <MenuItem
          onClick={() => {
            handleCloseMenu();
            openPanel("feed_info", "feed_info.txt");
          }}
        >
          <ListItemIcon>
            <ArticleOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary={t("feedInfo.menuItem") || "Feed info…"}
            secondary="feed_info.txt"
          />
        </MenuItem>
        {/* levels / pathways / translations / attributions intentionally
            omitted here — they're accessible via CommandPalette (Ctrl+K)
            and the SQL Console Browse-files strip. Feed info stays because
            it's a singleton with cross-field validation (URL, date range,
            contact) that benefits from a dedicated form. */}

        {lastAutoSaveAt && (
          <>
            <Divider sx={{ my: 0.5 }} />
            <Box sx={{ px: 2, py: 1, display: "flex", alignItems: "center", gap: 1 }}>
              {autoSaveFresh ? (
                <CloudDoneIcon sx={{ fontSize: 16, color: "success.main" }} />
              ) : (
                <SyncProblemIcon sx={{ fontSize: 16, color: "warning.main" }} />
              )}
              <Typography variant="caption" color="text.secondary">
                {t("project.autoSaveLast") || "Auto-saved"} :{" "}
                {new Date(lastAutoSaveAt).toLocaleTimeString()}
              </Typography>
            </Box>
          </>
        )}
      </Menu>

      {/* Hidden file input for Open… */}
      <input
        ref={fileInputRef}
        type="file"
        accept={PROJECT_EXT}
        style={{ display: "none" }}
        onChange={handleFileSelected}
      />

      {/* Upload progress overlay */}
      {progress !== null && (
        <Box
          sx={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            zIndex: (th) => th.zIndex.appBar + 10,
          }}
        >
          <LinearProgress variant="determinate" value={progress} />
        </Box>
      )}

      {/* Recovery dialog */}
      <Dialog
        open={recoverOpen}
        onClose={() => setRecoverOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          {t("project.recoverTitle") || "Recover auto-saved project"}
        </DialogTitle>
        <DialogContent>
          {snapshots.length === 0 ? (
            <Alert severity="info">
              {t("project.noSnapshots") ||
                "No auto-saved snapshots found in this browser."}
            </Alert>
          ) : (
            <Box>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {t("project.recoverBody") ||
                  "These snapshots are stored in your browser (IndexedDB) and only on this device. Pick one to restore."}
              </Typography>
              {snapshots.map((s) => (
                <Box
                  key={s.id}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    p: 1.5,
                    border: `1px solid ${theme.palette.divider}`,
                    borderRadius: 1,
                    mb: 1,
                  }}
                >
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography variant="body2" fontWeight={600}>
                      {s.meta?.source_feed_name ||
                        t("project.untitled") ||
                        "Untitled"}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {new Date(s.ts).toLocaleString()} ·{" "}
                      {(s.size / 1024 / 1024).toFixed(1)} MB
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.disabled"
                      display="block"
                      sx={{
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, monospace",
                        fontSize: 10,
                      }}
                    >
                      {s.session_id}
                    </Typography>
                  </Box>
                  <Box sx={{ display: "flex", gap: 0.5 }}>
                    <Tooltip title={t("project.restore") || "Restore"}>
                      <IconButton
                        size="small"
                        color="primary"
                        onClick={() => handleRestoreSnapshot(s.id)}
                      >
                        <RestoreIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title={t("project.delete") || "Delete"}>
                      <IconButton
                        size="small"
                        onClick={() => handleDeleteSnapshot(s.id)}
                      >
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <IconButton size="small" disabled>
                      <MoreVertIcon fontSize="small" />
                    </IconButton>
                  </Box>
                </Box>
              ))}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRecoverOpen(false)}>
            {t("app.close") || "Close"}
          </Button>
        </DialogActions>
      </Dialog>

      <BetaGateDialog
        open={betaGateOpen}
        onClose={() => {
          setBetaGateOpen(false);
          setPendingProjectFile(null);
          setBetaGateInitialError(null);
        }}
        onSubmit={handleBetaSubmitForOpenProject}
        initialError={betaGateInitialError}
      />
    </>
  );
}

export default ProjectMenu;
