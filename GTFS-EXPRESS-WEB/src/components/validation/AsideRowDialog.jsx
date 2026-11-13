/**
 * A row the import kept aside, read and settled: its file and line, why the network could not hold it, its values with
 * the key fields to fill, what comes with it, and for a duplicate the version loaded beside it. Loading it or removing
 * it is one edit, undone like any other; until then every export gives the row back as it was read.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, TextField, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import UnarchiveRoundedIcon from "@mui/icons-material/UnarchiveRounded";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { refusalOf, refusalToAction } from "../../utils/refusalToAction";
import { countWords } from "../../utils/countWords";
import { discardAsideRow } from "../../utils/asideApi";
import DialogHeader from "../common/DialogHeader";

const isEmpty = (v) => v == null || String(v).trim() === "";

const reasonText = (reason, data, t) => {
  if (reason.kind === "missing") return t("validation.aside.reason.missing", { field: reason.field });
  if (reason.kind === "duplicate_key") return t("validation.aside.reason.duplicate");
  if (reason.kind === "trip_aside") return t("validation.aside.reason.follows", { trip: data.row?.trip_id || "" });
  return t("validation.aside.reason.constraint");
};

export default function AsideRowDialog({ open, asideId, highlightFields = [], onClose }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { recordEdit } = useEditMode();
  const [currentId, setCurrentId] = useState(asideId);
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [values, setValues] = useState({});
  const [allColumns, setAllColumns] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => setCurrentId(asideId), [asideId]);

  useEffect(() => {
    if (!open || currentId == null) return undefined;
    let alive = true;
    setState({ loading: true, data: null, error: null });
    setValues({});
    setError(null);
    fetchWithSession(`${API_BASE_URL}/edit/aside/${encodeURIComponent(currentId)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!alive) return;
        // The refusal is kept as answered and worded at render: the load depends on the row, never on the words.
        if (!res.ok) setState({ loading: false, data: null, error: refusalOf(body, res.status) });
        else setState({ loading: false, data: body, error: null });
      })
      .catch((err) => alive && setState({ loading: false, data: null, error: refusalOf(err) }));
    return () => {
      alive = false;
    };
  }, [open, currentId]);

  const data = state.data;
  const merged = useMemo(() => ({ ...(data?.row || {}), ...values }), [data, values]);
  const keys = data?.keys || [];
  const missing = keys.filter((k) => isEmpty(merged[k]));
  const duplicate = Boolean(data?.reasons?.some((r) => r.kind === "duplicate_key"));
  // A duplicate whose loaded version is gone is a row like any other: nothing to keep in its place.
  const pair = duplicate && Boolean(data?.loaded);
  const followsOnly = Boolean(data?.reasons?.length) && data.reasons.every((r) => r.kind === "trip_aside");
  const leader = followsOnly ? (data.group || []).find((g) => g.table === "trips") : null;
  const companions = (data?.group || []).filter((g) => g.reasons.every((r) => r.kind === "trip_aside"));
  const marked = new Set([...missing, ...highlightFields, ...(data?.reasons || []).map((r) => r.field).filter(Boolean)]);
  const columns = (data?.columns || []).filter((c) => allColumns || keys.includes(c) || marked.has(c) || !isEmpty(data.row?.[c]) || (duplicate && !isEmpty(data.loaded?.[c])));

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/aside/${encodeURIComponent(currentId)}/admit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const action = refusalToAction(refusalOf(body, res.status), t);
        setError(action.body || action.title);
        return;
      }
      recordEdit(body.swapped ? t("validation.aside.swapped") : countWords(t, "validation.aside.loaded", body.admitted, { count: body.admitted, file: data.file }), body.validation, { entity: "aside", entityId: String(currentId) });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // Removed from the delivered GTFS: a duplicate keeps the version loaded, a trip takes the calls that hung off it.
  const discard = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = await discardAsideRow(currentId);
      recordEdit(pair ? t("validation.aside.keptLoaded") : countWords(t, "validation.aside.discarded", body.discarded, { count: body.discarded, file: data.file }), body.validation, { entity: "aside", entityId: String(currentId) });
      onClose();
    } catch (err) {
      const action = refusalToAction(refusalOf(err), t);
      setError(action.body || action.title);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth={duplicate ? "md" : "sm"} fullWidth data-testid="aside-row-dialog">
      <DialogHeader
        icon={<UnarchiveRoundedIcon />}
        title={t("validation.aside.title")}
        subtitle={data ? t("validation.aside.where", { file: data.file, line: data.line }) : null}
        onClose={onClose}
        closeDisabled={saving}
      />
      <DialogContent sx={{ pt: 1 }}>
        {state.loading && (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        )}
        {state.error && <Alert severity="error">{refusalToAction(state.error, t).body || refusalToAction(state.error, t).title}</Alert>}
        {data && (
          <>
            <Box sx={{ mb: 1.5 }} data-testid="aside-row-reasons">
              {data.reasons.map((r, i) => (
                <Typography key={i} sx={{ fontSize: "0.88rem", fontWeight: 600 }}>
                  {reasonText(r, data, t)}
                </Typography>
              ))}
              <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", mt: 0.5 }}>{t("validation.aside.kept")}</Typography>
            </Box>

            {leader ? (
              <Button variant="outlined" onClick={() => setCurrentId(leader.id)} data-testid="aside-open-trip" sx={{ textTransform: "none", fontWeight: 700 }}>
                {t("validation.aside.openTrip", { trip: data.row?.trip_id || "" })}
              </Button>
            ) : (
              <>
                {duplicate && data.loaded && (
                  <Box sx={{ display: "grid", gridTemplateColumns: "minmax(120px, 0.6fr) 1fr 1fr", gap: 1, alignItems: "center", mb: 1, px: 0.5 }}>
                    <span />
                    <Typography sx={{ fontSize: "0.72rem", fontWeight: 750, textTransform: "uppercase", letterSpacing: "0.05em", color: "text.secondary" }}>{t("validation.aside.loadedVersion")}</Typography>
                    <Typography sx={{ fontSize: "0.72rem", fontWeight: 750, textTransform: "uppercase", letterSpacing: "0.05em", color: "text.secondary" }}>{t("validation.aside.thisVersion")}</Typography>
                  </Box>
                )}
                <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }} data-testid="aside-row-fields">
                  {columns.map((c) => {
                    const isKey = keys.includes(c);
                    const empty = isKey && isEmpty(merged[c]);
                    const field = (
                      <TextField
                        size="small"
                        fullWidth
                        label={duplicate ? undefined : c}
                        value={merged[c] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [c]: e.target.value }))}
                        required={isKey}
                        error={empty}
                        inputProps={{ "data-testid": `aside-field-${c}` }}
                        sx={marked.has(c) ? { "& .MuiOutlinedInput-root": { backgroundColor: alpha(theme.palette.warning.main, 0.08) } } : undefined}
                      />
                    );
                    if (!duplicate || !data.loaded) return <Box key={c}>{field}</Box>;
                    return (
                      <Box key={c} sx={{ display: "grid", gridTemplateColumns: "minmax(120px, 0.6fr) 1fr 1fr", gap: 1, alignItems: "center" }}>
                        <Typography sx={{ fontSize: "0.8rem", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis" }}>{c}</Typography>
                        <Typography sx={{ fontSize: "0.85rem", color: String(data.loaded[c] ?? "") !== String(merged[c] ?? "") ? "warning.dark" : "text.secondary" }}>{data.loaded[c] ?? ""}</Typography>
                        {field}
                      </Box>
                    );
                  })}
                </Box>
                <Button size="small" onClick={() => setAllColumns((v) => !v)} sx={{ mt: 1, textTransform: "none", color: "text.secondary" }}>
                  {t(allColumns ? "validation.aside.lessColumns" : "validation.aside.allColumns")}
                </Button>
                {companions.length > 0 && (
                  <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", mt: 1 }} data-testid="aside-row-group">
                    {countWords(t, "validation.aside.group", companions.length, { count: companions.length, file: companions[0].file })}
                  </Typography>
                )}
              </>
            )}
            {error && (
              <Alert severity="error" sx={{ mt: 1.5 }}>
                {error}
              </Alert>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {data && !leader && !pair && (
          <Button color="error" onClick={discard} disabled={saving} data-testid="aside-row-discard" sx={{ textTransform: "none", mr: "auto" }}>
            {t("validation.aside.discard")}
          </Button>
        )}
        <Button onClick={onClose} disabled={saving} sx={{ textTransform: "none" }}>
          {t("app.cancel")}
        </Button>
        {data && !leader && pair && (
          <>
            <Button variant="outlined" onClick={submit} disabled={saving || missing.length > 0} data-testid="aside-row-load" sx={{ textTransform: "none", fontWeight: 600 }}>
              {t("validation.aside.useThis")}
            </Button>
            <Button variant="contained" disableElevation onClick={discard} disabled={saving} data-testid="aside-row-keep-loaded" sx={{ textTransform: "none", fontWeight: 700 }}>
              {t("validation.aside.keepLoaded")}
            </Button>
          </>
        )}
        {data && !leader && !pair && (
          <Button variant="contained" disableElevation onClick={submit} disabled={saving || missing.length > 0} data-testid="aside-row-load" sx={{ textTransform: "none", fontWeight: 700 }}>
            {saving ? t("validation.aside.loading") : t("validation.aside.load")}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
