/**
 * ReaderViewer — Home's picture of the product, beside its finder: the reader on the demo network, its four screens
 * (overview, timetable, map, the assistant answering: home/readerShots, real screenshots in the reader's language and
 * the theme's mode) shown one after the other, the image filling the card — no window drawn around it.
 *
 * The screens follow each other on their own, one every SLIDE_MS. The picture is the card alone: its few controls sit
 * on the image's foot in one small pill — a dot per screen (the active one longer), then the pause — so nothing under
 * it pushes the picture out of line with the finder. The screens hold while the pointer or the keyboard is on the
 * picture (the time left kept), stop for good with the pause (WCAG 2.2.2), and never move by themselves when the
 * system asks for less motion (the pause is not offered then). A dot shows its screen at once; a click on the image
 * enlarges it. The next screen is fetched while the current one shows: the first screen loads one image.
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, ButtonBase, Dialog, IconButton, useMediaQuery, useTheme } from "@mui/material";
import { keyframes } from "@mui/system";
import ZoomInRoundedIcon from "@mui/icons-material/ZoomInRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import PauseRoundedIcon from "@mui/icons-material/PauseRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { READER_SHOTS, readerShot } from "./readerShots";

export const SLIDE_MS = 6000;

const fadeIn = keyframes`
  from { opacity: 0; }
  to   { opacity: 1; }
`;

const preload = (src) => {
  try {
    const img = new Image();
    img.src = src;
  } catch {
    /* no Image in this environment */
  }
};

// The pill on the image's foot reads on any screenshot, light or dark: a dark glass, white marks.
const GLASS = "rgba(15, 23, 42, 0.62)";

