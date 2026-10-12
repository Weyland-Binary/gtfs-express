import React, { useState } from "react";
import LogoSvg from "../../assets/LogoSvg";
import {
  Box,
  Tabs,
  Tab,
  Paper,
  IconButton,
  Tooltip,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { styled, useTheme } from "@mui/material/styles";
import ScheduleIcon from "@mui/icons-material/Schedule";
import DashboardOutlinedIcon from "@mui/icons-material/DashboardOutlined";
import LightModeIcon from "@mui/icons-material/LightMode";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import StorageIcon from "@mui/icons-material/Storage";
import EditLocationAltIcon from "@mui/icons-material/EditLocationAlt";
import CompareArrowsIcon from "@mui/icons-material/CompareArrows";
import { useThemeMode } from "../../contexts/ThemeContext";
import GlobalSearch from "../GlobalSearch";
import LanguageSelector from "./LanguageSelector";
import ProjectMenu from "../edit/ProjectMenu";
import { TablesBrowserButton } from "../TablesBrowserDrawer";
import ShareButton from "../share/ShareButton";
import ModifyMenu, { AssistantButton } from "../edit/ModifyMenu";
import AccountMenu from "../account/AccountMenu";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDestructiveGuard } from "../../contexts/DestructiveGuardContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { useNavigate, HOME_PATH } from "../../utils/routes";

const StyledTabs = styled(Tabs)(({ theme }) => ({
  "& .MuiTabs-indicator": {
    height: 3,
    borderRadius: "3px 3px 0 0",
    background: theme.palette.mode === "dark" ? "#90caf9" : "#1976d2",
  },
  "& .MuiTab-root": {
    minHeight: 44,
    fontWeight: 500,
    fontSize: "0.85rem",
    textTransform: "none",
    color: theme.palette.text.secondary,
    transition: "all 0.2s ease-in-out",
    "&:hover": {
      color: theme.palette.primary.main,
      backgroundColor:
        theme.palette.mode === "dark"
          ? "rgba(255, 255, 255, 0.05)"
          : "rgba(25, 118, 210, 0.04)",
    },
    "&.Mui-selected": {
      color: theme.palette.primary.main,
      fontWeight: 600,
    },
  },
}));

const HeaderContainer = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(1, 2.5),
  marginBottom: 0,
  marginTop: 0,
  background: theme.palette.mode === "dark" ? "#1e1e1e" : "#ffffff",
  boxShadow: "none",
  borderRadius: "0 0 0 0",
  border:
    theme.palette.mode === "dark"
      ? "1px solid rgba(255,255,255,0.08)"
      : "1px solid rgba(0,0,0,0.06)",
  borderBottom: "none",
}));

const ThemeToggleButton = styled(IconButton)(({ theme }) => ({
  padding: 8,
  borderRadius: 10,
  backgroundColor:
    theme.palette.mode === "dark"
      ? "rgba(255, 255, 255, 0.08)"
      : "rgba(25, 118, 210, 0.08)",
  color: theme.palette.primary.main,
  transition: "all 0.2s ease-in-out",
  "&:hover": {
    backgroundColor:
      theme.palette.mode === "dark"
        ? "rgba(255, 255, 255, 0.15)"
        : "rgba(25, 118, 210, 0.15)",
    transform: "scale(1.05)",
  },
}));

/**
 * Header — the top bar and, with a network open, the explorer's toolbar.
 *
 * Reduced to the top bar of the shell (§3.1, WP1): the brand (→ Home), the
 * account, the language and the theme. "Modifier le réseau"
 * (`open-change-studio`) left it with WP4 (D48): it lives on the overview's
 * next-step card (HomeNextStep), on the network it applies to. The state of the work and the edit controls
 * left for the status bar (common/StatusBar.js): no pencil, no green group,
 * no validation badge up here any more.
 *
 * Under it (in its own row on a wide screen), with a network open, the explorer's toolbar: the network's tabs
 * in a <nav aria-label="Réseau"> (they stand where the steps' rail will be),
 * then the search, the working file, the tables and the share button
 * (`share-network` stays in this toolbar — D48), then the assistant by name
 * and « Modifier ▾ » (edit/ModifyMenu: retouch by hand here, or prepare a
 * change — 2026-10-08, the ways to modify visible on every tab). The tabs are routes
 * (/r/:id/apercu, /horaires, /traces, /sql, /comparer): `activeTab` is the
 * current one, `onSelectTab(slug)` navigates. Inside a project's steps the
 * rail stands where the toolbar is (`toolbar` false); the explorer inside a
 * project (/p/:id/voir/…) shows it again.
 */
