/**
 * Home on a phone (utils/layout): the product shown, not run. The same words as Home on a computer, in one column: the
 * title and the way to hand the product over to a computer (the phone's share sheet), the real screens one after the
 * other, what is sure, the features, the prices and the questions. The application itself opens on a computer.
 * The showcase moves on by itself, stops at a touch or with its pause (WCAG 2.2.2), and never moves with reduced motion.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Accordion, AccordionDetails, AccordionSummary, Box, Button, ButtonBase, IconButton, Typography, alpha, useMediaQuery, useTheme } from "@mui/material";
import { keyframes } from "@mui/system";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import PauseRoundedIcon from "@mui/icons-material/PauseRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import VerifiedUserOutlinedIcon from "@mui/icons-material/VerifiedUserOutlined";
import HowToRegOutlinedIcon from "@mui/icons-material/HowToRegOutlined";
import LayersOutlinedIcon from "@mui/icons-material/LayersOutlined";
import HistoryOutlinedIcon from "@mui/icons-material/HistoryOutlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { licenceLockOf, openPaywall, openPricing, useFeatures } from "../../utils/featuresApi";
import { trackUi } from "../../utils/uiTelemetry";
import { fetchPlans } from "../PricingDialog";
import { launchOf, launchUntilText } from "../../utils/launchOffer";
import LaunchBadge from "../account/LaunchBadge";
import { FEATURES, IconTile } from "./HomeFeatures";
import { FAQ } from "./LearnMore";
import { SHOWCASE, readerShot } from "./readerShots";
import { INK, homeGroundOf } from "./inkGround";
import MobileBar, { PageLink, pageLinksOf } from "./MobileBar";
import { SkipLink } from "../AppShell";
import { ShareButton, useSendToComputer } from "./MobileShare";

export const SLIDE_MS = 4500;
// The showcase's screens on a phone, a change shown by a brief's decision as on a computer.
const SLIDES = ["reader", "modify", "sheets", "shapes"].map((key) => SHOWCASE.find((s) => s.key === key));
const ON_BLUE = "rgba(255,255,255,0.88)";

const rise = keyframes`
  from { opacity: 0; transform: translateY(14px); }
  to   { opacity: 1; transform: none; }
`;
const riseSx = (delay) => ({ animation: `${rise} 0.6s ease-out ${delay}s both` });

const bandOf = (theme) => (theme.palette.mode === "dark" ? `linear-gradient(135deg, ${theme.palette.background.default} 0%, ${INK} 100%)` : `linear-gradient(135deg, ${INK} 0%, ${theme.palette.primary.dark} 55%, ${theme.palette.primary.main} 100%)`);

function Eyebrow({ children, onBlue = false }) {
  return <Typography sx={{ fontSize: "0.75rem", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: onBlue ? ON_BLUE : "primary.main", mb: 0.75 }}>{children}</Typography>;
}

function SectionTitle({ children, onBlue = false, id }) {
  const theme = useTheme();
  return (
    <Typography id={id} component="h2" sx={{ fontSize: "1.65rem", lineHeight: 1.15, fontWeight: 800, letterSpacing: "-0.03em", color: onBlue ? theme.palette.common.white : theme.palette.mode === "dark" ? "text.primary" : "primary.dark" }}>
      {children}
    </Typography>
  );
}

function Hero({ onShare }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { features } = useFeatures();
  const dark = theme.palette.mode === "dark";
  const lock = licenceLockOf(features?.access);
  const trial = lock === "sign_in_required" || lock === "subscription_required";
  const days = features?.access?.billing?.trial_days || 0;
  return (
    <Box
      component="section"
      aria-labelledby="mobile-home-title"
      data-testid="mobile-hero"
      sx={{
        px: 2.5,
        pt: 3.5,
        pb: 3,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <Box sx={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 1, px: 1.5, py: 0.75, borderRadius: 999, fontSize: "0.88rem", fontWeight: 600, color: "primary.main", backgroundColor: alpha(theme.palette.primary.main, dark ? 0.18 : 0.08), ...riseSx(0) }}>
        <VisibilityOutlinedIcon aria-hidden sx={{ fontSize: 17 }} />
        {t("home.chip")}
      </Box>
      <Typography id="mobile-home-title" component="h1" sx={{ fontSize: "2.25rem", lineHeight: 1.06, fontWeight: 800, letterSpacing: "-0.04em", textWrap: "balance", color: dark ? "text.primary" : "primary.dark", ...riseSx(0.08) }}>
        {t("hero.titleBefore")}
        <Box component="span" sx={{ background: `linear-gradient(90deg, ${theme.palette.primary.main}, ${theme.palette.primary.light})`, WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent" }}>
          {t("hero.highlight")}
        </Box>
        {t("hero.titleAfter")}
      </Typography>
      <Typography sx={{ fontSize: "1rem", lineHeight: 1.6, color: "text.secondary", ...riseSx(0.18) }}>{t("home.hero.sub")}</Typography>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25, mt: 0.5, ...riseSx(0.28) }}>
        <ShareButton onClick={onShare} />
        {trial && (
          <Button
            variant="outlined"
            onClick={() => {
              trackUi("trial.click", "home");
              openPaywall("studio", lock);
            }}
            data-testid="home-trial"
            sx={{ minHeight: 50, borderRadius: "14px", textTransform: "none", fontSize: "1rem", fontWeight: 600, backgroundColor: dark ? "transparent" : theme.palette.background.paper }}
          >
            {days > 0 ? t("home.trial", { days }) : t("home.trialNoDays")}
          </Button>
        )}
        <Typography sx={{ textAlign: "center", fontSize: "0.82rem", color: "text.secondary" }}>{t("mobile.desktopNote")}</Typography>
      </Box>
    </Box>
  );
}

function PhoneShowcase() {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const trackRef = useRef(null);
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const playing = !reduced && !paused;
  const goTo = useCallback(
    (i) => {
      const track = trackRef.current;
      const card = track?.children[i];
      if (!track || !card) return;
      track.scrollTo({ left: card.offsetLeft - track.offsetLeft - parseFloat(getComputedStyle(track).paddingLeft || "0"), behavior: reduced ? "auto" : "smooth" });
    },
    [reduced],
  );
  useEffect(() => {
    if (!playing) return undefined;
    const id = setTimeout(() => goTo((active + 1) % SLIDES.length), SLIDE_MS);
    return () => clearTimeout(id);
  }, [active, playing, goTo]);
  const onScroll = () => {
    const track = trackRef.current;
    if (!track || !track.children.length) return;
    const step = track.children[0].offsetWidth + 14;
    setActive(Math.max(0, Math.min(SLIDES.length - 1, Math.round(track.scrollLeft / step))));
  };
  return (
    <Box component="section" aria-labelledby="mobile-showcase-title" data-testid="mobile-showcase" sx={{ py: 4.5, color: theme.palette.common.white, background: bandOf(theme), overflow: "hidden" }}>
      <Box sx={{ px: 2.5, mb: 2.5 }}>
        <Eyebrow onBlue>{t("mobile.showcase.eyebrow")}</Eyebrow>
        <SectionTitle onBlue id="mobile-showcase-title">
          {t("home.show.title")}
        </SectionTitle>
      </Box>
      {/* A touch on the screens stops them moving: the person reads at their own pace. */}
      <Box
        ref={trackRef}
        onScroll={onScroll}
        onTouchStart={() => setPaused(true)}
        onPointerDown={() => setPaused(true)}
        data-testid="mobile-showcase-track"
        sx={{ display: "flex", gap: "14px", overflowX: "auto", px: 2.5, pb: 0.5, scrollSnapType: "x mandatory", scrollPaddingLeft: "20px", overscrollBehaviorX: "contain", scrollbarWidth: "none", "&::-webkit-scrollbar": { display: "none" } }}
      >
        {SLIDES.map((slide, i) => (
          <Box component="figure" key={slide.key} data-testid={`mobile-showcase-${slide.key}`} sx={{ m: 0, flex: "0 0 min(300px, 80vw)", scrollSnapAlign: "start", display: "flex", flexDirection: "column", gap: 1.5 }}>
            <Box sx={{ p: "8px 8px 12px", borderRadius: "14px 14px 6px 6px", backgroundColor: theme.palette.grey[900], boxShadow: "0 24px 50px rgba(0,0,0,0.35)" }}>
              <Box component="img" src={readerShot(slide.file, theme.palette.mode, language)} alt={t(`home.show.${slide.key}.title`)} loading={i === 0 ? "eager" : "lazy"} sx={{ width: "100%", aspectRatio: "16 / 9", display: "block", borderRadius: "6px", objectFit: "cover" }} />
            </Box>
            <Box component="figcaption" sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
              <Typography component="h3" sx={{ fontSize: "1.06rem", fontWeight: 700 }}>
                {t(`home.show.${slide.key}.title`)}
              </Typography>
              <Typography sx={{ fontSize: "0.9rem", lineHeight: 1.5, color: ON_BLUE }}>{t(`home.show.${slide.key}.text`)}</Typography>
            </Box>
          </Box>
        ))}
      </Box>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 1, mt: 2 }}>
        {SLIDES.map((slide, i) => (
          <ButtonBase key={slide.key} onClick={() => { setPaused(true); goTo(i); }} aria-label={t(`home.show.${slide.key}.title`)} aria-current={i === active ? "true" : undefined} data-testid={`mobile-showcase-dot-${i}`} sx={{ width: 32, height: 44, borderRadius: 2 }}>
            <Box aria-hidden sx={{ width: i === active ? 22 : 6, height: 6, borderRadius: 3, backgroundColor: i === active ? theme.palette.common.white : "rgba(255,255,255,0.45)", transition: "width .25s, background-color .25s" }} />
          </ButtonBase>
        ))}
        {!reduced && (
          <IconButton onClick={() => setPaused((p) => !p)} aria-label={paused ? t("learn.reader.play") : t("learn.reader.pause")} aria-pressed={paused} data-testid="mobile-showcase-pause" sx={{ ml: 1, width: 44, height: 44, color: theme.palette.common.white, backgroundColor: "rgba(255,255,255,0.12)", "&:hover": { backgroundColor: "rgba(255,255,255,0.2)" } }}>
            {paused ? <PlayArrowRoundedIcon /> : <PauseRoundedIcon />}
          </IconButton>
        )}
      </Box>
    </Box>
  );
}

