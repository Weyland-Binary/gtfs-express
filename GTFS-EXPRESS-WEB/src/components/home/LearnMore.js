/**
 * LearnMore — « En savoir plus », what GTFS Express does, folded under Home (`landing-more`).
 *
 * In the order a buyer asks, each part a title, one line, then cards — nothing to read twice:
 *
 *   Deux usages          reading (free, no account) and modifying (the licence), side by side
 *   Une modification     the modify journey's four steps, played by themselves (pausable), each with a small
 *                        live picture of what the step does
 *   Fiabilité            the six guarantees the product holds (the validator blocks, the objectives are
 *                        measured, simulated first, undoable versions, the brief as it is, nothing without you)
 *   Accès                reading free, the licence with the server's own price (never one written here), its
 *                        trial and its ways; « everything is open » on a server that sells nothing
 *   Vos données          what happens to the person's data, only what is true of the server
 *   Questions            six answers
 *
 * The reader's screenshots are not here: Home's head shows them beside its finder (home/ReaderViewer).
 *
 * On Home the whole page is ink (one blue ground, never paper and ink in turn):
 * `ink` makes every part's head and loose line white (InkContext) and leaves the ground to Home; the cards keep
 * their paper. Folded or alone, the parts keep the page's paper.
 *
 * Motion is decorative and quiet (parts rising into view, the journey's progress): with the system's « reduce
 * motion » nothing moves and the journey does not play by itself. Colours come from the theme only (rule #19).
 */

import { HOME_WIDTH } from "./inkGround";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Accordion, AccordionDetails, AccordionSummary, Box, Button, ButtonBase, Chip, Container, Typography, alpha, useMediaQuery, useTheme } from "@mui/material";
import { keyframes } from "@mui/system";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import EditRoadOutlinedIcon from "@mui/icons-material/EditRoadOutlined";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import PauseRoundedIcon from "@mui/icons-material/PauseRounded";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import VerifiedOutlinedIcon from "@mui/icons-material/VerifiedOutlined";
import QueryStatsOutlinedIcon from "@mui/icons-material/QueryStatsOutlined";
import ScienceOutlinedIcon from "@mui/icons-material/ScienceOutlined";
import HistoryOutlinedIcon from "@mui/icons-material/HistoryOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import HowToRegOutlinedIcon from "@mui/icons-material/HowToRegOutlined";
import LayersOutlinedIcon from "@mui/icons-material/LayersOutlined";
import VisibilityOffOutlinedIcon from "@mui/icons-material/VisibilityOffOutlined";
import ScheduleOutlinedIcon from "@mui/icons-material/ScheduleOutlined";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import PictureAsPdfOutlinedIcon from "@mui/icons-material/PictureAsPdfOutlined";
import TableChartOutlinedIcon from "@mui/icons-material/TableChartOutlined";
import ArticleOutlinedIcon from "@mui/icons-material/ArticleOutlined";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import RouteOutlinedIcon from "@mui/icons-material/RouteOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { openPricing, useFeatures } from "../../utils/featuresApi";
import { fetchPlans } from "../PricingDialog";

const rise = keyframes`
  from { opacity: 0; transform: translateY(18px); }
  to   { opacity: 1; transform: translateY(0); }
`;
const pop = keyframes`
  0%   { opacity: 0; transform: scale(0.6); }
  70%  { opacity: 1; transform: scale(1.08); }
  100% { opacity: 1; transform: scale(1); }
`;
const fill = keyframes`
  from { transform: scaleX(0); }
  to   { transform: scaleX(1); }
`;
const drift = keyframes`
  0%   { background-position: 0% 50%; }
  50%  { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
`;

const STEP_MS = 6000;

/** Whether the person asked the system to reduce motion. */
const useReducedMotion = () => useMediaQuery("(prefers-reduced-motion: reduce)");

/** A part that rises into view once, the first time it is seen (at once with reduced motion or without the API). */
function Reveal({ children, delay = 0, sx = {} }) {
  const reduced = useReducedMotion();
  const ref = useRef(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (reduced || typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return undefined;
    }
    const node = ref.current;
    if (!node) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [reduced]);
  return (
    <Box ref={ref} sx={{ opacity: seen ? 1 : 0, ...(seen && !reduced ? { animation: `${rise} 0.6s cubic-bezier(.2,.7,.2,1) ${delay}s both` } : {}), ...sx }}>
      {children}
    </Box>
  );
}

// Whether the parts stand on ink (Home's one blue ground): their heads and loose lines in white.
const InkContext = createContext(false);

