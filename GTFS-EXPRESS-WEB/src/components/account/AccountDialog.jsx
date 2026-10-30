/**
 * Signing in by a code sent by e-mail (no password: the code verifies the address, the first one creates the
 * account), then the account page. Every failure is one plain sentence (humanError), never a raw code.
 */

import React, { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, IconButton, Stack, TextField, Typography, alpha, useTheme } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import MarkEmailReadOutlinedIcon from "@mui/icons-material/MarkEmailReadOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useAccount } from "../../contexts/AccountContext";
import { humanError } from "../../utils/humanError";
import LicencePanel from "./LicencePanel";
import LegalLinks from "../legal/LegalLinks";
import SubscriptionPanel from "../billing/SubscriptionPanel";

const CODE_LENGTH = 6;
const RESEND_SECONDS = 60;

const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());

export default function AccountDialog({ open, onClose, reason = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const { me, requestCode, verifyCode, updateName, signOut } = useAccount();
  const [step, setStep] = useState("email"); // "email" | "code"
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [wait, setWait] = useState(0); // seconds before a new code may be asked
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const verifying = useRef(false);
  const accent = theme.palette.primary.main;

  useEffect(() => {
    if (open) {
      setError(null);
      setInfo(null);
    } else {
      setStep("email");
      setCode("");
      setBusy(false);
    }
  }, [open]);

  useEffect(() => setName(me?.display_name || ""), [me?.display_name]);

  useEffect(() => {
    if (wait <= 0) return undefined;
    const timer = setTimeout(() => setWait((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  const fail = (err) => setError(humanError(err, t)?.message || t("error.human.unknown"));

  const send = async (e) => {
    e?.preventDefault?.();
    if (busy) return;
    setError(null);
    setInfo(null);
    if (!looksLikeEmail(email)) {
      setError(t("account.error.invalidEmail"));
      return;
    }
    setBusy(true);
    try {
      const out = await requestCode(email.trim());
      setStep("code");
      setCode("");
      setWait(out?.resend_after_s ?? RESEND_SECONDS);
    } catch (err) {
      if (err?.code === "LOGIN_CODE_TOO_SOON") {
        setStep("code");
        setWait(err.body?.retry_after_s ?? RESEND_SECONDS);
      } else fail(err);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value = code) => {
    const digits = String(value || "").replace(/\D/g, "");
    if (verifying.current || digits.length !== CODE_LENGTH) return;
    verifying.current = true;
    setError(null);
    setBusy(true);
    try {
      const out = await verifyCode(email.trim(), digits);
      setCode("");
      setStep("email");
      setInfo(t(out?.created ? "account.toast.created" : "account.toast.signedIn"));
    } catch (err) {
      setCode("");
      fail(err);
    } finally {
      verifying.current = false;
      setBusy(false);
    }
  };

  const typeCode = (raw) => {
    const digits = String(raw || "").replace(/\D/g, "").slice(0, CODE_LENGTH);
    setCode(digits);
    if (digits.length === CODE_LENGTH) verify(digits);
  };

  const saveName = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await updateName(name.trim() || null);
      setInfo(t("account.toast.nameSaved"));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const leave = async (everywhere = false) => {
    if (busy) return;
    setBusy(true);
    try {
      await signOut(everywhere ? { everywhere: true } : undefined);
      onClose?.();
    } finally {
      setBusy(false);
    }
  };

  const nameChanged = (name.trim() || null) !== (me?.display_name || null);

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: 2.5 } }} aria-labelledby="account-dialog-title" data-testid="account-dialog">
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, px: 3, pt: 2.5, pb: 1.5, borderBottom: `1px solid ${alpha(accent, 0.18)}`, background: `linear-gradient(160deg, ${alpha(accent, 0.08)} 0%, ${alpha(theme.palette.background.paper, 0)} 100%)` }}>
        <Box sx={{ width: 40, height: 40, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: theme.palette.primary.contrastText, background: accent, flexShrink: 0 }}>
          {!me && step === "code" ? <MarkEmailReadOutlinedIcon /> : <PersonOutlineIcon />}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography component="h2" id="account-dialog-title" sx={{ m: 0, fontWeight: 800, fontSize: "1.05rem", lineHeight: 1.2 }}>{me ? t("account.dialog.title") : t("account.signIn")}</Typography>
          <Typography sx={{ fontSize: "0.78rem", color: "text.secondary", lineHeight: 1.4 }}>{me ? t("account.welcome", { name: me.display_name || me.email }) : t("account.code.subtitle")}</Typography>
        </Box>
        <IconButton size="small" onClick={onClose} disabled={busy} aria-label={t("app.close")}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      <DialogContent sx={{ pt: 2, pb: 1.5 }}>
        {!me && step === "email" && (
          <Box component="form" onSubmit={send} noValidate data-testid="account-step-email">
            {reason?.kind === "reader" && (
              <Typography data-testid="account-reason" sx={{ fontSize: "0.86rem", fontWeight: 650, lineHeight: 1.5, mb: 1 }}>
                {t("account.reason.reader", { count: reason.limit })}
              </Typography>
            )}
            <Typography sx={{ fontSize: "0.82rem", color: "text.secondary", lineHeight: 1.55, mb: 1.75 }}>{t("account.code.intro")}</Typography>
            <TextField label={t("account.email")} type="email" value={email} onChange={(e) => setEmail(e.target.value)} size="small" fullWidth required autoFocus autoComplete="email" inputProps={{ "data-testid": "account-email" }} />
            {error && (
              <Alert severity="error" sx={{ mt: 1.5 }} data-testid="account-error">
                {error}
              </Alert>
            )}
            <Button type="submit" variant="contained" disableElevation fullWidth disabled={busy} startIcon={busy ? <CircularProgress size={14} color="inherit" /> : null} data-testid="account-submit" sx={{ mt: 2, textTransform: "none", fontWeight: 800 }}>
              {busy ? t("account.submitting") : t("account.code.send")}
            </Button>
            {/* A new tab, so the address typed stays. */}
            <LegalLinks tabs={["utilisation", "confidentialite"]} testid="account-legal" sx={{ mt: 1.25, justifyContent: "center" }} />
          </Box>
        )}

        {!me && step === "code" && (
          <Box
            component="form"
            onSubmit={(e) => {
              e.preventDefault();
              verify();
            }}
            noValidate
            data-testid="account-step-code"
          >
            <Typography sx={{ fontSize: "0.82rem", color: "text.secondary", lineHeight: 1.55, mb: 1.75 }} data-testid="account-code-sent">
              {t("account.code.sentTo", { email: email.trim() })}
            </Typography>
            <TextField
              label={t("account.code.label")}
              value={code}
              onChange={(e) => typeCode(e.target.value)}
              size="small"
              fullWidth
              autoFocus
              autoComplete="one-time-code"
              disabled={busy}
              inputProps={{ "data-testid": "account-code", inputMode: "numeric", maxLength: CODE_LENGTH, style: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "1.25rem", letterSpacing: "0.45em", textAlign: "center" } }}
            />
            {error && (
              <Alert severity="error" sx={{ mt: 1.5 }} data-testid="account-error">
                {error}
              </Alert>
            )}
            <Button type="submit" variant="contained" disableElevation fullWidth disabled={busy || code.length !== CODE_LENGTH} startIcon={busy ? <CircularProgress size={14} color="inherit" /> : null} data-testid="account-verify" sx={{ mt: 2, textTransform: "none", fontWeight: 800 }}>
              {busy ? t("account.submitting") : t("account.signIn")}
            </Button>
            <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, mt: 1 }}>
              <Button
                size="small"
                color="inherit"
                onClick={() => {
                  setStep("email");
                  setError(null);
                }}
                disabled={busy}
                data-testid="account-change-email"
                sx={{ textTransform: "none", fontWeight: 600 }}
              >
                {t("account.code.changeEmail")}
              </Button>
              <Button size="small" onClick={() => send()} disabled={busy || wait > 0} data-testid="account-resend" sx={{ textTransform: "none", fontWeight: 600 }}>
                {wait > 0 ? t("account.code.resendIn", { seconds: wait }) : t("account.code.resend")}
              </Button>
            </Box>
          </Box>
        )}

        {me && (
          <Stack spacing={2}>
            <Box>
              <Box sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}>
                <TextField size="small" label={t("account.displayName")} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && nameChanged && saveName()} fullWidth autoComplete="name" helperText={t("account.displayNameHint")} inputProps={{ "data-testid": "account-name", maxLength: 80 }} />
                {nameChanged && (
                  <Button variant="outlined" onClick={saveName} disabled={busy} data-testid="account-name-save" sx={{ textTransform: "none", fontWeight: 700, whiteSpace: "nowrap", mt: "1px" }}>
                    {t("account.save")}
                  </Button>
                )}
              </Box>
            </Box>
            <LicencePanel />
            {me.subscription && <SubscriptionPanel />}
            {error && (
              <Alert severity="error" data-testid="account-error">
                {error}
              </Alert>
            )}
            {info && !error && (
              <Alert severity="success" data-testid="account-info">
                {info}
              </Alert>
            )}
          </Stack>
        )}
      </DialogContent>

      {me && (
        <DialogActions sx={{ px: 3, pb: 2, pt: 0, justifyContent: "space-between", flexWrap: "wrap", rowGap: 0.5 }}>
          <Typography sx={{ fontSize: "0.74rem", color: "text.disabled", minWidth: 0, flex: "1 1 120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} data-testid="account-email-label">
            {me.email}
          </Typography>
          <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", justifyContent: "flex-end", ml: "auto !important" }}>
            <Button size="small" color="inherit" onClick={() => leave(true)} disabled={busy} data-testid="account-signout-everywhere" sx={{ textTransform: "none", color: "text.secondary" }}>
              {t("account.signOutEverywhere")}
            </Button>
            <Button size="small" color="inherit" onClick={() => leave(false)} disabled={busy} data-testid="account-signout" sx={{ textTransform: "none", fontWeight: 700 }}>
              {t("account.signOut")}
            </Button>
          </Box>
        </DialogActions>
      )}
    </Dialog>
  );
}
