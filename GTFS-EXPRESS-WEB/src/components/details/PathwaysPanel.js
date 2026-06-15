import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Box,
  Typography,
  TextField,
  InputAdornment,
  Button,
  Alert,
  CircularProgress,
  IconButton,
  Tooltip,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import AddIcon from "@mui/icons-material/Add";
import CloseIcon from "@mui/icons-material/Close";
import SearchIcon from "@mui/icons-material/Search";
import EditIcon from "@mui/icons-material/Edit";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import SwapHorizIcon from "@mui/icons-material/SwapHoriz";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import EditPathwayDialog from "../edit/EditPathwayDialog";

const MODE_COLORS = {
  1: "default",
  2: "warning",
  3: "info",
  4: "secondary",
  5: "primary",
  6: "error",
  7: "error",
};

function PathwayRow({ pathway, isDark, modeLabel, onEdit, onDelete, t, openPanel, editable }) {
  const isBidi = Boolean(pathway.is_bidirectional);
  const DirIcon = isBidi ? SwapHorizIcon : ArrowForwardIcon;

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        py: 0.75,
        px: 1,
        borderRadius: 1,
        borderBottom: `1px solid ${isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)"}`,
        ...(editable && {
          "&:hover": {
            background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.02)",
          },
        }),
      }}
    >
      {/* pathway_id — copiable chip */}
      <Tooltip title={`pathway_id: ${pathway.pathway_id}`}>
        <Chip
          label={pathway.pathway_id}
          size="small"
          icon={<ContentCopyIcon sx={{ fontSize: "11px !important" }} />}
          onClick={() => navigator.clipboard.writeText(pathway.pathway_id)}
          sx={{ fontFamily: "monospace", fontSize: 10, height: 20, maxWidth: 110, cursor: "pointer", flexShrink: 0 }}
        />
      </Tooltip>

      {/* from_stop_id — clickable to navigate */}
      <Tooltip title={`from_stop_id: ${pathway.from_stop_id}`}>
        <Typography
          variant="body2"
          fontFamily="monospace"
          fontSize={11}
          color="text.secondary"
          sx={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            cursor: "pointer",
            "&:hover": { textDecoration: "underline", color: "primary.main" },
          }}
          onClick={() => openPanel({ type: "stop", id: pathway.from_stop_id })}
        >
          {pathway.from_stop_id}
        </Typography>
      </Tooltip>

      <DirIcon
        sx={{ fontSize: 14, opacity: 0.45, flexShrink: 0 }}
        titleAccess={isBidi ? "Bidirectional" : "One-way"}
      />

      {/* to_stop_id — clickable to navigate */}
      <Tooltip title={`to_stop_id: ${pathway.to_stop_id}`}>
        <Typography
          variant="body2"
          fontFamily="monospace"
          fontSize={11}
          color="text.secondary"
          sx={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            cursor: "pointer",
            "&:hover": { textDecoration: "underline", color: "primary.main" },
          }}
          onClick={() => openPanel({ type: "stop", id: pathway.to_stop_id })}
        >
          {pathway.to_stop_id}
        </Typography>
      </Tooltip>

      <Tooltip title={`pathway_mode ${pathway.pathway_mode}: ${modeLabel}`}>
        <Chip
          label={pathway.pathway_mode}
          size="small"
          color={MODE_COLORS[pathway.pathway_mode] ?? "default"}
          sx={{ fontSize: 10, height: 18, minWidth: 24, flexShrink: 0 }}
        />
      </Tooltip>

      {editable && (
        <>
          <Tooltip title={t("pathways.dialogTitleEdit")}>
            <IconButton
              size="small"
              onClick={() => onEdit(pathway)}
              aria-label={t("pathways.dialogTitleEdit")}
            >
              <EditIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title={t("app.delete")}>
            <IconButton
              size="small"
              color="error"
              onClick={() => onDelete(pathway)}
              aria-label={t("app.delete")}
            >
              <DeleteOutlineIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        </>
      )}
    </Box>
  );
}

/**
 * PathwaysPanel — side panel content for pathways.txt management.
 * Rendered inside DetailPanel when entity.type === "pathways".
 * Sticky filter bar + mode badge summary at top, scrollable list in the middle.
 */
