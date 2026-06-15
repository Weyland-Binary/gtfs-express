import React, { useState, useEffect } from "react";
import { Box, Typography, Button, useTheme, Fade } from "@mui/material";
import DesktopWindowsIcon from "@mui/icons-material/DesktopWindows";
import TouchAppIcon from "@mui/icons-material/TouchApp";
import { keyframes } from "@emotion/react";
import { useLanguage } from "../contexts/LanguageContext";

const float = keyframes`
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-8px); }
`;

const shimmer = keyframes`
  0% { background-position: -200% center; }
  100% { background-position: 200% center; }
`;

function MobileBanner() {
  const [dismissed, setDismissed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [visible, setVisible] = useState(false);
  const theme = useTheme();
  // All banner colours (gradients, borders, text tones) live in
  // theme.palette.banner — light/dark variants are resolved by the theme.
  const banner = theme.palette.banner;
  const { t } = useLanguage();

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    if (isMobile && !dismissed) {
      const t = setTimeout(() => setVisible(true), 300);
      return () => clearTimeout(t);
    }
  }, [isMobile, dismissed]);

  if (!isMobile || dismissed) return null;

  return (
    <Fade in={visible} timeout={600}>
      <Box
        sx={{
          position: "fixed",
          inset: 0,
          zIndex: 9999,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          p: 3,
          background: banner.backdrop,
          backdropFilter: "blur(20px)",
        }}
      >
        {/* Glow decoration */}
        <Box
          sx={{
            position: "absolute",
            top: "15%",
            left: "50%",
            transform: "translateX(-50%)",
            width: 260,
            height: 260,
            borderRadius: "50%",
            background: banner.glow,
            pointerEvents: "none",
          }}
        />

        {/* Icon */}
        <Box
          sx={{
            width: 80,
            height: 80,
            borderRadius: "24px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: banner.iconBg,
            border: `1px solid ${banner.iconBorder}`,
            mb: 3.5,
            animation: `${float} 3s ease-in-out infinite`,
          }}
        >
          <DesktopWindowsIcon
            sx={{
              fontSize: 36,
              // Same value as the historical per-mode pair (#1976d2 / #90caf9)
              color: theme.palette.primary.main,
            }}
          />
        </Box>

        {/* Title */}
        <Typography
          variant="h5"
          fontWeight={700}
          textAlign="center"
          sx={{
            color: banner.title,
            letterSpacing: "-0.02em",
            lineHeight: 1.2,
            mb: 1.5,
          }}
        >
          {t("mobileBanner.title")}
        </Typography>

        {/* Subtitle */}
        <Typography
          variant="body2"
          textAlign="center"
          sx={{
            color: banner.subtitle,
            maxWidth: 300,
            lineHeight: 1.6,
            mb: 4,
          }}
        >
          {t("mobileBanner.subtitle")}
        </Typography>

        {/* CTA — continue anyway */}
        <Button
          onClick={() => setDismissed(true)}
          variant="contained"
          disableElevation
          startIcon={<TouchAppIcon sx={{ fontSize: 18 }} />}
          sx={{
            borderRadius: "14px",
            textTransform: "none",
            fontWeight: 600,
            fontSize: "0.9rem",
            px: 3.5,
            py: 1.4,
            background: banner.cta,
            color: theme.palette.common.white,
            boxShadow: banner.ctaShadow,
            transition: "all 0.2s ease",
            "&:hover": {
              boxShadow: banner.ctaShadowHover,
              transform: "translateY(-1px)",
            },
            "&:active": {
              transform: "translateY(0)",
            },
          }}
        >
          {t("mobileBanner.continue")}
        </Button>

        {/* Shimmer bar */}
        <Box
          sx={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: 3,
            // Shimmer accent matches the historical per-mode pair
            // (#1976d2 / #90caf9) — exactly primary.main in each theme.
            background: `linear-gradient(90deg, transparent 0%, ${theme.palette.primary.main} 50%, transparent 100%)`,
            backgroundSize: "200% 100%",
            animation: `${shimmer} 2.5s ease-in-out infinite`,
            opacity: 0.5,
          }}
        />
      </Box>
    </Fade>
  );
}

export default MobileBanner;
