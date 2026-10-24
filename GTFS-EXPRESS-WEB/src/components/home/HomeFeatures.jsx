/**
 * Home under its head: the strip of what is sure (the validator, the person's decision, every file, seven languages)
 * and the features, eight of equal weight, each an icon, a name and a line.
 */

import React from "react";
import { Box, Container, Typography, alpha, useTheme } from "@mui/material";
import VerifiedUserOutlinedIcon from "@mui/icons-material/VerifiedUserOutlined";
import HowToRegOutlinedIcon from "@mui/icons-material/HowToRegOutlined";
import LayersOutlinedIcon from "@mui/icons-material/LayersOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import GestureOutlinedIcon from "@mui/icons-material/GestureOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import PrintOutlinedIcon from "@mui/icons-material/PrintOutlined";
import VerifiedOutlinedIcon from "@mui/icons-material/VerifiedOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { HOME_WIDTH } from "./inkGround";
import Reveal from "./Reveal";

/** An icon on its tinted tile; `tone` a palette colour. */
export function IconTile({ icon: Icon, tone, size = 44, solid = false }) {
  const theme = useTheme();
  return (
    <Box
      aria-hidden
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: size > 48 ? "50%" : "12px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: solid ? theme.palette.getContrastText(tone) : tone,
        backgroundColor: solid ? tone : alpha(tone, theme.palette.mode === "dark" ? 0.2 : 0.1),
      }}
    >
      <Icon sx={{ fontSize: Math.round(size * 0.5) }} />
    </Box>
  );
}

export function HomeStrip() {
  const theme = useTheme();
  const { t } = useLanguage();
  // Each promise in the colour of what it means: the validator's check green, the person's decision the brand's blue,
  // the files the data's blue.
  const items = [
    { key: "validator", icon: VerifiedUserOutlinedIcon, tone: theme.palette.success.main },
    { key: "decision", icon: HowToRegOutlinedIcon, tone: theme.palette.primary.main },
    { key: "files", icon: LayersOutlinedIcon, tone: theme.palette.info.main },
  ];
  return (
    <Box
      component="section"
      aria-label={t("home.strip.label")}
      data-testid="home-strip"
      sx={{
        borderTop: `1px solid ${theme.palette.divider}`,
        borderBottom: `1px solid ${theme.palette.divider}`,
        backgroundColor: theme.palette.mode === "dark" ? alpha(theme.palette.primary.main, 0.06) : theme.palette.background.paper,
      }}
    >
      <Container maxWidth={false} sx={{ maxWidth: HOME_WIDTH, py: 3.5 }}>
        <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexWrap: "wrap", justifyContent: "center", columnGap: { xs: 4, md: 8 }, rowGap: 2 }}>
          {items.map(({ key, icon, tone }) => (
            <Box component="li" key={key} data-testid={`home-strip-${key}`} sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
              <IconTile icon={icon} tone={tone} />
              <Typography sx={{ fontSize: "0.95rem", fontWeight: 600 }}>{t(`home.strip.${key}`)}</Typography>
            </Box>
          ))}
        </Box>
      </Container>
    </Box>
  );
}

// Each feature its own colour of the theme, so the eight read apart at a glance.
export const FEATURES = [
  { key: "reader", icon: VisibilityOutlinedIcon, tone: (p) => p.primary.main },
  { key: "assistant", icon: AutoAwesomeOutlinedIcon, tone: (p) => p.ai.main },
  { key: "hand", icon: EditOutlinedIcon, tone: (p) => p.warning.main },
  { key: "shapes", icon: GestureOutlinedIcon, tone: (p) => p.info.main },
  { key: "brief", icon: DescriptionOutlinedIcon, tone: (p) => p.secondary.main },
  { key: "sheets", icon: PrintOutlinedIcon, tone: (p) => p.error.main },
  { key: "quality", icon: VerifiedOutlinedIcon, tone: (p) => p.success.main },
  { key: "sql", icon: StorageOutlinedIcon, tone: (p) => (p.mode === "dark" ? p.grey[400] : p.grey[700]) },
];

export function HomeFeatures() {
  const theme = useTheme();
  const { t } = useLanguage();
  return (
    <Box component="section" id="fonctionnalites" aria-labelledby="home-features-title" data-testid="home-features" sx={{ scrollMarginTop: 72 }}>
      <Container maxWidth={false} sx={{ maxWidth: HOME_WIDTH, pt: { xs: 8, md: 13 }, display: "flex", flexDirection: "column", gap: { xs: 3, md: 5 } }}>
        <Reveal sx={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 1.5 }}>
          <Typography sx={{ fontSize: "0.9rem", fontWeight: 650, color: "primary.main" }}>{t("home.features.eyebrow")}</Typography>
          <Typography id="home-features-title" component="h2" sx={{ fontSize: { xs: "1.9rem", md: "2.6rem" }, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.1 }}>
            {t("home.features.title")}
          </Typography>
          <Typography sx={{ fontSize: { xs: "1rem", md: "1.12rem" }, color: "text.secondary", lineHeight: 1.6 }}>{t("home.features.lead")}</Typography>
        </Reveal>
        <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none", display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))", lg: "repeat(4, minmax(0, 1fr))" }, gap: 2 }}>
          {FEATURES.map(({ key, icon, tone }, i) => {
            const color = tone(theme.palette);
            return (
              <Reveal component="li" key={key} data-testid={`home-feature-${key}`} delay={0.06 * (i % 4) + 0.08 * Math.floor(i / 4)} sx={{ display: "flex" }}>
              <Box
                sx={{
                  flex: 1,
                  p: 3,
                  borderRadius: "16px",
                  border: `1px solid ${theme.palette.divider}`,
                  backgroundColor: theme.palette.background.paper,
                  display: "flex",
                  flexDirection: "column",
                  gap: 1.5,
                  transition: "transform 200ms, box-shadow 200ms, border-color 200ms",
                  "&:hover": {
                    transform: "translateY(-3px)",
                    borderColor: alpha(color, 0.45),
                    boxShadow: theme.palette.mode === "dark" ? "0 18px 40px rgba(0,0,0,0.45)" : `0 18px 40px ${alpha(theme.palette.primary.dark, 0.1)}`,
                  },
                  "@media (prefers-reduced-motion: reduce)": { transition: "none", "&:hover": { transform: "none" } },
                }}
              >
                <IconTile icon={icon} tone={color} />
                <Typography component="h3" sx={{ fontSize: "1.05rem", fontWeight: 700 }}>
                  {t(`home.features.${key}.title`)}
                </Typography>
                <Typography sx={{ fontSize: "0.92rem", color: "text.secondary", lineHeight: 1.55 }}>{t(`home.features.${key}.text`)}</Typography>
              </Box>
              </Reveal>
            );
          })}
        </Box>
      </Container>
    </Box>
  );
}
