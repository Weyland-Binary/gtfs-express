/**
 * MergeStopsDialog — fold one duplicate stop into another, from the
 * Diagnostic's duplicate_stops finding. The user picks the survivor (the
 * dry-run shows what each side carries), then POST /edit/stops/merge
 * re-points every reference and deletes the duplicate in one undo step.
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Radio,
  Typography,
  alpha,
  useTheme,
} from "@mui/material";
import MergeTypeIcon from "@mui/icons-material/MergeType";
import EditIcon from "@mui/icons-material/Edit";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";

const dryRun = async (survivorId, duplicateId) => {
  const res = await fetchWithSession(`${API_BASE_URL}/edit/stops/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ survivor_id: survivorId, duplicate_ids: [duplicateId], dry_run: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
};

export default function MergeStopsDialog({ open, stopA, stopB, onClose, onMerged }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const { editing, entering, enterEditMode, recordEdit } = useEditMode();
  const [plans, setPlans] = useState(null); // { [survivorId]: dryRunBody }
  const [survivor, setSurvivor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || !stopA || !stopB || !editing) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPlans(null);
    Promise.all([dryRun(stopA, stopB), dryRun(stopB, stopA)])
      .then(([keepA, keepB]) => {
        if (cancelled) return;
        setPlans({ [stopA]: keepA, [stopB]: keepB });
        // Default survivor: the stop with the most stop_times (ties → A).
        const aRefs = keepB.duplicates?.[0]?.stop_times ?? 0; // A's own stop_times
        const bRefs = keepA.duplicates?.[0]?.stop_times ?? 0;
        setSurvivor(bRefs > aRefs ? stopB : stopA);
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, stopA, stopB, editing]);

  const merge = useCallback(async () => {
    if (!survivor || saving) return;
    const duplicate = survivor === stopA ? stopB : stopA;
    setSaving(true);
    setError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/stops/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ survivor_id: survivor, duplicate_ids: [duplicate] }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      recordEdit(t("chat.op.mergedToast", { count: body.merged ?? 1 }), body.validation, { entity: "stop", entityId: survivor });
      if (onMerged) onMerged(body);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }, [survivor, saving, stopA, stopB, recordEdit, t, onMerged, onClose]);

  const option = (id) => {
    const plan = plans?.[id];
    const other = plans?.[id === stopA ? stopB : stopA];
    const name = plan?.survivor?.stop_name || other?.duplicates?.[0]?.stop_name || id;
    const stopTimes = other?.duplicates?.[0]?.stop_times ?? 0;
    const refs = plan ? Object.values(plan.by_table || {}).reduce((a, b) => a + b, 0) : null;
    const on = survivor === id;
    return (
      <Box
        key={id}
        component="label"
        data-testid={`merge-keep-${id}`}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          p: 1,
          borderRadius: 2,
          cursor: "pointer",
          border: `1px solid ${alpha(on ? theme.palette.primary.main : theme.palette.divider, on ? 0.8 : 1)}`,
          background: on ? alpha(theme.palette.primary.main, 0.06) : "transparent",
        }}
      >
        <Radio size="small" checked={on} onChange={() => setSurvivor(id)} value={id} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: "0.86rem", fontWeight: 700 }} noWrap>
            {t("audit.merge.keep", { name })}
          </Typography>
          <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", fontFamily: "monospace" }} noWrap>
            {id}
          </Typography>
        </Box>
        <Chip size="small" label={t("chat.op.stopTimes", { count: stopTimes })} sx={{ height: 20, fontSize: "0.64rem" }} />
        {on && refs != null && <Chip size="small" color="primary" variant="outlined" label={t("audit.merge.refs", { count: refs })} sx={{ height: 20, fontSize: "0.64rem" }} />}
      </Box>
    );
  };

  const plan = survivor ? plans?.[survivor] : null;

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="xs" fullWidth data-testid="merge-stops-dialog">
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1, fontSize: "1.05rem", fontWeight: 800 }}>
        <MergeTypeIcon color="primary" />
        {t("audit.merge.title")}
      </DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
        <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", lineHeight: 1.5 }}>{t("audit.merge.body")}</Typography>
        {!editing ? (
          <Button
            variant="outlined"
            startIcon={entering ? <CircularProgress size={14} color="inherit" /> : <EditIcon />}
            disabled={entering}
            onClick={() => enterEditMode()}
            sx={{ alignSelf: "flex-start", textTransform: "none", fontWeight: 600 }}
          >
            {t("chat.blocked.enterEditMode")}
          </Button>
        ) : loading ? (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 1 }}>
            <CircularProgress size={18} />
            <Typography sx={{ fontSize: "0.8rem" }}>{t("audit.merge.loading")}</Typography>
          </Box>
        ) : (
          plans && (
            <>
              {option(stopA)}
              {option(stopB)}
              {plan && plan.trips_with_both > 0 && (
                <Alert severity="warning" sx={{ fontSize: "0.76rem", py: 0.25 }}>
                  {t("chat.op.mergeBoth", { count: plan.trips_with_both })}
                </Alert>
              )}
              {plan && plan.filled && Object.keys(plan.filled).length > 0 && (
                <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>{t("chat.op.mergeFilled", { fields: Object.keys(plan.filled).join(", ") })}</Typography>
              )}
            </>
          )
        )}
        {error && <Alert severity="error" sx={{ fontSize: "0.76rem", py: 0.25 }}>{error}</Alert>}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={saving} sx={{ textTransform: "none" }}>
          {t("app.cancel")}
        </Button>
        <Button
          variant="contained"
          disableElevation
          disabled={!editing || !survivor || loading || saving}
          onClick={merge}
          startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <MergeTypeIcon />}
          data-testid="merge-stops-confirm"
          sx={{ textTransform: "none", fontWeight: 700 }}
        >
          {t("audit.merge.confirm")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