/**
 * The brand leads Home (§3.1). With a network open that means leaving it:
 * through the unsaved-changes guard, edit mode left first (the server's edit
 * state would otherwise bring the network back on arrival), then a fresh
 * page. With none (Home itself, a share landing) it is a plain navigation
 * through the router. A modified click (new tab, new window) is the
 * browser's. Shared with the Network Studio's bar (studio/StudioTopBar).
 */
export function useBrandHome(agenciesLoaded) {
  const { guard } = useDestructiveGuard();
  const { editing, exitEditMode } = useEditMode();
  const navigate = useNavigate();
  return (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!agenciesLoaded) {
      navigate(HOME_PATH);
      return;
    }
    guard(
      async () => {
        if (editing) await exitEditMode();
        window.location.assign("/");
      },
      { reason: "reload" },
    );
  };
}

/**
 * `rail`: inside a project, the slot of the steps' rail (AppShell). On a wide screen it stands in the header's own
 * row, between the brand and the actions — one bar instead of two; narrower, under the header as before.
 *
 * The explorer's toolbar follows the same rule (the owner's direction of 2026-10-08: the reader's height goes to
 * what it shows): on a wide screen with no rail in the row, the tabs and the tools stand in the header's own row,
 * between the brand and the account, the tabs as tall as the bar. Below "xl" the tabs drop their icons, so that the five
 * of them fit beside the search (in the header's row, or in their own row on one line). Narrower, or beside a project's rail, they keep their row under it.
 */
