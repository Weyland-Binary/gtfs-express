/**
 * Home's showcase: what the product does, one feature a tab (read the network, draw its shapes, change it, print its
 * stop sheets, query it in SQL), each shown by a screenshot of the real screen on a
 * 1920×1080 desktop (home/readerShots SHOWCASE, taken in the lab by e2e/tools/showcase-shots.mjs).
 * The tabs follow each other every SLIDE_MS, hold under the pointer or the keyboard, stop with the pause (WCAG
 * 2.2.2) and never move by themselves with reduced motion; the next picture is preloaded, the first loaded lazily
 * (the showcase sits under the finder). « Voir en vrai » opens the demo network on the screen the tab shows (the edit
 * screens behind the licence's gate); the tabs chosen and the screens opened are counted for the console.
 * It sits on the guarantees band's deep blue, so the light screenshots stand out from the page.
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, ButtonBase, Container, Dialog, IconButton, Typography, alpha, useMediaQuery, useTheme } from "@mui/material";
import { keyframes } from "@mui/system";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import GestureOutlinedIcon from "@mui/icons-material/GestureOutlined";
import PrintOutlinedIcon from "@mui/icons-material/PrintOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import ZoomInRoundedIcon from "@mui/icons-material/ZoomInRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import PauseRoundedIcon from "@mui/icons-material/PauseRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import { useDestructiveGuard } from "../../contexts/DestructiveGuardContext";
import { trackUi } from "../../utils/uiTelemetry";
import { useLanguage } from "../../contexts/LanguageContext";
import { SHOWCASE, readerShot } from "./readerShots";
import { SHOWCASE_WIDTH } from "./inkGround";
import Reveal from "./Reveal";

export const SLIDE_MS = 7000;

const ICONS = { reader: VisibilityOutlinedIcon, shapes: GestureOutlinedIcon, modify: EditOutlinedIcon, sheets: PrintOutlinedIcon, sql: StorageOutlinedIcon };

const fadeIn = keyframes`
  from { opacity: 0; transform: scale(0.995); }
  to   { opacity: 1; transform: scale(1); }
`;

const preload = (src) => {
  try {
    const img = new Image();
    img.src = src;
  } catch {
    /* no Image in this environment */
  }
};

// The whole section fits one screen: the picture is as wide as the column allows, never taller than what the app's
// bars, the tabs and the caption leave of the window.
const FRAME_WIDTH = { xs: "100%", md: "min(100%, calc((100vh - 340px) * 16 / 9))" };

// A dark glass so the controls read on any screenshot, light or dark.
const GLASS = "rgba(15, 23, 42, 0.62)";
// The deep end of the blue bands (LearnMore's guarantees and call), and the white levels read on it.
const INK = "#0B2447";
const ON_BLUE = { text: "rgba(255,255,255,0.8)", line: "rgba(255,255,255,0.2)", wash: "rgba(255,255,255,0.08)", hover: "rgba(255,255,255,0.14)" };

