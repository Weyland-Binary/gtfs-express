/**
 * The head of Home: the theme's blue band, its column, and the title the finder carries (the chip of free reading, the
 * page's one h1, the sentence under it), in white on the blue.
 */

import React from "react";
import { Box, Container, Typography, alpha, lighten, useTheme } from "@mui/material";
import { keyframes } from "@mui/system";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { HERO_WIDTH, heroBandOf } from "./inkGround";

const rise = keyframes`
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
`;
const riseSx = (delay) => ({ animation: `${rise} 0.55s ease-out ${delay}s both`, "@media (prefers-reduced-motion: reduce)": { animation: "none" } });

export function HomeTitle() {
  const theme = useTheme();
  const { t } = useLanguage();
  const dark = theme.palette.mode === "dark";
  const white = theme.palette.common.white;
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2.5, alignItems: "flex-start" }}>
      <Box data-testid="home-chip" sx={{ display: "inline-flex", alignItems: "center", gap: 1, px: 1.5, py: 0.6, borderRadius: 999, fontSize: "0.88rem", fontWeight: 600, color: white, backgroundColor: alpha(white, 0.14), ...riseSx(0) }}>
        <VisibilityOutlinedIcon aria-hidden sx={{ fontSize: 17 }} />
        {t("home.chip")}
      </Box>
      <Typography id="home-title" component="h1" sx={{ fontWeight: 680, fontSize: { xs: "2.1rem", md: "2.7rem", lg: "2.85rem", xl: "3.3rem" }, lineHeight: 1.05, letterSpacing: "-0.035em", textWrap: "balance", color: white, ...riseSx(0.05) }}>
        {t("hero.titleBefore")}
        <Box component="span" sx={{ background: dark ? `linear-gradient(90deg, ${theme.palette.primary.main}, ${theme.palette.primary.light})` : `linear-gradient(90deg, ${lighten(theme.palette.primary.light, 0.45)}, ${white})`, WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent" }}>
          {t("hero.highlight")}
        </Box>
        {t("hero.titleAfter")}
      </Typography>
      <Typography sx={{ maxWidth: 580, color: alpha(white, 0.84), fontSize: { xs: "1rem", md: "1.15rem" }, lineHeight: 1.6, textWrap: "pretty", ...riseSx(0.12) }}>{t("home.hero.sub")}</Typography>
    </Box>
  );
}

/** `grow`: the head takes what its screen leaves above the strip, its content centred in it. */
export default function HomeHero({ children, grow = false }) {
  const theme = useTheme();
  return (
    <Box
      data-testid="home-hero"
      sx={{
        position: "relative",
        flexShrink: 0,
        ...(grow ? { flexGrow: 1, display: "flex", flexDirection: "column", justifyContent: "center" } : {}),
        pt: { xs: 4, md: 7 },
        pb: { xs: 5, md: 9 },
        background: heroBandOf(theme),
      }}
    >
      <Container maxWidth={false} sx={{ maxWidth: HERO_WIDTH, display: "flex", flexDirection: "column", gap: 2 }}>
        {children}
      </Container>
    </Box>
  );
}
