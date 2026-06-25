import React, { useState, useEffect, useCallback } from "react";
import {
  Box,
  Typography,
  TextField,
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
import EditIcon from "@mui/icons-material/Edit";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import CheckIcon from "@mui/icons-material/Check";
import CloseIcon from "@mui/icons-material/Close";
import AddIcon from "@mui/icons-material/Add";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";

const EMPTY_NEW = { level_id: "", level_index: "", level_name: "" };

function LevelRowReadOnly({ level, isDark }) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        py: 0.75,
        px: 1,
        borderRadius: 1,
        borderBottom: (theme) =>
          `1px solid ${isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)"}`,
      }}
    >
      <Chip
        label={level.level_id}
        size="small"
        icon={<ContentCopyIcon sx={{ fontSize: "12px !important" }} />}
        onClick={() => navigator.clipboard.writeText(level.level_id)}
        sx={{ fontFamily: "monospace", fontSize: 11, height: 22, cursor: "pointer" }}
      />
      <Typography
        variant="body2"
        fontFamily="monospace"
        sx={{ width: 60, textAlign: "right", color: "text.secondary", flexShrink: 0 }}
      >
        {level.level_index ?? "—"}
      </Typography>
      <Typography variant="body2" sx={{ flex: 1, ml: 1 }}>
        {level.level_name || <em style={{ opacity: 0.4 }}>—</em>}
      </Typography>
    </Box>
  );
}

function LevelRowEditable({ level, onEdit, onDelete, t, isDark }) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        py: 0.75,
        px: 1,
        borderRadius: 1,
        borderBottom: (theme) =>
          `1px solid ${isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)"}`,
        "&:hover": {
          background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.02)",
        },
      }}
    >
      <Chip
        label={level.level_id}
        size="small"
        icon={<ContentCopyIcon sx={{ fontSize: "12px !important" }} />}
        onClick={() => navigator.clipboard.writeText(level.level_id)}
        sx={{ fontFamily: "monospace", fontSize: 11, height: 22, cursor: "pointer" }}
      />
      <Typography
        variant="body2"
        fontFamily="monospace"
        sx={{ width: 60, textAlign: "right", color: "text.secondary", flexShrink: 0 }}
      >
        {level.level_index ?? "—"}
      </Typography>
      <Typography variant="body2" sx={{ flex: 1, ml: 1 }}>
        {level.level_name || <em style={{ opacity: 0.4 }}>—</em>}
      </Typography>
      <Tooltip title={t("app.edit")}>
        <IconButton size="small" onClick={() => onEdit(level)} aria-label={t("app.edit")}>
          <EditIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Tooltip>
      <Tooltip title={t("app.delete")}>
        <IconButton size="small" color="error" onClick={() => onDelete(level)} aria-label={t("app.delete")}>
          <DeleteOutlineIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
}

/**
 * LevelsPanel — side panel content for levels.txt management.
 * Rendered inside DetailPanel when entity.type === "levels".
 * No Dialog wrapper — inline add/edit rows, sticky "Add level" button.
 */
