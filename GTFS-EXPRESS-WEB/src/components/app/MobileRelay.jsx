/**
 * What a phone sees in place of the application (utils/layout): the product opens on a computer, so the phone hands
 * it over (its share sheet, or the link copied) or goes on anyway, for this tab. Never a wall: a person who insists
 * gets the application as it is.
 */

import React from "react";
import { Box, Button, IconButton, Typography, alpha, useTheme } from "@mui/material";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import IosShareRoundedIcon from "@mui/icons-material/IosShareRounded";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import LogoSvg from "../../assets/LogoSvg";
import { useLanguage } from "../../contexts/LanguageContext";
import { useNavigate, HOME_PATH } from "../../utils/routes";
import { trackUi } from "../../utils/uiTelemetry";
import { rememberPhoneContinue } from "../../utils/layout";
import { homeGroundOf } from "../home/inkGround";
import { readerShot } from "../home/readerShots";
import { ShareButton, useSendToComputer } from "../home/MobileShare";
import { SkipLink } from "../AppShell";

// « Lien copié » says so for this long, then the button is the copy again.
const COPIED_MS = 3000;

export default function MobileRelay({ onContinue, title = null, link = null }) {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const navigate = useNavigate();
  const dark = theme.palette.mode === "dark";
  const { send, copy: copyText, snackbar } = useSendToComputer("relay", link);
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    trackUi("mobile.relay", "shown");
  }, []);
  React.useEffect(() => {
    if (title) document.title = title;
  }, [title]);
  const back = () => {
    if (window.history.length > 1) window.history.back();
    else navigate(HOME_PATH);
  };
  React.useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(id);
  }, [copied]);
  const copy = async () => {
    setCopied((await copyText()) === "copied");
  };
  const goOn = () => {
    trackUi("mobile.relay", "continue");
    rememberPhoneContinue();
    onContinue?.();
  };
  return (
    <Box data-testid="mobile-relay" sx={{ minHeight: "100dvh", display: "flex", flexDirection: "column", backgroundColor: dark ? theme.palette.background.default : homeGroundOf(theme) }}>
      <SkipLink />
      <Box component="header" sx={{ display: "flex", alignItems: "center", gap: 0.5, minHeight: 60, pt: "env(safe-area-inset-top)", pl: "max(4px, env(safe-area-inset-left))", pr: "max(12px, env(safe-area-inset-right))", backgroundColor: theme.palette.background.paper, borderBottom: `1px solid ${theme.palette.divider}` }}>
        <IconButton onClick={back} aria-label={t("mobile.relay.back")} data-testid="mobile-relay-back" sx={{ width: 44, height: 44, color: "text.primary" }}>
          <ArrowBackRoundedIcon />
        </IconButton>
        <LogoSvg role="img" aria-label="GTFS Express" style={{ width: 116, height: "auto", display: "block", overflow: "visible", color: dark ? "#ffffff" : "#111111" }} />
      </Box>
      <Box component="main" id="main" tabIndex={-1} sx={{ outline: "none", flex: 1, display: "flex", flexDirection: "column", gap: 2.5, px: 3, pt: 3.5, pb: "max(24px, env(safe-area-inset-bottom))", maxWidth: 520, width: "100%", mx: "auto", boxSizing: "border-box" }}>
        <Box aria-hidden sx={{ position: "relative", height: 210 }}>
          <Box sx={{ position: "absolute", right: 0, top: 8, width: "74%" }}>
            <Box sx={{ p: "6px 6px 9px", borderRadius: "12px 12px 5px 5px", backgroundColor: theme.palette.grey[900], boxShadow: `0 22px 46px ${alpha(theme.palette.common.black, dark ? 0.55 : 0.2)}` }}>
              <Box component="img" src={readerShot("Show_Reader", theme.palette.mode, language)} alt="" sx={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", display: "block", borderRadius: "5px" }} />
            </Box>
            <Box sx={{ height: 8, mx: "-12px", borderRadius: "0 0 10px 10px", backgroundColor: theme.palette.grey[dark ? 600 : 400] }} />
          </Box>
          <Box sx={{ position: "absolute", left: 0, bottom: 0, width: 66, height: 128, boxSizing: "border-box", borderRadius: "16px", border: `4px solid ${theme.palette.text.primary}`, backgroundColor: theme.palette.background.paper, display: "flex", alignItems: "center", justifyContent: "center", color: "primary.main" }}>
            <IosShareRoundedIcon />
          </Box>
        </Box>
        <Typography component="h1" sx={{ fontSize: "1.75rem", lineHeight: 1.15, fontWeight: 800, letterSpacing: "-0.035em", color: dark ? "text.primary" : "primary.dark" }}>
          {t("mobile.relay.title")}
        </Typography>
        <Typography sx={{ fontSize: "1rem", lineHeight: 1.6, color: "text.secondary" }}>{t("mobile.relay.text")}</Typography>
        <Box sx={{ flex: 1 }} />
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
          <ShareButton onClick={send} />
          <Button variant="outlined" onClick={copy} startIcon={<ContentCopyRoundedIcon />} data-testid="mobile-relay-copy" sx={{ minHeight: 50, borderRadius: "14px", textTransform: "none", fontSize: "1rem", fontWeight: 600 }}>
            {copied ? t("mobile.copied") : t("mobile.relay.copy")}
          </Button>
          <Button variant="text" onClick={goOn} data-testid="mobile-relay-continue" sx={{ alignSelf: "center", minHeight: 44, textTransform: "none", fontSize: "0.95rem", fontWeight: 500, color: "text.secondary" }}>
            {t("mobile.relay.continue")}
          </Button>
        </Box>
        <Typography sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 1, fontSize: "0.82rem", color: "text.secondary" }}>
          <VisibilityOutlinedIcon aria-hidden sx={{ fontSize: 16 }} />
          {t("mobile.relay.free")}
        </Typography>
      </Box>
      {snackbar}
    </Box>
  );
}