/** A part's head: a small eyebrow, its title, one line; on ink (`ink`, or the parts' InkContext), in white. */
function SectionHead({ eyebrow, title, lead, align = "center", ink: inkProp = false }) {
  const ink = useContext(InkContext) || inkProp;
  const theme = useTheme();
  return (
    <Box sx={{ textAlign: align, maxWidth: 720, mx: align === "center" ? "auto" : 0, mb: { xs: 3, md: 4 } }}>
      <Typography component="span" sx={{ display: "inline-block", mb: 1, px: 1.25, py: 0.4, borderRadius: 999, fontSize: "0.72rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", ...(ink ? { color: "#e0e7ff", backgroundColor: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.18)" } : { color: theme.palette.primary.main, backgroundColor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.16 : 0.08) }) }}>
        {eyebrow}
      </Typography>
      <Typography component="h3" sx={{ fontSize: { xs: "1.45rem", md: "1.9rem" }, fontWeight: 750, letterSpacing: "-0.025em", lineHeight: 1.2, ...(ink ? { color: "#fff" } : {}) }}>
        {title}
      </Typography>
      {lead && <Typography sx={{ mt: 1, fontSize: { xs: "0.92rem", md: "1rem" }, color: ink ? "rgba(255,255,255,0.78)" : "text.secondary", lineHeight: 1.6 }}>{lead}</Typography>}
    </Box>
  );
}

/** A soft surface, lifted on hover where it can be acted on. */
const cardSx = (theme, { hover = false } = {}) => ({
  borderRadius: "18px",
  border: `1px solid ${theme.palette.divider}`,
  backgroundColor: theme.palette.background.paper,
  boxShadow: theme.palette.mode === "dark" ? "0 1px 0 rgba(255,255,255,0.03) inset" : "0 1px 2px rgba(15,23,42,0.04)",
  transition: "transform 220ms cubic-bezier(.2,.7,.2,1), box-shadow 220ms, border-color 220ms",
  ...(hover
    ? {
        "&:hover": {
          transform: "translateY(-3px)",
          borderColor: alpha(theme.palette.primary.main, 0.35),
          boxShadow: theme.palette.mode === "dark" ? "0 18px 40px rgba(0,0,0,0.45)" : "0 18px 40px rgba(15,23,42,0.10)",
        },
      }
    : {}),
});

/** An icon in its tinted square. */
function IconTile({ icon: Icon, color, size = 40 }) {
  const theme = useTheme();
  return (
    <Box aria-hidden sx={{ width: size, height: size, flexShrink: 0, borderRadius: size > 36 ? "12px" : "10px", display: "flex", alignItems: "center", justifyContent: "center", color, backgroundColor: alpha(color, theme.palette.mode === "dark" ? 0.18 : 0.1) }}>
      <Icon sx={{ fontSize: size * 0.5 }} />
    </Box>
  );
}

// ── Deux usages ──────────────────────────────────────────────────────────────

function UseCard({ testid, icon, color, tag, title, lead, bullets, cta, onCta }) {
  const theme = useTheme();
  return (
    <Box data-testid={testid} sx={{ ...cardSx(theme, { hover: true }), position: "relative", overflow: "hidden", p: { xs: 2.5, md: 3.25 }, display: "flex", flexDirection: "column", gap: 2, "&::before": { content: '""', position: "absolute", inset: "0 0 auto 0", height: 3, background: `linear-gradient(90deg, ${color}, ${alpha(color, 0.2)})` } }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
        <IconTile icon={icon} color={color} size={46} />
        <Box sx={{ minWidth: 0 }}>
          <Typography component="span" sx={{ fontSize: "0.72rem", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color }}>
            {tag}
          </Typography>
          <Typography component="h4" sx={{ fontSize: "1.3rem", fontWeight: 750, letterSpacing: "-0.02em", lineHeight: 1.2 }}>
            {title}
          </Typography>
        </Box>
      </Box>
      <Typography sx={{ fontSize: "0.92rem", color: "text.secondary", lineHeight: 1.55 }}>{lead}</Typography>
      <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 1.1 }}>
        {bullets.map((b) => (
          <Box component="li" key={b} sx={{ display: "flex", alignItems: "flex-start", gap: 1.1, fontSize: "0.9rem", lineHeight: 1.45 }}>
            <Box aria-hidden sx={{ mt: "1px", width: 20, height: 20, flexShrink: 0, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color, backgroundColor: alpha(color, theme.palette.mode === "dark" ? 0.2 : 0.12) }}>
              <CheckRoundedIcon sx={{ fontSize: 14 }} />
            </Box>
            <span>{b}</span>
          </Box>
        ))}
      </Box>
      {onCta && (
        <Button onClick={onCta} endIcon={<ArrowForwardRoundedIcon />} data-testid={`${testid}-cta`} sx={{ mt: "auto", alignSelf: "flex-start", textTransform: "none", fontWeight: 700, borderRadius: "10px", px: 1.5, color, "&:hover": { backgroundColor: alpha(color, 0.08) } }}>
          {cta}
        </Button>
      )}
    </Box>
  );
}

function Uses({ onTryDemo }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const read = theme.palette.success.main;
  const edit = theme.palette.primary.main;
  return (
    <Box component="section" data-testid="learn-uses">
      <Reveal>
        <SectionHead eyebrow={t("learn.uses.eyebrow")} title={t("learn.uses.title")} lead={t("learn.uses.lead")} />
      </Reveal>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" }, gap: { xs: 2, md: 2.5 } }}>
        <Reveal delay={0.05} sx={{ display: "flex", "& > *": { flex: 1 } }}>
          <UseCard testid="learn-use-read" icon={VisibilityOutlinedIcon} color={read} tag={t("learn.read.tag")} title={t("learn.read.title")} lead={t("learn.read.lead")} bullets={[1, 2, 3, 4, 5].map((i) => t(`learn.read.b${i}`))} cta={t("learn.read.cta")} onCta={onTryDemo} />
        </Reveal>
        <Reveal delay={0.12} sx={{ display: "flex", "& > *": { flex: 1 } }}>
          <UseCard testid="learn-use-edit" icon={EditRoadOutlinedIcon} color={edit} tag={t("learn.edit.tag")} title={t("learn.edit.title")} lead={t("learn.edit.lead")} bullets={[1, 2, 3, 4, 5].map((i) => t(`learn.edit.b${i}`))} cta={t("learn.edit.cta")} onCta={() => openPricing(null)} />
        </Reveal>
      </Box>
    </Box>
  );
}

// ── Une modification, de bout en bout: the four steps and their live pictures ──

/** A line of a picture that appears in its turn (`i`), once the picture is shown. */
const appear = (i, reduced) => (reduced ? {} : { opacity: 0, animation: `${rise} 0.45s cubic-bezier(.2,.7,.2,1) ${0.15 + i * 0.22}s both` });

function PictureBrief({ reduced }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const docs = [
    { icon: PictureAsPdfOutlinedIcon, name: t("learn.demo.doc1"), color: theme.palette.error.main },
    { icon: TableChartOutlinedIcon, name: t("learn.demo.doc2"), color: theme.palette.success.main },
    { icon: ArticleOutlinedIcon, name: t("learn.demo.doc3"), color: theme.palette.info.main },
  ];
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Box sx={{ ...cardSx(theme), p: 1.75, display: "flex", alignItems: "center", gap: 1.5, ...appear(0, reduced) }}>
        <IconTile icon={RouteOutlinedIcon} color={theme.palette.primary.main} />
        <Box>
          <Typography sx={{ fontWeight: 700, fontSize: "0.95rem" }}>{t("learn.demo.network")}</Typography>
          <Typography sx={{ fontSize: "0.8rem", color: "text.secondary" }}>{t("learn.demo.networkMeta")}</Typography>
        </Box>
        <CheckCircleRoundedIcon sx={{ ml: "auto", color: theme.palette.success.main }} />
      </Box>
      <Typography sx={{ mt: 0.5, fontSize: "0.74rem", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "text.secondary", ...appear(1, reduced) }}>{t("learn.demo.docs")}</Typography>
      {docs.map((d, i) => (
        <Box key={d.name} sx={{ ...cardSx(theme), px: 1.75, py: 1.1, display: "flex", alignItems: "center", gap: 1.25, ...appear(i + 2, reduced) }}>
          <d.icon sx={{ color: d.color }} />
          <Typography sx={{ fontSize: "0.88rem", fontWeight: 600 }}>{d.name}</Typography>
          <Chip size="small" icon={<AutoAwesomeRoundedIcon sx={{ fontSize: "14px !important" }} />} label={t("learn.demo.read")} sx={{ ml: "auto", height: 22, fontSize: "0.7rem", fontWeight: 700, color: theme.palette.ai.main, backgroundColor: alpha(theme.palette.ai.main, 0.12), "& .MuiChip-icon": { color: theme.palette.ai.main } }} />
        </Box>
      ))}
    </Box>
  );
}

function PictureObjectives({ reduced }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const items = [1, 2, 3].map((i) => ({ text: t(`learn.demo.obj${i}`), page: i + 1 }));
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
      {items.map((o, i) => (
        <Box key={o.text} sx={{ ...cardSx(theme), p: 1.6, display: "flex", alignItems: "flex-start", gap: 1.25, ...appear(i, reduced) }}>
          <Box aria-hidden sx={{ mt: "2px", width: 22, height: 22, flexShrink: 0, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", backgroundColor: theme.palette.success.main, ...(reduced ? {} : { opacity: 0, animation: `${pop} 0.4s ease-out ${0.55 + i * 0.22}s both` }) }}>
            <CheckRoundedIcon sx={{ fontSize: 15 }} />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontSize: "0.92rem", fontWeight: 650, lineHeight: 1.4 }}>{o.text}</Typography>
            <Typography sx={{ mt: 0.25, fontSize: "0.76rem", color: "text.secondary", fontStyle: "italic" }}>« {t("learn.demo.objSource", { page: o.page })} »</Typography>
          </Box>
        </Box>
      ))}
      <Box sx={{ alignSelf: "flex-end", display: "flex", alignItems: "center", gap: 0.75, px: 1.5, height: 34, borderRadius: 999, fontSize: "0.82rem", fontWeight: 700, color: theme.palette.primary.contrastText, backgroundColor: theme.palette.primary.main, ...appear(4, reduced) }}>
        <HowToRegOutlinedIcon sx={{ fontSize: 17 }} />
        {t("learn.demo.objConfirm")}
      </Box>
    </Box>
  );
}

