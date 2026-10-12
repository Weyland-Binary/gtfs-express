/**
 * ReaderTour — a short animated tour of the reader on the demo network (the owner's ask of 2026-10-08: « une vidéo
 * animée qui parcourt les différentes sections », and no zoom under the pointer): its four screens — overview,
 * timetables, map, SQL console — one after the other, each slowly panned like a camera, cross-faded, its name in a
 * corner and the tour's progress under it. Real screenshots of the demo (public/img/{fr,en}/), in the reader's
 * language — French for French, English for every other language — and the theme's mode. No video file: four
 * still images and CSS, crisp at any size and light to load. With the system's « reduce motion », the first screen
 * stays still.
 *
 * `readerShot(name, mode, language)` is the screenshots' one address (LearnMore reads them too).
 */

import React, { useEffect, useState } from "react";
import { Box, alpha, useMediaQuery, useTheme } from "@mui/material";
import { keyframes } from "@mui/system";
import { useLanguage } from "../../contexts/LanguageContext";

/** The screenshots' address: French for a French reader, English for every other language. */
export const readerShot = (name, mode, language) => `/img/${language === "fr" ? "fr" : "en"}/${mode === "dark" ? "Dark" : "Light"}_${name}.webp`;

export const TOUR = [
  { key: "overview", file: "Overview", from: "0% 0%", to: "-4% -6%" },
  { key: "schedules", file: "Schedules", from: "-2% 0%", to: "-2% -10%" },
  { key: "map", file: "Map", from: "-6% -4%", to: "0% -8%" },
  { key: "sql", file: "Sql", from: "0% -2%", to: "-5% -9%" },
];

const SLIDE_MS = 3200;

const pan = (from, to) => keyframes`
  from { transform: scale(1.16) translate(${from.split(" ")[0]}, ${from.split(" ")[1]}); }
  to   { transform: scale(1.16) translate(${to.split(" ")[0]}, ${to.split(" ")[1]}); }
`;
const labelIn = keyframes`
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
`;
const grow = keyframes`
  from { transform: scaleX(0); }
  to   { transform: scaleX(1); }
`;

export default function ReaderTour({ height = 128, label = true }) {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [active, setActive] = useState(0);
  const mode = theme.palette.mode;

  // One screen after the other, for as long as the tour is in sight of a person who did not ask for stillness.
  useEffect(() => {
    if (reduced) return undefined;
    const timer = setTimeout(() => setActive((a) => (a + 1) % TOUR.length), SLIDE_MS);
    return () => clearTimeout(timer);
  }, [active, reduced]);

  const ink = mode === "dark" ? "#0b1220" : "#0f172a";
  return (
    <Box aria-hidden data-testid="reader-tour" data-slide={TOUR[active].key} sx={{ position: "relative", height, overflow: "hidden", backgroundColor: mode === "dark" ? "#0b1d30" : "#eef2f7" }}>
      {TOUR.map((s, i) => {
        const on = i === active;
        return (
          <Box
            key={s.key}
            component="img"
            src={readerShot(s.file, mode, language)}
            alt=""
            decoding="async"
            sx={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: "top left",
              transformOrigin: "top left",
              opacity: on ? 1 : 0,
              transition: "opacity 700ms ease",
              ...(on && !reduced ? { animation: `${pan(s.from, s.to)} ${SLIDE_MS + 700}ms linear both` } : { transform: "scale(1.16)" }),
            }}
          />
        );
      })}
      {/* A soft shade at the foot, for the label to read on any screen */}
      <Box sx={{ position: "absolute", inset: 0, background: `linear-gradient(180deg, ${alpha(ink, 0)} 55%, ${alpha(ink, 0.45)} 100%)` }} />
      {label && (
        <Box key={TOUR[active].key} sx={{ position: "absolute", left: 10, bottom: 12, px: 1, height: 22, display: "flex", alignItems: "center", borderRadius: 999, fontSize: "0.7rem", fontWeight: 700, color: "#fff", backgroundColor: alpha(ink, 0.55), backdropFilter: "blur(4px)", ...(reduced ? {} : { animation: `${labelIn} 450ms ease-out 250ms both` }) }}>
          {t(`learn.reader.tab.${TOUR[active].key}`)}
        </Box>
      )}
      {/* The tour's progress: one segment a screen */}
      <Box sx={{ position: "absolute", left: 10, right: 10, bottom: 5, display: "flex", gap: 0.5 }}>
        {TOUR.map((s, i) => (
          <Box key={s.key} sx={{ flex: 1, height: 3, borderRadius: 2, overflow: "hidden", backgroundColor: "rgba(255,255,255,0.35)" }}>
            <Box key={i === active ? `on-${active}` : "off"} sx={{ height: "100%", transformOrigin: "left", backgroundColor: "#fff", transform: i < active || (i === active && reduced) ? "scaleX(1)" : "scaleX(0)", ...(i === active && !reduced ? { animation: `${grow} ${SLIDE_MS}ms linear both` } : {}) }} />
          </Box>
        ))}
      </Box>
    </Box>
  );
}
