/**
 * StudioTopBar — the one bar of the Network Studio (a project's pages,
 * create and modify), in place of the app's header: the way home (the
 * mark), the project and its job, the five steps, the step's actions, the
 * language, the theme and the account.
 *
 *   rail     the slot AppShell gives for the steps (StepNav, portaled by the
 *            project's page): in the bar on a wide screen, on a row of its
 *            own under it otherwise
 *   actions  the slot for the step's actions (StepFrame's back, extras and
 *            primary action, through <StepActions>): the step's foot moves
 *            here, so the work below it has the whole height
 *
 * The project's name is renamed in place (`onRename`, Lot H): a click on it
 * (`studio-project-name`, a button) opens the field (`studio-project-rename`),
 * Enter or leaving it keeps the name, Escape leaves it as it was; an empty
 * name is never kept. ① no longer asks it: a project is named after its
 * network when it opens one.
 *
 * `main-header` stays its test id (the shell's banner), as the app's header.
 */

import React, { useState } from "react";
import { Box, ButtonBase, IconButton, InputBase, Tooltip, Typography, useMediaQuery } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import LightModeOutlinedIcon from "@mui/icons-material/LightModeOutlined";
import DarkModeOutlinedIcon from "@mui/icons-material/DarkModeOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useThemeMode } from "../../contexts/ThemeContext";
import { useBrandHome } from "../Header/Header";
import LanguageSelector from "../Header/LanguageSelector";
import AccountMenu from "../account/AccountMenu";
import { tokensOf } from "./studioTheme";

/** The studio's mark: a route between two stops, in the ink of the bar. */
function StudioMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" style={{ fill: "none", stroke: "currentColor", strokeWidth: 2.1, strokeLinecap: "round", strokeLinejoin: "round" }}>
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M8.5 18H16a3 3 0 0 0 0-6H8a3 3 0 0 1 0-6h7.5" />
    </svg>
  );
}

/** The project's name, renamed in place: a button that opens a field; Enter or blur keeps, Escape cancels. */
function ProjectName({ name, onRename, k, t }) {
  const [draft, setDraft] = useState(null);
  const sx = { fontSize: "0.84rem", fontWeight: 600, minWidth: 0, maxWidth: { xs: 160, lg: 240, xl: 340 } };
  const keep = () => {
    const next = String(draft ?? "").trim().slice(0, 200);
    if (next && next !== name) onRename(next);
    setDraft(null);
  };
  if (draft !== null) {
    return (
      <InputBase
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={keep}
        onKeyDown={(e) => {
          if (e.key === "Enter") keep();
          else if (e.key === "Escape") setDraft(null);
        }}
        inputProps={{ "data-testid": "studio-project-rename", "aria-label": t("network.project.name"), maxLength: 200 }}
        sx={{ ...sx, width: { xs: 160, lg: 240, xl: 340 }, px: 0.75, height: 28, borderRadius: "6px", border: `1px solid ${k.accent}`, backgroundColor: k.surface }}
      />
    );
  }
  const shown = name || t("studio.untitled");
  if (!onRename) {
    return (
      <Typography component="span" title={name || undefined} data-testid="studio-project-name" sx={{ ...sx, color: name ? "text.primary" : "text.secondary", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {shown}
      </Typography>
    );
  }
  return (
    <Tooltip title={t("studio.rename")}>
      <ButtonBase onClick={() => setDraft(name)} data-testid="studio-project-name" aria-label={`${shown} — ${t("studio.rename")}`} sx={{ ...sx, display: "block", px: 0.5, mx: -0.5, height: 28, borderRadius: "6px", color: name ? "text.primary" : "text.secondary", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left", "&:hover": { backgroundColor: k.hover } }}>
        {shown}
      </ButtonBase>
    </Tooltip>
  );
}

export default function StudioTopBar({ agenciesLoaded = false, project = null, rail = null, actions = null, onRename = null }) {
  const theme = useTheme();
  const k = tokensOf(theme);
  const { t } = useLanguage();
  const { toggleMode, isDark } = useThemeMode();
  const home = useBrandHome(agenciesLoaded);
  const inline = useMediaQuery(theme.breakpoints.up("lg"));
  const name = String(project?.name ?? "").trim();
  return (
    <>
      <Box component="header" data-testid="main-header" data-studio="true" sx={{ minHeight: 52, display: "flex", alignItems: "center", gap: 1.5, px: 1.5, backgroundColor: k.surface, borderBottom: `1px solid ${k.line}` }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0, flex: "0 1 auto" }}>
          <Tooltip title={t("studio.home")}>
            <Box component="a" href="/" onClick={home} aria-label={t("studio.home")} data-testid="studio-home" sx={{ width: 28, height: 28, flexShrink: 0, borderRadius: "8px", backgroundColor: k.ink, color: k.surface, display: "flex", alignItems: "center", justifyContent: "center", "&:focus-visible": { outline: `2px solid ${k.accent}`, outlineOffset: 2 } }}>
              <StudioMark />
            </Box>
          </Tooltip>
          <Box component="span" aria-hidden sx={{ color: k.lineStrong, fontSize: 18, fontWeight: 300, lineHeight: 1 }}>
            /
          </Box>
          <ProjectName name={name} onRename={project ? onRename : null} k={k} t={t} />
          {project && (
            <Box component="span" data-testid="studio-job" sx={{ flexShrink: 0, height: 20, px: "7px", display: "inline-flex", alignItems: "center", borderRadius: 999, fontSize: "0.7rem", fontWeight: 500, backgroundColor: k.hover, color: k.ink2 }}>
              {t(project.job === "modify" ? "studio.job.modify" : "studio.job.create")}
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
