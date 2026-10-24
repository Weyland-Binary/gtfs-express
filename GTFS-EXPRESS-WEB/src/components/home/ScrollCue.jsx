/**
 * The first screen's invitation to read on: what comes next, and a chevron that breathes. A click scrolls to the
 * showcase; it fades out once the page is scrolled and never moves with reduced motion.
 */

import React, { useEffect, useState } from "react";
import { Box, ButtonBase, alpha, useMediaQuery, useTheme } from "@mui/material";
import { keyframes } from "@mui/system";
import KeyboardArrowDownRoundedIcon from "@mui/icons-material/KeyboardArrowDownRounded";
import { useLanguage } from "../../contexts/LanguageContext";

const nudge = keyframes`
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(4px); }
`;
const appear = keyframes`
  from { opacity: 0; transform: translate(-50%, 8px); }
  to   { opacity: 1; transform: translate(-50%, 0); }
`;

const SCROLLED_PX = 24;

export default function ScrollCue({ scroller = null, targetId }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!scroller) return undefined;
    const onScroll = () => setGone(scroller.scrollTop > SCROLLED_PX);
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [scroller]);
  const go = () => document.getElementById(targetId)?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  const tone = theme.palette.primary.main;
  // The entrance on the wrapper, the fade on the button: an animation's fill would hold the opacity.
  return (
    <Box sx={{ position: "absolute", left: "50%", bottom: { xs: 14, md: 22 }, zIndex: 1, transform: "translateX(-50%)", animation: reduced ? "none" : `${appear} 0.7s cubic-bezier(.16,1,.3,1) 1.1s both` }}>
    <ButtonBase
      onClick={go}
      data-testid="home-scroll-cue"
      aria-hidden={gone ? "true" : undefined}
      tabIndex={gone ? -1 : 0}
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 1.25,
        pl: 2,
        pr: 0.75,
        py: 0.75,
        borderRadius: 999,
        fontSize: "0.88rem",
        fontWeight: 650,
        color: "text.secondary",
        backgroundColor: alpha(theme.palette.background.paper, 0.7),
        border: `1px solid ${theme.palette.divider}`,
        backdropFilter: "blur(8px)",
        opacity: gone ? 0 : 1,
        pointerEvents: gone ? "none" : "auto",
        transition: "opacity 300ms ease, color 150ms, border-color 150ms, box-shadow 150ms",
        "&:hover, &.Mui-focusVisible": { color: tone, borderColor: alpha(tone, 0.5), boxShadow: `0 6px 18px ${alpha(theme.palette.primary.dark, 0.12)}` },
        "&.Mui-focusVisible": { outline: `2px solid ${tone}`, outlineOffset: 2 },
        "&:hover .cue-arrow": { backgroundColor: tone, color: theme.palette.primary.contrastText },
      }}
    >
      {t("home.scrollCue")}
      <Box
        className="cue-arrow"
        aria-hidden
        sx={{ width: 28, height: 28, borderRadius: "50%", display: "grid", placeItems: "center", color: tone, backgroundColor: alpha(tone, 0.1), transition: "background-color 150ms, color 150ms" }}
      >
        <KeyboardArrowDownRoundedIcon sx={{ fontSize: 20, animation: reduced ? "none" : `${nudge} 1.8s ease-in-out infinite` }} />
      </Box>
    </ButtonBase>
    </Box>
  );
}
