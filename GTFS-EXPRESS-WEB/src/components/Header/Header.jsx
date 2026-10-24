import React, { useRef, useState } from "react";
import LogoSvg from "../../assets/LogoSvg";
import {
  Box,
  Tabs,
  Tab,
  Paper,
  IconButton,
  Menu,
  Tooltip,
  useMediaQuery,
} from "@mui/material";
import { styled, useTheme } from "@mui/material/styles";
import RouteOutlinedIcon from "@mui/icons-material/RouteOutlined";
import PrintOutlinedIcon from "@mui/icons-material/PrintOutlined";
import DashboardOutlinedIcon from "@mui/icons-material/DashboardOutlined";
import LightModeIcon from "@mui/icons-material/LightMode";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import StorageIcon from "@mui/icons-material/Storage";
import EditLocationAltIcon from "@mui/icons-material/EditLocationAlt";
import CompareArrowsIcon from "@mui/icons-material/CompareArrows";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import { useThemeMode } from "../../contexts/ThemeContext";
import LanguageSelector from "./LanguageSelector";
import ProjectMenu, { FeedInfoMenuItem } from "../edit/ProjectMenu";
import { TablesBrowserButton } from "../TablesBrowserDrawer";
import ShareButton from "../share/ShareButton";
import ModifyMenu, { AssistantButton } from "../edit/ModifyMenu";
import AccountMenu from "../account/AccountMenu";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDestructiveGuard } from "../../contexts/DestructiveGuardContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { useNavigate, HOME_PATH } from "../../utils/routes";
import { useExpertInAccount, useExpertMode } from "../../utils/expertMode";
import { ExpertSwitch, SearchTrigger, WorkIdentity } from "./BarParts";
import { foldOf, useBarFold } from "./barFold";

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
  // A hairline between two tabs, on the middle third of their height: each view reads as its own.
  "& .MuiTab-root + .MuiTab-root::before": {
    content: '""',
    position: "absolute",
    left: 0,
    top: "30%",
    bottom: "30%",
    width: "1px",
    backgroundColor: theme.palette.divider,
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

/** Kept mounted, so a dialog or a drawer a row opens outlives the menu. */
function MoreTools({ expert }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [anchor, setAnchor] = useState(null);
  const close = () => setAnchor(null);
  return (
    <>
      <Tooltip title={t("bar.moreTools")}>
        <IconButton size="small" onClick={(e) => setAnchor(e.currentTarget)} aria-label={t("bar.moreTools")} aria-haspopup="menu" aria-expanded={Boolean(anchor)} data-testid="bar-more" sx={{ padding: 1, borderRadius: 2.5, color: theme.palette.text.secondary }}>
          <MoreHorizIcon sx={{ fontSize: 20 }} />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={close} keepMounted anchorOrigin={{ vertical: "bottom", horizontal: "right" }} transformOrigin={{ vertical: "top", horizontal: "right" }} slotProps={{ paper: { sx: { minWidth: 240 } } }} data-testid="bar-more-menu">
        <ShareButton asMenuItem onPick={close} />
        {expert && <TablesBrowserButton asMenuItem onPick={close} />}
        {expert && <FeedInfoMenuItem onPick={close} />}
      </Menu>
    </>
  );
}

/**
 * The brand leads Home. With a network open, through the unsaved-changes guard and with edit mode left first (the
 * server's edit state would otherwise bring the network back on arrival), then a fresh page. A modified click is the
 * browser's.
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
 * The reader's top bar. On a wide screen the project's `rail`, or the explorer's toolbar when no rail is in the row,
 * stands in the header's own row so the reader's height goes to what it shows; narrower, under the header.
 */
function Header({ agenciesLoaded, activeTab = false, onSelectTab, toolbar = true, rail = null, railCompact = false, work = null, draft = false, tabsShown = true, draftInProgress = null, draftSlot = null }) {
  const { toggleMode, isDark } = useThemeMode();
  const theme = useTheme();
  const { t, language } = useLanguage();
  const handleLogoClick = useBrandHome(agenciesLoaded);
  const { editing } = useEditMode();
  const [expert] = useExpertMode();
  const expertInAccount = useExpertInAccount();
  const wide = useMediaQuery(theme.breakpoints.up("lg"));
  const roomy = useMediaQuery(theme.breakpoints.up("xl"));
  const inline = Boolean(rail) && wide;
  const showToolbar = agenciesLoaded && toolbar;
  // A compact rail (one way back) shares the row with the tabs; a full one (the steps) takes it.
  const toolbarInline = showToolbar && wide && (!inline || railCompact);
  // The header gets crowded below "lg" (below "xl" with the tabs in its row): the account keeps its icon only.
  const compactActions = toolbarInline ? !roomy : !wide;
  // The expert tabs show with « Expert » on, or while one of them is the page shown (reached by its address).
  const expertTab = (slug) => expert || activeTab === slug;

  const tabs = [
    { slug: "apercu", testid: "tab-home", icon: <DashboardOutlinedIcon sx={{ fontSize: 20 }} />, label: t("explorer.overview") },
    { slug: "horaires", testid: "tab-schedules", icon: <RouteOutlinedIcon sx={{ fontSize: 20 }} />, label: t("header.tabSchedules") },
    { slug: "fiches", testid: "tab-sheets", icon: <PrintOutlinedIcon sx={{ fontSize: 20 }} />, label: t("header.tabSheets") },
    editing && { slug: "traces", testid: "tab-shape-studio", icon: <EditLocationAltIcon sx={{ fontSize: 20 }} />, label: t("explorer.shapes") },
    expertTab("sql") && { slug: "sql", testid: "tab-sql", icon: <StorageIcon sx={{ fontSize: 20 }} />, label: t("sqlConsole.headerBtn") },
    expertTab("comparer") && { slug: "comparer", testid: "tab-compare", icon: <CompareArrowsIcon sx={{ fontSize: 20 }} />, label: t("compare.tab") },
  ].filter(Boolean);
  const tabValue = tabs.some((tab) => tab.slug === activeTab) ? activeTab : false;
  const toolbarRef = useRef(null);
  const level = useBarFold(toolbarRef, { active: toolbarInline, resetKey: `${expert}|${tabs.map((tab) => tab.slug).join(",")}|${language}` });
  const fold = foldOf(level);
  // In its own row (narrower screens, or beside a rail) the toolbar has the room: it does not fold.
  const tabIcons = toolbarInline ? roomy && fold.tabIcons : roomy;
  const searchCompact = toolbarInline && (!roomy || fold.searchCompact);
  // Folding the tools pays only with « Expert » on (share alone is one icon either way).
  const toolsInMenu = toolbarInline && expert && fold.toolsInMenu;
  const assistantCompact = toolbarInline ? fold.assistantCompact : !roomy;

  const explorerToolbar = showToolbar && (
    <Box
      ref={toolbarRef}
      data-testid="explorer-toolbar"
      data-placement={toolbarInline ? "header" : "row"}
      data-fold={toolbarInline ? level : undefined}
      sx={toolbarInline ? { flex: 1, minWidth: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1.5, alignSelf: "stretch" } : { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", columnGap: 1.5 }}
    >
      {/* The reader's tabs belong to the reader: out of sight (their place kept) while a draft shows its change. */}
      <Box component="nav" aria-label={t("a11y.networkNav")} aria-hidden={tabsShown ? undefined : "true"} inert={tabsShown ? undefined : ""} sx={{ minWidth: 0, maxWidth: "100%", alignSelf: toolbarInline ? "stretch" : undefined, display: toolbarInline ? "flex" : undefined, visibility: tabsShown ? "visible" : "hidden" }}>
        <StyledTabs
          value={tabValue}
          onChange={(e, slug) => onSelectTab?.(slug)}
          variant="scrollable"
          scrollButtons="auto"
          sx={toolbarInline ? { minHeight: 0, alignSelf: "stretch", "& .MuiTabs-scroller, & .MuiTabs-flexContainer": { height: "100%" }, "& .MuiTab-root": { minHeight: 0, height: "100%", px: fold.tabsTight ? 1 : 1.5, minWidth: 0 } } : undefined}
        >
          {tabs.map((tab) => (
            <Tab key={tab.slug} value={tab.slug} data-testid={tab.testid} icon={tabIcons ? tab.icon : undefined} iconPosition="start" label={tab.label} />
          ))}
        </StyledTabs>
      </Box>
      <Box component="section" display="flex" alignItems="center" gap={toolbarInline ? 1 : 1.5} aria-label={t("explorer.tools")} data-testid="explorer-tools" sx={{ flexShrink: 0 }}>
        {/* Ctrl K opens the command palette always; its button shows with « Expert » on. */}
        {expert && <SearchTrigger compact={searchCompact} bare={toolbarInline && fold.searchBare} />}
        {toolsInMenu ? (
          <MoreTools expert={expert} />
        ) : (
          <>
            {expert && <ProjectMenu />}
            {expert && <TablesBrowserButton />}
            <ShareButton />
          </>
        )}
        {/* In a draft the panel beside the reader is the assistant and the way to modify. */}
        {!draft && <AssistantButton compact={assistantCompact} />}
        {!draft && <ModifyMenu compact={!roomy || (toolbarInline && fold.assistantCompact)} draftInProgress={draftInProgress} />}
        {/* A draft's bar stands where « Modifier » stands; folded, its labels leave the sight, never the screen reader. */}
        {draft && draftSlot && <Box ref={draftSlot} data-testid="draft-slot" data-compact={toolbarInline && fold.draftCompact ? "true" : undefined} sx={{ display: "flex", alignItems: "center", "&[data-compact=true] .draft-fold-label": { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" } }} />}
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
        <Tooltip title={agenciesLoaded ? t("studio.home") : ""}>
          <Box
            component="a"
            href="/"
            aria-label={t("studio.home")}
            onClick={handleLogoClick}
            sx={{ display: "flex", alignItems: "center", flexShrink: 0, height: 44, px: 1, borderRadius: 2, "&:hover": { backgroundColor: theme.palette.action.hover }, "&:focus-visible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 } }}
          >
            <LogoSvg aria-hidden="true" style={{ width: work ? 138 : 178, height: "auto", display: "block", overflow: "visible", color: isDark ? "#ffffff" : "#111111" }} />
          </Box>
        </Tooltip>
        <WorkIdentity work={work} />

        {inline && (
          // The rail's own frame (padding, border, background) is the header's here.
          <Box data-testid="header-rail" data-compact={railCompact ? "true" : undefined} sx={{ flex: railCompact ? "0 0 auto" : 1, minWidth: 0, "& [data-testid=step-nav]": { px: 0, py: 0, borderBottom: "none", background: "transparent" } }}>
            {rail}
          </Box>
        )}
        {toolbarInline && explorerToolbar}
        {!inline && !toolbarInline && <Box sx={{ flex: 1 }} />}
        <Box display="flex" alignItems="center" gap={toolbarInline ? 1 : 1.5} justifyContent="flex-end" sx={toolbarInline ? { flexShrink: 0, pl: 2, borderLeft: `1px solid ${theme.palette.divider}` } : undefined}>
          {agenciesLoaded && !expertInAccount && <ExpertSwitch />}
          {/* Renders nothing while accounts are off. */}
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
