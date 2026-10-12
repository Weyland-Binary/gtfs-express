/**
 * TrialForm — who tries GTFS Express, asked at the moment the free trial starts (the owner's decision of
 * 2026-10-12: signing in stays one address and a code; the trial, which costs the operator its AI, asks a name, the
 * organisation and its role, the network and a phone being optional). The server checks the same fields
 * (POST /billing/trial, 400 INVALID_INPUT { missing }) and mails the trial's messages in the reader's language.
 *
 * Shared by the offer (PricingDialog's trial way) and the account's licence (LicencePanel). The name is the
 * account's own when it has one. `onSubmit(profile)` starts the trial and may throw: the form says the failure in
 * one plain sentence (humanError) and stays filled.
 *
 * Test ids: trial-form, trial-name, trial-organisation, trial-role, trial-network, trial-phone, trial-submit,
 * trial-cancel, trial-error.
 */

import React, { useState } from "react";
import { Box, Button, CircularProgress, MenuItem, TextField, Typography } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import { useAccount } from "../../contexts/AccountContext";
import { humanError } from "../../utils/humanError";

// The server's ORG_ROLES (accounts/store), in the order a transport professional reads them.
const ROLES = ["authority", "operator", "consultancy", "other"];

export default function TrialForm({ days = 14, onSubmit, onCancel = null }) {
  const { t } = useLanguage();
  const { me } = useAccount();
  const [form, setForm] = useState({ name: me?.display_name || "", organisation: me?.profile?.organisation || "", role: me?.profile?.org_role || "", network: "", phone: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ready = form.name.trim() && form.organisation.trim() && ROLES.includes(form.role);
  const field = (key) => ({ value: form[key], onChange: (e) => setForm((f) => ({ ...f, [key]: e.target.value })), size: "small", fullWidth: true, disabled: busy });

  const submit = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: form.name.trim(), organisation: form.organisation.trim(), role: form.role, ...(form.network.trim() ? { network: form.network.trim() } : {}), ...(form.phone.trim() ? { phone: form.phone.trim() } : {}) });
    } catch (err) {
      setError(humanError(err, t)?.message || t("error.human.unknown"));
      setBusy(false);
    }
  };

  return (
    <Box component="form" onSubmit={submit} data-testid="trial-form" sx={{ display: "flex", flexDirection: "column", gap: 1.25, mt: 1 }}>
      <Box>
        <Typography sx={{ fontSize: "0.9rem", fontWeight: 800 }}>{t("trial.form.title")}</Typography>
        <Typography sx={{ fontSize: "0.78rem", color: "text.secondary" }}>{t("trial.form.lead")}</Typography>
      </Box>
      <TextField {...field("name")} label={t("trial.form.name")} required autoComplete="name" inputProps={{ maxLength: 80, "data-testid": "trial-name" }} />
      <TextField {...field("organisation")} label={t("trial.form.organisation")} required autoComplete="organization" inputProps={{ maxLength: 160, "data-testid": "trial-organisation" }} />
      <TextField {...field("role")} select label={t("trial.form.role")} required SelectProps={{ SelectDisplayProps: { "data-testid": "trial-role" } }}>
        {ROLES.map((r) => (
          <MenuItem key={r} value={r} data-testid={`trial-role-${r}`}>
            {t(`trial.form.role.${r}`)}
          </MenuItem>
        ))}
      </TextField>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 1.25 }}>
        <TextField {...field("network")} label={t("trial.form.network")} inputProps={{ maxLength: 160, "data-testid": "trial-network" }} />
        <TextField {...field("phone")} label={t("trial.form.phone")} type="tel" autoComplete="tel" inputProps={{ maxLength: 40, "data-testid": "trial-phone" }} />
      </Box>
      {error && (
        <Typography role="alert" data-testid="trial-error" sx={{ fontSize: "0.78rem", color: "error.main" }}>
          {error}
        </Typography>
      )}
      <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1, flexWrap: "wrap" }}>
        {onCancel && (
          <Button onClick={onCancel} disabled={busy} data-testid="trial-cancel" sx={{ textTransform: "none" }}>
            {t("trial.form.cancel")}
          </Button>
        )}
        <Button type="submit" variant="contained" disableElevation disabled={!ready || busy} startIcon={busy ? <CircularProgress size={14} color="inherit" /> : null} data-testid="trial-submit" sx={{ textTransform: "none", fontWeight: 800 }}>
          {t("trial.form.submit", { days })}
        </Button>
      </Box>
    </Box>
  );
}
