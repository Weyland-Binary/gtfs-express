/**
 * The bar of a project's steps, built from the reader header's parts (Header/BarParts) so both read as one frame.
 * The steps sit in the bar while they fit (measured: centred and clipped, a step would sit under its neighbours and
 * take no click), on a row of their own otherwise. `main-header` stays its test id, as the app's header.
 */

import React, { useLayoutEffect, useRef, useState } from "react";
import { Box, IconButton, Tooltip, useMediaQuery } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import LightModeOutlinedIcon from "@mui/icons-material/LightModeOutlined";
import DarkModeOutlinedIcon from "@mui/icons-material/DarkModeOutlined";
import LogoSvg from "../../assets/LogoSvg";
import { useExpertInAccount, useExpertMode } from "../../utils/expertMode";
import { useLanguage } from "../../contexts/LanguageContext";
import { useThemeMode } from "../../contexts/ThemeContext";
import { useBrandHome } from "../Header/Header";
import { ExpertSwitch, SearchTrigger, WorkIdentity } from "../Header/BarParts";
import LanguageSelector from "../Header/LanguageSelector";
import AccountMenu from "../account/AccountMenu";
import { tokensOf } from "./studioTheme";

export default function StudioTopBar({ agenciesLoaded = false, project = null, rail = null, actions = null, onRename = null, work = null }) {
  const [expert] = useExpertMode();
  const expertInAccount = useExpertInAccount();
  const theme = useTheme();
  const k = tokensOf(theme);
  const { t } = useLanguage();
  const { toggleMode, isDark } = useThemeMode();
  const home = useBrandHome(agenciesLoaded);
  const inline = useMediaQuery(theme.breakpoints.up("lg"));
  const roomy = useMediaQuery(theme.breakpoints.up("xl"));
  const name = String(project?.name ?? "").trim();
  // The steps leave the bar when they no longer fit in it, and come back once the room they needed is there again.
  const slotRef = useRef(null);
  const [needed, setNeeded] = useState(0);
  const railInBar = inline && Boolean(rail) && !needed;
  useLayoutEffect(() => {
    const box = slotRef.current;
    if (!box || !inline || !rail) return undefined;
    const measure = () => {
      if (!needed && box.scrollWidth > box.clientWidth + 1) setNeeded(box.scrollWidth);
      else if (needed && box.clientWidth >= needed) setNeeded(0);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    if (box.firstElementChild) observer.observe(box.firstElementChild);
    return () => observer.disconnect();
  });
  return (
    <>
      <Box component="header" data-testid="main-header" data-studio="true" sx={{ minHeight: 52, display: "flex", alignItems: "center", gap: 1.5, px: 1.5, backgroundColor: k.surface, borderBottom: `1px solid ${k.line}` }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, minWidth: 0, flex: "0 1 auto" }}>
          <Tooltip title={t("studio.home")}>
            <Box component="a" href="/" onClick={home} aria-label={t("studio.home")} data-testid="studio-home" sx={{ display: "flex", alignItems: "center", flexShrink: 0, height: 36, px: 0.75, borderRadius: "8px", color: k.ink, "&:hover": { backgroundColor: k.hover }, "&:focus-visible": { outline: `2px solid ${k.accent}`, outlineOffset: 2 } }}>
              <LogoSvg aria-hidden="true" style={{ width: 118, height: "auto", display: "block", overflow: "visible", color: isDark ? "#ffffff" : "#111111" }} />
            </Box>
          </Tooltip>
          <Box component="span" aria-hidden sx={{ color: k.lineStrong, fontSize: 18, fontWeight: 300, lineHeight: 1 }}>
            /
          </Box>
          <WorkIdentity work={{ name, onRename: project ? onRename : null, state: work?.state || null, onOpen: work?.onOpen || null }} nameTestid="studio-project-name" renameTestid="studio-project-rename" />
        </Box>
        {railInBar ? (
          <Box ref={slotRef} data-testid="studio-steps" sx={{ flex: 1, minWidth: 0, overflow: "hidden", display: "flex", justifyContent: "center", "& [data-testid=step-nav]": { px: 0, py: 0, borderBottom: "none", background: "transparent" } }}>
            {rail}
          </Box>
        ) : (
          <Box ref={slotRef} data-testid="studio-steps-room" sx={{ flex: 1, minWidth: 0 }} />
        )}
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexShrink: 0 }}>
          {actions}
          {/* The global search's button with « Expert » on; Ctrl K opens it always. */}
          {expert && <SearchTrigger compact />}
          {roomy && !expertInAccount && <ExpertSwitch />}
          <Box aria-hidden sx={{ width: "1px", height: 20, backgroundColor: k.line, mx: 0.25 }} />
          <LanguageSelector />
          <Tooltip title={isDark ? t("header.lightMode") : t("header.darkMode")}>
            <IconButton size="small" onClick={toggleMode} data-testid="theme-toggle" data-mode={isDark ? "dark" : "light"} aria-label={isDark ? t("header.lightMode") : t("header.darkMode")} sx={{ color: k.ink2 }}>
              {isDark ? <LightModeOutlinedIcon sx={{ fontSize: 19 }} /> : <DarkModeOutlinedIcon sx={{ fontSize: 19 }} />}
            </IconButton>
          </Tooltip>
          <AccountMenu compact />
        </Box>
      </Box>
      {rail && !railInBar && <Box sx={{ backgroundColor: k.surface }}>{rail}</Box>}
    </>
  );
}
