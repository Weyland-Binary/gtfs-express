import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Box,
  Typography,
  Button,
  Alert,
  CircularProgress,
  Chip,
  Tooltip,
  IconButton,
  TextField,
  InputAdornment,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Link,
  Stack,
} from "@mui/material";
import { useTheme, alpha } from "@mui/material/styles";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import AddIcon from "@mui/icons-material/Add";
import EditIcon from "@mui/icons-material/Edit";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import LanguageIcon from "@mui/icons-material/Language";
import EmailIcon from "@mui/icons-material/Email";
import PhoneIcon from "@mui/icons-material/Phone";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import SearchIcon from "@mui/icons-material/Search";
import CloseIcon from "@mui/icons-material/Close";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import EditAttributionDialog from "../edit/EditAttributionDialog";

const SPEC_URL =
  "https://gtfs.org/documentation/schedule/reference/#attributionstxt";

/**
 * Compute the human-readable target descriptor for an attribution row.
 * Returns one of:
 *   { kind: "feed" }
 *   { kind: "agency", id: "AG_1" }
 *   { kind: "route",  id: "R42"  }
 *   { kind: "trip",   id: "T7"   }
 */
function describeTarget(row) {
  if (row.agency_id) return { kind: "agency", id: row.agency_id };
  if (row.route_id) return { kind: "route", id: row.route_id };
  if (row.trip_id) return { kind: "trip", id: row.trip_id };
  return { kind: "feed", id: null };
}

/**
 * AttributionsPanel — side panel content for attributions.txt management.
 * Rendered inside DetailPanel when entity.type === "attributions".
 *
 * The attributions table credits data producers, operators and authorities,
 * either feed-wide or scoped to a specific agency / route / trip
 * (see GTFS spec — mutual exclusivity is enforced server-side).
 */