function PictureChange({ reduced }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const before = ["07:00", "07:15", "07:30", "07:45", "08:00"];
  const after = ["07:00", "07:10", "07:20", "07:30", "07:40", "07:50", "08:00"];
  // A departure: kept, added (green, popping in), or removed (struck through).
  const cell = (time, state, i) => {
    const tone = state === "added" ? theme.palette.success.main : state === "removed" ? theme.palette.error.main : null;
    return (
      <Box key={`${time}-${i}`} sx={{ px: 1, py: 0.5, borderRadius: "8px", fontSize: "0.82rem", fontWeight: 650, fontVariantNumeric: "tabular-nums", border: `1px solid ${tone ? alpha(tone, 0.45) : theme.palette.divider}`, color: tone || "text.primary", backgroundColor: tone ? alpha(tone, 0.09) : "transparent", textDecoration: state === "removed" ? "line-through" : "none", ...(state === "added" && !reduced ? { opacity: 0, animation: `${pop} 0.4s ease-out ${0.75 + i * 0.1}s both` } : {}) }}>
        {time}
      </Box>
    );
  };
  return (
    <Box sx={{ ...cardSx(theme), p: 2, display: "flex", flexDirection: "column", gap: 1.75 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, ...appear(0, reduced) }}>
        <Box sx={{ px: 0.9, height: 22, borderRadius: "6px", display: "flex", alignItems: "center", fontSize: "0.74rem", fontWeight: 800, color: "#fff", backgroundColor: theme.palette.brand.info }}>3</Box>
        <Typography sx={{ fontWeight: 700, fontSize: "0.92rem" }}>{t("learn.demo.line3")}</Typography>
        <Chip size="small" label={t("learn.demo.modified")} sx={{ ml: "auto", height: 22, fontSize: "0.7rem", fontWeight: 700, color: theme.palette.warning.main, backgroundColor: alpha(theme.palette.warning.main, 0.14) }} />
      </Box>
      <Box sx={appear(1, reduced)}>
        <Typography sx={{ mb: 0.75, fontSize: "0.72rem", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "text.secondary" }}>{t("learn.demo.before")}</Typography>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>{before.map((x, i) => cell(x, after.includes(x) ? "same" : "removed", i))}</Box>
      </Box>
      <Box sx={appear(2, reduced)}>
        <Typography sx={{ mb: 0.75, fontSize: "0.72rem", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "text.secondary" }}>{t("learn.demo.after")}</Typography>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>{after.map((x, i) => cell(x, before.includes(x) ? "same" : "added", i))}</Box>
      </Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, fontSize: "0.86rem", fontWeight: 650, color: theme.palette.success.main, ...appear(3, reduced) }}>
        <QueryStatsOutlinedIcon sx={{ fontSize: 18 }} />
        {t("learn.demo.trips")}
      </Box>
    </Box>
  );
}

