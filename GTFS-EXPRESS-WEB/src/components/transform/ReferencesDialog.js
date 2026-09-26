/**
 * ReferencesDialog — other operators' timetables the changes must fit (the
 * regional trains at the station, a coach network): added from a public
 * GTFS URL, kept only where they call near the network, read-only. The
 * change planner reads them to align connections.
 */

import React, { useCallback, useEffect, useState } from "react";
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, TextField, Typography } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { useLanguage } from "../../contexts/LanguageContext";
import { fetchReferences, addReference, removeReference } from "../../utils/transformApi";

const fmtDate = (ymd) => (ymd ? `${ymd.slice(6, 8)}/${ymd.slice(4, 6)}/${ymd.slice(0, 4)}` : "—");

export default function ReferencesDialog({ open, onClose, onChange }) {
  const { t } = useLanguage();
  const [list, setList] = useState([]);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    fetchReferences()
      .then((d) => setList(d.references || []))
      .catch((err) => setError(err.message));
  }, []);
  useEffect(() => {
    if (open) {
      setError(null);
      load();
    }
  }, [open, load]);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await addReference({ url: url.trim(), name: name.trim() || undefined });
      setUrl("");
      setName("");
      load();
      onChange?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id) => {
    try {
      await removeReference(id);
      load();
      onChange?.();
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth data-testid="change-references">
      <DialogTitle sx={{ fontWeight: 800 }}>{t("transform.references.title")}</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
        <Typography sx={{ fontSize: "0.78rem", color: "text.secondary" }}>{t("transform.references.hint")}</Typography>
        {error && <Alert severity="warning" sx={{ py: 0 }}>{error}</Alert>}
        {list.map((r) => (
          <Box key={r.id} data-testid="change-reference" sx={{ display: "flex", alignItems: "center", gap: 1, p: 1, borderRadius: "10px", boxShadow: (th) => `0 0 0 1px ${th.palette.divider}` }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontSize: "0.82rem", fontWeight: 700 }} noWrap>
                {r.name}
              </Typography>
              <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }}>
                {t("transform.references.meta", { agencies: (r.agencies || []).join(", ") || "—", trips: r.counts?.trips ?? 0, from: fmtDate(r.validity?.start), to: fmtDate(r.validity?.end) })}
              </Typography>
            </Box>
            <IconButton size="small" onClick={() => remove(r.id)} aria-label={t("transform.references.remove")}>
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </Box>
        ))}
        {!list.length && <Typography sx={{ fontSize: "0.76rem", color: "text.secondary" }}>{t("transform.references.none")}</Typography>}
        <TextField size="small" label={t("transform.references.url")} placeholder="https://…/gtfs.zip" value={url} onChange={(e) => setUrl(e.target.value)} inputProps={{ "data-testid": "change-reference-url" }} />
        <TextField size="small" label={t("transform.references.name")} value={name} onChange={(e) => setName(e.target.value)} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} sx={{ textTransform: "none" }}>
          {t("app.close")}
        </Button>
        <Button variant="contained" disableElevation disabled={busy || !/^https:\/\/\S+$/i.test(url.trim())} onClick={add} data-testid="change-reference-add" startIcon={busy ? <CircularProgress size={14} color="inherit" /> : null} sx={{ textTransform: "none", fontWeight: 700 }}>
          {t("transform.references.add")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
