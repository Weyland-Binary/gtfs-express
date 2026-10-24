/**
 * Home's illustration beside the finder: four lines of a transit network drawing themselves, a vehicle running on
 * each, two cards floating over it (a line's next departure, the validation). Decorative: one label for a screen
 * reader. The vehicles and the cards stop with the pause button (WCAG 2.2.2) and never move with reduced motion.
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, IconButton, Typography, alpha, useMediaQuery, useTheme } from "@mui/material";
import { keyframes } from "@mui/system";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import PauseRoundedIcon from "@mui/icons-material/PauseRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import { useLanguage } from "../../contexts/LanguageContext";

const draw = keyframes`
  to { stroke-dashoffset: 0; }
`;
const pulse = keyframes`
  0%, 100% { transform: scale(1); opacity: 1; }
  50%      { transform: scale(1.35); opacity: 0.55; }
`;
const float = keyframes`
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-8px); }
`;

// The lines' paths in a 560×500 box, and where a vehicle starts on each (as a share of its run).
const LINES = [
  { id: "l1", d: "M30 420 C 140 400, 180 300, 280 260 S 460 140, 530 70", dur: 9 },
  { id: "l2", d: "M60 90 L 200 170 L 280 260 L 360 330 L 510 440", dur: 11 },
  { id: "l3", d: "M20 260 L 150 260 C 210 260 230 260 280 260 L 420 260 C 470 260 500 280 540 300", dur: 8 },
  { id: "l4", d: "M140 480 L 210 370 L 280 260 L 330 160 L 380 30", dur: 10 },
];
const STOPS = [
  [200, 170],
  [360, 330],
  [150, 260],
  [420, 260],
  [210, 370],
  [330, 160],
  [180, 320],
  [430, 160],
];

export default function HeroNetwork() {
  const theme = useTheme();
  const { t } = useLanguage();
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [paused, setPaused] = useState(false);
  const svgRef = useRef(null);
  const moving = !reduced && !paused;
  const dark = theme.palette.mode === "dark";
  const colors = [theme.palette.primary.main, theme.palette.error.main, theme.palette.success.main, theme.palette.warning.main];
  const ink = dark ? theme.palette.grey[200] : theme.palette.primary.dark;

  // SMIL runs on the SVG's own clock: the pause stops it where it is.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof svg.pauseAnimations !== "function") return;
    if (moving) svg.unpauseAnimations();
    else svg.pauseAnimations();
  }, [moving]);

  const card = { position: "absolute", display: "flex", alignItems: "center", gap: 1.25, px: 2, py: 1.5, borderRadius: "14px", backgroundColor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, boxShadow: dark ? "0 16px 40px rgba(0,0,0,0.45)" : `0 16px 40px ${alpha(theme.palette.primary.dark, 0.14)}` };
  return (
    <Box data-testid="home-network" data-moving={moving ? "true" : "false"} sx={{ position: "relative", height: { xs: 360, md: 480 }, minWidth: 0 }}>
      <Box component="svg" ref={svgRef} role="img" aria-label={t("home.net.aria")} viewBox="0 0 560 500" sx={{ width: "100%", height: "100%", overflow: "visible" }}>
        {LINES.map((l, i) => (
          <Box
            component="path"
            key={l.id}
            id={`home-net-${l.id}`}
            d={l.d}
            fill="none"
            stroke={colors[i]}
            strokeWidth={9}
            strokeLinecap="round"
            strokeLinejoin="round"
            sx={reduced ? {} : { strokeDasharray: 900, strokeDashoffset: 900, animation: `${draw} 2.6s ease-out ${0.35 * i}s forwards` }}
          />
        ))}
        <g fill={theme.palette.background.paper} stroke={ink} strokeWidth={4}>
          <Box component="circle" cx={280} cy={260} r={16} sx={moving ? { transformBox: "fill-box", transformOrigin: "center", animation: `${pulse} 2.4s ease-in-out infinite` } : {}} />
          {STOPS.map(([x, y]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r={8} />
          ))}
        </g>
        {!reduced &&
          LINES.map((l, i) => (
            <circle key={`v-${l.id}`} r={8} fill={colors[i]} stroke={theme.palette.background.paper} strokeWidth={3}>
              <animateMotion dur={`${l.dur}s`} begin={`${0.5 * i}s`} repeatCount="indefinite">
                <mpath href={`#home-net-${l.id}`} />
              </animateMotion>
            </circle>
          ))}
      </Box>
      <Box aria-hidden sx={{ ...card, left: 8, top: 36, ...(moving ? { animation: `${float} 5s ease-in-out infinite` } : {}) }}>
        <Box sx={{ minWidth: 30, height: 30, px: 0.75, borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: "0.85rem", color: theme.palette.error.contrastText, backgroundColor: theme.palette.error.main }}>B2</Box>
        <Box>
          <Typography sx={{ fontSize: "0.88rem", fontWeight: 700, lineHeight: 1.3 }}>{t("home.net.line")}</Typography>
          <Typography sx={{ fontSize: "0.8rem", color: "text.secondary" }}>{t("home.net.next", { time: "07:42" })}</Typography>
        </Box>
      </Box>
      <Box aria-hidden sx={{ ...card, right: 0, bottom: 56, ...(moving ? { animation: `${float} 6s ease-in-out 0.8s infinite` } : {}) }}>
        <Box sx={{ width: 32, height: 32, borderRadius: "9px", display: "flex", alignItems: "center", justifyContent: "center", color: theme.palette.success.main, backgroundColor: alpha(theme.palette.success.main, dark ? 0.2 : 0.12) }}>
          <CheckRoundedIcon sx={{ fontSize: 19 }} />
        </Box>
        <Box>
          <Typography sx={{ fontSize: "0.88rem", fontWeight: 700, lineHeight: 1.3 }}>{t("home.net.valid")}</Typography>
          <Typography sx={{ fontSize: "0.8rem", color: "text.secondary" }}>{t("home.net.validText")}</Typography>
        </Box>
      </Box>
      {!reduced && (
        <IconButton
          size="small"
          onClick={() => setPaused((p) => !p)}
          aria-pressed={paused}
          aria-label={paused ? t("learn.reader.play") : t("learn.reader.pause")}
          title={paused ? t("learn.reader.play") : t("learn.reader.pause")}
          data-testid="home-network-pause"
          sx={{ position: "absolute", right: 4, top: 4, color: "text.secondary", backgroundColor: alpha(theme.palette.background.paper, 0.85), border: `1px solid ${theme.palette.divider}`, "&:hover": { backgroundColor: theme.palette.background.paper } }}
        >
          {paused ? <PlayArrowRoundedIcon fontSize="small" /> : <PauseRoundedIcon fontSize="small" />}
        </IconButton>
      )}
    </Box>
  );
}
