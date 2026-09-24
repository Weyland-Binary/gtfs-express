/**
 * PricingDialog — the offer, at the moment it matters (the free cap on a
 * network, the end of the trial, the command palette): Free / Pro / Team
 * cards from GET /config/plans, the caller's current plan, Stripe Checkout
 * when billing is configured, otherwise a request by email, and the
 * "I have a code" path that unlocks immediately.
 */

import React, { useEffect, useState } from "react";
import { Box, Button, Chip, CircularProgress, Dialog, DialogContent, IconButton, TextField, Typography, alpha, useTheme } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import CheckIcon from "@mui/icons-material/Check";
import VpnKeyOutlinedIcon from "@mui/icons-material/VpnKeyOutlined";
import MailOutlineIcon from "@mui/icons-material/MailOutline";
import WorkspacePremiumOutlinedIcon from "@mui/icons-material/WorkspacePremiumOutlined";
import API_BASE_URL from "../config";
import { useLanguage } from "../contexts/LanguageContext";
import { BETA_CODE_STORAGE_KEY } from "./edit/BetaGateDialog";

export const PRICING_EVENT = "gtfs:open-pricing";

const formatCode = (raw) => {
  const stripped = (raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  return stripped.match(/.{1,4}/g)?.join("-") || "";
};

export async function fetchPlans() {
  const headers = {};
  try {
    const code = localStorage.getItem(BETA_CODE_STORAGE_KEY);
    if (code) headers["X-Beta-Code"] = code;
  } catch {
    /* storage disabled */
  }
  const res = await fetch(`${API_BASE_URL}/config/plans`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default function PricingDialog({ open, onClose, reason = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    fetchPlans()
      .then(setData)
      .catch((err) => setError(err.message));
  }, [open, saved]);

  const activate = () => {
    if (code.replace(/-/g, "").length < 8) return;
    try {
      localStorage.setItem(BETA_CODE_STORAGE_KEY, code);
    } catch {
      /* storage disabled */
    }
    setSaved(true);
    setCodeOpen(false);
    window.dispatchEvent(new CustomEvent("gtfs:plan-changed"));
  };

  const current = data?.current?.name || "free";
  const contact = data?.contact_email || "";
  const mailto = (plan) => `mailto:${contact}?subject=${encodeURIComponent(`GTFS Express — ${plan.toUpperCase()} plan`)}&body=${encodeURIComponent("Hello,\n\nI would like to subscribe to the plan above.\n\nName / Organization:\nNetwork size (lines, stops):\n\nThank you.")}`;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth PaperProps={{ sx: { borderRadius: 3 } }} data-testid="pricing-dialog">
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 3, pt: 2.5, pb: 1 }}>
        <WorkspacePremiumOutlinedIcon sx={{ color: theme.palette.ai.main }} />
        <Box sx={{ flex: 1 }}>
          <Typography sx={{ fontWeight: 800, fontSize: "1.15rem", lineHeight: 1.2 }}>{t("pricing.title")}</Typography>
          <Typography sx={{ fontSize: "0.8rem", color: "text.secondary" }}>{reason === "network_limit" ? t("pricing.reason.networkLimit") : reason === "ai_quota" ? t("pricing.reason.aiQuota") : t("pricing.subtitle")}</Typography>
        </Box>
        <IconButton size="small" onClick={onClose} aria-label={t("app.close")}>
          <CloseIcon />
        </IconButton>
      </Box>
      <DialogContent sx={{ pt: 1 }}>
        {error && <Typography sx={{ color: "error.main", fontSize: "0.8rem" }}>{error}</Typography>}
        {!data && !error && (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress size={22} />
          </Box>
        )}
        {data && (
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "repeat(3, 1fr)" }, gap: 1.5 }}>
            {data.plans.map((plan) => {
              const isCurrent = plan.id === current;
              const highlight = plan.id === "pro";
              return (
                <Box key={plan.id} data-testid={`plan-${plan.id}`} sx={{ borderRadius: 2.5, p: 2, border: `1px solid ${alpha(highlight ? theme.palette.ai.main : theme.palette.divider, highlight ? 0.7 : 1)}`, background: highlight ? alpha(theme.palette.ai.main, 0.05) : "transparent", display: "flex", flexDirection: "column", gap: 1, position: "relative" }}>
                  {highlight && <Chip size="small" label={t("pricing.popular")} sx={{ position: "absolute", top: -10, right: 12, height: 20, fontSize: "0.62rem", fontWeight: 800, background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart}, ${theme.palette.ai.gradientEnd})`, color: "#fff" }} />}
                  <Typography sx={{ fontWeight: 800, fontSize: "1rem" }}>{t(`pricing.plan.${plan.id}.name`)}</Typography>
                  <Box sx={{ display: "flex", alignItems: "baseline", gap: 0.5 }}>
                    <Typography sx={{ fontWeight: 900, fontSize: "1.6rem", lineHeight: 1 }}>{plan.price_eur === 0 ? t("pricing.free") : `${plan.price_eur} €`}</Typography>
                    {plan.price_eur > 0 && <Typography sx={{ fontSize: "0.74rem", color: "text.secondary" }}>{t("pricing.perMonth")}</Typography>}
                  </Box>
                  <Typography sx={{ fontSize: "0.76rem", color: "text.secondary", lineHeight: 1.45 }}>{t(`pricing.plan.${plan.id}.tagline`)}</Typography>
                  <Box sx={{ display: "flex", flexDirection: "column", gap: 0.4, my: 0.5 }}>
                    <Box sx={{ display: "flex", gap: 0.6, fontSize: "0.76rem" }}>
                      <CheckIcon sx={{ fontSize: 15, color: "success.main" }} />
                      {t("pricing.limit.lines", { count: plan.limits.network_lines })}
                    </Box>
                    <Box sx={{ display: "flex", gap: 0.6, fontSize: "0.76rem" }}>
                      <CheckIcon sx={{ fontSize: 15, color: "success.main" }} />
                      {plan.id === "free" ? t("pricing.limit.aiTrial", { count: plan.limits.ai_messages }) : t("pricing.limit.aiDaily", { count: plan.limits.ai_messages })}
                    </Box>
                    {plan.features.map((f) => (
                      <Box key={f} sx={{ display: "flex", gap: 0.6, fontSize: "0.76rem" }}>
                        <CheckIcon sx={{ fontSize: 15, color: "success.main" }} />
                        {t(`pricing.feature.${f}`)}
                      </Box>
                    ))}
                  </Box>
                  <Box sx={{ flex: 1 }} />
                  {isCurrent ? (
                    <Chip size="small" label={t("pricing.current")} color="success" variant="outlined" sx={{ alignSelf: "flex-start", fontWeight: 700 }} data-testid={`plan-${plan.id}-current`} />
                  ) : plan.id === "free" ? null : plan.checkout_url ? (
                    <Button variant="contained" disableElevation href={plan.checkout_url} target="_blank" rel="noreferrer" sx={{ textTransform: "none", fontWeight: 800, background: highlight ? `linear-gradient(135deg, ${theme.palette.ai.gradientStart}, ${theme.palette.ai.gradientEnd})` : undefined }}>
                      {t("pricing.subscribe")}
                    </Button>
                  ) : (
                    <Button variant={highlight ? "contained" : "outlined"} disableElevation startIcon={<MailOutlineIcon />} href={mailto(plan.id)} target="_blank" rel="noreferrer" sx={{ textTransform: "none", fontWeight: 700 }} data-testid={`plan-${plan.id}-request`}>
                      {t("pricing.request")}
                    </Button>
                  )}
                </Box>
              );
            })}
          </Box>
        )}
        <Box sx={{ mt: 2, display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
          {codeOpen ? (
            <>
              <TextField size="small" label={t("beta.codeLabel")} placeholder="XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(formatCode(e.target.value))} onKeyDown={(e) => e.key === "Enter" && activate()} inputProps={{ "data-testid": "pricing-code", style: { fontFamily: "monospace", letterSpacing: 1 } }} autoFocus />
              <Button variant="contained" disableElevation onClick={activate} disabled={code.replace(/-/g, "").length < 8} data-testid="pricing-code-activate" sx={{ textTransform: "none", fontWeight: 700 }}>
                {t("beta.submit")}
              </Button>
            </>
          ) : (
            <Button size="small" startIcon={<VpnKeyOutlinedIcon />} onClick={() => setCodeOpen(true)} data-testid="pricing-have-code" sx={{ textTransform: "none", fontWeight: 600 }}>
              {t("pricing.haveCode")}
            </Button>
          )}
          {saved && <Typography sx={{ fontSize: "0.76rem", color: "success.main", fontWeight: 600 }}>{t("pricing.codeSaved")}</Typography>}
          <Box sx={{ flex: 1 }} />
          <Typography sx={{ fontSize: "0.7rem", color: "text.disabled" }}>{t("pricing.footnote")}</Typography>
        </Box>
      </DialogContent>
    </Dialog>
  );
}