function PathwaysPanel() {
  const { t } = useLanguage();
  const { editing, recordEdit, dataVersion } = useEditMode();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { openPanel } = useDetailPanel();

  const [pathways, setPathways] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
  const [filter, setFilter] = useState("");
  const [pathwayDialog, setPathwayDialog] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [confirmDeletePathway, setConfirmDeletePathway] = useState(null);

  const modeLabel = useCallback(
    (mode) => t(`pathways.mode.${mode}`) || String(mode),
    [t],
  );

  const loadPathways = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/pathways`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to load pathways");
      // API returns { data: [...] }
      setPathways(Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []);
    } catch (err) {
      setFetchError(err.message || "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPathways();
    setFilter("");
    setDeleteError(null);
  }, [loadPathways, dataVersion]);

  const handleDeleteRequest = (pathway) => {
    setConfirmDeletePathway(pathway);
    setDeleteError(null);
  };

  const handleDeleteConfirm = async () => {
    const pathway = confirmDeletePathway;
    if (!pathway) return;
    setDeletingId(pathway.pathway_id);
    setDeleteError(null);
    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/pathways/${encodeURIComponent(pathway.pathway_id)}`,
        { method: "DELETE" },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Delete failed");
      }
      recordEdit(`Deleted pathway ${pathway.pathway_id}`, body.validation, {
        entity: "pathway",
        entityId: pathway.pathway_id,
      });
      setConfirmDeletePathway(null);
      await loadPathways();
    } catch (err) {
      setDeleteError(err.message || "Network error");
    } finally {
      setDeletingId(null);
    }
  };

  const modeCounts = useMemo(() => {
    const counts = {};
    pathways.forEach((p) => {
      counts[p.pathway_mode] = (counts[p.pathway_mode] || 0) + 1;
    });
    return counts;
  }, [pathways]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return pathways;
    const q = filter.trim().toLowerCase();
    return pathways.filter(
      (p) =>
        p.pathway_id?.toLowerCase().includes(q) ||
        p.from_stop_id?.toLowerCase().includes(q) ||
        p.to_stop_id?.toLowerCase().includes(q),
    );
  }, [pathways, filter]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {/* Sticky toolbar */}
      <Box
        sx={{
          position: "sticky",
          top: 0,
          zIndex: 2,
          background: theme.palette.background.paper,
          pt: 0.5,
          pb: 1,
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}
      >
        <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
          <TextField
            size="small"
            fullWidth
            placeholder={t("pathways.filterPlaceholder")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 16 }} />
                </InputAdornment>
              ),
              endAdornment: filter ? (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={() => setFilter("")} aria-label={t("app.clearFilter")}>
                    <CloseIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </InputAdornment>
              ) : null,
            }}
          />
          {editing && (
            <Button
              size="small"
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => setPathwayDialog({ mode: "create" })}
              sx={{ flexShrink: 0 }}
            >
              {t("pathways.addBtn")}
            </Button>
          )}
        </Box>

        {/* Mode badge summary */}
        {Object.keys(modeCounts).length > 0 && (
          <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
            {Object.entries(modeCounts).map(([mode, count]) => (
              <Tooltip key={mode} title={modeLabel(Number(mode))}>
                <Chip
                  label={`${mode}: ${count}`}
                  size="small"
                  color={MODE_COLORS[Number(mode)] ?? "default"}
                  sx={{ fontSize: 10, height: 20 }}
                />
              </Tooltip>
            ))}
          </Box>
        )}
      </Box>

      {/* Error banners */}
      {fetchError && (
        <Alert
          severity="error"
          action={
            <Button size="small" color="inherit" onClick={loadPathways}>
              {t("app.retry")}
            </Button>
          }
        >
          {fetchError}
        </Alert>
      )}
      {deleteError && (
        <Alert severity="warning" onClose={() => setDeleteError(null)}>
          {deleteError}
        </Alert>
      )}

      {loading && (
        <Box display="flex" alignItems="center" gap={2} justifyContent="center" py={4}>
          <CircularProgress size={20} aria-busy="true" />
          <Typography variant="body2" color="text.secondary">
            {t("pathways.loading")}
          </Typography>
        </Box>
      )}

      {!loading && !fetchError && (
        <>
          {/* Column header */}
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              px: 1,
              py: 0.5,
              borderBottom: (theme) => `1px solid ${theme.palette.divider}`,
              background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.025)",
            }}
          >
            <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ width: 110, flexShrink: 0 }}>
              pathway_id
            </Typography>
            <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ flex: 1 }}>
              from_stop_id
            </Typography>
            <Box sx={{ width: 18, flexShrink: 0 }} />
            <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ flex: 1 }}>
              to_stop_id
            </Typography>
            <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ width: 28, textAlign: "center", flexShrink: 0 }}>
              mode
            </Typography>
            {editing && <Box sx={{ width: 56, flexShrink: 0 }} />}
          </Box>

          {/* Empty state */}
          {filtered.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: "center", fontSize: 13 }}>
              {pathways.length === 0
                ? editing
                  ? t("pathways.emptyState")
                  : t("pathways.emptyStateReadOnly")
                : t("pathways.noMatch")}
            </Typography>
          )}

          {/* Pathway rows */}
          {filtered.map((p) => (
            <PathwayRow
              key={p.pathway_id}
              pathway={p}
              isDark={isDark}
              modeLabel={modeLabel(p.pathway_mode)}
              editable={editing}
              onEdit={(pw) => setPathwayDialog({ mode: "edit", initial: pw })}
              onDelete={handleDeleteRequest}
              t={t}
              openPanel={openPanel}
            />
          ))}
        </>
      )}

      {/* Edit / create sub-dialog */}
      {pathwayDialog && (
        <EditPathwayDialog
          open
          mode={pathwayDialog.mode}
          initial={pathwayDialog.initial}
          onClose={() => setPathwayDialog(null)}
          onSaved={async () => {
            setPathwayDialog(null);
            await loadPathways();
          }}
        />
      )}

      {/* Delete confirmation dialog */}
      <Dialog
        open={Boolean(confirmDeletePathway)}
        onClose={() => setConfirmDeletePathway(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t("pathways.deleteConfirmTitle")}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">{t("pathways.deleteConfirmBody")}</Typography>
          {confirmDeletePathway && (
            <Typography
              variant="caption"
              fontFamily="monospace"
              color="text.secondary"
              sx={{ display: "block", mt: 1 }}
            >
              pathway_id: {confirmDeletePathway.pathway_id}
            </Typography>
          )}
          {deleteError && (
            <Alert severity="error" sx={{ mt: 2 }}>{deleteError}</Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setConfirmDeletePathway(null); setDeleteError(null); }} disabled={!!deletingId}>
            {t("app.cancel")}
          </Button>
          <Button color="error" variant="contained" onClick={handleDeleteConfirm} disabled={!!deletingId}>
            {deletingId ? <CircularProgress size={18} /> : t("app.delete")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default PathwaysPanel;
