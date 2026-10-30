/**
 * The product on a computer's screen beside Home's finder, on the head's blue: the real screens of the reader, a change
 * with a brief, the stop sheets and the shapes (home/readerShots, a 1920×1080 desktop) following each other every
 * SLIDE_MS. They hold under the pointer or the keyboard, stop with the pause (WCAG 2.2.2) and never move by themselves
 * with reduced motion. « Voir en vrai » opens the demo network on the screen shown (the edit screens behind the
 * licence's gate); the shapes, a modification, point to the licence instead while it is locked. The screens chosen and
 * opened are counted for the console. While the finder searches a place, the
 * screen shows its wait and then the networks found (`found`, from FindNetworkPanel), the screens standing still;
 * a network opening shows its steps there (home/OpeningScreen), and the screen is the one that grows into the reader
 * (utils/immersion).
 */

import React, { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Box, ButtonBase, Dialog, IconButton, Typography, alpha, useMediaQuery, useTheme } from "@mui/material";
import { keyframes } from "@mui/system";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import PauseRoundedIcon from "@mui/icons-material/PauseRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import { useDestructiveGuard } from "../../contexts/DestructiveGuardContext";
import { useLanguage } from "../../contexts/LanguageContext";
import { licenceLockOf, openPricing, useFeatures } from "../../utils/featuresApi";
import { trackUi } from "../../utils/uiTelemetry";
import { SHOWCASE, readerShot } from "./readerShots";
import { INK } from "./inkGround";
import { useNetworkOpening } from "../../utils/networkOpening";
import { registerScreen } from "../../utils/immersion";

const OpeningScreen = lazy(() => import("./OpeningScreen"));

export const SLIDE_MS = 6000;
export const SLIDES = ["reader", "modify", "sheets", "shapes"].map((key) => SHOWCASE.find((s) => s.key === key));

const fadeIn = keyframes`
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: none; }
`;

const preload = (src) => {
  try {
    const img = new Image();
    img.src = src;
  } catch {
    /* no Image in this environment */
  }
};

