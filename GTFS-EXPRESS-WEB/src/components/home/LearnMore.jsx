/**
 * Home's lower half: how it works (three steps along a route a vehicle runs), what is sure (a band in the theme's
 * blue), the prices (reading, the licence, a quote; prices from the server only, never written here), the questions,
 * and the call to open a network. With reduced motion nothing moves. Colours from the theme (#19).
 */

import React, { useEffect, useMemo, useState } from "react";
import { Accordion, AccordionDetails, AccordionSummary, Box, Button, ButtonBase, Container, Typography, alpha, useMediaQuery, useTheme } from "@mui/material";
import { keyframes } from "@mui/system";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import VerifiedUserOutlinedIcon from "@mui/icons-material/VerifiedUserOutlined";
import HistoryOutlinedIcon from "@mui/icons-material/HistoryOutlined";
import HowToRegOutlinedIcon from "@mui/icons-material/HowToRegOutlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import ReceiptLongOutlinedIcon from "@mui/icons-material/ReceiptLongOutlined";
import AccountBalanceOutlinedIcon from "@mui/icons-material/AccountBalanceOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { openPricing } from "../../utils/featuresApi";
import { fetchPlans } from "../PricingDialog";
import { launchOf, launchUntilText } from "../../utils/launchOffer";
import LaunchBadge from "../account/LaunchBadge";
import { IconTile } from "./HomeFeatures";
import { HOME_WIDTH } from "./inkGround";
import Reveal from "./Reveal";

const road = keyframes`
  to { stroke-dashoffset: -18; }
`;
const ride = keyframes`
  from { left: 0%; }
  to   { left: 100%; }
`;

const useReducedMotion = () => useMediaQuery("(prefers-reduced-motion: reduce)");

function SectionHead({ eyebrow, title, lead = null, align = "left", onBlue = false }) {
  return (
    <Box sx={{ textAlign: align, maxWidth: 760, mx: align === "center" ? "auto" : 0, display: "flex", flexDirection: "column", gap: 1.5, alignItems: align === "center" ? "center" : "flex-start" }}>
      {eyebrow && <Typography sx={{ fontSize: "0.9rem", fontWeight: 650, color: onBlue ? "rgba(255,255,255,0.8)" : "primary.main" }}>{eyebrow}</Typography>}
      <Typography component="h2" sx={{ fontSize: { xs: "1.8rem", md: "2.5rem" }, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.1, ...(onBlue ? { color: "#fff" } : {}) }}>
        {title}
      </Typography>
      {lead && <Typography sx={{ fontSize: { xs: "1rem", md: "1.1rem" }, color: onBlue ? "rgba(255,255,255,0.8)" : "text.secondary", lineHeight: 1.6 }}>{lead}</Typography>}
    </Box>
  );
}

// ── How it works: three steps along a route