function PictureDelivery({ reduced }) {
  const theme = useTheme();
  const { t } = useLanguage();
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
      {[1, 2, 3].map((i) => (
        <Box key={i} sx={{ ...cardSx(theme), px: 1.75, py: 1.25, display: "flex", alignItems: "center", gap: 1.25, ...appear(i - 1, reduced) }}>
          <CheckCircleRoundedIcon sx={{ color: theme.palette.success.main, ...(reduced ? {} : { animation: `${pop} 0.4s ease-out ${0.3 + (i - 1) * 0.22}s both` }) }} />
          <Typography sx={{ fontSize: "0.92rem", fontWeight: 650 }}>{t(`learn.demo.check${i}`)}</Typography>
        </Box>
      ))}
      <Box sx={{ mt: 0.5, p: 2, borderRadius: "16px", display: "flex", alignItems: "center", gap: 1.5, color: "#fff", background: `linear-gradient(135deg, ${theme.palette.mode === "dark" ? theme.palette.ai.dark : theme.palette.primary.main}, ${theme.palette.ai.gradientStart})`, boxShadow: `0 14px 30px ${alpha(theme.palette.ai.main, 0.3)}`, ...appear(3, reduced) }}>
        <Box sx={{ width: 42, height: 42, borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.18)" }}>
          <Inventory2OutlinedIcon />
        </Box>
        <Box>
          <Typography sx={{ fontWeight: 750, fontSize: "0.98rem" }}>{t("learn.demo.package")}</Typography>
          <Typography sx={{ fontSize: "0.8rem", opacity: 0.85 }}>{t("learn.demo.packageFiles")}</Typography>
        </Box>
        <DownloadOutlinedIcon sx={{ ml: "auto", opacity: 0.9 }} />
      </Box>
    </Box>
  );
}

