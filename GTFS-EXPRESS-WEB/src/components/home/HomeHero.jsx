/**
 * The head of Home: a light ground lit in the theme's blue, its column, and the title the finder carries (the chip of
 * free reading, the page's one h1, the sentence under it).
 */

import React from "react";
import { Box, Container, Typography, alpha, useTheme } from "@mui/material";
import { keyframes } from "@mui/system";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { HOME_WIDTH, homeGroundOf } from "./inkGround";

const rise = keyframes`
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
`;
const riseSx = (delay) => ({ animation: `${rise} 0.55s ease-out ${delay}s both`, "@media (prefers-reduced-motion: reduce)": { animation: "none" } });

export function HomeTitle() {
  const theme = useTheme();
  const { t } = useLanguage();
  const dark = theme.palette.mode === "dark";
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2.5, alignItems: "flex-start" }}>
      <Box data-testid="home-chip" sx={{ display: "inline-flex", alignItems: "center", gap: 1, px: 1.5, py: 0.6, borderRadius: 999, fontSize: "0.88rem", fontWeight: 600, color: "primary.main", backgroundColor: alpha(theme.palette.primary.main, dark ? 0.18 : 0.08), ...riseSx(0) }}>
        <VisibilityOutlinedIcon aria-hidden sx={{ fontSize: 17 }} />
        {t("home.chip")}
      </Box>
      <Typography id="home-title" component="h1" sx={{ fontWeight: 800, fontSize: { xs: "2.1rem", md: "3.1rem", xl: "3.6rem" }, lineHeight: 1.05, letterSpacing: "-0.04em", textWrap: "balance", color: dark ? "text.primary" : "primary.dark", ...riseSx(0.05) }}>
        {t("hero.titleBefore")}
        <Box component="span" sx={{ background: `linear-gradient(90deg, ${theme.palette.primary.main}, ${theme.palette.primary.light})`, WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent" }}>
          {t("hero.highlight")}
        </Box>
        {t("hero.titleAfter")}
      </Typography>
      <Typography sx={{ maxWidth: 580, color: "text.secondary", fontSize: { xs: "1rem", md: "1.15rem" }, lineHeight: 1.6, textWrap: "pretty", ...riseSx(0.12) }}>{t("home.hero.sub")}</Typography>
    </Box>
  );
}

/** `grow`: the head takes what its screen leaves above the strip, its content centred in it; `cue` sits at its foot. */
export default function HomeHero({ children, grow = false, cue = null }) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  return (
    <Box
      data-testid="home-hero"
      sx={{
        position: "relative",
        flexShrink: 0,
        ...(grow ? { flexGrow: 1, display: "flex", flexDirection: "column", justifyContent: "center" } : {}),
        pt: { xs: 4, md: 7 },
        pb: { xs: 5, md: 9 },
        // The grey of the page, a soft light behind the network drawing itself.
        background: dark
          ? `radial-gradient(900px 420px at 85% 10%, ${alpha(theme.palette.primary.main, 0.22)}, transparent 70%), ${theme.palette.background.default}`
          : `radial-gradient(860px 460px at 82% 18%, ${alpha(theme.palette.common.white, 0.95)}, transparent 72%), ${homeGroundOf(theme)}`,
      }}
    >
      <Container maxWidth={false} sx={{ maxWidth: HOME_WIDTH, display: "flex", flexDirection: "column", gap: 2 }}>
        {children}
      </Container>
      {cue}
    </Box>
  );
}