function Header({ agenciesLoaded, activeTab = false, onSelectTab, toolbar = true, rail = null }) {
  const { toggleMode, isDark } = useThemeMode();
  const theme = useTheme();
  const { t } = useLanguage();
  const [logoHovered, setLogoHovered] = useState(false);
  const handleLogoClick = useBrandHome(agenciesLoaded);
  const { editing } = useEditMode();
  const wide = useMediaQuery(theme.breakpoints.up("lg"));
  const roomy = useMediaQuery(theme.breakpoints.up("xl"));
  const inline = Boolean(rail) && wide;
  const showToolbar = agenciesLoaded && toolbar;
  const toolbarInline = showToolbar && wide && !inline;
  // The header gets crowded below "lg" (below "xl" with the tabs in its row): the account keeps its icon only.
  const compactActions = toolbarInline ? !roomy : !wide;
  const tabIcons = roomy;

  const isHoverActive = agenciesLoaded && logoHovered;

  const tabs = [
    { slug: "apercu", testid: "tab-home", icon: <DashboardOutlinedIcon sx={{ fontSize: 20 }} />, label: t("explorer.overview") },
    { slug: "horaires", testid: "tab-schedules", icon: <ScheduleIcon sx={{ fontSize: 20 }} />, label: t("header.tabSchedules") },
    // Shapes — edit-mode-only geometry editor.
    editing && { slug: "traces", testid: "tab-shape-studio", icon: <EditLocationAltIcon sx={{ fontSize: 20 }} />, label: t("explorer.shapes") },
    { slug: "sql", testid: "tab-sql", icon: <StorageIcon sx={{ fontSize: 20 }} />, label: t("sqlConsole.headerBtn") },
    { slug: "comparer", testid: "tab-compare", icon: <CompareArrowsIcon sx={{ fontSize: 20 }} />, label: t("compare.tab") },
  ].filter(Boolean);
  const tabValue = tabs.some((tab) => tab.slug === activeTab) ? activeTab : false;

  const explorerToolbar = showToolbar && (
    <Box
      data-testid="explorer-toolbar"
      data-placement={toolbarInline ? "header" : "row"}
      sx={toolbarInline ? { flex: 1, minWidth: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1.5, alignSelf: "stretch" } : { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", columnGap: 1.5 }}
    >
      <Box component="nav" aria-label={t("a11y.networkNav")} sx={{ minWidth: 0, maxWidth: "100%", alignSelf: toolbarInline ? "stretch" : undefined, display: toolbarInline ? "flex" : undefined }}>
        <StyledTabs
          value={tabValue}
          onChange={(e, slug) => onSelectTab?.(slug)}
          variant="scrollable"
          scrollButtons="auto"
          sx={toolbarInline ? { minHeight: 0, alignSelf: "stretch", "& .MuiTabs-scroller, & .MuiTabs-flexContainer": { height: "100%" }, "& .MuiTab-root": { minHeight: 0, height: "100%", px: 1.5, minWidth: 0 } } : undefined}
        >
          {tabs.map((tab) => (
            <Tab key={tab.slug} value={tab.slug} data-testid={tab.testid} icon={tabIcons ? tab.icon : undefined} iconPosition="start" label={tab.label} />
          ))}
        </StyledTabs>
      </Box>
      <Box component="section" display="flex" alignItems="center" gap={toolbarInline ? 1 : 1.5} aria-label={t("explorer.tools")} data-testid="explorer-tools" sx={{ flexShrink: 0 }}>
        <GlobalSearch width={toolbarInline ? "clamp(150px, 13vw, 280px)" : { xs: 280, md: 240 }} />
        <ProjectMenu />
        <TablesBrowserButton />
        <ShareButton />
        {/* The ways to modify the network, on every tab (2026-10-08): the assistant by name, then « Modifier ▾ ». */}
        <AssistantButton compact={!roomy} />
        <ModifyMenu compact={!roomy} />
      </Box>
    </Box>
  );

  return (
    <>
    <HeaderContainer
      elevation={0}
      sx={toolbarInline ? { py: 0, borderBottom: `1px solid ${theme.palette.divider}` } : inline ? { py: 0.5, borderBottom: `1px solid ${theme.palette.divider}` } : undefined}
    >
      <Box component="header" data-testid="main-header" display="flex" alignItems="center" justifyContent="space-between" gap={toolbarInline ? 2 : 1.5} sx={toolbarInline ? { minHeight: 56 } : undefined}>
        {/* Brand → Home; morphs into "Load a new file" on hover when a network is open */}
        <Box
          component="a"
          href="/"
          aria-label={agenciesLoaded ? t("header.loadNewFile") : "GTFS Express"}
          onMouseEnter={() => agenciesLoaded && setLogoHovered(true)}
          onMouseLeave={() => setLogoHovered(false)}
          onFocus={() => agenciesLoaded && setLogoHovered(true)}
          onBlur={() => setLogoHovered(false)}
          onClick={handleLogoClick}
          sx={{
            position: "relative",
            display: "block",
            width: 194,
            height: 44,
            cursor: "pointer",
            borderRadius: 2,
            overflow: "hidden",
            flexShrink: 0,
            transition: "background 0.2s",
            backgroundColor: isHoverActive
              ? isDark
                ? "rgba(144,202,249,0.10)"
                : "rgba(25,118,210,0.07)"
              : "transparent",
            border: `1px solid ${isHoverActive ? (isDark ? "rgba(144,202,249,0.25)" : "rgba(25,118,210,0.25)") : "transparent"}`,
          }}
        >
          <Box
            aria-hidden="true"
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-start",
              pl: 1,
              opacity: isHoverActive ? 0 : 1,
              transform: isHoverActive ? "translateY(-10px)" : "translateY(0)",
              transition: "opacity 0.22s ease, transform 0.22s ease",
              pointerEvents: "none",
            }}
          >
            <LogoSvg
              style={{
                width: 178,
                height: "auto",
                display: "block",
                overflow: "visible",
                color: isDark ? "#ffffff" : "#111111",
              }}
            />
          </Box>
          <Box
            aria-hidden="true"
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 0.5,
              opacity: isHoverActive ? 1 : 0,
              transform: isHoverActive ? "translateY(0)" : "translateY(10px)",
              transition: "opacity 0.22s ease, transform 0.22s ease",
              pointerEvents: "none",
            }}
          >
            <UploadFileIcon sx={{ fontSize: 18, color: theme.palette.primary.main }} />
            <Typography variant="body2" fontWeight={600} sx={{ color: theme.palette.primary.main, fontSize: "0.8rem", letterSpacing: "-0.01em" }}>
              {t("header.loadNewFile")}
            </Typography>
          </Box>
        </Box>

        {inline && (
          // The rail's own frame (padding, border, background) is the header's here.
          <Box data-testid="header-rail" sx={{ flex: 1, minWidth: 0, "& [data-testid=step-nav]": { px: 0, py: 0, borderBottom: "none", background: "transparent" } }}>
            {rail}
          </Box>
        )}
        {toolbarInline && explorerToolbar}
        <Box display="flex" alignItems="center" gap={toolbarInline ? 1 : 1.5} justifyContent="flex-end" sx={toolbarInline ? { flexShrink: 0, pl: 2, borderLeft: `1px solid ${theme.palette.divider}` } : undefined}>
          {/* Account (ACCOUNTS_ENABLED): renders nothing while accounts are off. */}
          <AccountMenu compact={compactActions} />
          <LanguageSelector />
          <Tooltip title={isDark ? t("header.lightMode") : t("header.darkMode")}>
            <ThemeToggleButton onClick={toggleMode} size="small" data-testid="theme-toggle" data-mode={isDark ? "dark" : "light"} aria-label={isDark ? t("header.lightMode") : t("header.darkMode")}>
              {isDark ? <LightModeIcon sx={{ fontSize: 20 }} /> : <DarkModeIcon sx={{ fontSize: 20 }} />}
            </ThemeToggleButton>
          </Tooltip>
        </Box>
      </Box>

      {!toolbarInline && explorerToolbar}
    </HeaderContainer>
    {rail && !inline && rail}
    </>
  );
}

export default Header;
