import React, { useState, useEffect, useCallback } from "react";
import {
  Box,
  Typography,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  IconButton,
  TextField,
  MenuItem,
  Button,
  Alert,
  CircularProgress,
  Tooltip,
} from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditIcon from "@mui/icons-material/Edit";
import AddIcon from "@mui/icons-material/Add";
import TranslateIcon from "@mui/icons-material/Translate";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import EditTranslationDialog from "./EditTranslationDialog";

/**
 * TranslationsRecordPanel — reusable component mounted inside an AccordionDetails
 * in each entity dialog (EditStopDialog, EditRouteDialog, etc.).
 *
 * This is the per-record translations panel. For the full-feed translations
 * manager (all tables), see src/components/details/TranslationsPanel.js.
 *
 * Props:
 *   tableName    — GTFS table name, e.g. "stops"
 *   recordId     — primary key value, e.g. stop_id. null for feed_info.
 *   recordSubId  — stop_sequence (only for stop_times)
 *   fields       — array of translatable field names for this table
 */
function TranslationsRecordPanel({ tableName, recordId, recordSubId, fields }) {
  const { t } = useLanguage();
  const { editing, recordEdit, dataVersion } = useEditMode();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Inline add form state
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null); // {row} for edit dialog

  const loadTranslations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ table_name: tableName });
      if (recordId != null) params.set("record_id", recordId);
      if (recordSubId != null) params.set("record_sub_id", recordSubId);
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/translations?${params.toString()}`,
      );
      if (!res.ok) throw new Error("Failed to load translations");
      const data = await res.json();
      setRows(Array.isArray(data) ? data : data.translations || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [tableName, recordId, recordSubId]);

  useEffect(() => {
    if (!tableName) return;
    loadTranslations();
  }, [loadTranslations, dataVersion]);

  const handleDelete = async (row) => {
    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/translations/${row.id}`,
        { method: "DELETE" },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Delete failed");
      }
      recordEdit(t("translations.deletedToast"), body.validation, {
        entity: "translation",
        entityId: String(row.id),
      });
      await loadTranslations();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSaved = async () => {
    await loadTranslations();
    setAddOpen(false);
    setEditTarget(null);
  };

  return (
    <Box>
      {error && (
        <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 1.5 }}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 2 }}>
          <CircularProgress size={20} />
        </Box>
      ) : rows.length === 0 ? (
        <Box
          sx={{
            py: 2,
            px: 1,
            textAlign: "center",
            borderRadius: 1,
            border: (theme) => `1px dashed ${theme.palette.divider}`,
          }}
        >
          <TranslateIcon
            sx={{ fontSize: 28, opacity: 0.3, mb: 0.5, display: "block", mx: "auto" }}
          />
          <Typography variant="caption" color="text.secondary">
            {t("translations.emptyState")}
          </Typography>
        </Box>
      ) : (
        <Table size="small" sx={{ mb: 1 }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 700, py: 0.75 }}>
                {t("translations.colField")}
              </TableCell>
              <TableCell sx={{ fontWeight: 700, py: 0.75 }}>
                {t("translations.colLanguage")}
              </TableCell>
              <TableCell sx={{ fontWeight: 700, py: 0.75 }}>
                {t("translations.colTranslation")}
              </TableCell>
              <TableCell sx={{ py: 0.75, width: 72 }} />
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} hover>
                <TableCell
                  sx={{
                    py: 0.5,
                    fontFamily: "monospace",
                    fontSize: 12,
                  }}
                >
                  {row.field_name}
                </TableCell>
                <TableCell sx={{ py: 0.5, fontFamily: "monospace", fontSize: 12 }}>
                  {row.language}
                </TableCell>
                <TableCell
                  sx={{
                    py: 0.5,
                    maxWidth: 200,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <Tooltip title={row.translation} placement="top">
                    <span>{row.translation}</span>
                  </Tooltip>
                </TableCell>
                <TableCell sx={{ py: 0.5 }}>
                  {editing && (
                    <Box sx={{ display: "flex", gap: 0.25 }}>
                      <IconButton
                        size="small"
                        onClick={() => setEditTarget(row)}
                        aria-label="edit translation"
                      >
                        <EditIcon sx={{ fontSize: 15 }} />
                      </IconButton>
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => handleDelete(row)}
                        aria-label="delete translation"
                      >
                        <DeleteOutlineIcon sx={{ fontSize: 15 }} />
                      </IconButton>
                    </Box>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {editing && (
        <Button
          size="small"
          startIcon={<AddIcon />}
          onClick={() => setAddOpen(true)}
          sx={{ mt: rows.length > 0 ? 0.5 : 1 }}
        >
          {t("translations.addBtn")}
        </Button>
      )}

      {/* Create dialog — only when editing */}
      {editing && (
        <EditTranslationDialog
          open={addOpen}
          mode="create"
          initial={{
            table_name: tableName,
            field_name: fields?.[0] || "",
            language: "",
            translation: "",
            record_id: recordId ?? "",
            record_sub_id: recordSubId ?? "",
            field_value: "",
          }}
          lockedTable={tableName}
          availableFields={fields}
          onClose={() => setAddOpen(false)}
          onSaved={handleSaved}
        />
      )}

      {/* Edit dialog — only when editing */}
      {editTarget && editing && (
        <EditTranslationDialog
          open={Boolean(editTarget)}
          mode="edit"
          initial={editTarget}
          lockedTable={tableName}
          availableFields={fields}
          onClose={() => setEditTarget(null)}
          onSaved={handleSaved}
        />
      )}
    </Box>
  );
}

export default TranslationsRecordPanel;
