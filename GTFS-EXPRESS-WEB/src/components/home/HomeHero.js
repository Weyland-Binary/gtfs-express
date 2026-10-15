/**
 * HomeHero — the head of Home: its blue ground and its column, holding what Home puts there (the finder with the
 * reader's picture beside it). Its parts:
 *
 *   HomeTitle      Home's one question as the page's title (`home-title`, « Quel réseau voulez-vous explorer ou
 *                  modifier ? »), one sentence on what exploring and modifying are under it
 *   HomePromises   the promise the product keeps (the MobilityData validator), under the head's two columns
 *
 * The head has no drawing of its own (it would repeat the network under the page): the page's network
 * (NetworkBackdrop) runs through it, lit over its blue — which lies under the network (`home-hero-bg`, a plane of the
 * page's stacking), its words over it. Its blue does not stop at its foot: it fades into the page over HEAD_FADE
 * below (a hard edge between a blue head and a white page reads as two pages).
 */

import React from "react";
import { Box, Container, Typography } from "@mui/material";
import { keyframes } from "@mui/system";
import VerifiedIcon from "@mui/icons-material/Verified";
import { useLanguage } from "../../contexts/LanguageContext";
import { HEAD_FADE } from "./NetworkBackdrop";
import { HOME_WIDTH } from "./inkGround";

const rise = keyframes`
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
`;
const riseSx = (delay) => ({ animation: `${rise} 0.55s ease-out ${delay}s both`, "@media (prefers-reduced-motion: reduce)": { animation: "none" } });

/** Home's question, the page's one h1, and the sentence under it. */
export function HomeTitle() {
  const { t } = useLanguage();
  return (
    <Box sx={{ color: "#fff" }}>
      <Typography id="home-title" component="h1" sx={{ fontWeight: 800, fontSize: { xs: "1.75rem", md: "2.35rem", xl: "2.75rem" }, lineHeight: 1.12, letterSpacing: "-0.035em", textWrap: "balance", ...riseSx(0.05) }}>
        {t("hero.titleBefore")}
        <Box component="span" sx={{ background: "linear-gradient(90deg, #93c5fd, #f0abfc)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
          {t("hero.highlight")}
        </Box>
        {t("hero.titleAfter")}
      </Typography>
      <Typography sx={{ mt: 1.5, maxWidth: 560, color: "rgba(255,255,255,0.8)", fontSize: { xs: "0.95rem", md: "1.04rem", xl: "1.12rem" }, lineHeight: 1.55, textWrap: "pretty", ...riseSx(0.12) }}>
        {t("home.hero.sub")}
      </Typography>
    </Box>
  );
}

/**
 * The promise the head keeps under its two columns: the network checked by the MobilityData validator, its badge in
 * the theme's green. One only (the owner, 2026-10-13): the brief and the checked, undoable change are the title's
 * sentence already.
 */
export function HomePromises() {
  const { t } = useLanguage();
  return (
    <Box component="p" data-testid="home-promises" sx={{ m: 0, display: "flex", justifyContent: "center", alignItems: "center", gap: 1, fontSize: { xs: "0.95rem", xl: "1.05rem" }, fontWeight: 650, color: "rgba(255,255,255,0.92)", ...riseSx(0.25) }}>
      <VerifiedIcon aria-hidden sx={{ fontSize: { xs: 24, xl: 26 }, color: "success.light" }} />
      {t("home.hero.trust.validator")}
    </Box>
  );
}

// `grow`: the head takes the room the first screen leaves (centring its content), or keeps its own height (the room
// below it then given to what follows).
export default function HomeHero({ children, grow = true }) {
  return (
    <Box
      data-testid="home-hero"
      sx={{
        // No stacking context of its own (no z-index): its blue (z 0) lies under the page's network (z 1), its words
        // and cards (z 2) over it.
        position: "relative",
        // Home's first screen is a column as tall as the view: the head takes what the rest leaves and centres its
        // content in it (never shrinking under its content).
        flexShrink: 0,
        flexGrow: { md: grow ? 1 : 0 },
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        pt: { xs: 3, md: 4 },
        pb: { xs: 4, md: 0 },
      }}
    >
      <Box
        aria-hidden
        data-testid="home-hero-bg"
        sx={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          // Past the foot: the blue dissolves into the page over HEAD_FADE.
          bottom: -HEAD_FADE,
          zIndex: 0,
          WebkitMaskImage: `linear-gradient(180deg, #000 0, #000 calc(100% - ${HEAD_FADE}px), transparent 100%)`,
          maskImage: `linear-gradient(180deg, #000 0, #000 calc(100% - ${HEAD_FADE}px), transparent 100%)`,
          background: (theme) =>
            theme.palette.mode === "dark"
              ? "radial-gradient(1200px 500px at 80% 20%, rgba(99,102,241,0.28), transparent 60%), linear-gradient(135deg, #07142b 0%, #0d2a52 55%, #0b1f3d 100%)"
              : "radial-gradient(1200px 500px at 80% 10%, rgba(129,140,248,0.45), transparent 60%), linear-gradient(135deg, #0b2447 0%, #1655b8 55%, #1f6fe0 100%)",
          // A faint grid of points, the drawing paper of a network.
          "&::before": {
            content: '""',
            position: "absolute",
            inset: 0,
            backgroundImage: "radial-gradient(rgba(255,255,255,0.12) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
            maskImage: "linear-gradient(180deg, rgba(0,0,0,0.9), rgba(0,0,0,0.2))",
            pointerEvents: "none",
          },
        }}
      />
      {/* Wider than the page's column on a very large screen: the picture of the reader grows with the room it has. */}
      <Container maxWidth={false} sx={{ position: "relative", zIndex: 2, maxWidth: { xs: HOME_WIDTH, xl: HOME_WIDTH + 200 }, display: "flex", flexDirection: "column", gap: 2 }}>
        {children}
      </Container>
    </Box>
  );
}
