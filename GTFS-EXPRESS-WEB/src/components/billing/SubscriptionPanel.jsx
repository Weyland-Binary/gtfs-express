/** The state shown is the server's (`me.subscription`): nothing here decides what the account may do. */

import React, { useState } from "react";
import { Box, Button, CircularProgress, Typography, alpha, useTheme } from "@mui/material";
import WorkspacePremiumOutlinedIcon from "@mui/icons-material/WorkspacePremiumOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useAccount } from "../../contexts/AccountContext";
import { openPricing, useFeatures } from "../../utils/featuresApi";
import { openPortal } from "../../utils/billingApi";
import { humanError } from "../../utils/humanError";

const STATUS_KEYS = { active: "billing.status.active", trialing: "billing.status.trialing", past_due: "billing.status.pastDue" };

const dateOf = (iso, language) => {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(language || "fr", { day: "numeric", month: "long", year: "numeric" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
};

export default function SubscriptionPanel() {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const { me, entitlements } = useAccount();
  const { features } = useFeatures();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const sub = me?.subscription || null;
  const portal = Boolean(features?.access?.billing?.portal);
  const active = Boolean(sub?.active);
  const granted = !active && (entitlements.includes("edit") || entitlements.includes("studio"));
  const tone = sub?.status === "past_due" ? theme.palette.warning.main : active ? theme.palette.success.main : theme.palette.text.secondary;
  const when = dateOf(sub?.current_period_end, language);

  const manage = async () => {
    setError(null);
    setBusy(true);
    try {
      await openPortal();
    } catch (err) {
      setError(humanError(err, t)?.message || t("error.human.unknown"));
      setBusy(false);
    }
  };

  return (
    <Box data-testid="account-subscription" data-status={sub?.status || "none"}>
      <Typography sx={{ fontSize: "0.72rem", fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "text.secondary", mb: 0.75 }}>{t("billing.title")}</Typography>
      <Box sx={{ display: "flex", gap: 1.25, alignItems: "flex-start", px: 1.25, py: 1, borderRadius: 1.5, background: alpha(tone, 0.07) }}>
        <WorkspacePremiumOutlinedIcon sx={{ fontSize: 20, color: tone, mt: "1px" }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {active ? (
            <>
              <Typography sx={{ fontSize: "0.86rem", fontWeight: 700 }}>
                {t("licence.name")}
                <Box component="span" data-testid="account-subscription-status" sx={{ ml: 1, fontSize: "0.72rem", fontWeight: 700, color: tone }}>
                  {t(STATUS_KEYS[sub.status] || "billing.status.active")}
                </Box>
              </Typography>
              {when && <Typography sx={{ fontSize: "0.76rem", color: "text.secondary", mt: 0.25 }}>{t(sub.cancel_at_period_end ? "billing.endsOn" : "billing.renewsOn", { date: when })}</Typography>}
              {sub.status === "past_due" && <Typography sx={{ fontSize: "0.76rem", color: "warning.main", mt: 0.25 }}>{t("billing.pastDueHint")}</Typography>}
            </>
          ) : granted ? (
            <Typography sx={{ fontSize: "0.82rem" }}>{t("billing.granted")}</Typography>
          ) : (
            <Typography sx={{ fontSize: "0.82rem" }}>{t(sub ? "billing.ended" : "billing.none")}</Typography>
          )}
        </Box>
      </Box>
      <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1, mt: 1 }}>
        {active && portal && (
          <Button size="small" variant="outlined" onClick={manage} disabled={busy} startIcon={busy ? <CircularProgress size={12} color="inherit" /> : null} data-testid="account-subscription-manage" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("billing.manage")}
          </Button>
        )}
        {!active && !granted && (
          <Button size="small" variant="contained" disableElevation onClick={() => openPricing(null)} data-testid="account-subscription-plans" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("paywall.cta.seePlans")}
          </Button>
        )}
      </Box>
      {error && (
        <Typography role="alert" sx={{ fontSize: "0.76rem", color: "error.main", mt: 0.5 }}>
          {error}
        </Typography>
      )}
    </Box>
  );
}
