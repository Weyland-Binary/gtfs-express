/**
 * StudioPaywall — a project's page when the licence is not (or no longer)
 * the person's: the paid offer (featuresApi.licenceLockOf), in the
 * studio's own look, in place of the step's work. The steps stay in the bar
 * (the project is there, kept), the work waits for the subscription.
 *
 * It says what the studio does and what it guarantees — the four promises
 * the product sells (guided creation and modification, an assistant whose
 * every proposal the engine measures, a GTFS delivered only when the
 * canonical validator passes it, a package that names who accepted what) —
 * then the one action that lifts the lock: sign in (`sign_in_required`), or
 * see the licence and its three ways — the free trial, paying online, a quote
 * (`subscription_required`).
 * Nothing here is a payment: the offer (PricingDialog) and the server do it.
 *
 *   state    "sign_in_required" | "subscription_required"
 *   project  the project kept behind it (its name is said)
 */

import React, { useEffect, useState } from "react";
import { Box, Button, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import RouteOutlinedIcon from "@mui/icons-material/RouteOutlined";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import VerifiedOutlinedIcon from "@mui/icons-material/VerifiedOutlined";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useAccount } from "../../contexts/AccountContext";
import { openPaywall } from "../../utils/featuresApi";
import { useNavigate, HOME_PATH } from "../../utils/routes";
import { tokensOf } from "../studio/studioTheme";
import { fetchPlans } from "../PricingDialog";

const PROMISES = [
  { icon: RouteOutlinedIcon, key: "guided" },
  { icon: AutoAwesomeOutlinedIcon, key: "assistant" },
  { icon: VerifiedOutlinedIcon, key: "canonical" },
  { icon: Inventory2OutlinedIcon, key: "package" },
];

export default function StudioPaywall({ state = "subscription_required", project = null }) {
  const theme = useTheme();
  const k = tokensOf(theme);
  const { t, language } = useLanguage();
  const account = useAccount();
  const navigate = useNavigate();
  const [price, setPrice] = useState(null);
  const [priceMonth, setPriceMonth] = useState(null);

  // The licence's yearly price, as the server's offer says it (never a price written here).
  useEffect(() => {
    let cancelled = false;
    fetchPlans()
      .then((data) => {
        const pro = (data?.plans || []).find((p) => p.id === "pro");
        if (!cancelled && pro && pro.price_eur > 0) setPrice(pro.price_eur);
        if (!cancelled && pro && pro.price_eur_month > 0) setPriceMonth(pro.price_eur_month);
      })
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = state === "sign_in_required" && account.enabled;
  const name = String(project?.name ?? "").trim();
  return (
    <Box data-testid="studio-paywall" data-state={state} sx={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", alignItems: { xs: "flex-start", md: "center" }, justifyContent: "center", px: 2, py: { xs: 3, md: 4 }, backgroundColor: k.ground }}>
      <Box component="section" aria-labelledby="studio-paywall-title" sx={{ width: "100%", maxWidth: 760, borderRadius: "14px", border: `1px solid ${k.line}`, backgroundColor: k.surface, boxShadow: k.float, overflow: "hidden" }}>
        <Box sx={{ px: { xs: 2.5, md: 4 }, pt: { xs: 2.5, md: 3.5 }, pb: 2.5, borderBottom: `1px solid ${k.lineSoft}` }}>
          <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.75, height: 24, px: 1.1, borderRadius: 999, backgroundColor: k.accentSoft, color: k.accent, fontSize: "0.72rem", fontWeight: 600, mb: 1.5 }}>
            <LockOutlinedIcon sx={{ fontSize: 14 }} />
            {t("paywall.eyebrow")}
          </Box>
          <Typography id="studio-paywall-title" component="h1" sx={{ fontSize: { xs: "1.3rem", md: "1.55rem" }, fontWeight: 650, letterSpacing: "-0.015em", lineHeight: 1.25, color: k.ink }}>
            {t("paywall.studio.title")}
          </Typography>
          <Typography sx={{ mt: 1, fontSize: "0.92rem", lineHeight: 1.6, color: k.ink2, maxWidth: 620 }}>{t("paywall.studio.lead")}</Typography>
        </Box>
        <Box component="ul" sx={{ listStyle: "none", m: 0, px: { xs: 2.5, md: 4 }, py: 2.5, display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 2 }}>
          {PROMISES.map(({ icon: Icon, key }) => (
            <Box component="li" key={key} data-testid={`studio-paywall-${key}`} sx={{ display: "flex", gap: 1.25, alignItems: "flex-start" }}>
              <Box sx={{ width: 32, height: 32, flexShrink: 0, borderRadius: "9px", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: k.accentSoft, color: k.accent }}>
                <Icon sx={{ fontSize: 18 }} />
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontSize: "0.86rem", fontWeight: 600, color: k.ink, lineHeight: 1.35 }}>{t(`paywall.promise.${key}.title`)}</Typography>
                <Typography sx={{ fontSize: "0.8rem", color: k.ink2, lineHeight: 1.5, mt: 0.25 }}>{t(`paywall.promise.${key}.body`)}</Typography>
              </Box>
            </Box>
          ))}
        </Box>
        <Box sx={{ px: { xs: 2.5, md: 4 }, py: 2.25, backgroundColor: k.subtle, borderTop: `1px solid ${k.lineSoft}`, display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
          <Box sx={{ flex: "1 1 260px", minWidth: 0 }}>
            <Typography sx={{ fontSize: "0.86rem", fontWeight: 600, color: k.ink }}>{price && priceMonth ? t("paywall.priceBoth", { price: new Intl.NumberFormat(language || "fr", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(price), month: new Intl.NumberFormat(language || "fr", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(priceMonth) }) : price ? t("paywall.price", { price: new Intl.NumberFormat(language || "fr", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(price) }) : t("paywall.priceNone")}</Typography>
            <Typography sx={{ fontSize: "0.78rem", color: k.ink2, mt: 0.25 }}>{name ? t("paywall.kept", { name }) : t("paywall.keptNone")}</Typography>
          </Box>
          <Button variant="text" onClick={() => navigate(HOME_PATH)} data-testid="studio-paywall-home" sx={{ textTransform: "none", fontWeight: 600, color: k.ink2 }}>
            {t("paywall.cta.home")}
          </Button>
          {signIn ? (
            <>
              <Button variant="outlined" onClick={() => account.openAccountDialog({ tab: "signin" })} data-testid="studio-paywall-signin" sx={{ textTransform: "none", fontWeight: 600 }}>
                {t("status.user.signIn")}
              </Button>
              <Button variant="contained" disableElevation onClick={() => openPaywall("studio", state)} data-testid="studio-paywall-plans" sx={{ textTransform: "none", fontWeight: 600 }}>
                {t("paywall.cta.seePlans")}
              </Button>
            </>
          ) : (
            <Button variant="contained" disableElevation onClick={() => openPaywall("studio", state)} data-testid="studio-paywall-plans" sx={{ textTransform: "none", fontWeight: 600 }}>
              {t("paywall.cta.seePlans")}
            </Button>
          )}
        </Box>
      </Box>
    </Box>
  );
}