export default function HeroScreen({ onTry = null, found: answer = null }) {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const { guard } = useDestructiveGuard();
  const { features } = useFeatures();
  const lock = licenceLockOf(features?.access);
  const licenceLocked = lock === "sign_in_required" || lock === "subscription_required";
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hold, setHold] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [opening, setOpening] = useState(false);
  const remaining = useRef(SLIDE_MS);
  const screenRef = useRef(null);
  const arriving = useNetworkOpening();
  // A network opening takes the screen over the finder's answer.
  const found = arriving ? { state: "opening", body: <Suspense fallback={null}><OpeningScreen opening={arriving} /></Suspense> } : answer;
  useEffect(() => registerScreen(screenRef.current), []);
  const shot = SLIDES[active];
  const srcOf = (s) => readerShot(s.file, theme.palette.mode, language);
  const title = t(`home.show.${shot.key}.title`);
  const playing = !reduced && !paused && !zoom && !found;
  const waiting = found?.state === "loading";
  const white = theme.palette.common.white;
  const focusRing = { outline: `2px solid ${white}`, outlineOffset: 2 };

  // A new screen gets its whole time; a hold keeps what was left.
  useEffect(() => {
    remaining.current = SLIDE_MS;
  }, [active]);
  useEffect(() => {
    if (!playing || hold) return undefined;
    const started = Date.now();
    const id = setTimeout(() => setActive((i) => (i + 1) % SLIDES.length), remaining.current);
    return () => {
      clearTimeout(id);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [active, playing, hold]);
  useEffect(() => {
    preload(srcOf(SLIDES[(active + 1) % SLIDES.length]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, language, theme.palette.mode]);

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

  return (
    <Box
      component="section"
      aria-labelledby="home-screen-title"
      data-testid="home-screen"
      data-playing={playing && !hold ? "true" : "false"}
      onMouseEnter={() => setHold(true)}
      onMouseLeave={() => setHold(false)}
      onFocus={() => setHold(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setHold(false)}
      // As wide as its column, never so tall that the strip under the head leaves the first screen.
      sx={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 0, maxWidth: { md: "max(600px, calc((100vh - 453px) * 16 / 9))" }, mx: "auto", color: white }}
    >
      <Typography id="home-screen-title" component="h2" sx={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>
        {t("home.show.title")}
      </Typography>
      <Box sx={{ position: "relative", width: "100%", boxSizing: "border-box", p: "11px 11px 24px", borderRadius: "18px", backgroundColor: theme.palette.grey[900], boxShadow: `0 40px 80px ${alpha(theme.palette.common.black, 0.45)}, 0 0 0 1px ${alpha(white, 0.06)}` }}>
        <Box ref={screenRef} sx={{ position: "relative" }}>
          <ButtonBase
            onClick={() => setZoom(true)}
            disabled={Boolean(found)}
            aria-hidden={found ? "true" : undefined}
            aria-label={`${t("learn.reader.zoom")} : ${title}`}
            data-testid="home-screen-shot"
            data-shot={shot.key}
            sx={{ display: "block", width: "100%", aspectRatio: "16 / 9", overflow: "hidden", borderRadius: "6px", backgroundColor: theme.palette.background.default, "&.Mui-focusVisible": { outline: `3px solid ${white}`, outlineOffset: 2 } }}
          >
            <Box sx={{ display: "flex", width: `${SLIDES.length * 100}%`, height: "100%", transform: `translateX(-${(active * 100) / SLIDES.length}%)`, transition: "transform 0.7s cubic-bezier(.2,.7,.2,1)", "@media (prefers-reduced-motion: reduce)": { transition: "none" } }}>
              {SLIDES.map((s, i) => (
                <Box key={s.key} component="img" src={srcOf(s)} alt={i === active ? title : ""} aria-hidden={i === active ? undefined : "true"} loading={i === 0 ? "eager" : "lazy"} decoding="async" sx={{ display: "block", width: `${100 / SLIDES.length}%`, height: "100%", objectFit: "cover", objectPosition: "top left" }} />
              ))}
            </Box>
          </ButtonBase>
          {found && (
            <Box data-testid="home-screen-found" data-state={found.state} sx={{ position: "absolute", inset: 0, overflow: "hidden", borderRadius: "6px", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: waiting ? alpha(INK, 0.55) : theme.palette.background.paper, backdropFilter: waiting ? "blur(3px)" : "none", animation: `${fadeIn} 0.3s ease-out both`, "@media (prefers-reduced-motion: reduce)": { animation: "none" } }}>
              {found.body}
            </Box>
          )}
        </Box>
        <Box aria-hidden sx={{ position: "absolute", left: "50%", bottom: 9, width: 6, height: 6, ml: "-3px", borderRadius: "50%", backgroundColor: theme.palette.grey[700] }} />
      </Box>
      <Box aria-hidden sx={{ width: 96, height: 48, background: `linear-gradient(180deg, ${alpha(white, 0.42)}, ${alpha(white, 0.72)})`, clipPath: "polygon(14% 0, 86% 0, 100% 100%, 0 100%)" }} />
      <Box aria-hidden sx={{ width: 240, height: 12, borderRadius: "6px 6px 3px 3px", background: `linear-gradient(180deg, ${alpha(white, 0.85)}, ${alpha(white, 0.6)})`, boxShadow: `0 16px 26px ${alpha(theme.palette.common.black, 0.3)}` }} />

      {found ? (
        <Box sx={{ width: "100%", mt: 2.5, minHeight: 56, display: "flex", alignItems: "center", gap: 2 }}>
          <Box key={found.state} sx={{ flex: 1, minWidth: 0, animation: `${fadeIn} 0.4s ease-out both`, "@media (prefers-reduced-motion: reduce)": { animation: "none" } }}>
            {found.state === "results" && (
              <>
                <Typography sx={{ fontSize: "1rem", fontWeight: 700 }}>{t("home.screen.results.title")}</Typography>
                <Typography sx={{ fontSize: "0.88rem", color: alpha(white, 0.84) }}>{t("home.screen.results.sub")}</Typography>
              </>
            )}
          </Box>
          {found.back && !waiting && (
            <ButtonBase onClick={found.back} disabled={found.busy} data-testid="home-screen-back" sx={{ flexShrink: 0, height: 36, px: 1.75, borderRadius: 999, border: `1px solid ${alpha(white, 0.45)}`, color: white, fontSize: "0.86rem", fontWeight: 600, "&:hover": { borderColor: white, backgroundColor: alpha(white, 0.08) }, "&.Mui-focusVisible": focusRing }}>
              {t("home.screen.back")}
            </ButtonBase>
          )}
        </Box>
      ) : (
        <Box sx={{ width: "100%", mt: 2.5, minHeight: 56, display: "flex", alignItems: "center", gap: 2 }}>
          <Box key={shot.key} sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 0.25, animation: `${fadeIn} 0.4s ease-out both`, "@media (prefers-reduced-motion: reduce)": { animation: "none" } }}>
            <Typography component="h3" sx={{ fontSize: "1rem", fontWeight: 700 }}>
              {title}
            </Typography>
            {shot.key === "shapes" && licenceLocked ? (
              <ButtonBase onClick={() => openPricing(null)} data-testid="home-screen-licence" sx={{ gap: 0.5, minHeight: 28, borderRadius: 1, fontSize: "0.88rem", fontWeight: 600, color: alpha(white, 0.88), "&:hover": { color: white, textDecoration: "underline" }, "&.Mui-focusVisible": focusRing }}>
                {t("licence.see")}
                <ArrowForwardRoundedIcon aria-hidden sx={{ fontSize: 17 }} />
              </ButtonBase>
            ) : onTry && (
              <ButtonBase onClick={() => tryIt(shot.key)} disabled={opening} data-testid="home-screen-try" data-shot={shot.key} sx={{ gap: 0.5, minHeight: 28, borderRadius: 1, fontSize: "0.88rem", fontWeight: 600, color: alpha(white, 0.88), "&:hover": { color: white, textDecoration: "underline" }, "&.Mui-focusVisible": focusRing }}>
                {t("home.show.try")}
                <ArrowForwardRoundedIcon aria-hidden sx={{ fontSize: 17 }} />
              </ButtonBase>
            )}
          </Box>
          <Box role="group" aria-label={t("home.show.title")} sx={{ display: "flex", alignItems: "center" }}>
            {SLIDES.map((s, i) => {
              const on = i === active;
              return (
                <ButtonBase
                  key={s.key}
                  onClick={() => {
                    setActive(i);
                    trackUi("showcase.tab", s.key);
                  }}
                  onMouseEnter={() => preload(srcOf(s))}
                  aria-label={t(`home.show.${s.key}.title`)}
                  aria-current={on ? "true" : undefined}
                  data-testid={`home-screen-dot-${s.key}`}
                  sx={{ width: 30, height: 36, borderRadius: 2, "&.Mui-focusVisible": focusRing }}
                >
                  <Box aria-hidden sx={{ width: on ? 22 : 8, height: 8, borderRadius: 4, backgroundColor: on ? white : alpha(white, 0.4), transition: "width .25s, background-color .25s", "@media (prefers-reduced-motion: reduce)": { transition: "none" } }} />
                </ButtonBase>
              );
            })}
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
              data-testid="home-screen-pause"
              sx={{ width: 36, height: 36, color: white, backgroundColor: alpha(white, 0.14), "&:hover": { backgroundColor: alpha(white, 0.22) }, "&.Mui-focusVisible": focusRing }}
            >
              {paused ? <PlayArrowRoundedIcon sx={{ fontSize: 20 }} /> : <PauseRoundedIcon sx={{ fontSize: 20 }} />}
            </IconButton>
          )}
        </Box>
      )}

      <Dialog open={zoom} onClose={() => setZoom(false)} maxWidth={false} PaperProps={{ sx: { borderRadius: "14px", overflow: "hidden", maxWidth: "96vw", backgroundColor: "transparent", boxShadow: "none" } }}>
        <Box sx={{ position: "relative" }}>
          <Box component="img" src={srcOf(shot)} alt={title} sx={{ display: "block", maxWidth: "96vw", maxHeight: "92vh", borderRadius: "14px" }} />
          <IconButton onClick={() => setZoom(false)} aria-label={t("app.close")} sx={{ position: "absolute", top: 10, right: 10, color: white, backgroundColor: alpha(theme.palette.common.black, 0.6), "&:hover": { backgroundColor: alpha(theme.palette.common.black, 0.8) } }}>
            <CloseRoundedIcon />
          </IconButton>
        </Box>
      </Dialog>
    </Box>
  );
}