function Journey() {
  const theme = useTheme();
  const { t } = useLanguage();
  const reduced = useReducedMotion();
  const icons = [CloudUploadOutlinedIcon, EditOutlinedIcon, VerifiedUserOutlinedIcon];
  return (
    <Box component="section" data-testid="learn-journey" sx={{ display: "flex", flexDirection: "column", gap: { xs: 4, md: 6 } }}>
      <Reveal>
        <SectionHead eyebrow={t("learn.journey.eyebrow")} title={t("learn.journey.title")} />
      </Reveal>
      <Box sx={{ position: "relative" }}>
        {/* The route between the three stops, and a vehicle running it. */}
        <Box aria-hidden sx={{ display: { xs: "none", md: "block" }, position: "absolute", left: "16.6%", right: "16.6%", top: 30, height: 4 }}>
          <Box component="svg" width="100%" height="4" sx={{ display: "block" }}>
            <Box component="line" x1="0" y1="2" x2="100%" y2="2" stroke={alpha(theme.palette.primary.main, 0.45)} strokeWidth={3} strokeDasharray="8 10" sx={reduced ? {} : { animation: `${road} 1.2s linear infinite` }} />
          </Box>
          {!reduced && <Box sx={{ position: "absolute", top: -6, width: 16, height: 16, ml: "-8px", borderRadius: "50%", backgroundColor: theme.palette.primary.main, border: `3px solid ${theme.palette.background.paper}`, boxShadow: `0 2px 6px ${alpha(theme.palette.primary.dark, 0.35)}`, animation: `${ride} 7s linear infinite` }} />}
        </Box>
        <Box component="ol" sx={{ position: "relative", m: 0, p: 0, listStyle: "none", display: "grid", gridTemplateColumns: { xs: "1fr", md: "repeat(3, minmax(0, 1fr))" }, gap: { xs: 3, md: 4 } }}>
          {[1, 2, 3].map((i) => {
            const Icon = icons[i - 1];
            return (
              <Reveal key={i} delay={0.08 * i} component="li" data-testid={`learn-step-${i}`} sx={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 1.5 }}>
                  <Box aria-hidden sx={{ width: 64, height: 64, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: theme.palette.primary.contrastText, backgroundColor: theme.palette.primary.main, border: `6px solid ${theme.palette.background.default}`, boxShadow: `0 6px 18px ${alpha(theme.palette.primary.main, 0.3)}` }}>
                    <Icon sx={{ fontSize: 26 }} />
                  </Box>
                  <Typography component="h3" sx={{ fontSize: "1.15rem", fontWeight: 700 }}>
                    {t(`learn.journey.s${i}.title`)}
                  </Typography>
                  <Typography sx={{ fontSize: "0.95rem", color: "text.secondary", lineHeight: 1.55, maxWidth: 320 }}>{t(`learn.journey.s${i}.text`)}</Typography>
              </Reveal>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

// ── What is sure, in the theme's blue

function Trust() {
  const theme = useTheme();
  const { t } = useLanguage();
  const items = [
    { key: "learn.trust.t1", icon: VerifiedUserOutlinedIcon },
    { key: "learn.trust.t4", icon: HistoryOutlinedIcon },
    { key: "learn.trust.t6", icon: HowToRegOutlinedIcon },
    { key: "learn.data.d2", icon: LockOutlinedIcon },
  ];
  const dark = theme.palette.mode === "dark";
  return (
    <Box component="section" data-testid="learn-trust" sx={{ color: "#fff", background: `linear-gradient(135deg, ${dark ? theme.palette.primary.dark : "#0B2447"} 0%, ${theme.palette.primary.dark} 55%, ${theme.palette.primary.main} 100%)` }}>
      <Container maxWidth={false} sx={{ maxWidth: HOME_WIDTH, py: { xs: 7, md: 11 }, display: "flex", flexDirection: "column", gap: { xs: 4, md: 5.5 } }}>
        <Reveal>
          <SectionHead title={t("learn.trust.title")} onBlue />
        </Reveal>
        <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none", display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))", md: "repeat(4, minmax(0, 1fr))" }, gap: { xs: 3, md: 3.5 } }}>
          {items.map(({ key, icon: Icon }, i) => (
            <Reveal component="li" key={key} delay={0.07 * (i + 1)} sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
              <Box aria-hidden sx={{ width: 44, height: 44, borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.14)" }}>
                <Icon sx={{ fontSize: 22 }} />
              </Box>
              <Typography component="h3" sx={{ fontSize: "1.05rem", fontWeight: 700 }}>
                {t(`${key}.title`)}
              </Typography>
              <Typography sx={{ fontSize: "0.95rem", lineHeight: 1.55, color: "rgba(255,255,255,0.78)" }}>{t(`${key}.text`)}</Typography>
            </Reveal>
          ))}
        </Box>
      </Container>
    </Box>
  );
}

// ── Prices

function PriceCard({ testid, icon, title, amount, sub, text, cta, onCta, featured = false, badge = null, children }) {
  const theme = useTheme();
  return (
    <Box data-testid={testid} sx={{ p: { xs: 3, md: 3.75 }, borderRadius: "18px", backgroundColor: theme.palette.background.paper, border: featured ? `2px solid ${theme.palette.primary.main}` : `1px solid ${theme.palette.divider}`, boxShadow: featured ? `0 24px 60px ${alpha(theme.palette.primary.main, 0.18)}` : "none", display: "flex", flexDirection: "column", gap: 1.75 }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
        <IconTile icon={icon} tone={theme.palette.primary.main} solid={featured} />
        {badge}
      </Box>
      <Typography component="h3" sx={{ fontSize: "1.15rem", fontWeight: 700 }}>
        {title}
      </Typography>
      <Box sx={{ display: "flex", alignItems: "baseline", gap: 1, flexWrap: "wrap" }}>
        <Typography sx={{ fontSize: "2.3rem", fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1 }}>{amount}</Typography>
        {sub && <Typography sx={{ color: "text.secondary" }}>{sub}</Typography>}
      </Box>
      {children}
      <Typography sx={{ fontSize: "0.95rem", color: "text.secondary", lineHeight: 1.55 }}>{text}</Typography>
      <Button onClick={onCta} variant={featured ? "contained" : "outlined"} disableElevation data-testid={`${testid}-cta`} sx={{ mt: "auto", height: 46, textTransform: "none", fontWeight: 700, borderRadius: "12px" }}>
        {cta}
      </Button>
    </Box>
  );
}

function Licence({ onTryDemo }) {
  const { t, language } = useLanguage();
  const [plans, setPlans] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetchPlans()
      .then((p) => !cancelled && setPlans(p))
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, []);
  const paid = plans?.model === "paid";
  const pro = (plans?.plans || []).find((p) => p.id === "pro");
  const money = (v) => {
    try {
      return new Intl.NumberFormat(language || "fr", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v);
    } catch {
      return `${v} €`;
    }
  };
  const price = useMemo(() => (pro && pro.price_eur > 0 ? money(pro.price_eur) : null), [pro, language]); // eslint-disable-line react-hooks/exhaustive-deps
  const priceMonth = useMemo(() => (pro && pro.price_eur_month > 0 ? money(pro.price_eur_month) : null), [pro, language]); // eslint-disable-line react-hooks/exhaustive-deps
  const days = Number(plans?.trial_days) || 0;
  const launch = launchOf(pro);
  return (
    <Box component="section" id="tarifs" data-testid="learn-licence" sx={{ display: "flex", flexDirection: "column", gap: { xs: 4, md: 5 }, scrollMarginTop: 72 }}>
      <Reveal>
        <SectionHead eyebrow={t("learn.licence.eyebrow")} title={t("learn.licence.title")} lead={days > 0 ? t("learn.licence.b1", { days }) : null} align="center" />
      </Reveal>
      <Reveal delay={0.05}>
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "repeat(3, minmax(0, 1fr))" }, gap: 2.5, alignItems: "stretch" }}>
          <PriceCard testid="learn-licence-read" icon={VisibilityOutlinedIcon} title={t("learn.licence.read")} amount={t("pricing.free")} text={t("learn.licence.readText")} cta={t("learn.read.cta")} onCta={() => onTryDemo?.()} />
          {plans && !paid ? (
            <PriceCard testid="learn-licence-card" icon={EditOutlinedIcon} title={t("learn.licence.name")} amount={t("pricing.free")} text={t("learn.licence.open")} cta={t("learn.read.cta")} onCta={() => onTryDemo?.()} featured />
          ) : (
            <PriceCard testid="learn-licence-card" icon={EditOutlinedIcon} title={t("learn.licence.name")} amount={price || "…"} sub={price ? (launch.offer ? `${t("licence.perYear")} · ${launch.until ? launchUntilText(t, launch.until, language) : t("learn.licence.launch")}` : t("licence.perYear")) : null} badge={price && launch.offer ? <LaunchBadge testId="learn-licence-card-badge" /> : null} text={t("learn.licence.text")} cta={t("learn.licence.cta")} onCta={() => openPricing(null)} featured>
              {price && priceMonth && (
                <Typography data-testid="learn-licence-monthly" sx={{ fontSize: "0.92rem", color: "text.secondary", mt: -0.75 }}>
                  {t("licence.perMonthAlt", { price: priceMonth })}
                </Typography>
              )}
            </PriceCard>
          )}
          <PriceCard testid="learn-licence-quote" icon={ReceiptLongOutlinedIcon} title={t("learn.licence.quote")} amount={t("learn.licence.quoteAmount")} text={t("learn.licence.quoteText")} cta={t("learn.licence.quoteCta")} onCta={() => openPricing(null, { way: "quote" })} />
        </Box>
        {paid ? (
          <Box data-testid="learn-public-buyers" sx={{ mt: 2.5, display: "flex", alignItems: "center", justifyContent: "center", gap: 1, flexWrap: "wrap", fontSize: "0.95rem", textAlign: "center" }}>
            <AccountBalanceOutlinedIcon aria-hidden sx={{ fontSize: 20, color: "primary.main" }} />
            <Typography component="span" sx={{ fontSize: "inherit", color: "text.secondary" }}>
              {t("licence.publicBuyers")}
            </Typography>
            <ButtonBase onClick={() => openPricing(null, { way: "quote" })} data-testid="learn-public-buyers-quote" sx={{ fontSize: "inherit", fontWeight: 700, color: "primary.main", textDecoration: "underline", textUnderlineOffset: 3, borderRadius: "4px" }}>
              {t("licence.way.quote.cta")}
            </ButtonBase>
          </Box>
        ) : null}
      </Reveal>
    </Box>
  );
}