const PICTURES = [PictureBrief, PictureObjectives, PictureChange, PictureDelivery];

function Journey() {
  const theme = useTheme();
  const { t } = useLanguage();
  const reduced = useReducedMotion();
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(!reduced);
  const [hover, setHover] = useState(false);
  const running = playing && !hover && !reduced;

  // The steps play by themselves, one every few seconds, paused under the pointer or by the person.
  useEffect(() => {
    if (!running) return undefined;
    const timer = setTimeout(() => setActive((a) => (a + 1) % PICTURES.length), STEP_MS);
    return () => clearTimeout(timer);
  }, [running, active]);

  const pick = useCallback((i) => {
    setActive(i);
    setPlaying(false);
  }, []);
  const Picture = PICTURES[active];
  const accent = theme.palette.primary.main;
  return (
    <Box component="section" data-testid="learn-journey">
      <Reveal>
        <SectionHead eyebrow={t("learn.journey.eyebrow")} title={t("learn.journey.title")} lead={t("learn.journey.lead")} />
      </Reveal>
      <Reveal delay={0.05}>
        <Box onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} sx={{ ...cardSx(theme), p: { xs: 1.5, md: 2.5 }, display: "grid", gridTemplateColumns: { xs: "1fr", md: "minmax(0, 0.95fr) minmax(0, 1.05fr)" }, gap: { xs: 2, md: 3 }, background: `radial-gradient(1200px 400px at 100% 0%, ${alpha(theme.palette.ai.main, theme.palette.mode === "dark" ? 0.1 : 0.06)}, transparent 60%), ${theme.palette.background.paper}` }}>
          {/* The play/pause button stands beside the tablist, not inside it: a tablist may only hold tabs (axe
              aria-required-children). */}
          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
            <Box role="tablist" aria-orientation="vertical" aria-label={t("learn.journey.title")} sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
              {PICTURES.map((_, i) => {
                const on = i === active;
                return (
                  <ButtonBase key={i} role="tab" aria-selected={on} onClick={() => pick(i)} data-testid={`learn-step-${i + 1}`} sx={{ position: "relative", overflow: "hidden", justifyContent: "flex-start", alignItems: "flex-start", gap: 1.5, textAlign: "left", p: 1.75, borderRadius: "14px", border: `1px solid ${on ? alpha(accent, 0.4) : "transparent"}`, backgroundColor: on ? alpha(accent, theme.palette.mode === "dark" ? 0.12 : 0.06) : "transparent", transition: "background-color 220ms, border-color 220ms", "&:hover": on ? {} : { backgroundColor: alpha(theme.palette.text.primary, 0.035) } }}>
                    <Box aria-hidden sx={{ width: 30, height: 30, flexShrink: 0, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.86rem", fontWeight: 800, color: on ? theme.palette.primary.contrastText : "text.secondary", backgroundColor: on ? accent : alpha(theme.palette.text.primary, 0.07), transition: "background-color 220ms, color 220ms" }}>
                      {i + 1}
                    </Box>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography sx={{ fontSize: "0.98rem", fontWeight: 700, color: on ? "text.primary" : "text.secondary", lineHeight: 1.3 }}>{t(`learn.journey.s${i + 1}.title`)}</Typography>
                      <Box sx={{ display: "grid", gridTemplateRows: on ? "1fr" : "0fr", transition: "grid-template-rows 300ms ease" }}>
                        <Typography sx={{ overflow: "hidden", mt: on ? 0.5 : 0, fontSize: "0.86rem", color: "text.secondary", lineHeight: 1.5 }}>{t(`learn.journey.s${i + 1}.text`)}</Typography>
                      </Box>
                    </Box>
                    {on && running && <Box key={`p-${active}`} aria-hidden sx={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 3, transformOrigin: "left", backgroundColor: accent, animation: `${fill} ${STEP_MS}ms linear both` }} />}
                  </ButtonBase>
                );
              })}
            </Box>
            {!reduced && (
              <Button size="small" onClick={() => setPlaying((p) => !p)} startIcon={playing ? <PauseRoundedIcon /> : <PlayArrowRoundedIcon />} data-testid="learn-journey-play" sx={{ alignSelf: "flex-start", mt: 0.5, textTransform: "none", fontWeight: 600, color: "text.secondary" }}>
                {playing ? t("learn.journey.pause") : t("learn.journey.play")}
              </Button>
            )}
          </Box>
          <Box aria-live="polite" sx={{ position: "relative", minHeight: { xs: 300, md: 340 }, p: { xs: 0.5, md: 1.5 }, borderRadius: "14px", backgroundColor: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.03 : 0.02), border: `1px dashed ${theme.palette.divider}`, display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <Box key={active} data-testid="learn-step-picture" data-step={active + 1} sx={{ width: "100%", maxWidth: 440, mx: "auto" }}>
              <Picture reduced={reduced} />
            </Box>
          </Box>
        </Box>
      </Reveal>
    </Box>
  );
}

// ── Fiabilité ────────────────────────────────────────────────────────────────

function Trust() {
  const theme = useTheme();
  const { t } = useLanguage();
  const items = [
    { icon: VerifiedOutlinedIcon, color: theme.palette.success.main },
    { icon: QueryStatsOutlinedIcon, color: theme.palette.primary.main },
    { icon: ScienceOutlinedIcon, color: theme.palette.ai.main },
    { icon: HistoryOutlinedIcon, color: theme.palette.info.main },
    { icon: DescriptionOutlinedIcon, color: theme.palette.warning.main },
    { icon: HowToRegOutlinedIcon, color: theme.palette.secondary.main },
  ];
  return (
    <Box component="section" data-testid="learn-trust">
      <Reveal>
        <SectionHead eyebrow={t("learn.trust.eyebrow")} title={t("learn.trust.title")} lead={t("learn.trust.lead")} />
      </Reveal>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", md: "repeat(3, 1fr)" }, gap: { xs: 1.5, md: 2 } }}>
        {items.map((it, i) => (
          <Reveal key={i} delay={0.04 * i} sx={{ display: "flex", "& > *": { flex: 1 } }}>
            <Box sx={{ ...cardSx(theme, { hover: true }), p: 2.25, display: "flex", flexDirection: "column", gap: 1.25 }}>
              <IconTile icon={it.icon} color={it.color} />
              <Typography component="h4" sx={{ fontSize: "1.02rem", fontWeight: 700, letterSpacing: "-0.01em" }}>
                {t(`learn.trust.t${i + 1}.title`)}
              </Typography>
              <Typography sx={{ fontSize: "0.88rem", color: "text.secondary", lineHeight: 1.55 }}>{t(`learn.trust.t${i + 1}.text`)}</Typography>
            </Box>
          </Reveal>
        ))}
      </Box>
    </Box>
  );
}

// ── Accès: reading free, the licence as the server sells it ────────────────

function Licence({ onTryDemo }) {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const reduced = useReducedMotion();
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
  const price = useMemo(() => {
    if (!pro || !(pro.price_eur > 0)) return null;
    try {
      return new Intl.NumberFormat(language || "fr", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(pro.price_eur);
    } catch {
      return `${pro.price_eur} €`;
    }
  }, [pro, language]);
  // The same licence by the month, without commitment (online only).
  const priceMonth = useMemo(() => {
    if (!pro || !(pro.price_eur_month > 0)) return null;
    try {
      return new Intl.NumberFormat(language || "fr", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(pro.price_eur_month);
    } catch {
      return `${pro.price_eur_month} €`;
    }
  }, [pro, language]);
  const days = Number(plans?.trial_days) || 0;
  const bullets = [days > 0 ? t("learn.licence.b1", { days }) : null, t("learn.licence.b2"), t("learn.licence.b3")].filter(Boolean);
  // Deep tones in both modes: the dark theme's primary is too pale under white text.
  const start = theme.palette.mode === "dark" ? theme.palette.ai.dark : theme.palette.primary.main;
  const end = theme.palette.ai.gradientStart;
  return (
    <Box component="section" data-testid="learn-licence">
      <Reveal>
        <SectionHead eyebrow={t("learn.licence.eyebrow")} title={t("learn.licence.title")} />
      </Reveal>
      <Reveal delay={0.05}>
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "minmax(0, 0.8fr) minmax(0, 1.2fr)" }, gap: { xs: 2, md: 2.5 } }}>
          <Box sx={{ ...cardSx(theme), p: { xs: 2.5, md: 3 }, display: "flex", flexDirection: "column", gap: 1.25 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1.25 }}>
              <IconTile icon={VisibilityOutlinedIcon} color={theme.palette.success.main} size={44} />
              <Typography component="h4" sx={{ fontSize: "1.25rem", fontWeight: 750 }}>
                {t("learn.licence.read")}
              </Typography>
            </Box>
            <Typography sx={{ fontSize: "2.1rem", fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1, color: theme.palette.success.main }}>{t("pricing.free")}</Typography>
            <Typography sx={{ fontSize: "0.9rem", color: "text.secondary", lineHeight: 1.55 }}>{t("learn.licence.readText")}</Typography>
            {onTryDemo && (
              <Button onClick={onTryDemo} endIcon={<ArrowForwardRoundedIcon />} sx={{ mt: "auto", alignSelf: "flex-start", textTransform: "none", fontWeight: 700, borderRadius: "10px", color: theme.palette.success.main }}>
                {t("learn.read.cta")}
              </Button>
            )}
          </Box>
          <Box data-testid="learn-licence-card" sx={{ position: "relative", overflow: "hidden", borderRadius: "18px", p: { xs: 2.5, md: 3 }, color: "#fff", background: `linear-gradient(120deg, ${start}, ${end}, ${start})`, backgroundSize: "200% 200%", ...(reduced ? {} : { animation: `${drift} 14s ease-in-out infinite` }), boxShadow: `0 24px 60px ${alpha(start, 0.32)}` }}>
            <Box aria-hidden sx={{ position: "absolute", right: -60, top: -60, width: 220, height: 220, borderRadius: "50%", backgroundColor: "rgba(255,255,255,0.08)" }} />
            <Box aria-hidden sx={{ position: "absolute", right: 60, bottom: -90, width: 180, height: 180, borderRadius: "50%", backgroundColor: "rgba(255,255,255,0.06)" }} />
            <Box sx={{ position: "relative", display: "flex", flexDirection: "column", gap: 1.5 }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1.25 }}>
                <Box sx={{ width: 44, height: 44, borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.18)" }}>
                  <EditRoadOutlinedIcon />
                </Box>
                <Typography component="h4" sx={{ fontSize: "1.25rem", fontWeight: 750 }}>
                  {t("learn.licence.name")}
                </Typography>
              </Box>
              {plans && !paid ? (
                <Typography data-testid="learn-licence-open" sx={{ fontSize: "1rem", fontWeight: 600, opacity: 0.95 }}>
                  {t("learn.licence.open")}
                </Typography>
              ) : (
                <>
                  {price && (
                    <Box sx={{ display: "flex", alignItems: "baseline", gap: 1, flexWrap: "wrap" }}>
                      <Typography data-testid="learn-licence-price" sx={{ fontSize: "2.1rem", fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1 }}>
                        {price}
                      </Typography>
                      <Typography sx={{ fontSize: "0.92rem", opacity: 0.9 }}>{t("licence.perYear")}</Typography>
                      <Typography sx={{ fontSize: "0.74rem", px: 1, py: 0.25, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.16)" }}>{t("learn.licence.indicative")}</Typography>
                    </Box>
                  )}
                  {price && priceMonth && (
                    <Typography data-testid="learn-licence-monthly" sx={{ fontSize: "0.88rem", opacity: 0.92, mt: -0.75 }}>
                      {t("licence.perMonthAlt", { price: priceMonth })}
                    </Typography>
                  )}
                  <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.9 }}>
                    {bullets.map((b) => (
                      <Box component="li" key={b} sx={{ display: "flex", alignItems: "flex-start", gap: 1, fontSize: "0.9rem", lineHeight: 1.45 }}>
                        <CheckRoundedIcon sx={{ fontSize: 18, mt: "1px" }} />
                        <span>{b}</span>
                      </Box>
                    ))}
                  </Box>
                  <Button onClick={() => openPricing(null)} variant="contained" disableElevation endIcon={<ArrowForwardRoundedIcon />} data-testid="learn-licence-cta" sx={{ alignSelf: "flex-start", mt: 0.5, textTransform: "none", fontWeight: 750, borderRadius: "11px", px: 2.25, height: 42, color: start, backgroundColor: "#fff", "&:hover": { backgroundColor: "rgba(255,255,255,0.9)" } }}>
                    {t("learn.licence.cta")}
                  </Button>
                </>
              )}
            </Box>
          </Box>
        </Box>
      </Reveal>
    </Box>
  );
}