function AttributionsPanel() {
  const { t } = useLanguage();
  const { editing, recordEdit, dataVersion } = useEditMode();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { openPanel } = useDetailPanel();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
  const [filterText, setFilterText] = useState("");

  const [editTarget, setEditTarget] = useState(null); // { mode, initial }
  const [confirmDeleteRow, setConfirmDeleteRow] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/attributions`, { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to load attributions");
      }
      const data = await res.json();
      const all = Array.isArray(data)
        ? data
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.attributions)
            ? data.attributions
            : [];
      setRows(all);
    } catch (err) {
      setFetchError(err.message || "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll, dataVersion]);

  const filteredRows = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [
        r.attribution_id,
        r.organization_name,
        r.agency_id,
        r.route_id,
        r.trip_id,
        r.attribution_email,
        r.attribution_url,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [rows, filterText]);

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
        `${API_BASE_URL}/edit/attributions/${row.id}`,
        { method: "DELETE" },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Delete failed");
      }
      recordEdit(t("attributions.deletedToast"), body.validation, {
        entity: "attribution",
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
  };

  // ── DataTable column templates ─────────────────────────────────────────

  const idBody = (row) => {
    if (!row.attribution_id) {
      return (
        <Typography
          component="span"
          variant="caption"
          sx={{ opacity: 0.4, fontFamily: "monospace" }}
        >
          —
        </Typography>
      );
    }
    return (
      <Tooltip title={`attribution_id: ${row.attribution_id}`}>
        <Chip
          label={row.attribution_id}
          size="small"
          icon={<ContentCopyIcon sx={{ fontSize: "11px !important" }} />}
          onClick={() => navigator.clipboard.writeText(row.attribution_id)}
          sx={{
            fontFamily: "monospace",
            fontSize: 10,
            height: 20,
            maxWidth: 140,
            cursor: "pointer",
          }}
        />
      </Tooltip>
    );
  };

  const targetBody = (row) => {
    const tgt = describeTarget(row);
    if (tgt.kind === "feed") {
      return (
        <Chip
          label={t("attributions.targetFeed")}
          size="small"
          sx={{
            fontSize: 10,
            height: 20,
            background: alpha(theme.palette.info.main, isDark ? 0.18 : 0.12),
            color: theme.palette.info.main,
            fontWeight: 600,
          }}
        />
      );
    }
    const colorMap = {
      agency: theme.palette.secondary.main,
      route: theme.palette.primary.main,
      trip: theme.palette.success.main,
    };
    const accent = colorMap[tgt.kind];
    const labelMap = {
      agency: t("attributions.targetAgency"),
      route: t("attributions.targetRoute"),
      trip: t("attributions.targetTrip"),
    };
    const navTypeMap = { agency: null, route: "route", trip: "trip" };
    const navType = navTypeMap[tgt.kind];
    return (
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
        <Chip
          label={labelMap[tgt.kind]}
          size="small"
          sx={{
            fontSize: 9,
            height: 16,
            alignSelf: "flex-start",
            background: alpha(accent, isDark ? 0.18 : 0.12),
            color: accent,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        />
        <Tooltip title={navType ? t("app.openStop") : tgt.id}>
          <Typography
            variant="body2"
            fontFamily="monospace"
            fontSize={11}
            noWrap
            onClick={
              navType
                ? () => openPanel(navType, tgt.id)
                : undefined
            }
            sx={{
              cursor: navType ? "pointer" : "default",
              "&:hover": navType
                ? { textDecoration: "underline", color: accent }
                : {},
            }}
          >
            {tgt.id}
          </Typography>
        </Tooltip>
      </Box>
    );
  };

  const orgBody = (row) => (
    <Typography
      variant="body2"
      sx={{
        fontSize: 12,
        fontWeight: 500,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
      title={row.organization_name}
    >
      {row.organization_name}
    </Typography>
  );

  const rolesBody = (row) => {
    const roles = [
      { key: "is_producer", label: t("attributions.roleProducer"), active: Number(row.is_producer) === 1 },
      { key: "is_operator", label: t("attributions.roleOperator"), active: Number(row.is_operator) === 1 },
      { key: "is_authority", label: t("attributions.roleAuthority"), active: Number(row.is_authority) === 1 },
    ];
    return (
      <Stack direction="row" spacing={0.5}>
        {roles.map((r) => (
          <Tooltip key={r.key} title={r.key}>
            <Chip
              label={r.label}
              size="small"
              sx={{
                fontSize: 9,
                height: 18,
                fontWeight: 700,
                letterSpacing: "0.04em",
                color: r.active
                  ? theme.palette.primary.contrastText
                  : theme.palette.text.disabled,
                background: r.active
                  ? theme.palette.primary.main
                  : alpha(theme.palette.text.primary, isDark ? 0.06 : 0.04),
                opacity: r.active ? 1 : 0.55,
                "& .MuiChip-label": { px: 0.75 },
              }}
            />
          </Tooltip>
        ))}
      </Stack>
    );
  };

  const contactBody = (row) => {
    const items = [];
    if (row.attribution_url) {
      items.push(
        <Tooltip key="url" title={row.attribution_url}>
          <IconButton
            component="a"
            href={row.attribution_url}
            target="_blank"
            rel="noreferrer"
            size="small"
            sx={{ p: 0.25 }}
            onClick={(e) => e.stopPropagation()}
          >
            <LanguageIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>,
      );
    }
    if (row.attribution_email) {
      items.push(
        <Tooltip key="email" title={row.attribution_email}>
          <IconButton
            component="a"
            href={`mailto:${row.attribution_email}`}
            size="small"
            sx={{ p: 0.25 }}
            onClick={(e) => e.stopPropagation()}
          >
            <EmailIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>,
      );
    }
    if (row.attribution_phone) {
      items.push(
        <Tooltip key="phone" title={row.attribution_phone}>
          <IconButton
            component="a"
            href={`tel:${row.attribution_phone}`}
            size="small"
            sx={{ p: 0.25 }}
            onClick={(e) => e.stopPropagation()}
          >
            <PhoneIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>,
      );
    }
    if (items.length === 0) {
      return (
        <Typography
          component="span"
          variant="caption"
          sx={{ opacity: 0.4, fontFamily: "monospace" }}
        >
          —
        </Typography>
      );
    }
    return <Box sx={{ display: "flex", gap: 0.25 }}>{items}</Box>;
  };

  const actionsBody = (row) => (
    <Box sx={{ display: "flex", gap: 0.25 }}>
      <Tooltip title={t("app.edit")}>
        <IconButton
          size="small"
          onClick={() => setEditTarget({ mode: "edit", initial: row })}
          sx={{ p: 0.25 }}
        >
          <EditIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Tooltip>
      <Tooltip title={t("app.delete")}>
        <IconButton
          size="small"
          color="error"
          onClick={() => handleDeleteRequest(row)}
          sx={{ p: 0.25 }}
        >
          <DeleteOutlineIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        height: "100%",
        gap: 1,
      }}
    >
      {/* Subtitle */}
      <Typography variant="caption" color="text.secondary" sx={{ mt: -0.5 }}>
        {t("attributions.subtitle")}
      </Typography>

      {/* Sticky toolbar: filter + add button */}
      <Box
        sx={{
          position: "sticky",
          top: 0,
          zIndex: 2,
          background: theme.palette.background.paper,
          pt: 0.5,
          pb: 1,
          display: "flex",
          gap: 1,
          alignItems: "center",
        }}
      >
        <TextField
          size="small"
          fullWidth
          placeholder={t("attributions.filterPlaceholder")}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
            endAdornment: filterText ? (
              <InputAdornment position="end">
                <IconButton size="small" onClick={() => setFilterText("")}>
                  <CloseIcon fontSize="small" />
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
            onClick={() => setEditTarget({ mode: "create" })}
            sx={{ flexShrink: 0 }}
          >
            {t("attributions.addBtn")}
          </Button>
        )}
      </Box>

      {/* Count badge */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Chip
          label={
            filterText && filteredRows.length !== rows.length
              ? `${filteredRows.length} / ${rows.length}`
              : `${rows.length}`
          }
          size="small"
          variant="outlined"
        />
      </Box>

      {fetchError && (
        <Alert
          severity="error"
          action={
            <Button size="small" color="inherit" onClick={loadAll}>
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
            {t("attributions.loading")}
          </Typography>
        </Box>
      )}

      {/* Empty state */}
      {!loading && !fetchError && rows.length === 0 && (
        <Box sx={{ py: 4, textAlign: "center" }}>
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
            {t("attributions.empty")}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.5 }}>
            {t("attributions.emptyHint")}
          </Typography>
          <Link
            href={SPEC_URL}
            target="_blank"
            rel="noreferrer"
            variant="caption"
            sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontFamily: "monospace" }}
          >
            {t("attributions.specLink")}
            <OpenInNewIcon sx={{ fontSize: 12 }} />
          </Link>
        </Box>
      )}

      {!loading && rows.length > 0 && filteredRows.length === 0 && (
        <Typography
          variant="body2"
          color="text.secondary"
          textAlign="center"
          sx={{ py: 3 }}
        >
          {t("attributions.noMatch")}
        </Typography>
      )}

      {/* DataTable */}
      {!loading && filteredRows.length > 0 && (
        <Box
          sx={{
            flex: 1,
            overflow: "auto",
            minHeight: 0,
            width: "100%",
            "& .p-datatable-thead > tr > th": {
              position: "sticky",
              top: 0,
              zIndex: 2,
              padding: "3px 8px !important",
              fontSize: "11px !important",
              lineHeight: 1.4,
              backgroundColor:
                theme.palette.mode === "dark"
                  ? theme.palette.grey[900]
                  : theme.palette.grey[100],
              color: theme.palette.text.primary,
              borderBottom: `1px solid ${theme.palette.divider}`,
            },
            "& .p-datatable-tbody > tr > td": {
              padding: "4px 8px !important",
              backgroundColor: theme.palette.background.paper,
            },
            "& .p-datatable": { width: "100%" },
            "& .p-datatable table": { width: "100%" },
          }}
        >
          <DataTable
            value={filteredRows}
            size="small"
            style={{ fontSize: 12, width: "100%" }}
            emptyMessage={t("attributions.empty")}
            rowHover
          >
            <Column
              field="attribution_id"
              header={t("attributions.colId")}
              body={idBody}
              style={{ width: 130 }}
            />
            <Column
              header={t("attributions.colTarget")}
              body={targetBody}
              style={{ width: 140 }}
            />
            <Column
              field="organization_name"
              header={t("attributions.colOrganization")}
              body={orgBody}
              style={{ flex: 1, minWidth: 140 }}
            />
            <Column
              header={t("attributions.colRoles")}
              body={rolesBody}
              style={{ width: 220 }}
            />
            <Column
              header={t("attributions.colContact")}
              body={contactBody}
              style={{ width: 80 }}
            />
            {editing && (
              <Column
                header={t("attributions.colActions")}
                body={actionsBody}
                style={{ width: 64 }}
              />
            )}
          </DataTable>
        </Box>
      )}

      {/* Edit / create dialog */}
      {editTarget && (
        <EditAttributionDialog
          open
          mode={editTarget.mode}
          initial={editTarget.initial}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            handleSaved();
          }}
        />
      )}

      {/* Delete confirmation dialog */}
      <Dialog
        open={Boolean(confirmDeleteRow)}
        onClose={() => setConfirmDeleteRow(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t("attributions.deleteConfirm")}</DialogTitle>
        <DialogContent>
          {confirmDeleteRow && (
            <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
              <Typography variant="body2">
                {confirmDeleteRow.organization_name}
              </Typography>
              {confirmDeleteRow.attribution_id && (
                <Typography
                  variant="caption"
                  fontFamily="monospace"
                  color="text.secondary"
                >
                  attribution_id: {confirmDeleteRow.attribution_id}
                </Typography>
              )}
              <Typography
                variant="caption"
                fontFamily="monospace"
                color="text.secondary"
              >
                #{confirmDeleteRow.id}
              </Typography>
            </Box>
          )}
          {deleteError && (
            <Alert severity="warning" sx={{ mt: 2 }}>
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

export default AttributionsPanel;