export default function Showcase({ onTry = null }) {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const { guard } = useDestructiveGuard();
  const [opening, setOpening] = useState(false);
  // The demo replaces the network open here: unsaved edits go through the destructive guard first.
  const tryIt = (key) => {
    if (!onTry || opening) return;
    trackUi("showcase.try", key);
    guard(
      async () => {
        setOpening(true);
        try {
          await onTry(key);
        } finally {
          setOpening(false);
        }
      },
      { reason: "loadSample" },
    );
  };
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [active, setActive] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [paused, setPaused] = useState(false);
  const [hold, setHold] = useState(false);
  const shot = SHOWCASE[active];
  const srcOf = (s) => readerShot(s.file, theme.palette.mode, language);
  const src = srcOf(shot);
  const title = t(`home.show.${shot.key}.title`);
  const playing = !reduced && !paused && !zoom;
  const remaining = useRef(SLIDE_MS);
  const white = theme.palette.common.white;
  const dark = theme.palette.mode === "dark";
  const focusRing = { outline: `2px solid ${white}`, outlineOffset: 2 };

  // A new tab gets its whole time; a hold keeps what was left.
  useEffect(() => {
    remaining.current = SLIDE_MS;
  }, [active]);
  useEffect(() => {
    if (!playing || hold) return undefined;
    const started = Date.now();
    const id = setTimeout(() => setActive((i) => (i + 1) % SHOWCASE.length), remaining.current);
    return () => {
      clearTimeout(id);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [active, playing, hold]);
  useEffect(() => {
    preload(srcOf(SHOWCASE[(active + 1) % SHOWCASE.length]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, language, theme.palette.mode]);

  // Arrow keys move between the tabs, as in a WAI-ARIA tab list.
  const onKeyDown = (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const n = (active + step + SHOWCASE.length) % SHOWCASE.length;
    setActive(n);
    e.currentTarget.querySelectorAll('[role="tab"]')[n]?.focus();
  };

  return (
    <Box
      component="section"
      aria-labelledby="home-showcase-title"
      data-testid="home-showcase"
      data-playing={playing && !hold ? "true" : "false"}
      onMouseEnter={() => setHold(true)}
      onMouseLeave={() => setHold(false)}
      onFocus={() => setHold(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setHold(false)}
      sx={{
        position: "relative",
        overflow: "hidden",
        color: white,
        pt: { xs: 6, md: 7 },
        pb: { xs: 7, md: 9 },
        background: `linear-gradient(135deg, ${dark ? theme.palette.primary.dark : INK} 0%, ${theme.palette.primary.dark} 55%, ${theme.palette.primary.main} 100%)`,
        // A soft light under the picture and a faint dot grid, fading out at the edges.
        "&::before": { content: '""', position: "absolute", inset: 0, pointerEvents: "none", background: "radial-gradient(55% 45% at 50% 62%, rgba(255,255,255,0.16), transparent 72%)" },
        "&::after": { content: '""', position: "absolute", inset: 0, pointerEvents: "none", backgroundImage: "radial-gradient(rgba(255,255,255,0.12) 1px, transparent 1.4px)", backgroundSize: "22px 22px", WebkitMaskImage: "radial-gradient(70% 60% at 50% 45%, #000 20%, transparent 75%)", maskImage: "radial-gradient(70% 60% at 50% 45%, #000 20%, transparent 75%)" },
      }}
    >
      <Container maxWidth={false} sx={{ position: "relative", zIndex: 1, maxWidth: SHOWCASE_WIDTH, display: "flex", flexDirection: "column", alignItems: "center", gap: { xs: 2, md: 2.5 } }}>
        {/* The tabs say what the section is: its heading is for screen readers and the page's outline only. */}
        <Typography id="home-showcase-title" component="h2" sx={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>
          {t("home.show.title")}
        </Typography>

        <Reveal>
        <Box role="tablist" aria-label={t("home.show.title")} onKeyDown={onKeyDown} data-testid="home-showcase-tabs" sx={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 0.75, p: 0.75, borderRadius: 999, backgroundColor: ON_BLUE.wash, border: `1px solid ${ON_BLUE.line}`, backdropFilter: "blur(8px)" }}>
          {SHOWCASE.map((s, i) => {
            const on = i === active;
            const Icon = ICONS[s.key];
            return (
              <ButtonBase
                key={s.key}
                role="tab"
                id={`home-show-tab-${s.key}`}
                aria-selected={on}
                aria-controls="home-show-panel"
                tabIndex={on ? 0 : -1}
                onClick={() => {
                  setActive(i);
                  trackUi("showcase.tab", s.key);
                }}
                onMouseEnter={() => preload(srcOf(s))}
                data-testid={`home-show-tab-${s.key}`}
                sx={{ gap: 0.85, px: { xs: 1.5, md: 2 }, height: { xs: 36, md: 40 }, borderRadius: 999, fontSize: { xs: "0.84rem", md: "0.92rem" }, fontWeight: on ? 700 : 550, color: on ? INK : ON_BLUE.text, backgroundColor: on ? white : "transparent", boxShadow: on ? "0 4px 14px rgba(2, 8, 23, 0.28)" : "none", transition: "background-color 200ms, color 200ms", "&:hover": on ? {} : { color: white, backgroundColor: ON_BLUE.hover }, "&.Mui-focusVisible": focusRing, "@media (prefers-reduced-motion: reduce)": { transition: "none" } }}
              >
                <Icon aria-hidden sx={{ fontSize: 18 }} />
                {t(`home.show.${s.key}.tab`)}
              </ButtonBase>
            );
          })}
        </Box>
        </Reveal>

        <Reveal delay={0.1} sx={{ width: "100%" }}>
        <Box role="tabpanel" id="home-show-panel" aria-labelledby={`home-show-tab-${shot.key}`} sx={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: { xs: 1.5, md: 2 } }}>
          {/* The caption, one row over the picture and as wide: what the tab shows, then « Voir en vrai ». */}
          <Box key={`text-${shot.key}`} sx={{ width: FRAME_WIDTH, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: { xs: "wrap", md: "nowrap" }, gap: { xs: 1.5, md: 3 }, minHeight: { md: 56 }, animation: `${fadeIn} 0.4s ease-out both`, "@media (prefers-reduced-motion: reduce)": { animation: "none" } }}>
            <Box sx={{ minWidth: 0, maxWidth: 820 }}>
              <Typography component="h3" sx={{ fontWeight: 700, fontSize: { xs: "1.05rem", md: "1.15rem" } }}>
                {title}
              </Typography>
              <Typography sx={{ mt: 0.25, color: ON_BLUE.text, fontSize: { xs: "0.9rem", md: "0.95rem" }, lineHeight: 1.45, textWrap: "pretty" }}>{t(`home.show.${shot.key}.text`)}</Typography>
            </Box>
            {onTry && (
              <ButtonBase onClick={() => tryIt(shot.key)} disabled={opening} data-testid="home-showcase-try" data-shot={shot.key} sx={{ flexShrink: 0, whiteSpace: "nowrap", gap: 0.75, px: 2, height: 36, borderRadius: 999, fontSize: "0.9rem", fontWeight: 700, color: INK, backgroundColor: white, boxShadow: "0 4px 14px rgba(2, 8, 23, 0.25)", transition: "background-color 150ms, transform 150ms", "&:hover": { backgroundColor: alpha(white, 0.9), transform: "translateY(-1px)" }, "&.Mui-focusVisible": focusRing, "@media (prefers-reduced-motion: reduce)": { transition: "none", "&:hover": { transform: "none" } } }}>
                {t("home.show.try")}
                <ArrowForwardRoundedIcon aria-hidden sx={{ fontSize: 18 }} />
              </ButtonBase>
            )}
          </Box>
          <Box component="figure" sx={{ m: 0, width: FRAME_WIDTH, position: "relative", borderRadius: { xs: "12px", md: "16px" }, overflow: "hidden", border: `1px solid ${ON_BLUE.line}`, backgroundColor: theme.palette.background.paper, boxShadow: `0 0 0 6px ${ON_BLUE.wash}, 0 40px 110px rgba(2, 8, 23, ${dark ? 0.7 : 0.5})`, "&:hover .show-zoom": { opacity: 1 } }}>
            <ButtonBase onClick={() => setZoom(true)} aria-label={`${t("learn.reader.zoom")} : ${title}`} data-testid="home-showcase-shot" data-shot={shot.key} sx={{ display: "block", width: "100%", aspectRatio: "16 / 9", backgroundColor: theme.palette.background.default, "&.Mui-focusVisible": { outline: `3px solid ${white}`, outlineOffset: -3 } }}>
              <Box key={src} component="img" src={src} alt={title} loading={active === 0 ? "lazy" : undefined} decoding="async" sx={{ display: "block", width: "100%", height: "100%", objectFit: "cover", objectPosition: "top left", animation: `${fadeIn} 0.45s ease-out both`, "@media (prefers-reduced-motion: reduce)": { animation: "none" } }} />
            </ButtonBase>
            <Box className="show-zoom" aria-hidden sx={{ position: "absolute", top: 12, right: 12, width: 36, height: 36, borderRadius: "50%", display: "grid", placeItems: "center", color: white, backgroundColor: GLASS, opacity: 0, transition: "opacity 150ms", pointerEvents: "none" }}>
              <ZoomInRoundedIcon sx={{ fontSize: 20 }} />
            </Box>
            {!reduced && (
              <IconButton
                onClick={() => {
                  remaining.current = SLIDE_MS;
                  setPaused((p) => !p);
                }}
                aria-label={paused ? t("learn.reader.play") : t("learn.reader.pause")}
                title={paused ? t("learn.reader.play") : t("learn.reader.pause")}
                aria-pressed={paused}
                data-testid="home-showcase-pause"
                sx={{ position: "absolute", left: 12, bottom: 12, width: 34, height: 34, color: white, backgroundColor: GLASS, backdropFilter: "blur(6px)", "&:hover": { backgroundColor: "rgba(15,23,42,0.8)" } }}
              >
                {paused ? <PlayArrowRoundedIcon sx={{ fontSize: 20 }} /> : <PauseRoundedIcon sx={{ fontSize: 20 }} />}
              </IconButton>
            )}
          </Box>
        </Box>
        </Reveal>
      </Container>

      <Dialog open={zoom} onClose={() => setZoom(false)} maxWidth={false} PaperProps={{ sx: { borderRadius: "14px", overflow: "hidden", maxWidth: "96vw", backgroundColor: "transparent", boxShadow: "none" } }}>
        <Box sx={{ position: "relative" }}>
          <Box component="img" src={src} alt={title} sx={{ display: "block", maxWidth: "96vw", maxHeight: "92vh", borderRadius: "14px" }} />
          <IconButton onClick={() => setZoom(false)} aria-label={t("app.close")} sx={{ position: "absolute", top: 10, right: 10, color: white, backgroundColor: GLASS, "&:hover": { backgroundColor: "rgba(15,23,42,0.8)" } }}>
            <CloseRoundedIcon />
          </IconButton>
        </Box>
      </Dialog>
    </Box>
  );
}