export default function ReaderViewer() {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [active, setActive] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [paused, setPaused] = useState(false);
  const [hold, setHold] = useState(false);
  const shot = READER_SHOTS[active];
  const srcOf = (s) => readerShot(s.file, theme.palette.mode, language);
  const src = srcOf(shot);
  const caption = t(`learn.reader.caption.${shot.key}`);
  const playing = !reduced && !paused && !zoom;
  const remaining = useRef(SLIDE_MS);
  const white = theme.palette.common.white;

  // A new screen has its whole time; a hold keeps what was left of it.
  useEffect(() => {
    remaining.current = SLIDE_MS;
  }, [active]);
  useEffect(() => {
    if (!playing || hold) return undefined;
    const started = Date.now();
    const id = setTimeout(() => setActive((i) => (i + 1) % READER_SHOTS.length), remaining.current);
    return () => {
      clearTimeout(id);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [active, playing, hold]);

  useEffect(() => {
    preload(srcOf(READER_SHOTS[(active + 1) % READER_SHOTS.length]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, language, theme.palette.mode]);

  // The dots move with the arrows, as a tab list does (WAI-ARIA).
  const onKeyDown = (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const n = (active + step + READER_SHOTS.length) % READER_SHOTS.length;
    setActive(n);
    e.currentTarget.querySelectorAll('[role="tab"]')[n]?.focus();
  };

  return (
    <Box
      component="figure"
      data-testid="home-reader"
      data-playing={playing && !hold ? "true" : "false"}
      onMouseEnter={() => setHold(true)}
      onMouseLeave={() => setHold(false)}
      onFocus={() => setHold(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setHold(false)}
      sx={{ m: 0, minWidth: 0, position: "relative", borderRadius: "14px", overflow: "hidden", border: "1px solid rgba(255,255,255,0.18)", backgroundColor: theme.palette.background.paper, boxShadow: "0 40px 90px rgba(2, 8, 23, 0.55), 0 0 0 1px rgba(255,255,255,0.04)", "&:hover .reader-zoom": { opacity: 1 } }}
    >
      <Box role="tabpanel" id="home-reader-panel" aria-label={t(`learn.reader.tab.${shot.key}`)}>
        <ButtonBase onClick={() => setZoom(true)} aria-label={`${t("learn.reader.zoom")} — ${caption}`} data-testid="home-reader-shot" sx={{ display: "block", width: "100%", aspectRatio: "1440 / 860", backgroundColor: theme.palette.background.default }}>
          <Box key={src} component="img" src={src} alt={caption} fetchpriority={active === 0 ? "high" : undefined} sx={{ display: "block", width: "100%", height: "100%", objectFit: "cover", objectPosition: "top left", animation: `${fadeIn} 0.45s ease-out both`, "@media (prefers-reduced-motion: reduce)": { animation: "none" } }} />
        </ButtonBase>
      </Box>
      <Box className="reader-zoom" aria-hidden sx={{ position: "absolute", top: 10, right: 10, width: 34, height: 34, borderRadius: "50%", display: "grid", placeItems: "center", color: white, backgroundColor: GLASS, opacity: 0, transition: "opacity 150ms", pointerEvents: "none" }}>
        <ZoomInRoundedIcon sx={{ fontSize: 19 }} />
      </Box>

      {/* On the image's foot: a dot per screen, then the pause. */}
      <Box sx={{ position: "absolute", left: "50%", bottom: 12, transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 0.75, pl: 1.25, pr: reduced ? 1.25 : 0.5, height: 28, borderRadius: 999, backgroundColor: GLASS, backdropFilter: "blur(6px)" }}>
        <Box role="tablist" aria-label={t("learn.reader.eyebrow")} onKeyDown={onKeyDown} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          {READER_SHOTS.map((s, i) => {
            const on = i === active;
            const label = t(`learn.reader.tab.${s.key}`);
            return (
              <ButtonBase
                key={s.key}
                role="tab"
                aria-selected={on}
                aria-controls="home-reader-panel"
                aria-label={label}
                title={label}
                tabIndex={on ? 0 : -1}
                onClick={() => setActive(i)}
                onMouseEnter={() => preload(srcOf(s))}
                data-testid={`home-reader-tab-${s.key}`}
                sx={{ p: 0.5, borderRadius: 999, "&.Mui-focusVisible": { outline: `2px solid ${white}`, outlineOffset: 1 } }}
              >
                <Box sx={{ width: on ? 18 : 7, height: 7, borderRadius: 999, backgroundColor: white, opacity: on ? 1 : 0.5, transition: "width 200ms, opacity 200ms", "@media (prefers-reduced-motion: reduce)": { transition: "none" } }} />
              </ButtonBase>
            );
          })}
        </Box>
        {!reduced && (
          <IconButton
            size="small"
            onClick={() => {
              // Played again, the screen starts its time over.
              remaining.current = SLIDE_MS;
              setPaused((p) => !p);
            }}
            aria-label={paused ? t("learn.reader.play") : t("learn.reader.pause")}
            title={paused ? t("learn.reader.play") : t("learn.reader.pause")}
            aria-pressed={paused}
            data-testid="home-reader-pause"
            sx={{ width: 22, height: 22, color: white, "&:hover": { backgroundColor: "rgba(255,255,255,0.16)" } }}
          >
            {paused ? <PlayArrowRoundedIcon sx={{ fontSize: 16 }} /> : <PauseRoundedIcon sx={{ fontSize: 16 }} />}
          </IconButton>
        )}
      </Box>

      <Dialog open={zoom} onClose={() => setZoom(false)} maxWidth={false} PaperProps={{ sx: { borderRadius: "14px", overflow: "hidden", maxWidth: "94vw", backgroundColor: "transparent", boxShadow: "none" } }}>
        <Box sx={{ position: "relative" }}>
          <Box component="img" src={src} alt={caption} sx={{ display: "block", maxWidth: "94vw", maxHeight: "90vh", borderRadius: "14px" }} />
          <IconButton onClick={() => setZoom(false)} aria-label={t("app.close")} sx={{ position: "absolute", top: 10, right: 10, color: white, backgroundColor: GLASS, "&:hover": { backgroundColor: "rgba(15,23,42,0.8)" } }}>
            <CloseRoundedIcon />
          </IconButton>
        </Box>
      </Dialog>
    </Box>
  );
}
