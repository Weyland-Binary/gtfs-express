/**
 * StudioTopBar — the bar of a project's steps, in place of the reader's
 * header and built from the same parts (Header/BarParts), so that both read
 * as one frame: the brand (→ Home), the project's name and the state of its
 * work (« Brouillon · n modifications », « Appliqué en vN »…), the steps, the
 * step's actions, the one search (⌘K), « Expert », the language, the theme
 * and the account.
 *
 *   rail     the slot AppShell gives for the steps (StepNav, portaled by the
 *            project's page): in the bar on a wide screen, on a row of its
 *            own under it otherwise
 *   actions  the slot for the step's actions (StepFrame's back, extras and
 *            primary action, through <StepActions>): the step's foot moves
 *            here, so the work below it has the whole height
 *   work     { state, onOpen } — the state of the work (utils/workState)
 *
 * The project's name is renamed in place (`onRename`): a click on it
 * (`studio-project-name`, a button) opens the field (`studio-project-rename`),
 * Enter or leaving it keeps the name, Escape leaves it as it was; an empty
 * name is never kept. ① does not ask it: a project is named after its
 * network when it opens one. A project that designs a network says its job
 * (`studio-job`) where a modify project says its state.
 *
 * `main-header` stays its test id (the shell's banner), as the app's header.
 */

import React from "react";
import { Box, IconButton, Tooltip, useMediaQuery } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import LightModeOutlinedIcon from "@mui/icons-material/LightModeOutlined";
import DarkModeOutlinedIcon from "@mui/icons-material/DarkModeOutlined";
import LogoSvg from "../../assets/LogoSvg";
import { useExpertMode } from "../../utils/expertMode";
import { useLanguage } from "../../contexts/LanguageContext";
import { useThemeMode } from "../../contexts/ThemeContext";
import { useBrandHome } from "../Header/Header";
import { ExpertSwitch, SearchTrigger, WorkIdentity } from "../Header/BarParts";
import LanguageSelector from "../Header/LanguageSelector";
import AccountMenu from "../account/AccountMenu";
import { tokensOf } from "./studioTheme";

export default function StudioTopBar({ agenciesLoaded = false, project = null, rail = null, actions = null, onRename = null, work = null }) {
  const [expert] = useExpertMode();
  const theme = useTheme();
  const k = tokensOf(theme);
  const { t } = useLanguage();
  const { toggleMode, isDark } = useThemeMode();
  const home = useBrandHome(agenciesLoaded);
  const inline = useMediaQuery(theme.breakpoints.up("lg"));
  const roomy = useMediaQuery(theme.breakpoints.up("xl"));
  const name = String(project?.name ?? "").trim();
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
          {project && project.job !== "modify" && (
            <Box component="span" data-testid="studio-job" sx={{ flexShrink: 0, height: 20, px: "7px", display: "inline-flex", alignItems: "center", borderRadius: 999, fontSize: "0.7rem", fontWeight: 500, backgroundColor: k.hover, color: k.ink2 }}>
              {t("studio.job.create")}
            </Box>
          )}
        </Box>
        {inline && rail ? (
          <Box data-testid="studio-steps" sx={{ flex: 1, minWidth: 0, overflow: "hidden", display: "flex", justifyContent: "center", "& [data-testid=step-nav]": { px: 0, py: 0, borderBottom: "none", background: "transparent" } }}>
            {rail}
          </Box>
        ) : (
          <Box sx={{ flex: 1 }} />
        )}
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexShrink: 0 }}>
          {actions}
          {/* The global search's button with « Expert » on; Ctrl K opens it always. */}
          {expert && <SearchTrigger compact />}
          {roomy && <ExpertSwitch />}
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
      {rail && !inline && <Box sx={{ backgroundColor: k.surface }}>{rail}</Box>}
    </>
  );
}
