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
import ScheduleIcon from "@mui/icons-material/Schedule";
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
import { useExpertMode } from "../../utils/expertMode";
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
 * « ⋯ »: the secondary tools folded out of a short bar (barFold's third step) — share, and with « Expert » on the
 * tables and the feed's metadata. Kept mounted, so that a dialog or a drawer a row opens outlives the menu.
 */
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
 * Header — the reader's top bar, built from the parts it shares with a
 * project's bar (StudioTopBar, through BarParts), so that both read as one
 * frame: the brand (→ Home), the work's identity — the network's or the
 * project's name and the state of the work (« Réseau source », « Brouillon ·
 * n modifications », « Appliqué en vN ») —, then the « Expert » switch, the
 * account, the language and the theme. The edit controls and the checks are
 * the status bar's (common/StatusBar.js).
 *
 * With a network open, the explorer's toolbar: the network's tabs in a
 * <nav aria-label="Réseau"> — « Vue d'ensemble », « Horaires », « Tracés » in
 * edit mode, and with « Expert » on the SQL console and the comparison —,
 * then the one search (the command palette, ⌘K), the tables and the feed's
 * metadata with « Expert » on, the share button (`share-network`), the
 * assistant by name and « Modifier ▾ » (edit/ModifyMenu). The tabs are
 * routes (/r/:id/apercu, /horaires, /traces, /sql, /comparer): `activeTab`
 * is the current one, `onSelectTab(slug)` navigates; an expert tab reached
 * by its address shows while it is the current one. Inside a project's steps
 * the rail stands where the toolbar is (`toolbar` false); the explorer inside
 * a project (/p/:id/voir/…) shows it again.
 */
/**
 * The brand leads Home. With a network open that means leaving it:
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
 * row, between the brand and the actions — one bar instead of two; narrower, under the header.
 *
 * The explorer's toolbar follows the same rule (the reader's height goes to
 * what it shows): on a wide screen with no rail in the row, the tabs and the tools stand in the header's own row,
 * between the brand and the account, the tabs as tall as the bar. Below "xl" the tabs drop their icons, so that the five
 * of them fit beside the search (in the header's row, or in their own row on one line). Narrower, or beside a project's rail, they keep their row under it.
 */
function Header({ agenciesLoaded, activeTab = false, onSelectTab, toolbar = true, rail = null, work = null, draft = false, tabsShown = true, draftInProgress = null, draftSlot = null }) {
  const { toggleMode, isDark } = useThemeMode();
  const theme = useTheme();
  const { t, language } = useLanguage();
  const handleLogoClick = useBrandHome(agenciesLoaded);
  const { editing } = useEditMode();
  const [expert] = useExpertMode();
  const wide = useMediaQuery(theme.breakpoints.up("lg"));
  const roomy = useMediaQuery(theme.breakpoints.up("xl"));
  const inline = Boolean(rail) && wide;
  const showToolbar = agenciesLoaded && toolbar;
  // One row, « Expert » on or off: the toolbar folds its parts when the room runs short (barFold).
  const toolbarInline = showToolbar && wide && !inline;
  // The header gets crowded below "lg" (below "xl" with the tabs in its row): the account keeps its icon only.
  const compactActions = toolbarInline ? !roomy : !wide;
  // The expert tabs show with « Expert » on, or while one of them is the page shown (reached by its address).
  const expertTab = (slug) => expert || activeTab === slug;

  const tabs = [
    { slug: "apercu", testid: "tab-home", icon: <DashboardOutlinedIcon sx={{ fontSize: 20 }} />, label: t("explorer.overview") },
    { slug: "horaires", testid: "tab-schedules", icon: <ScheduleIcon sx={{ fontSize: 20 }} />, label: t("header.tabSchedules") },
    // Shapes — edit-mode-only geometry editor.
    editing && { slug: "traces", testid: "tab-shape-studio", icon: <EditLocationAltIcon sx={{ fontSize: 20 }} />, label: t("explorer.shapes") },
    expertTab("sql") && { slug: "sql", testid: "tab-sql", icon: <StorageIcon sx={{ fontSize: 20 }} />, label: t("sqlConsole.headerBtn") },
    expertTab("comparer") && { slug: "comparer", testid: "tab-compare", icon: <CompareArrowsIcon sx={{ fontSize: 20 }} />, label: t("compare.tab") },
  ].filter(Boolean);
  const tabValue = tabs.some((tab) => tab.slug === activeTab) ? activeTab : false;
  const toolbarRef = useRef(null);
  const level = useBarFold(toolbarRef, { active: toolbarInline, resetKey: `${expert}|${tabs.map((tab) => tab.slug).join(",")}|${language}` });
  const fold = foldOf(level);
  // In its own row (narrower screens, or beside a rail) the toolbar has the room: only the old rules apply there.
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
        <SearchTrigger compact={searchCompact} bare={toolbarInline && fold.searchBare} />
        {/* The tables and the feed's metadata are the specialist's: shown with « Expert » on; in « ⋯ » on a short bar. */}
        {toolsInMenu ? (
          <MoreTools expert={expert} />
        ) : (
          <>
            {expert && <ProjectMenu />}
            {expert && <TablesBrowserButton />}
            <ShareButton />
          </>
        )}
        {/* The ways to modify the network, on every tab: the assistant by name, then « Modifier ▾ », which keeps its label. */}
        {/* In a draft (the panel « Modifications » beside the reader) the panel is the assistant and the way to modify. */}
        {!draft && <AssistantButton compact={assistantCompact} />}
        {!draft && <ModifyMenu compact={!roomy || (toolbarInline && fold.assistantCompact)} draftInProgress={draftInProgress} />}
        {/* In a draft by hand, its button (the Change Studio's, drawn here) stands where « Modifier » stands. */}
        {draft && draftSlot && <Box ref={draftSlot} data-testid="draft-slot" sx={{ display: "flex", alignItems: "center" }} />}
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
        {/* Brand → Home (through the unsaved-changes guard with a network open) */}
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
          <Box data-testid="header-rail" sx={{ flex: 1, minWidth: 0, "& [data-testid=step-nav]": { px: 0, py: 0, borderBottom: "none", background: "transparent" } }}>
            {rail}
          </Box>
        )}
        {toolbarInline && explorerToolbar}
        {!inline && !toolbarInline && <Box sx={{ flex: 1 }} />}
        <Box display="flex" alignItems="center" gap={toolbarInline ? 1 : 1.5} justifyContent="flex-end" sx={toolbarInline ? { flexShrink: 0, pl: 2, borderLeft: `1px solid ${theme.palette.divider}` } : undefined}>
          {/* « Expert » once a network is open: the specialist's tools. */}
          {agenciesLoaded && <ExpertSwitch />}
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