// ── Questions

export const FAQ = [1, 2, 3, 4, 5, 6, 7, 8];

function Faq() {
  const theme = useTheme();
  const { t } = useLanguage();
  const [open, setOpen] = useState(0);
  return (
    <Box component="section" id="questions" data-testid="learn-faq" sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "minmax(0, 1fr) minmax(0, 2fr)" }, gap: { xs: 3, md: 6 }, scrollMarginTop: 72 }}>
      <Reveal>
        <SectionHead eyebrow={t("learn.faq.eyebrow")} title={t("learn.faq.title")} />
      </Reveal>
      <Reveal delay={0.05}>
        <Box>
          {FAQ.map((i, idx) => (
            <Accordion key={i} disableGutters elevation={0} square expanded={open === idx} onChange={(_, on) => setOpen(on ? idx : -1)} data-testid={`learn-faq-${i}`} sx={{ backgroundColor: "transparent", borderBottom: `1px solid ${theme.palette.divider}`, "&:before": { display: "none" } }}>
              <AccordionSummary expandIcon={<ExpandMoreRoundedIcon />} sx={{ px: 0, minHeight: 64, "& .MuiAccordionSummary-content": { my: 1.75 } }}>
                <Typography sx={{ fontSize: "1.02rem", fontWeight: 650 }}>{t(`learn.faq.q${i}`)}</Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ px: 0, pt: 0, pb: 2.5 }}>
                <Typography sx={{ fontSize: "0.95rem", color: "text.secondary", lineHeight: 1.65 }}>{t(`learn.faq.a${i}`)}</Typography>
              </AccordionDetails>
            </Accordion>
          ))}
        </Box>
      </Reveal>
    </Box>
  );
}

