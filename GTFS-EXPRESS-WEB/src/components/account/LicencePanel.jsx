/**
 * The account's licence: where it comes from, until when, and the one action that fits. The state is the server's
 * (`me.licence`, accounts/store.licenceOf): nothing here decides what the account may do.
 */

import React, { useState } from "react";
import { Box, Button, Typography, alpha, useTheme } from "@mui/material";
import WorkspacePremiumOutlinedIcon from "@mui/icons-material/WorkspacePremiumOutlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import LockOpenOutlinedIcon from "@mui/icons-material/LockOpenOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useAccount } from "../../contexts/AccountContext";
import { isPaidModel, openPricing, useFeatures } from "../../utils/featuresApi";
import { openPortal } from "../../utils/billingApi";
import { humanError } from "../../utils/humanError";
import TrialForm from "./TrialForm";

const eurosOf = (n, language) => {
  try {
    return new Intl.NumberFormat(language || "fr", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(Number(n) || 0);
  } catch {
    return `${Number(n) || 0} €`;
  }
};

const SOURCE_KEYS = { owner: "licence.source.owner", subscription: "licence.source.subscription", tester: "licence.source.admin", admin: "licence.source.admin", trial: "licence.source.trial" };

export const licenceDateOf = (iso, language) => {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(language || "fr", { day: "numeric", month: "long", year: "numeric" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
};

export default function LicencePanel() {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const { me, licence, startTrial } = useAccount();
  const { features } = useFeatures();
  const [busy, setBusy] = useState(null); // "trial" | "portal"
  const [error, setError] = useState(null);
  const [started, setStarted] = useState(false);
  const [asking, setAsking] = useState(false);
  const allowance = me?.ai_allowance || null;
  const paid = isPaidModel(features?.access);
  const active = Boolean(licence?.active);
  const source = active ? licence.source : null;
  const days = features?.access?.billing?.trial_days ?? 14;
  const until = licenceDateOf(licence?.until, language);
  const trialEnded = !active && licence?.trial_until ? licenceDateOf(licence.trial_until, language) : null;
  const portal = source === "subscription" && Boolean(features?.access?.billing?.portal);
  const tone = active ? theme.palette.success.main : paid ? theme.palette.text.secondary : theme.palette.info.main;
  const Icon = active ? WorkspacePremiumOutlinedIcon : paid ? LockOutlinedIcon : LockOpenOutlinedIcon;

  const run = async (what, fn) => {
    setError(null);
    setBusy(what);
    try {
      await fn();
      if (what === "trial") setStarted(true);
    } catch (err) {
      setError(humanError(err, t)?.message || t("error.human.unknown"));
    } finally {
      setBusy(null);
    }
  };

  // The open model: nothing is sold on this server.
  if (!paid && !active) {
    return (
      <Box data-testid="account-licence" data-source="open" sx={{ display: "flex", gap: 1.25, alignItems: "flex-start", px: 1.25, py: 1, borderRadius: 1.5, background: alpha(tone, 0.07) }}>
        <Icon sx={{ fontSize: 20, color: tone, mt: "1px" }} />
        <Typography sx={{ fontSize: "0.82rem", lineHeight: 1.5 }}>{t("licence.open")}</Typography>
      </Box>
    );
  }

  return (
    <Box data-testid="account-licence" data-source={source || "none"} data-active={active ? "1" : "0"}>
      <Typography sx={{ fontSize: "0.72rem", fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "text.secondary", mb: 0.75 }}>{t("licence.title")}</Typography>
      <Box sx={{ display: "flex", gap: 1.25, alignItems: "flex-start", px: 1.25, py: 1, borderRadius: 1.5, background: alpha(tone, 0.07) }}>
        <Icon sx={{ fontSize: 20, color: tone, mt: "1px" }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {active ? (
            <>
              <Typography data-testid="account-licence-source" sx={{ fontSize: "0.86rem", fontWeight: 700 }}>
                {t(SOURCE_KEYS[source] || "licence.source.admin")}
              </Typography>
              <Typography sx={{ fontSize: "0.76rem", color: "text.secondary", mt: 0.25 }}>{until ? t("licence.until", { date: until }) : t("licence.noEnd")}</Typography>
              <Typography sx={{ fontSize: "0.76rem", color: "text.secondary", mt: 0.25 }}>{t(source === "trial" ? "licence.includesTrial" : "licence.includes")}</Typography>
              {allowance && (
                <Typography data-testid="account-ai-allowance" data-exhausted={allowance.exhausted ? "1" : "0"} sx={{ fontSize: "0.76rem", color: allowance.exhausted ? "warning.main" : "text.secondary", mt: 0.25 }}>
                  {t(allowance.kind === "trial" ? "licence.ai.trial" : "licence.ai.month", { spent: eurosOf(allowance.spent_eur, language), limit: eurosOf(allowance.limit_eur, language) })}
                </Typography>
              )}
            </>
          ) : (
            <>
              <Typography sx={{ fontSize: "0.86rem", fontWeight: 700 }}>{t("licence.none.title")}</Typography>
              <Typography sx={{ fontSize: "0.76rem", color: "text.secondary", mt: 0.25, lineHeight: 1.5 }}>{t("licence.none.body")}</Typography>
              {trialEnded && <Typography sx={{ fontSize: "0.76rem", color: "text.secondary", mt: 0.25 }}>{t("licence.trial.ended", { date: trialEnded })}</Typography>}
            </>
          )}
        </Box>
      </Box>
      <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1, mt: 1, flexWrap: "wrap" }}>
        {!active && licence?.trial_available && !asking && (
          <Button size="small" variant="outlined" onClick={() => setAsking(true)} disabled={Boolean(busy)} data-testid="account-start-trial" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("licence.trial.start", { days })}
          </Button>
        )}
        {portal && (
          <Button size="small" variant="outlined" onClick={() => run("portal", openPortal)} disabled={Boolean(busy)} data-testid="account-subscription-manage" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("billing.manage")}
          </Button>
        )}
        {(!active || source === "trial") && (
          <Button size="small" variant="contained" disableElevation onClick={() => openPricing(null)} data-testid="account-see-licence" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("licence.see")}
          </Button>
        )}
      </Box>
      {asking && !active && (
        <TrialForm
          days={days}
          onCancel={() => setAsking(false)}
          onSubmit={async (profile) => {
            await startTrial(profile);
            setAsking(false);
            setStarted(true);
          }}
        />
      )}
      {started && active && source === "trial" && (
        <Typography role="status" data-testid="account-trial-started" sx={{ fontSize: "0.76rem", color: "success.main", mt: 0.5 }}>
          {t("licence.trial.started", { date: until || "" })}
        </Typography>
      )}
      {error && (
        <Typography role="alert" sx={{ fontSize: "0.76rem", color: "error.main", mt: 0.5 }}>
          {error}
        </Typography>
      )}
      {me && !me.email_verified && <Typography sx={{ fontSize: "0.74rem", color: "text.secondary", mt: 0.5 }}>{t("refusal.EMAIL_UNVERIFIED.body")}</Typography>}
    </Box>
  );
}