function LevelsPanel() {
  const { t } = useLanguage();
  const { editing, recordEdit, dataVersion } = useEditMode();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";

  const [levels, setLevels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);

  const [editingRow, setEditingRow] = useState(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState(null);

  const [showAdd, setShowAdd] = useState(false);
  const [newForm, setNewForm] = useState(EMPTY_NEW);
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState(null);

  const [deletingId, setDeletingId] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [confirmDeleteLevel, setConfirmDeleteLevel] = useState(null); // level object to confirm

  const loadLevels = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/levels`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to load levels");
      // API returns { data: [...] }
      setLevels(Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []);
    } catch (err) {
      setFetchError(err.message || "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLevels();
    setNewForm(EMPTY_NEW);
    setAddError(null);
    setEditingRow(null);
    setEditError(null);
    setDeletingId(null);
    setDeleteError(null);
    setShowAdd(false);
  }, [loadLevels, dataVersion]);

  const validateNewForm = () => {
    if (!newForm.level_id.trim()) return t("levels.errorIdRequired");
    if (levels.some((l) => l.level_id === newForm.level_id.trim()))
      return t("levels.errorIdDuplicate");
    if (newForm.level_index === "" || isNaN(parseFloat(newForm.level_index)))
      return t("levels.errorIndexRequired");
    return null;
  };

  const handleAdd = async () => {
    const err = validateNewForm();
    if (err) { setAddError(err); return; }
    setAddSaving(true);
    setAddError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/levels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          level_id: newForm.level_id.trim(),
          level_index: parseFloat(newForm.level_index),
          level_name: newForm.level_name.trim() || null,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || t("levels.savedToast"));
      recordEdit(`Added level ${newForm.level_id.trim()}`, body.validation, {
        entity: "level",
        entityId: newForm.level_id.trim(),
      });
      setNewForm(EMPTY_NEW);
      setShowAdd(false);
      await loadLevels();
    } catch (err) {
      setAddError(err.message || "Network error");
    } finally {
      setAddSaving(false);
    }
  };

  const handleEditSave = async () => {
    if (!editingRow) return;
    if (editingRow.level_index === "" || isNaN(parseFloat(editingRow.level_index))) {
      setEditError(t("levels.errorIndexRequired"));
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/levels/${encodeURIComponent(editingRow.level_id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            level_index: parseFloat(editingRow.level_index),
            level_name: editingRow.level_name.trim() || null,
          }),
        },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || t("levels.savedToast"));
      recordEdit(`Updated level ${editingRow.level_id}`, body.validation, {
        entity: "level",
        entityId: editingRow.level_id,
      });
      setEditingRow(null);
      await loadLevels();
    } catch (err) {
      setEditError(err.message || "Network error");
    } finally {
      setEditSaving(false);
    }
  };

  const handleDeleteRequest = (level) => {
    setConfirmDeleteLevel(level);
    setDeleteError(null);
  };

  const handleDeleteConfirm = async () => {
    const level = confirmDeleteLevel;
    if (!level) return;
    setDeletingId(level.level_id);
    setDeleteError(null);
    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/levels/${encodeURIComponent(level.level_id)}`,
        { method: "DELETE" },
      );
      if (res.status === 409) {
        const body = await res.json();
        const count = body.count ?? "?";
        setDeleteError(t("levels.errorReferenced", { count }));
        setConfirmDeleteLevel(null);
        setDeletingId(null);
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Delete failed");
      }
      recordEdit(`Deleted level ${level.level_id}`, body.validation, {
        entity: "level",
        entityId: level.level_id,
      });
      setConfirmDeleteLevel(null);
      await loadLevels();
    } catch (err) {
      setDeleteError(err.message || "Network error");
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <Box display="flex" alignItems="center" gap={2} justifyContent="center" py={4}>
        <CircularProgress size={20} aria-busy="true" />
        <Typography variant="body2" color="text.secondary">
          {t("levels.loading")}
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {/* Sticky add button */}
      {editing && (
        <Box
          sx={{
            position: "sticky",
            top: 0,
            zIndex: 2,
            background: (t) => t.palette.background.paper,
            pb: 1,
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <Button
            size="small"
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => { setShowAdd(true); setAddError(null); }}
          >
            {t("levels.addBtn")}
          </Button>
        </Box>
      )}

      {/* Error banners */}
      {fetchError && (
        <Alert severity="error" action={
          <Button size="small" color="inherit" onClick={loadLevels}>
            {t("app.retry")}
          </Button>
        }>
          {fetchError}
        </Alert>
      )}
      {deleteError && (
        <Alert severity="warning" onClose={() => setDeleteError(null)}>
          {deleteError}
        </Alert>
      )}

      {/* Column header */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1,
          pb: 0.5,
          borderBottom: (theme) => `1px solid ${theme.palette.divider}`,
        }}
      >
        <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ width: 120 }}>
          {t("levels.colLevelId")}
        </Typography>
        <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ width: 60, textAlign: "right" }}>
          {t("levels.colLevelIndex")}
        </Typography>
        <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ flex: 1, ml: 1 }}>
          {t("levels.colLevelName")}
        </Typography>
        {editing && <Box sx={{ width: 64 }} />}
      </Box>

      {/* Empty state */}
      {levels.length === 0 && !showAdd && (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ py: 3, textAlign: "center", fontSize: 13 }}
        >
          {editing ? t("levels.emptyState") : t("levels.emptyStateReadOnly")}
        </Typography>
      )}

      {/* Level rows */}
      {levels.map((level) =>
        editing && editingRow?.level_id === level.level_id ? (
          <Box
            key={level.level_id}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              py: 0.75,
              px: 1,
              background: isDark ? "rgba(99,102,241,0.06)" : "rgba(99,102,241,0.04)",
              borderRadius: 1,
              mb: 0.25,
            }}
          >
            <Typography
              variant="body2"
              fontFamily="monospace"
              sx={{ width: 120, flexShrink: 0, fontWeight: 600 }}
            >
              {level.level_id}
            </Typography>
            <TextField
              value={editingRow.level_index}
              onChange={(e) => setEditingRow((r) => ({ ...r, level_index: e.target.value }))}
              size="small"
              type="number"
              sx={{ width: 76 }}
              inputProps={{ step: 0.5 }}
              error={!!editError}
            />
            <TextField
              value={editingRow.level_name}
              onChange={(e) => setEditingRow((r) => ({ ...r, level_name: e.target.value }))}
              size="small"
              sx={{ flex: 1 }}
              error={!!editError}
            />
            <Tooltip title={t("levels.saveBtn")}>
              <span>
                <IconButton
                  size="small"
                  color="primary"
                  onClick={handleEditSave}
                  disabled={editSaving}
                  aria-label={t("levels.saveBtn")}
                >
                  {editSaving ? <CircularProgress size={14} /> : <CheckIcon sx={{ fontSize: 14 }} />}
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={t("levels.cancelBtn")}>
              <IconButton
                size="small"
                onClick={() => { setEditingRow(null); setEditError(null); }}
                aria-label={t("levels.cancelBtn")}
              >
                <CloseIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          </Box>
        ) : editing ? (
          <LevelRowEditable
            key={level.level_id}
            level={level}
            onEdit={(l) =>
              setEditingRow({
                ...l,
                level_index: String(l.level_index ?? ""),
                level_name: l.level_name || "",
              })
            }
            onDelete={handleDeleteRequest}
            t={t}
            isDark={isDark}
          />
        ) : (
          <LevelRowReadOnly key={level.level_id} level={level} isDark={isDark} />
        ),
      )}

      {editError && (
        <Alert severity="error">{editError}</Alert>
      )}

      {/* Add new level form */}
      {editing && showAdd && (
        <>
          <Box
            sx={{
              display: "flex",
              alignItems: "flex-start",
              gap: 1,
              mt: 1.5,
              pt: 1.5,
              borderTop: (theme) => `1px dashed ${theme.palette.divider}`,
              flexWrap: "wrap",
            }}
          >
            <TextField
              label={t("levels.colLevelId")}
              value={newForm.level_id}
              onChange={(e) => setNewForm((f) => ({ ...f, level_id: e.target.value }))}
              size="small"
              sx={{ width: 120 }}
              inputProps={{ style: { fontFamily: "monospace" } }}
              error={!!addError && !newForm.level_id.trim()}
              autoFocus
            />
            <TextField
              label={t("levels.colLevelIndex")}
              value={newForm.level_index}
              onChange={(e) => setNewForm((f) => ({ ...f, level_index: e.target.value }))}
              size="small"
              type="number"
              sx={{ width: 96 }}
              inputProps={{ step: 0.5 }}
              error={!!addError && (newForm.level_index === "" || isNaN(parseFloat(newForm.level_index)))}
              helperText="e.g. -1, 0, 0.5"
            />
            <TextField
              label={t("levels.colLevelName")}
              value={newForm.level_name}
              onChange={(e) => setNewForm((f) => ({ ...f, level_name: e.target.value }))}
              size="small"
              sx={{ flex: 1, minWidth: 120 }}
              placeholder="Ground floor…"
            />
            <Box sx={{ display: "flex", gap: 0.5, mt: 0.5 }}>
              <Button
                variant="contained"
                size="small"
                onClick={handleAdd}
                disabled={addSaving}
                startIcon={addSaving ? <CircularProgress size={14} /> : null}
              >
                {t("levels.addBtn")}
              </Button>
              <IconButton
                size="small"
                onClick={() => { setShowAdd(false); setAddError(null); setNewForm(EMPTY_NEW); }}
                aria-label={t("levels.cancelBtn")}
              >
                <CloseIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Box>
          </Box>
          {addError && (
            <Alert severity="error" sx={{ mt: 0.5 }}>{addError}</Alert>
          )}
        </>
      )}
      {/* Delete confirmation dialog */}
      <Dialog
        open={Boolean(confirmDeleteLevel)}
        onClose={() => setConfirmDeleteLevel(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t("levels.deleteConfirmTitle")}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {t("levels.deleteConfirmBody")}
          </Typography>
          {confirmDeleteLevel && (
            <Typography
              variant="caption"
              fontFamily="monospace"
              color="text.secondary"
              sx={{ display: "block", mt: 1 }}
            >
              level_id: {confirmDeleteLevel.level_id}
            </Typography>
          )}
          {deleteError && (
            <Alert severity="warning" sx={{ mt: 2 }}>{deleteError}</Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => { setConfirmDeleteLevel(null); setDeleteError(null); }}
            disabled={!!deletingId}
          >
            {t("app.cancel")}
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={handleDeleteConfirm}
            disabled={!!deletingId}
          >
            {deletingId ? <CircularProgress size={18} /> : t("app.delete")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default LevelsPanel;
