import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Box,
  Typography,
  TextField,
  MenuItem,
  Button,
  Alert,
  CircularProgress,
  Chip,
  Tooltip,
  IconButton,
  InputAdornment,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from "@mui/material";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditIcon from "@mui/icons-material/Edit";
import SearchIcon from "@mui/icons-material/Search";
import CloseIcon from "@mui/icons-material/Close";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import EditTranslationDialog from "../edit/EditTranslationDialog";

const TABLES = [
  "agency",
  "stops",
  "routes",
  "trips",
  "stop_times",
  "feed_info",
  "pathways",
  "levels",
  "attributions",
];

/**
 * TranslationsPanel — side panel content for translations.txt management.
 * Rendered inside DetailPanel when entity.type === "translations".
 *
 * IMPORTANT: This is the FULL-FEED translations manager panel (all tables).
 * It is NOT the same as TranslationsRecordPanel (src/components/edit/TranslationsRecordPanel.js)
 * which is the per-record accordion component embedded in entity edit dialogs.
 *
 * No Dialog wrapper — sticky filter bar at top, PrimeReact DataTable in the middle.
 */
function TranslationsPanel() {
  const { t } = useLanguage();
  const { editing, recordEdit, dataVersion } = useEditMode();

  const [filterTable, setFilterTable] = useState("");
  const [filterLanguage, setFilterLanguage] = useState("");
  const [filterSearch, setFilterSearch] = useState("");

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [confirmDeleteRow, setConfirmDeleteRow] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filterTable) params.set("table_name", filterTable);
      if (filterLanguage) params.set("language", filterLanguage);
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/translations?${params.toString()}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to load translations");
      }
      const data = await res.json();
      // API returns { data: [...] }; legacy shape was { translations: [...] } or bare array
      const allRows = Array.isArray(data)
        ? data
        : Array.isArray(data?.data)
          ? data.data
          : data?.translations || [];
      setRows(allRows);
    } catch (err) {
      setError(err.message || "Network error");
    } finally {
      setLoading(false);
    }
  }, [filterTable, filterLanguage]);

  useEffect(() => {
    loadAll();
  }, [loadAll, dataVersion]);

  const availableLanguages = useMemo(() => {
    return [...new Set(rows.map((r) => r.language))].sort();
  }, [rows]);

  /** Count of translations per language (over ALL rows, ignoring current filter) */
  const langCounts = useMemo(() => {
    const counts = {};
    rows.forEach((r) => {
      counts[r.language] = (counts[r.language] || 0) + 1;
    });
    return counts;
  }, [rows]);

  const filteredRows = useMemo(() => {
    if (!filterSearch.trim()) return rows;
    const q = filterSearch.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (r.record_id || "").toLowerCase().includes(q) ||
        (r.field_value || "").toLowerCase().includes(q) ||
        (r.translation || "").toLowerCase().includes(q),
    );
  }, [rows, filterSearch]);

  const handleDeleteRequest = (row) => {
    setConfirmDeleteRow(row);
    setDeleteError(null);
  };

  const handleDeleteConfirm = async () => {
    const row = confirmDeleteRow;
    if (!row) return;
    setDeleting(true);
    setDeleteError(null);
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
      setConfirmDeleteRow(null);
      await loadAll();
    } catch (err) {
      setDeleteError(err.message || "Network error");
    } finally {
      setDeleting(false);
    }
  };

  const handleSaved = async () => {
    await loadAll();
    setCreateOpen(false);
    setEditTarget(null);
  };

  // ── DataTable column templates ──────────────────────────────────────────────

  const tableNameBody = (row) => (
    <Typography variant="caption" fontFamily="monospace" fontSize={11}>
      {row.table_name}
    </Typography>
  );

  const fieldNameBody = (row) => (
    <Typography variant="caption" fontFamily="monospace" fontSize={11}>
      {row.field_name}
    </Typography>
  );

  const languageBody = (row) => (
    <Chip
      label={row.language}
      size="small"
      sx={{ height: 20, fontSize: 10, fontFamily: "monospace" }}
    />
  );

  const recordIdBody = (row) =>
    row.record_id ? (
      <Typography variant="caption" fontFamily="monospace" fontSize={11}>
        {row.record_id}
        {row.record_sub_id ? `:${row.record_sub_id}` : ""}
      </Typography>
    ) : row.field_value ? (
      <Tooltip title={`field_value: ${row.field_value}`}>
        <Typography
          variant="caption"
          fontFamily="monospace"
          fontSize={11}
          color="text.secondary"
          sx={{ fontStyle: "italic" }}
        >
          ≈ {row.field_value}
        </Typography>
      </Tooltip>
    ) : (
      <Typography variant="caption" color="text.disabled">
        —
      </Typography>
    );

  const translationBody = (row) => (
    <Tooltip title={row.translation} placement="top">
      <Typography
        variant="body2"
        fontSize={12}
        sx={{
          maxWidth: "100%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {row.translation}
      </Typography>
    </Tooltip>
  );

  const actionsBody = (row) => {
    if (!editing) return null;
    return (
      <Box sx={{ display: "flex", gap: 0.25 }}>
        <Tooltip title={t("app.edit")}>
          <IconButton
            size="small"
            onClick={() => setEditTarget(row)}
            aria-label={t("app.edit")}
          >
            <EditIcon sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title={t("app.delete")}>
          <IconButton
            size="small"
            color="error"
            onClick={() => handleDeleteRequest(row)}
            aria-label={t("app.delete")}
          >
            <DeleteOutlineIcon sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
      </Box>
    );
  };

  return (
    <Box
      sx={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        minHeight: 0,
      }}
    >
      {/* Filter bar — always visible thanks to flex layout (no fragile sticky) */}
      <Box
        sx={{
          flexShrink: 0,
          pt: 0.5,
          pb: 1,
          display: "flex",
          flexDirection: "column",
          gap: 0.75,
        }}
      >
        {/* Single toolbar: [count] · [table filter] [lang filter] [search ──────] · [+ Add] */}
        <Box
          sx={{
            display: "flex",
            gap: 1,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <Chip
            label={
              (filterSearch || filterTable || filterLanguage) &&
              filteredRows.length !== rows.length
                ? `${filteredRows.length} / ${rows.length}`
                : t("translations.countBadge", { count: filteredRows.length })
            }
            size="small"
            variant="outlined"
            sx={{ flexShrink: 0 }}
          />

          <TextField
            select
            label={t("translations.colTableName")}
            value={filterTable}
            onChange={(e) => setFilterTable(e.target.value)}
            size="small"
            sx={{ minWidth: 130 }}
          >
            <MenuItem value="">
              <em>{t("translations.filterAllTables")}</em>
            </MenuItem>
            {TABLES.map((tbl) => (
              <MenuItem key={tbl} value={tbl} sx={{ fontFamily: "monospace" }}>
                {tbl}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            label={t("translations.colLanguage")}
            value={filterLanguage}
            onChange={(e) => setFilterLanguage(e.target.value)}
            size="small"
            sx={{ minWidth: 150 }}
          >
            <MenuItem value="">
              <em>{t("translations.filterAllLanguages")}</em>
            </MenuItem>
            {availableLanguages.map((lang) => (
              <MenuItem
                key={lang}
                value={lang}
                sx={{ fontFamily: "monospace" }}
              >
                {lang}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            value={filterSearch}
            onChange={(e) => setFilterSearch(e.target.value)}
            placeholder={t("translations.filterPlaceholder")}
            size="small"
            sx={{ flex: 1, minWidth: 130 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 16 }} />
                </InputAdornment>
              ),
              endAdornment: filterSearch ? (
                <InputAdornment position="end">
                  <IconButton
                    size="small"
                    onClick={() => setFilterSearch("")}
                    aria-label={t("app.clearFilter")}
                  >
                    <CloseIcon sx={{ fontSize: 14 }} />
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
              onClick={() => setCreateOpen(true)}
              sx={{ flexShrink: 0 }}
            >
              {t("translations.addBtn")}
            </Button>
          )}
        </Box>

        {/* Language distribution chips */}
        {Object.keys(langCounts).length > 0 && (
          <Box
            sx={{
              display: "flex",
              gap: 0.5,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            {Object.entries(langCounts)
              .sort(([, a], [, b]) => b - a)
              .map(([lang, count]) => (
                <Chip
                  key={lang}
                  label={`${lang.toUpperCase()}: ${count}`}
                  size="small"
                  variant={filterLanguage === lang ? "filled" : "outlined"}
                  sx={{
                    fontSize: 10,
                    height: 20,
                    fontFamily: "monospace",
                    cursor: "pointer",
                  }}
                  onClick={() =>
                    setFilterLanguage(filterLanguage === lang ? "" : lang)
                  }
                />
              ))}
          </Box>
        )}
      </Box>

      {/* Error */}
      {error && (
        <Alert
          severity="error"
          onClose={() => setError(null)}
          action={
            <Button size="small" color="inherit" onClick={loadAll}>
              {t("app.retry")}
            </Button>
          }
        >
          {error}
        </Alert>
      )}

      {/* Loading */}
      {loading && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 2,
            justifyContent: "center",
            py: 6,
          }}
        >
          <CircularProgress size={20} aria-busy="true" />
          <Typography variant="body2" color="text.secondary">
            {t("translations.loading")}
          </Typography>
        </Box>
      )}

      {/* Empty state */}
      {!loading && filteredRows.length === 0 && (
        <Box sx={{ py: 4, textAlign: "center" }}>
          <Typography variant="body2" color="text.secondary">
            {rows.length === 0
              ? editing
                ? t("translations.emptyState")
                : t("translations.emptyStateReadOnly")
              : t("translations.noMatch")}
          </Typography>
        </Box>
      )}

      {/* DataTable — the Box manages scroll (overflow:auto), the header
          is sticky via CSS. More reliable than scrollHeight="flex" of
          PrimeReact which requires a rigid flex chain. */}
      {!loading && filteredRows.length > 0 && (
        <Box
          sx={{
            flex: 1,
            overflow: "auto",
            minHeight: 0,
            width: "100%",
            /* Header sticky via CSS — works in any overflow:auto */
            "& .p-datatable-thead > tr > th": {
              position: "sticky",
              top: 0,
              zIndex: 2,
              padding: "3px 8px !important",
              fontSize: "11px !important",
              lineHeight: 1.4,
              backgroundColor: (th) =>
                th.palette.mode === "dark"
                  ? th.palette.grey[900]
                  : th.palette.grey[100],
              color: (th) => th.palette.text.primary,
              borderBottom: (th) => `1px solid ${th.palette.divider}`,
            },
            /* Body cells */
            "& .p-datatable-tbody > tr > td": {
              padding: "2px 8px !important",
              backgroundColor: (th) => th.palette.background.paper,
            },
            /* Pleine largeur */
            "& .p-datatable": { width: "100%" },
            "& .p-datatable table": { width: "100%" },
          }}
        >
          <DataTable
            value={filteredRows}
            size="small"
            style={{ fontSize: 12, width: "100%" }}
            emptyMessage={t("translations.emptyState")}
            rowHover
          >
            <Column
              field="table_name"
              header={t("translations.colTableName")}
              body={tableNameBody}
              style={{ width: 110 }}
            />
            <Column
              field="field_name"
              header={t("translations.colField")}
              body={fieldNameBody}
              style={{ width: 130 }}
            />
            <Column
              field="language"
              header={t("translations.colLanguage")}
              body={languageBody}
              style={{ width: 90 }}
            />
            <Column
              header={`${t("translations.colRecordId")} / ${t("translations.colFieldValue")}`}
              body={recordIdBody}
              style={{ width: 150 }}
            />
            <Column
              field="translation"
              header={t("translations.colTranslation")}
              body={translationBody}
              style={{ flex: 1 }}
            />
            {editing && (
              <Column header="" body={actionsBody} style={{ width: 72 }} />
            )}
          </DataTable>
        </Box>
      )}

      {/* Create dialog */}
      {editing && (
        <EditTranslationDialog
          open={createOpen}
          mode="create"
          initial={{}}
          onClose={() => setCreateOpen(false)}
          onSaved={handleSaved}
        />
      )}

      {/* Edit dialog */}
      {editTarget && editing && (
        <EditTranslationDialog
          open={Boolean(editTarget)}
          mode="edit"
          initial={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={handleSaved}
        />
      )}

      {/* Delete confirmation dialog */}
      <Dialog
        open={Boolean(confirmDeleteRow)}
        onClose={() => setConfirmDeleteRow(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t("translations.deleteConfirmTitle")}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {t("translations.deleteConfirmBody")}
          </Typography>
          {confirmDeleteRow && (
            <Box
              sx={{
                mt: 1.5,
                display: "flex",
                flexDirection: "column",
                gap: 0.5,
              }}
            >
              <Typography
                variant="caption"
                fontFamily="monospace"
                color="text.secondary"
              >
                {confirmDeleteRow.table_name}.{confirmDeleteRow.field_name} [
                {confirmDeleteRow.language}]
              </Typography>
              {confirmDeleteRow.record_id && (
                <Typography
                  variant="caption"
                  fontFamily="monospace"
                  color="text.secondary"
                >
                  record_id: {confirmDeleteRow.record_id}
                </Typography>
              )}
            </Box>
          )}
          {deleteError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {deleteError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setConfirmDeleteRow(null);
              setDeleteError(null);
            }}
            disabled={deleting}
          >
            {t("app.cancel")}
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={handleDeleteConfirm}
            disabled={deleting}
          >
            {deleting ? <CircularProgress size={18} /> : t("app.delete")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default TranslationsPanel;
