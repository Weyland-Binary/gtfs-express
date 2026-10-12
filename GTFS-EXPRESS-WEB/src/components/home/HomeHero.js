/**
 * HomeHero — the head of Home for a visitor without works (2026-10-08: « une présentation digne des plus grands
 * sites », both ways in on one screen).
 *
 * What the product does, in one column: an eyebrow, the two lines of the title, one sentence on a tall screen, three
 * promises it keeps (three pills, like the eyebrow). The head has no drawing nor cards of its own any more (the
 * owner's remarks of 2026-10-08: they repeated the network under the page): the page's network (NetworkBackdrop)
 * runs through it, lit over its blue — which lies under the network (`home-hero-bg`, a plane of the page's
 * stacking), its words over it. Home's two panels overlap its foot, and its blue does not stop there: it fades into
 * the page over HEAD_FADE below (the owner's remark of 2026-10-12: a hard edge between a blue head and a white page
 * read as two pages), the panels sitting on the fade.
 */

import React from "react";
import { Box, Container, Typography } from "@mui/material";
import { keyframes } from "@mui/system";
import VerifiedIcon from "@mui/icons-material/Verified";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { useLanguage } from "../../contexts/LanguageContext";
import { HEAD_FADE } from "./NetworkBackdrop";
import { HOME_WIDTH } from "./inkGround";

// The pill the eyebrow and the promises share: glass over the blue.
const pillSx = { display: "inline-flex", alignItems: "center", gap: 0.75, px: 1.25, py: 0.5, borderRadius: 999, fontSize: "0.76rem", fontWeight: 650, color: "#e0e7ff", backgroundColor: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.18)" };

const rise = keyframes`
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
`;

export default function HomeHero() {
  const { t } = useLanguage();
  const promises = [
    { icon: VerifiedIcon, text: t("home.hero.trust.validator") },
    { icon: ReplayRoundedIcon, text: t("home.hero.trust.undo") },
    { icon: DescriptionOutlinedIcon, text: t("home.hero.trust.brief") },
  ];
  return (
    <Box
      data-testid="home-hero"
      sx={{
        // No stacking context of its own (no z-index): its blue (z 0) lies under the page's network (z 1), its words
        // and cards (z 2) over it.
        position: "relative",
        // Home is a column as tall as the screen: the hero keeps its height (overflow hidden would let it shrink).
        flexShrink: 0,
        color: "#fff",
        pt: { xs: 3, md: 3, "@media (max-height: 760px)": { pt: 2.25 } },
        pb: { xs: 9, md: 10, "@media (max-height: 760px)": { pb: 9 } },
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
          // Past the foot: the blue dissolves into the page over HEAD_FADE (the panels sit on the fade).
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
      <Container maxWidth={false} sx={{ position: "relative", zIndex: 2, maxWidth: HOME_WIDTH, display: "grid", gridTemplateColumns: "minmax(0, 1fr)" }}>
        <Box sx={{ maxWidth: 820 }}>
          <Box sx={{ ...pillSx, mb: 1.75, fontSize: "0.74rem", fontWeight: 700, animation: `${rise} 0.5s ease-out both` }}>
            <AutoAwesomeIcon sx={{ fontSize: 15, color: "#c7d2fe" }} />
            {t("home.hero.eyebrow")}
          </Box>
          <Typography component="h1" sx={{ fontWeight: 800, fontSize: { xs: "1.6rem", sm: "1.9rem", md: "2.15rem" }, lineHeight: 1.15, letterSpacing: "-0.03em", animation: `${rise} 0.55s ease-out 0.05s both`, "@media (max-height: 760px)": { fontSize: { md: "1.9rem" } } }}>
            {t("hero.titleBefore")}
            <Box component="span" sx={{ background: "linear-gradient(90deg, #93c5fd, #f0abfc)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              {t("hero.highlight")}
            </Box>
            {t("hero.titleAfter")}
            <Box component="br" />
            <Box component="span" sx={{ color: "rgba(255,255,255,0.82)" }}>
              {t("hero.titleSecondLine")}
            </Box>
          </Typography>
          <Typography sx={{ mt: 1.5, maxWidth: 600, color: "rgba(255,255,255,0.8)", fontSize: { xs: "0.9rem", md: "1rem" }, lineHeight: 1.6, animation: `${rise} 0.55s ease-out 0.12s both`, "@media (max-height: 979px)": { display: "none" } }}>
            {t("home.hero.lead")}
          </Typography>
          <Box component="ul" sx={{ listStyle: "none", p: 0, m: 0, mt: 2, display: "flex", flexWrap: "wrap", gap: { xs: 1, md: 2 }, animation: `${rise} 0.55s ease-out 0.2s both` }}>
            {promises.map(({ icon: Icon, text }) => (
              <Box component="li" key={text} sx={{ ...pillSx, color: "rgba(255,255,255,0.92)" }}>
                <Icon sx={{ fontSize: 15, color: "#c7d2fe" }} />
                {text}
              </Box>
            ))}
          </Box>
        </Box>
      </Container>
    </Box>
  );
}