// ── Vos données ──────────────────────────────────────────────────────────────

function Data() {
  const theme = useTheme();
  const { t } = useLanguage();
  const { features } = useFeatures();
  const days = features?.workspace?.retention_days ?? features?.projects_retention_days ?? null;
  const items = [
    { icon: LayersOutlinedIcon, title: t("learn.data.d1.title"), text: t("learn.data.d1.text") },
    { icon: VisibilityOffOutlinedIcon, title: t("learn.data.d2.title"), text: t("learn.data.d2.text") },
    { icon: ScheduleOutlinedIcon, title: t("learn.data.d3.title"), text: days ? t("learn.data.d3.text", { days }) : t("learn.data.d3.textNone") },
    { icon: DownloadOutlinedIcon, title: t("learn.data.d4.title"), text: t("learn.data.d4.text") },
  ];
  return (
    <Box component="section" data-testid="learn-data">
      <Reveal>
        <SectionHead eyebrow={t("learn.data.eyebrow")} title={t("learn.data.title")} />
      </Reveal>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", lg: "repeat(4, 1fr)" }, gap: { xs: 1.5, md: 2 } }}>
        {items.map((it, i) => (
          <Reveal key={it.title} delay={0.05 * i} sx={{ display: "flex", "& > *": { flex: 1 } }}>
            <Box sx={{ ...cardSx(theme), p: 2.25, display: "flex", flexDirection: "column", gap: 1 }}>
              <IconTile icon={it.icon} color={theme.palette.primary.main} size={36} />
              <Typography component="h4" sx={{ fontSize: "0.98rem", fontWeight: 700 }}>
                {it.title}
              </Typography>
              <Typography sx={{ fontSize: "0.86rem", color: "text.secondary", lineHeight: 1.55 }}>{it.text}</Typography>
            </Box>
          </Reveal>
        ))}
      </Box>
    </Box>
  );
}

