import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  Box,
  Typography,
  TextField,
  InputAdornment,
  IconButton,
  Button,
  Chip,
  CircularProgress,
  Alert,
  Tooltip,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import SearchIcon from "@mui/icons-material/Search";
import CloseIcon from "@mui/icons-material/Close";
import AddIcon from "@mui/icons-material/Add";
import EditIcon from "@mui/icons-material/Edit";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import EditTransferDialog from "../edit/EditTransferDialog";
import { useDetailPanel } from "../../contexts/DetailPanelContext";

/** Format seconds into a human-readable string: 60→"1 min", 90→"1 min 30s", 30→"30s" */
function formatMinTime(seconds) {
  if (seconds == null) return "—";
  const s = Number(seconds);
  if (isNaN(s)) return `${seconds}s`;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m} min ${rem}s` : `${m} min`;
}

const TRANSFER_TYPE_COLOR = {
  0: "default",
  1: "primary",
  2: "warning",
  3: "error",
  4: "success",
  5: "info",
};

/**
 * TransfersPanel — side panel content for transfers.txt management.
 * Rendered inside DetailPanel when entity.type === "transfers".
 * No Dialog wrapper — sticky filter bar at top, scrollable list in middle.
 */
function TransfersPanel() {
  const { t } = useLanguage();
  const { editing, dataVersion } = useEditMode();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { openPanel } = useDetailPanel();

  const [transfers, setTransfers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
  const [filterText, setFilterText] = useState("");
  const [editTarget, setEditTarget] = useState(null);

  const loadTransfers = useCallback(() => {
    setLoading(true);
    setFetchError(null);
    const controller = new AbortController();
    fetchWithSession(`${API_BASE_URL}/edit/transfers`, { signal: controller.signal, cache: "no-store" })
      .then((r) => {
        if (!r.ok) return r.json().then((b) => Promise.reject(new Error(b.error || "Fetch error")));
        return r.json();
      })
      // API returns { data: [...] }
      .then((data) => setTransfers(Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : []))
      .catch((err) => {
        if (err.name !== "AbortError") setFetchError(err.message || "Network error");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    return loadTransfers();
  }, [loadTransfers, dataVersion]);

  const filtered = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return transfers;
    return transfers.filter((tr) =>
      [
        tr.from_stop_id,
        tr.to_stop_id,
        tr.from_route_id,
        tr.to_route_id,
        tr.from_trip_id,
        tr.to_trip_id,
      ]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(q)),
    );
  }, [transfers, filterText]);

  const typeLabel = (typeVal) => t(`transfers.type.${typeVal}`);

  const headerBg = isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.025)";

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
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
          placeholder={t("transfers.filterPlaceholder")}
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
            {t("transfers.addBtn")}
          </Button>
        )}
      </Box>

      {/* Count badge */}
      <Box sx={{ mb: 1, display: "flex", alignItems: "center", gap: 1 }}>
        <Chip
          label={
            filterText && filtered.length !== transfers.length
              ? `${filtered.length} / ${transfers.length}`
              : t("transfers.countBadge").replace("{count}", filtered.length)
          }
          size="small"
          variant="outlined"
        />
      </Box>

      {/* Loading / error / empty states */}
      {loading && (
        <Box display="flex" alignItems="center" gap={2} justifyContent="center" py={4}>
          <CircularProgress size={20} aria-busy="true" />
          <Typography variant="body2" color="text.secondary">
            {t("transfers.loading")}
          </Typography>
        </Box>
      )}

      {fetchError && (
        <Alert
          severity="error"
          action={
            <Button size="small" color="inherit" onClick={loadTransfers}>
              {t("app.retry")}
            </Button>
          }
          sx={{ mb: 1 }}
        >
          {fetchError}
        </Alert>
      )}

      {!loading && !fetchError && filtered.length === 0 && (
        <Typography variant="body2" color="text.secondary" textAlign="center" sx={{ py: 3 }}>
          {transfers.length === 0
            ? editing
              ? t("transfers.emptyState")
              : t("transfers.emptyStateReadOnly")
            : t("transfers.noMatch")}
        </Typography>
      )}

      {/* Table */}
      {!loading && !fetchError && filtered.length > 0 && (
        <Box>
          {/* Column header */}
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: editing ? "1fr 1fr 160px 80px 36px" : "1fr 1fr 160px 80px",
              px: 1,
              py: 0.75,
              borderBottom: `1px solid ${theme.palette.divider}`,
              background: headerBg,
              position: "sticky",
              top: 60,
              zIndex: 1,
            }}
          >
            {[
              t("transfers.colFrom"),
              t("transfers.colTo"),
              t("transfers.colType"),
              t("transfers.colMinTime"),
              ...(editing ? [""] : []),
            ].map((h, i) => (
              <Typography
                key={i}
                variant="caption"
                sx={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "text.secondary" }}
              >
                {h}
              </Typography>
            ))}
          </Box>

          {filtered.map((tr) => (
            <Box
              key={tr.id}
              sx={{
                display: "grid",
                gridTemplateColumns: editing ? "1fr 1fr 160px 80px 36px" : "1fr 1fr 160px 80px",
                px: 1,
                py: 0.85,
                alignItems: "center",
                borderBottom: `1px solid ${theme.palette.divider}`,
                "&:hover": {
                  background: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.025)",
                },
              }}
            >
              {/* From */}
              <Box sx={{ minWidth: 0 }}>
                {tr.from_stop_id && (
                  <Tooltip title={t("app.openStop")}>
                    <Typography
                      variant="body2"
                      fontFamily="monospace"
                      fontSize={11}
                      noWrap
                      onClick={() => openPanel({ type: "stop", id: tr.from_stop_id })}
                      sx={{ cursor: "pointer", "&:hover": { textDecoration: "underline", color: "primary.main" } }}
                    >
                      {tr.from_stop_id}
                    </Typography>
                  </Tooltip>
                )}
                {tr.from_route_id && (
                  <Typography variant="caption" color="text.secondary" fontFamily="monospace" noWrap display="block">
                    route: {tr.from_route_id}
                  </Typography>
                )}
                {tr.from_trip_id && (
                  <Typography variant="caption" color="text.secondary" fontFamily="monospace" noWrap display="block">
                    trip: {tr.from_trip_id}
                  </Typography>
                )}
              </Box>

              {/* To */}
              <Box sx={{ minWidth: 0 }}>
                {tr.to_stop_id && (
                  <Tooltip title={t("app.openStop")}>
                    <Typography
                      variant="body2"
                      fontFamily="monospace"
                      fontSize={11}
                      noWrap
                      onClick={() => openPanel({ type: "stop", id: tr.to_stop_id })}
                      sx={{ cursor: "pointer", "&:hover": { textDecoration: "underline", color: "primary.main" } }}
                    >
                      {tr.to_stop_id}
                    </Typography>
                  </Tooltip>
                )}
                {tr.to_route_id && (
                  <Typography variant="caption" color="text.secondary" fontFamily="monospace" noWrap display="block">
                    route: {tr.to_route_id}
                  </Typography>
                )}
                {tr.to_trip_id && (
                  <Typography variant="caption" color="text.secondary" fontFamily="monospace" noWrap display="block">
                    trip: {tr.to_trip_id}
                  </Typography>
                )}
              </Box>

              {/* Type */}
              <Tooltip title={typeLabel(tr.transfer_type)}>
                <Chip
                  label={`${tr.transfer_type} — ${typeLabel(tr.transfer_type)}`}
                  size="small"
                  color={TRANSFER_TYPE_COLOR[tr.transfer_type] ?? "default"}
                  sx={{ fontSize: 10, maxWidth: 155 }}
                />
              </Tooltip>

              {/* Min time — formatted human-readable */}
              <Tooltip title={tr.min_transfer_time != null ? `${tr.min_transfer_time}s` : ""}>
                <Typography variant="body2" fontFamily="monospace" fontSize={11}>
                  {formatMinTime(tr.min_transfer_time)}
                </Typography>
              </Tooltip>

              {/* Edit action */}
              {editing && (
                <Tooltip title={t("transfers.dialogTitleEdit")}>
                  <IconButton
                    size="small"
                    aria-label={t("transfers.dialogTitleEdit")}
                    onClick={() => setEditTarget({ mode: "edit", initial: tr })}
                  >
                    <EditIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
            </Box>
          ))}
        </Box>
      )}

      {/* Edit / create sub-dialog — modal overlay on top of the panel */}
      {editTarget && (
        <EditTransferDialog
          open
          mode={editTarget.mode}
          initial={editTarget.initial}
          onClose={() => setEditTarget(null)}
          onSaved={() => setEditTarget(null)}
        />
      )}
    </Box>
  );
}

export default TransfersPanel;