// ── The call to open a network: the finder's own drop zone, at the top of the page

function OpenCall() {
  const theme = useTheme();
  const { t } = useLanguage();
  const reduced = useReducedMotion();
  const pick = () => {
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
    document.querySelector('[data-testid="find-network-upload"]')?.click();
  };
  return (
    <Box data-testid="home-open-call" sx={{ borderRadius: "24px", p: { xs: 3.5, md: 7 }, display: "grid", gridTemplateColumns: { xs: "1fr", md: "minmax(0, 1fr) minmax(0, 1fr)" }, gap: { xs: 3, md: 5 }, alignItems: "center", color: "#fff", background: `linear-gradient(135deg, #0B2447 0%, ${theme.palette.primary.dark} 60%, ${theme.palette.primary.main} 100%)` }}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
        <Typography component="h2" sx={{ fontSize: { xs: "1.7rem", md: "2.3rem" }, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.1 }}>
          {t("home.cta.title")}
        </Typography>
        <Typography sx={{ fontSize: "1.05rem", color: "rgba(255,255,255,0.8)" }}>{t("home.cta.text")}</Typography>
      </Box>
      <ButtonBase onClick={pick} data-testid="home-open-call-drop" sx={{ justifyContent: "flex-start", gap: 2, p: 2.75, borderRadius: "16px", border: "2px dashed rgba(255,255,255,0.55)", backgroundColor: "rgba(255,255,255,0.08)", textAlign: "left", transition: "background-color 150ms, border-color 150ms", "&:hover": { backgroundColor: "rgba(255,255,255,0.14)", borderColor: "#fff" }, "&.Mui-focusVisible": { outline: "2px solid #fff", outlineOffset: 2 } }}>
        <Box aria-hidden sx={{ width: 52, height: 52, flexShrink: 0, borderRadius: "13px", display: "flex", alignItems: "center", justifyContent: "center", color: theme.palette.primary.main, backgroundColor: "#fff" }}>
          <CloudUploadOutlinedIcon sx={{ fontSize: 26 }} />
        </Box>
        <Box>
          <Typography sx={{ fontSize: "1.05rem", fontWeight: 700 }}>{t("findNetwork.drop.home")}</Typography>
          <Typography sx={{ fontSize: "0.88rem", color: "rgba(255,255,255,0.8)" }}>{t("findNetwork.drop.hint")}</Typography>
        </Box>
      </ButtonBase>
    </Box>
  );
}

export default function LearnMore({ onTryDemo = null }) {
  return (
    <Box data-testid="learn-more-body" sx={{ display: "flex", flexDirection: "column" }}>
      <Container maxWidth={false} sx={{ maxWidth: HOME_WIDTH, py: { xs: 8, md: 13 } }}>
        <Journey />
      </Container>
      <Trust />
      <Container maxWidth={false} sx={{ maxWidth: HOME_WIDTH, pt: { xs: 8, md: 13 }, display: "flex", flexDirection: "column", gap: { xs: 8, md: 13 } }}>
        <Licence onTryDemo={onTryDemo} />
        <Faq />
      </Container>
      <Container maxWidth={false} sx={{ maxWidth: HOME_WIDTH, py: { xs: 8, md: 12 } }}>
        <Reveal>
          <OpenCall />
        </Reveal>
      </Container>
    </Box>
  );
}