// ── Questions ────────────────────────────────────────────────────────────────

function Faq() {
  const theme = useTheme();
  const { t } = useLanguage();
  const [open, setOpen] = useState(0);
  return (
    <Box component="section" data-testid="learn-faq">
      <Reveal>
        <SectionHead eyebrow={t("learn.faq.eyebrow")} title={t("learn.faq.title")} />
      </Reveal>
      <Reveal delay={0.05}>
        <Box sx={{ maxWidth: 860, mx: "auto", ...cardSx(theme), overflow: "hidden" }}>
          {[1, 2, 3, 4, 5, 6].map((i, idx) => (
            <Accordion key={i} disableGutters elevation={0} square expanded={open === idx} onChange={(_, on) => setOpen(on ? idx : -1)} data-testid={`learn-faq-${i}`} sx={{ backgroundColor: "transparent", "&:before": { display: "none" }, "& + &": { borderTop: `1px solid ${theme.palette.divider}` } }}>
              <AccordionSummary expandIcon={<ExpandMoreRoundedIcon />} sx={{ px: { xs: 2, md: 2.75 }, minHeight: 60, "& .MuiAccordionSummary-content": { my: 1.5 } }}>
                <Typography sx={{ fontSize: "0.98rem", fontWeight: 650 }}>{t(`learn.faq.q${i}`)}</Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ px: { xs: 2, md: 2.75 }, pt: 0, pb: 2.25 }}>
                <Typography sx={{ fontSize: "0.92rem", color: "text.secondary", lineHeight: 1.65 }}>{t(`learn.faq.a${i}`)}</Typography>
              </AccordionDetails>
            </Accordion>
          ))}
        </Box>
      </Reveal>
    </Box>
  );
}

