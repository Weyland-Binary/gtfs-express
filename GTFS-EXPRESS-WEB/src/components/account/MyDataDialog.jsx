/**
 * « Mes données »: the account's data downloaded (GET /auth/me/export) and the account deleted (DELETE /auth/me, its
 * e-mail typed to confirm). A project the account holds and shares is never deleted under its team: the server
 * answers 409 ACCOUNT_PROJECTS_SHARED and each project is handed to one of its members here first.
 */

import React, { useEffect, useState } from "react";
import { Alert, Box, Button, CircularProgress, Dialog, DialogContent, DialogTitle, Divider, IconButton, MenuItem, Stack, TextField, Typography } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import DeleteForeverOutlinedIcon from "@mui/icons-material/DeleteForeverOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useAccount } from "../../contexts/AccountContext";
import * as accountApi from "../../utils/accountApi";
import RefusalNotice from "../common/RefusalNotice";

const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase() && String(a || "").trim() !== "";

/** No-op where the browser cannot (a test without object URLs). */
const saveFile = (blob, filename) => {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
};

function SharedProject({ project, onHandedOver }) {
  const { t } = useLanguage();
  const members = Array.isArray(project.members) ? project.members : [];
  const [to, setTo] = useState(members[0]?.user_id || "");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState(null);
  const handOver = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      await accountApi.handOverProject(project.id, to);
      onHandedOver(project, members.find((m) => m.user_id === to) || null);
    } catch (err) {
      setRefusal(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Box data-testid={`my-data-shared-${project.id}`} sx={{ border: 1, borderColor: "divider", borderRadius: 1.5, p: 1.25 }}>
      <Typography sx={{ fontSize: "0.84rem", fontWeight: 700 }}>{project.name || project.id}</Typography>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 1, alignItems: { sm: "center" } }}>
        <TextField select size="small" label={t("account.data.shared.member")} value={to} onChange={(e) => setTo(e.target.value)} sx={{ minWidth: 220 }} inputProps={{ "data-testid": `my-data-handover-to-${project.id}` }}>
          {members.map((m) => (
            <MenuItem key={m.user_id} value={m.user_id}>
              {m.name || m.user_id}
            </MenuItem>
          ))}
        </TextField>
        <Button variant="outlined" size="small" disabled={!to || busy} onClick={handOver} data-testid={`my-data-handover-${project.id}`} sx={{ textTransform: "none" }}>
          {busy ? <CircularProgress size={16} /> : t("account.data.shared.handOver")}
        </Button>
      </Stack>
      {refusal && <RefusalNotice refusal={refusal} onAction={(id) => id === "retry" && handOver()} supported={["retry"]} testid={`my-data-handover-refusal-${project.id}`} sx={{ mt: 1 }} />}
    </Box>
  );
}