function Strip() {
  const theme = useTheme();
  const { t } = useLanguage();
  const items = [
    { key: "validator", icon: VerifiedUserOutlinedIcon, tone: theme.palette.success.main },
    { key: "decision", icon: HowToRegOutlinedIcon, tone: theme.palette.primary.main },
    { key: "files", icon: LayersOutlinedIcon, tone: theme.palette.info.main },
  ];
  return (
    <Box component="ul" aria-label={t("home.strip.label")} data-testid="home-strip" sx={{ listStyle: "none", m: "24px 16px 0", px: 2, py: 0.75, borderRadius: "18px", backgroundColor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
      {items.map(({ key, icon, tone }, i) => (
        <Box component="li" key={key} sx={{ display: "flex", alignItems: "center", gap: 1.75, py: 1.5, borderTop: i ? `1px solid ${theme.palette.divider}` : "none" }}>
          <IconTile icon={icon} tone={tone} size={40} />
          <Typography sx={{ fontSize: "0.95rem", fontWeight: 600 }}>{t(`home.strip.${key}`)}</Typography>
        </Box>
      ))}
    </Box>
  );
}

function Features() {
  const theme = useTheme();
  const { t } = useLanguage();
  return (
    <Box component="section" aria-labelledby="mobile-features-title" data-testid="mobile-features" sx={{ px: 2, pt: 5, display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ px: 0.5 }}>
        <Eyebrow>{t("home.features.eyebrow")}</Eyebrow>
        <SectionTitle id="mobile-features-title">{t("home.features.title")}</SectionTitle>
        <Typography sx={{ mt: 1, fontSize: "0.95rem", lineHeight: 1.55, color: "text.secondary" }}>{t("home.features.lead")}</Typography>
      </Box>
      <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 1.25 }}>
        {FEATURES.map(({ key, icon, tone }) => (
          <Box component="li" key={key} sx={{ p: 1.75, borderRadius: "16px", backgroundColor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, display: "flex", flexDirection: "column", gap: 1 }}>
            <IconTile icon={icon} tone={tone(theme.palette)} size={36} />
            <Typography component="h3" sx={{ fontSize: "0.9rem", fontWeight: 700, lineHeight: 1.3 }}>
              {t(`home.features.${key}.title`)}
            </Typography>
            <Typography sx={{ fontSize: "0.82rem", lineHeight: 1.45, color: "text.secondary" }}>{t(`home.features.${key}.text`)}</Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function Trust() {
  const theme = useTheme();
  const { t } = useLanguage();
  const items = [
    { key: "learn.trust.t1", icon: VerifiedUserOutlinedIcon },
    { key: "learn.trust.t4", icon: HistoryOutlinedIcon },
    { key: "learn.trust.t6", icon: HowToRegOutlinedIcon },
    { key: "learn.data.d2", icon: LockOutlinedIcon },
  ];
  return (
    <Box component="section" aria-labelledby="mobile-trust-title" data-testid="mobile-trust" sx={{ mt: 5, px: 2.5, py: 5, color: theme.palette.common.white, background: bandOf(theme), display: "flex", flexDirection: "column", gap: 2.25 }}>
      <SectionTitle onBlue id="mobile-trust-title">
        {t("learn.trust.title")}
      </SectionTitle>
      <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 2.25 }}>
        {items.map(({ key, icon: Icon }) => (
          <Box component="li" key={key} sx={{ display: "flex", gap: 1.75 }}>
            <Box aria-hidden sx={{ width: 40, height: 40, flexShrink: 0, borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.12)" }}>
              <Icon sx={{ fontSize: 21 }} />
            </Box>
            <Box>
              <Typography component="h3" sx={{ fontSize: "0.98rem", fontWeight: 700, mb: 0.25 }}>
                {t(`${key}.title`)}
              </Typography>
              <Typography sx={{ fontSize: "0.9rem", lineHeight: 1.5, color: ON_BLUE }}>{t(`${key}.text`)}</Typography>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function Prices() {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const { features } = useFeatures();
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
  const money = useCallback(
    (v) => {
      try {
        return new Intl.NumberFormat(language || "fr", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v);
      } catch {
        return `${v} €`;
      }
    },
    [language],
  );
  const pro = (plans?.plans || []).find((p) => p.id === "pro");
  const paid = plans?.model === "paid";
  const price = pro && pro.price_eur > 0 ? money(pro.price_eur) : null;
  const priceMonth = pro && pro.price_eur_month > 0 ? money(pro.price_eur_month) : null;
  const days = Number(plans?.trial_days) || 0;
  const launch = launchOf(pro);
  const priceNote = [priceMonth ? t("licence.perMonthAlt", { price: priceMonth }) : null, launch.until ? launchUntilText(t, launch.until, language) : launch.offer ? t("learn.licence.launch") : null].filter(Boolean).join(" · ");
  const quoteForm = () => openPricing(null, { way: "quote-form" });
  const lock = licenceLockOf(features?.access);
  const trial = lock === "sign_in_required" || lock === "subscription_required";
  const card = (featured = false) => ({ p: 2.25, borderRadius: "18px", backgroundColor: theme.palette.background.paper, border: featured ? `2px solid ${theme.palette.primary.main}` : `1px solid ${theme.palette.divider}`, boxShadow: featured ? `0 16px 36px ${alpha(theme.palette.primary.main, 0.14)}` : "none", display: "flex", flexDirection: "column", gap: 0.75 });
  const label = { fontSize: "0.88rem", fontWeight: 700, color: "text.secondary" };
  const amount = { fontSize: "1.75rem", fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.15 };
  return (
    <Box component="section" id="tarifs" aria-labelledby="mobile-prices-title" data-testid="mobile-prices" sx={{ px: 2, pt: 5, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Box sx={{ px: 0.5, pb: 0.5 }}>
        <Eyebrow>{t("learn.licence.eyebrow")}</Eyebrow>
        <SectionTitle id="mobile-prices-title">{t("learn.licence.title")}</SectionTitle>
      </Box>
      <Box sx={card()}>
        <Typography sx={label}>{t("learn.licence.read")}</Typography>
        <Typography sx={amount}>{t("pricing.free")}</Typography>
        <Typography sx={{ fontSize: "0.9rem", lineHeight: 1.5, color: "text.secondary" }}>{t("learn.licence.readText")}</Typography>
      </Box>
      <Box sx={card(true)} data-testid="mobile-prices-licence">
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
          <Typography sx={{ ...label, color: "primary.main" }}>{t("learn.licence.name")}</Typography>
          {paid && price && launch.offer ? <LaunchBadge testId="mobile-prices-launch" /> : null}
        </Box>
        {plans && !paid ? (
          <>
            <Typography sx={amount}>{t("pricing.free")}</Typography>
            <Typography sx={{ fontSize: "0.9rem", lineHeight: 1.5 }}>{t("learn.licence.open")}</Typography>
          </>
        ) : (
          <>
            <Box sx={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", columnGap: 0.75 }}>
              <Typography sx={{ ...amount, fontSize: "1.9rem" }}>{price || "…"}</Typography>
              {price && <Typography sx={{ fontSize: "0.9rem", color: "text.secondary" }}>{t("licence.perYear")}</Typography>}
            </Box>
            {price && priceNote && <Typography sx={{ fontSize: "0.82rem", color: "text.secondary" }}>{priceNote}</Typography>}
            <Typography sx={{ fontSize: "0.9rem", lineHeight: 1.5 }}>{t("learn.licence.text")}</Typography>
            {days > 0 && (
              <Typography sx={{ display: "flex", alignItems: "center", gap: 0.75, fontSize: "0.9rem", fontWeight: 600, color: "success.main" }}>
                <CheckRoundedIcon aria-hidden sx={{ fontSize: 19 }} />
                {t("learn.licence.b1", { days })}
              </Typography>
            )}
            {trial && (
              <Button
                variant="contained"
                disableElevation
                onClick={() => {
                  trackUi("trial.click", "home");
                  openPaywall("studio", lock);
                }}
                sx={{ mt: 0.75, minHeight: 50, borderRadius: "14px", textTransform: "none", fontSize: "1rem", fontWeight: 600 }}
              >
                {days > 0 ? t("home.trial", { days }) : t("home.trialNoDays")}
              </Button>
            )}
          </>
        )}
      </Box>
      {paid ? (
        <Box data-testid="mobile-public-buyers" sx={{ px: 0.5, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 0.5 }}>
          <Typography sx={{ fontSize: "0.92rem", lineHeight: 1.5 }}>{t("licence.publicBuyers")}</Typography>
          <Button variant="outlined" onClick={quoteForm} data-testid="mobile-public-buyers-quote" sx={{ minHeight: 44, borderRadius: "12px", textTransform: "none", fontSize: "0.95rem", fontWeight: 600 }}>
            {t("licence.way.quote.cta")}
          </Button>
        </Box>
      ) : null}
      <Box sx={card()}>
        <Typography sx={label}>{t("learn.licence.quote")}</Typography>
        <Typography sx={{ ...amount, fontSize: "1.5rem" }}>{t("learn.licence.quoteAmount")}</Typography>
        <Typography sx={{ fontSize: "0.9rem", lineHeight: 1.5, color: "text.secondary" }}>{t("learn.licence.quoteText")}</Typography>
        <Button onClick={quoteForm} data-testid="mobile-prices-quote" sx={{ alignSelf: "flex-start", minHeight: 44, px: 0, textTransform: "none", fontSize: "0.95rem", fontWeight: 600 }}>
          {t("learn.licence.quoteCta")}
        </Button>
      </Box>
    </Box>
  );
}

function Faq() {
  const theme = useTheme();
  const { t } = useLanguage();
  const [open, setOpen] = useState(0);
  return (
    <Box component="section" id="questions" aria-labelledby="mobile-faq-title" data-testid="mobile-faq" sx={{ px: 2, pt: 5 }}>
      <Box sx={{ px: 0.5, pb: 1.5 }}>
        <SectionTitle id="mobile-faq-title">{t("learn.faq.title")}</SectionTitle>
      </Box>
      <Box sx={{ borderRadius: "18px", overflow: "hidden", border: `1px solid ${theme.palette.divider}`, backgroundColor: theme.palette.background.paper }}>
        {FAQ.map((i, idx) => (
          <Accordion key={i} disableGutters elevation={0} square expanded={open === idx} onChange={(_, on) => setOpen(on ? idx : -1)} data-testid={`mobile-faq-${i}`} sx={{ backgroundColor: "transparent", borderTop: idx ? `1px solid ${theme.palette.divider}` : "none", "&:before": { display: "none" } }}>
            <AccordionSummary expandIcon={<ExpandMoreRoundedIcon color="primary" />} sx={{ px: 2, minHeight: 56, "& .MuiAccordionSummary-content": { my: 1.5 } }}>
              <Typography component="h3" sx={{ fontSize: "0.98rem", fontWeight: 650, lineHeight: 1.4 }}>
                {t(`learn.faq.q${i}`)}
              </Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ px: 2, pt: 0, pb: 2 }}>
              <Typography sx={{ fontSize: "0.92rem", lineHeight: 1.6, color: "text.secondary" }}>{t(`learn.faq.a${i}`)}</Typography>
            </AccordionDetails>
          </Accordion>
        ))}
      </Box>
    </Box>
  );
}

function Call({ onShare }) {
  const theme = useTheme();
  const { t } = useLanguage();
  return (
    <Box component="section" aria-labelledby="mobile-call-title" data-testid="mobile-call" sx={{ m: "40px 16px 0", p: 3, borderRadius: "24px", color: theme.palette.common.white, background: bandOf(theme), display: "flex", flexDirection: "column", gap: 1.5 }}>
      <SectionTitle onBlue id="mobile-call-title">
        {t("home.cta.title")}
      </SectionTitle>
      <Typography sx={{ fontSize: "0.95rem", lineHeight: 1.55, color: ON_BLUE }}>{t("mobile.cta.text")}</Typography>
      <ShareButton onClick={onShare} onBlue sx={{ mt: 0.75 }} />
    </Box>
  );
}

function Foot() {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const links = useMemo(() => pageLinksOf(t, language), [t, language]);
  return (
    <Box component="footer" data-testid="mobile-footer" sx={{ mt: 5, px: 2.5, pt: 3, pb: "max(32px, env(safe-area-inset-bottom))", backgroundColor: theme.palette.background.paper, borderTop: `1px solid ${theme.palette.divider}`, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Box component="nav" aria-label={t("a11y.legalNav")} sx={{ display: "flex", flexWrap: "wrap", columnGap: 2.25 }}>
        {links.map((link) => (
          <PageLink key={link.testid} link={link} sx={{ fontSize: "0.92rem" }} />
        ))}
      </Box>
      <Typography sx={{ fontSize: "0.82rem", color: "text.secondary" }}>© {new Date().getFullYear()} Weyland-Binary</Typography>
    </Box>
  );
}

export default function MobileHome({ title = null }) {
  const theme = useTheme();
  const { send, snackbar } = useSendToComputer("home");
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
  return (
    <Box data-testid="mobile-home" sx={{ minHeight: "100dvh", display: "flex", flexDirection: "column", backgroundColor: homeGroundOf(theme), overflowX: "clip" }}>
      <SkipLink />
      <MobileBar />
      <Box component="main" id="main" tabIndex={-1} sx={{ flex: 1, display: "flex", flexDirection: "column", outline: "none" }}>
        <Hero onShare={send} />
        <PhoneShowcase />
        <Strip />
        <Features />
        <Trust />
        <Prices />
        <Faq />
        <Call onShare={send} />
      </Box>
      <Foot />
      {snackbar}
    </Box>
  );
}