/**
 * One part of the page, edge to edge, the content in the page's column over the network under the page (z 2): the
 * part itself makes no stacking context. Folded under the projects (`bands` false), the parts keep the fold's width.
 * On a page of ink (`onInk`, Home), no part draws a ground: the page's own is under all of them.
 */
function Part({ bands = true, tight = false, onInk = false, children }) {
  if (!bands) return <Box sx={{ py: tight ? 1 : { xs: 3, md: 4.5 } }}>{children}</Box>;
  if (onInk) {
    return (
      <Box sx={{ position: "relative", py: { xs: 4, md: 5.5 } }}>
        <Container maxWidth={false} sx={{ position: "relative", zIndex: 2, maxWidth: HOME_WIDTH }}>
          {children}
        </Container>
      </Box>
    );
  }
  return (
    <Box sx={{ position: "relative", py: { xs: 3, md: 4.5 } }}>
      <Container maxWidth={false} sx={{ position: "relative", zIndex: 2, maxWidth: HOME_WIDTH }}>
        {children}
      </Container>
    </Box>
  );
}

export default function LearnMore({ onTryDemo = null, bands = true, ink = false }) {
  const onInk = bands && ink;
  return (
    <InkContext.Provider value={onInk}>
      <Box data-testid="learn-more-body" data-on-ink={onInk ? "true" : undefined} sx={{ display: "flex", flexDirection: "column", py: { xs: 2, md: 3 } }}>
        <Part bands={bands} onInk={onInk}>
          <Uses onTryDemo={onTryDemo} />
        </Part>
        <Part bands={bands} onInk={onInk}>
          <Journey />
        </Part>
        <Part bands={bands} onInk={onInk}>
          <Trust />
        </Part>
        <Part bands={bands} onInk={onInk}>
          <Licence onTryDemo={onTryDemo} />
        </Part>
        <Part bands={bands} onInk={onInk}>
          <Data />
        </Part>
        <Part bands={bands} onInk={onInk}>
          <Faq />
        </Part>
      </Box>
    </InkContext.Provider>
  );
}
