import React, { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  CircularProgress,
  Alert,
  Chip,
  Divider,
  LinearProgress,
  Checkbox,
  FormControlLabel,
} from "@mui/material";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import DeleteForeverIcon from "@mui/icons-material/DeleteForever";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";

/**
 * Generic "before delete" preview + confirm dialog.
 *
 * Fetches GET /edit/preview/{entity}/{id} which returns:
 *   { entity, id, cascade: { trips, stop_times, transfers, ... },
 *     orphans: { shapes, services, ... }, warnings: [] }
 *
 * Props:
 *   open        — bool
 *   entity      — "route" | "stop" | "trip" | "service"
 *   entityId    — id to delete
 *   entityLabel — display string shown in the header (optional)
 *   onCancel    — close callback
 *   onConfirm   — called after the user confirms (parent actually runs DELETE)
 */

const ENTITY_META = {
  route: {
    color: "error",
    labelKey: "cascade.entity.route",
  },
  stop: {
    color: "error",
    labelKey: "cascade.entity.stop",
  },
  trip: {
    color: "error",
    labelKey: "cascade.entity.trip",
  },
  service: {
    color: "error",
    labelKey: "cascade.entity.service",
  },
};

function Row({ label, count, danger }) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        py: 0.6,
        px: 1,
        borderRadius: 1,
        background: (theme) =>
          danger
            ? theme.palette.mode === "dark"
              ? "rgba(239, 83, 80, 0.08)"
              : "rgba(239, 83, 80, 0.06)"
            : "transparent",
      }}
    >
      <Typography variant="body2" sx={{ fontSize: 13 }}>
        {label}
      </Typography>
      <Chip
        size="small"
        label={count.toLocaleString()}
        color={count > 0 ? (danger ? "error" : "default") : "default"}
        sx={{
          height: 20,
          fontSize: 11,
          fontWeight: 700,
          fontFamily: "monospace",
          minWidth: 42,
        }}
      />
    </Box>
  );
}

function CascadePreviewDialog({
  open,
  entity,
  entityId,
  entityLabel,
  onCancel,
  onConfirm,
}) {
  const { t } = useLanguage();
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [executing, setExecuting] = useState(false);

  useEffect(() => {
    if (!open || !entity || !entityId) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setPreview(null);
    setError(null);
    setConfirmChecked(false);
    fetchWithSession(
      `${API_BASE_URL}/edit/preview/${entity}/${encodeURIComponent(entityId)}`,
      { signal: controller.signal },
    )
      .then((r) => r.json().then((body) => ({ ok: r.ok, body })))
      .then(({ ok, body }) => {
        if (!ok) {
          setError(body.error || t("cascade.loadError"));
          return;
        }
        setPreview(body);
      })
      .catch((err) => {
        if (err.name !== "AbortError") setError(err.message || "Network error");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [open, entity, entityId, t]);

  const meta = ENTITY_META[entity] || ENTITY_META.route;

  const totalAffected = useMemo(() => {
    if (!preview) return 0;
    const cascade = preview.cascade || {};
    return Object.values(cascade).reduce(
      (acc, v) => acc + (typeof v === "number" ? v : 0),
      0,
    );
  }, [preview]);

  const handleConfirm = async () => {
    setExecuting(true);
    try {
      await onConfirm?.();
    } finally {
      setExecuting(false);
    }
  };

  const cascadeRows = preview?.cascade
    ? Object.entries(preview.cascade).filter(([, v]) => typeof v === "number")
    : [];
  const orphanRows = preview?.orphans
    ? Object.entries(preview.orphans).filter(([, v]) => typeof v === "number")
    : [];

  return (
    <Dialog
      open={open}
      onClose={executing ? undefined : onCancel}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: {
          borderTop: (theme) => `3px solid ${theme.palette.error.main}`,
          borderRadius: 2,
        },
      }}
    >
      <DialogTitle sx={{ pb: 1 }}>
        <Box display="flex" alignItems="center" gap={1.25}>
          <Box
            sx={{
              width: 36,
              height: 36,
              borderRadius: 1.5,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: (theme) =>
                theme.palette.mode === "dark"
                  ? "rgba(239,83,80,0.18)"
                  : "rgba(239,83,80,0.12)",
              color: "error.main",
            }}
          >
            <WarningAmberIcon />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={700} lineHeight={1.2}>
              {t("cascade.title", { entity: t(meta.labelKey) })}
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontFamily: "monospace", display: "block", mt: 0.25 }}
            >
              {entityLabel || entityId}
            </Typography>
          </Box>
        </Box>
      </DialogTitle>
      <DialogContent dividers sx={{ pt: 1.5 }}>
        {loading && <LinearProgress />}
        {error && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {error}
          </Alert>
        )}
        {preview && (
          <Box display="flex" flexDirection="column" gap={1.25}>
            <Alert severity="warning" icon={<DeleteForeverIcon />}>
              {t("cascade.irreversible")}
            </Alert>

            {cascadeRows.length > 0 && (
              <Box>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    fontWeight: 700,
                    fontSize: 10,
                    mb: 0.5,
                    display: "block",
                  }}
                >
                  {t("cascade.deletedEntities")}
                </Typography>
                <Box
                  sx={{
                    border: "1px solid",
                    borderColor: "divider",
                    borderRadius: 1,
                    overflow: "hidden",
                  }}
                >
                  {cascadeRows.map(([key, val]) => (
                    <Row
                      key={key}
                      label={t(`cascade.table.${key}`, {
                        defaultValue: key,
                      })}
                      count={val}
                      danger
                    />
                  ))}
                </Box>
              </Box>
            )}

            {orphanRows.length > 0 && (
              <Box>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    fontWeight: 700,
                    fontSize: 10,
                    mb: 0.5,
                    display: "block",
                  }}
                >
                  {t("cascade.orphans")}
                </Typography>
                <Box
                  sx={{
                    border: "1px solid",
                    borderColor: "divider",
                    borderRadius: 1,
                    overflow: "hidden",
                  }}
                >
                  {orphanRows.map(([key, val]) => (
                    <Row
                      key={key}
                      label={t(`cascade.table.${key}`, {
                        defaultValue: key,
                      })}
                      count={val}
                    />
                  ))}
                </Box>
              </Box>
            )}

            {Array.isArray(preview.warnings) && preview.warnings.length > 0 && (
              <Box sx={{ mt: 0.5 }}>
                {preview.warnings.map((w, i) => (
                  <Alert
                    key={i}
                    severity="warning"
                    sx={{ mb: 0.5, fontSize: 12 }}
                  >
                    {w}
                  </Alert>
                ))}
              </Box>
            )}

            <Divider sx={{ my: 1 }} />
            <FormControlLabel
              control={
                <Checkbox
                  checked={confirmChecked}
                  onChange={(e) => setConfirmChecked(e.target.checked)}
                  color="error"
                />
              }
              label={
                <Typography variant="body2" fontWeight={600}>
                  {t("cascade.confirmCheckbox", {
                    count: totalAffected.toLocaleString(),
                  })}
                </Typography>
              }
            />
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button
          onClick={onCancel}
          disabled={executing}
          color="inherit"
        >
          {t("app.cancel")}
        </Button>
        <Button
          onClick={handleConfirm}
          variant="contained"
          color="error"
          disabled={!preview || !confirmChecked || loading || executing}
          startIcon={
            executing ? (
              <CircularProgress size={14} color="inherit" />
            ) : (
              <DeleteForeverIcon />
            )
          }
        >
          {executing ? t("cascade.deleting") : t("cascade.confirmBtn")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default CascadePreviewDialog;