export default function MyDataDialog({ open, onClose }) {
  const { t } = useLanguage();
  const { me, deleteAccount } = useAccount();
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [shared, setShared] = useState(null); // the projects to hand over first (409 ACCOUNT_PROJECTS_SHARED)
  const [handed, setHanded] = useState([]);
  const [refusal, setRefusal] = useState(null);
  const [deleted, setDeleted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setExported(false);
    setConfirm("");
    setShared(null);
    setHanded([]);
    setRefusal(null);
    setDeleted(false);
  }, [open]);

  const doExport = async () => {
    setExporting(true);
    setRefusal(null);
    try {
      const { blob, filename } = await accountApi.exportMyData();
      saveFile(blob, filename);
      setExported(true);
    } catch (err) {
      setRefusal(err);
    } finally {
      setExporting(false);
    }
  };

  const doDelete = async () => {
    setDeleting(true);
    setRefusal(null);
    try {
      await deleteAccount(confirm.trim());
      setDeleted(true);
      setShared(null);
    } catch (err) {
      if (err?.code === "ACCOUNT_PROJECTS_SHARED" && Array.isArray(err.body?.projects)) setShared(err.body.projects);
      else setRefusal(err);
    } finally {
      setDeleting(false);
    }
  };

  const onHandedOver = (project, member) => {
    setShared((list) => (list || []).filter((p) => p.id !== project.id));
    setHanded((list) => [...list, { id: project.id, name: member?.name || member?.user_id || "" }]);
  };

  const email = me?.email || "";
  const pending = (shared || []).length;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="my-data-title" data-testid="my-data-dialog">
      <DialogTitle id="my-data-title" sx={{ pr: 6, fontWeight: 800 }}>
        {t("account.data.title")}
        <IconButton aria-label={t("app.close")} onClick={onClose} sx={{ position: "absolute", right: 8, top: 8 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        {deleted ? (
          <Alert severity="success" data-testid="my-data-deleted">
            {t("account.data.delete.done")}
          </Alert>
        ) : (
          <Stack spacing={2}>
            <Typography sx={{ fontSize: "0.86rem", color: "text.secondary" }}>{t("account.data.intro")}</Typography>
            <Box component="section" aria-labelledby="my-data-export-title">
              <Typography id="my-data-export-title" component="h3" sx={{ fontSize: "0.92rem", fontWeight: 800 }}>
                {t("account.data.export.title")}
              </Typography>
              <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", mb: 1 }}>{t("account.data.export.body")}</Typography>
              <Button variant="outlined" startIcon={exporting ? <CircularProgress size={16} /> : <DownloadOutlinedIcon />} disabled={exporting} onClick={doExport} data-testid="my-data-export" sx={{ textTransform: "none" }}>
                {t("account.data.export.action")}
              </Button>
              {exported && (
                <Typography role="status" sx={{ fontSize: "0.78rem", color: "success.main", mt: 0.5 }} data-testid="my-data-exported">
                  {t("account.data.export.done")}
                </Typography>
              )}
            </Box>
            <Divider />
            <Box component="section" aria-labelledby="my-data-delete-title">
              <Typography id="my-data-delete-title" component="h3" sx={{ fontSize: "0.92rem", fontWeight: 800, color: "error.main" }}>
                {t("account.data.delete.title")}
              </Typography>
              <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", mb: 1.25 }}>{t("account.data.delete.body")}</Typography>
              {shared && (
                <Box data-testid="my-data-shared" sx={{ mb: 1.5 }}>
                  <Alert severity={pending ? "warning" : "success"} sx={{ mb: 1 }}>
                    <Typography sx={{ fontSize: "0.84rem", fontWeight: 700 }}>{pending ? t("account.data.shared.title") : t("account.data.shared.done")}</Typography>
                    {pending > 0 && <Typography sx={{ fontSize: "0.8rem" }}>{t("account.data.shared.body")}</Typography>}
                  </Alert>
                  <Stack spacing={1}>
                    {shared.map((p) => (
                      <SharedProject key={p.id} project={p} onHandedOver={onHandedOver} />
                    ))}
                  </Stack>
                </Box>
              )}
              {handed.map((h) => (
                <Typography key={h.id} role="status" sx={{ fontSize: "0.78rem", color: "success.main" }} data-testid={`my-data-handed-${h.id}`}>
                  {t("account.data.shared.handedOver", { name: h.name })}
                </Typography>
              ))}
              <TextField
                fullWidth
                size="small"
                type="email"
                autoComplete="off"
                label={t("account.data.delete.confirmLabel")}
                helperText={t("account.data.delete.confirmHint", { email })}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                inputProps={{ "data-testid": "my-data-delete-confirm" }}
                sx={{ mt: 0.5, mb: 1 }}
              />
              <Button variant="contained" color="error" startIcon={deleting ? <CircularProgress size={16} color="inherit" /> : <DeleteForeverOutlinedIcon />} disabled={!same(confirm, email) || deleting || pending > 0} onClick={doDelete} data-testid="my-data-delete" sx={{ textTransform: "none" }}>
                {t("account.data.delete.action")}
              </Button>
            </Box>
            {refusal && <RefusalNotice refusal={refusal} onAction={(id) => id === "retry" && setRefusal(null)} supported={["retry"]} testid="my-data-refusal" />}
          </Stack>
        )}
      </DialogContent>
    </Dialog>
  );
}
