// The console's frame: the sections on the left (with what waits in each), the period, the search (⌘K), the
// refresh and the operator on top, the screen in the middle. The period and a refresh reach every screen through
// ConsoleContext. Under the md breakpoint (the operator's phone) the sections fold into a drawer opened from the top
// bar, and the search shrinks to its icon: the screen keeps the whole width.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  Avatar,
  Box,
  ButtonBase,
  Divider,
  Drawer,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  alpha,
  useMediaQuery,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import SpaceDashboardOutlinedIcon from "@mui/icons-material/SpaceDashboardOutlined";
import PeopleAltOutlinedIcon from "@mui/icons-material/PeopleAltOutlined";
import WorkspacePremiumOutlinedIcon from "@mui/icons-material/WorkspacePremiumOutlined";
import InsightsOutlinedIcon from "@mui/icons-material/InsightsOutlined";
import TimelineOutlinedIcon from "@mui/icons-material/TimelineOutlined";
import DnsOutlinedIcon from "@mui/icons-material/DnsOutlined";
import SearchIcon from "@mui/icons-material/Search";
import RefreshIcon from "@mui/icons-material/Refresh";
import LightModeOutlinedIcon from "@mui/icons-material/LightModeOutlined";
import DarkModeOutlinedIcon from "@mui/icons-material/DarkModeOutlined";
import LogoutIcon from "@mui/icons-material/Logout";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import MenuIcon from "@mui/icons-material/Menu";
import { useThemeMode } from "../../../contexts/ThemeContext";
import { adminPath, useLocation, useNavigate } from "../../../utils/routes";
import { fetchOverview } from "../adminApi";
import { TABULAR, useAdminQuery } from "./ui";
import { fmtTime } from "./format";
import CommandSearch from "./CommandSearch";

export const SIDEBAR_WIDTH = 236;
export const PERIODS = [
  { days: 1, label: "24h" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
];

const ConsoleContext = createContext(null);
export const useConsole = () => useContext(ConsoleContext);

/**
 * A screen's sub-view and search, kept in the URL (?tab=, ?q=) so that every view has its link and the search
 * (⌘K) can open one: [tab, setTab, q].
 */
export function useConsoleTab(tabs, fallback) {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(search);
  const asked = params.get("tab");
  const tab = tabs.includes(asked) ? asked : fallback;
  const setTab = useCallback(
    (next) => {
      const p = new URLSearchParams();
      if (next !== fallback) p.set("tab", next);
      navigate(`${pathname}${p.toString() ? `?${p}` : ""}`, { replace: true });
    },
    [navigate, pathname, fallback],
  );
  return [tab, setTab, params.get("q") || ""];
}

const SECTIONS = [
  { id: "overview", label: "Overview", icon: SpaceDashboardOutlinedIcon },
  { id: "accounts", label: "Accounts", icon: PeopleAltOutlinedIcon },
  { id: "revenue", label: "Licences & revenue", icon: WorkspacePremiumOutlinedIcon, badge: (a) => count(a, ["quotes_new", "payments_failing", "grants_ending"]) },
  { id: "usage", label: "Consumption", icon: InsightsOutlinedIcon, badge: (a) => count(a, ["allowance_exhausted", "ai_budget"]) },
  { id: "activity", label: "Activity", icon: TimelineOutlinedIcon },
  { id: "operations", label: "Operations", icon: DnsOutlinedIcon, badge: (a) => count(a, ["server_errors", "capacity"]), alert: true },
];
const count = (attention, kinds) => (attention || []).filter((a) => kinds.includes(a.kind)).reduce((n, a) => n + (a.kind === "capacity" || a.kind === "ai_budget" ? 1 : a.count || 0), 0);

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");
const PERIOD_KEY = "gtfs:admin:days";
const readDays = () => {
  try {
    const v = parseInt(localStorage.getItem(PERIOD_KEY), 10);
    return PERIODS.some((p) => p.days === v) ? v : 30;
  } catch {
    return 30;
  }
};

function NavItem({ item, active, badge, onClick }) {
  const theme = useTheme();
  const Icon = item.icon;
  return (
    <ButtonBase
      onClick={onClick}
      data-testid={`admin-nav-${item.id}`}
      aria-current={active ? "page" : undefined}
      sx={{
        width: "100%",
        justifyContent: "flex-start",
        gap: 1.25,
        position: "relative",
        px: 1.25,
        py: { xs: 1.25, md: 0.9 },
        borderRadius: "8px",
        fontSize: 14,
        fontWeight: active ? 600 : 500,
        color: active ? "text.primary" : "text.secondary",
        bgcolor: active ? alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.16 : 0.08) : "transparent",
        "&:hover": { bgcolor: active ? undefined : "action.hover", color: "text.primary" },
        "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}` },
        "&::before": active ? { content: '""', position: "absolute", left: -10, top: 8, bottom: 8, width: 3, borderRadius: 3, bgcolor: "primary.main" } : undefined,
      }}
    >
      <Icon sx={{ fontSize: 19, color: active ? "primary.main" : "inherit" }} />
      <Box component="span" sx={{ flex: 1, textAlign: "left" }}>
        {item.label}
      </Box>
      {badge ? (
        <Box
          component="span"
          sx={{
            minWidth: 20,
            height: 20,
            px: 0.75,
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 700,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: item.alert ? theme.palette.error.contrastText : theme.palette.primary.contrastText,
            bgcolor: item.alert ? "error.main" : "primary.main",
            ...TABULAR,
          }}
        >
          {badge}
        </Box>
      ) : null}
    </ButtonBase>
  );
}

export default function ConsoleShell({ me, section, onSignOut, children }) {
  const theme = useTheme();
  const navigate = useNavigate();
  const { mode, toggleMode } = useThemeMode();
  const [days, setDaysState] = useState(readDays);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshedAt, setRefreshedAt] = useState(new Date());
  const [searchOpen, setSearchOpen] = useState(false);
  const [menu, setMenu] = useState(null);
  const narrow = useMediaQuery(theme.breakpoints.down("md"));
  const [navOpen, setNavOpen] = useState(false);

  const setDays = useCallback((d) => {
    setDaysState(d);
    try {
      localStorage.setItem(PERIOD_KEY, String(d));
    } catch {
      /* the period is remembered when the browser lets it */
    }
  }, []);
  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setRefreshedAt(new Date());
  }, []);
  // A screen, one object of it, and its view (?tab=, ?q=): every place in the console has its URL.
  const go = useCallback(
    (s, objectId = null, params = null) => {
      const q = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString() : "";
      navigate(`${adminPath(s, objectId)}${q ? `?${q}` : ""}`);
    },
    [navigate],
  );

  // What waits for the operator, for the sections' badges (the last 24 hours, every minute).
  const pending = useAdminQuery(() => fetchOverview(1), [refreshKey], { refreshMs: 60_000, enabled: Boolean(me && me.server && me.server.accounts) });
  const attention = useMemo(() => (pending.data ? pending.data.attention : []), [pending.data]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const current = SECTIONS.find((s) => s.id === section) || SECTIONS[0];
  useEffect(() => {
    document.title = `${current.label} — Console — GTFS Express`;
  }, [current.label]);

  const value = useMemo(() => ({ days, setDays, refreshKey, refresh, me, go, attention }), [days, setDays, refreshKey, refresh, me, go, attention]);
  const who = me && me.operator ? me.operator.display_name || me.operator.email : "Admin token";
  const env = me && me.server ? me.server.env : "";

  const sidebar = (
    <>
      <Stack direction="row" spacing={1.25} alignItems="center" sx={{ px: 2.25, height: 60 }}>
        <Box sx={{ width: 28, height: 28, borderRadius: "6px", bgcolor: "primary.main", color: "primary.contrastText", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 12, letterSpacing: "-0.02em" }}>GE</Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontWeight: 700, fontSize: 14, lineHeight: 1.2 }}>GTFS Express</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.2 }}>
            Operator console
          </Typography>
        </Box>
      </Stack>
      <Stack component={narrow ? "nav" : "div"} aria-label={narrow ? "Console sections" : undefined} spacing={0.25} sx={{ px: 1.25, pt: 1, flex: 1, overflowY: "auto" }}>
        {SECTIONS.map((s) => (
          <NavItem
            key={s.id}
            item={s}
            active={s.id === current.id}
            badge={s.badge ? s.badge(attention) : 0}
            onClick={() => {
              setNavOpen(false);
              go(s.id);
            }}
          />
        ))}
      </Stack>
      <Divider />
      <ButtonBase
        onClick={(e) => setMenu(e.currentTarget)}
        data-testid="admin-operator"
        sx={{ px: 2, py: 1.5, justifyContent: "flex-start", gap: 1.25, textAlign: "left", "&:hover": { bgcolor: "action.hover" } }}
      >
        <Avatar sx={{ width: 30, height: 30, fontSize: 13, fontWeight: 700, bgcolor: alpha(theme.palette.primary.main, 0.15), color: "primary.main" }}>{String(who).slice(0, 1).toUpperCase()}</Avatar>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
            {who}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap component="div">
            {me && me.via === "account" ? "Operator account" : "Signed in with the token"}
            {env ? ` · ${env}` : ""}
          </Typography>
        </Box>
      </ButtonBase>
      <Menu anchorEl={menu} open={Boolean(menu)} onClose={() => setMenu(null)} anchorOrigin={{ vertical: "top", horizontal: "left" }} transformOrigin={{ vertical: "bottom", horizontal: "left" }}>
        <MenuItem
          onClick={() => {
            setMenu(null);
            toggleMode();
          }}
        >
          <ListItemIcon>{mode === "dark" ? <LightModeOutlinedIcon fontSize="small" /> : <DarkModeOutlinedIcon fontSize="small" />}</ListItemIcon>
          <ListItemText>{mode === "dark" ? "Light theme" : "Dark theme"}</ListItemText>
        </MenuItem>
        <MenuItem component="a" href="/" target="_blank" rel="noopener" onClick={() => setMenu(null)}>
          <ListItemIcon>
            <OpenInNewIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Open the app</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem
          data-testid="admin-sign-out"
          onClick={() => {
            setMenu(null);
            onSignOut();
          }}
        >
          <ListItemIcon>
            <LogoutIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Sign out</ListItemText>
        </MenuItem>
      </Menu>
    </>
  );

  return (
    <ConsoleContext.Provider value={value}>
      <Box sx={{ display: "flex", minHeight: "100vh", bgcolor: "background.default", color: "text.primary" }} lang="en">
        {narrow ? (
          <Drawer lang="en" open={navOpen} onClose={() => setNavOpen(false)} PaperProps={{ sx: { width: Math.min(SIDEBAR_WIDTH + 44, 320), maxWidth: "85vw", display: "flex", flexDirection: "column" } }} data-testid="admin-nav-drawer">
            {sidebar}
          </Drawer>
        ) : (
          <Box
            component="nav"
            aria-label="Console sections"
            sx={{
              width: SIDEBAR_WIDTH,
              flexShrink: 0,
              borderRight: `1px solid ${theme.palette.divider}`,
              bgcolor: "background.paper",
              position: "sticky",
              top: 0,
              height: "100vh",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {sidebar}
          </Box>
        )}

        <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <Stack
            direction="row"
            alignItems="center"
            spacing={1.5}
            sx={{
              height: { xs: 56, md: 60 },
              px: { xs: 1.5, sm: 2.5, md: 4 },
              position: "sticky",
              top: 0,
              zIndex: 5,
              bgcolor: alpha(theme.palette.background.default, 0.85),
              backdropFilter: "blur(8px)",
              borderBottom: `1px solid ${theme.palette.divider}`,
            }}
          >
            {narrow ? (
              <IconButton onClick={() => setNavOpen(true)} aria-label="Open the sections" data-testid="admin-nav-open" sx={{ ml: -0.5 }}>
                <MenuIcon />
              </IconButton>
            ) : null}
            {narrow ? (
              <Typography noWrap sx={{ fontWeight: 650, fontSize: 15, minWidth: 0, display: { xs: "none", sm: "block" } }}>
                {current.label}
              </Typography>
            ) : null}
            <ButtonBase
              onClick={() => setSearchOpen(true)}
              data-testid="admin-search"
              aria-label="Search accounts, projects, working copies"
              sx={{
                display: { xs: "none", md: "flex" },
                width: { md: 300, lg: 360 },
                height: 36,
                px: 1.5,
                gap: 1,
                justifyContent: "flex-start",
                borderRadius: "8px",
                border: `1px solid ${theme.palette.divider}`,
                bgcolor: "background.paper",
                color: "text.secondary",
                fontSize: 13.5,
                "&:hover": { borderColor: alpha(theme.palette.text.primary, 0.25) },
              }}
            >
              <SearchIcon sx={{ fontSize: 18 }} />
              <Box component="span" sx={{ flex: 1, textAlign: "left" }}>
                Search accounts, projects, working copies
              </Box>
              <Box component="kbd" sx={{ fontFamily: "inherit", fontSize: 11, fontWeight: 600, px: 0.75, py: 0.1, borderRadius: "4px", border: `1px solid ${theme.palette.divider}` }}>
                {IS_MAC ? "⌘K" : "Ctrl K"}
              </Box>
            </ButtonBase>
            <Box sx={{ flex: 1 }} />
            {narrow ? (
              <IconButton size="small" onClick={() => setSearchOpen(true)} aria-label="Search" data-testid="admin-search-icon" sx={{ border: `1px solid ${theme.palette.divider}`, borderRadius: "8px", width: 34, height: 34 }}>
                <SearchIcon fontSize="small" />
              </IconButton>
            ) : null}
            <ToggleButtonGroup
              size="small"
              exclusive
              value={days}
              onChange={(_e, v) => v && setDays(v)}
              aria-label="Period"
              data-testid="admin-period"
              sx={{ flexShrink: 0, "& .MuiToggleButton-root": { px: { xs: 1, sm: 1.4 }, py: 0.45, fontSize: 12.5, fontWeight: 600, textTransform: "none", border: `1px solid ${theme.palette.divider}` } }}
            >
              {PERIODS.map((p) => (
                <ToggleButton key={p.days} value={p.days} data-testid={`admin-period-${p.days}`}>
                  {p.label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            <Tooltip title={`Refresh · updated ${fmtTime(refreshedAt.toISOString())}`}>
              <IconButton size="small" onClick={refresh} aria-label="Refresh" data-testid="admin-refresh" sx={{ border: `1px solid ${theme.palette.divider}`, borderRadius: "8px", width: 34, height: 34 }}>
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
          <Box component="main" sx={{ px: { xs: 2, sm: 3, md: 4 }, py: { xs: 2.5, md: 3.5 }, flex: 1, minWidth: 0, maxWidth: 1600, width: "100%", mx: "auto" }} data-testid={`admin-page-${current.id}`} key={`${current.id}`}>
            {children}
          </Box>
        </Box>
        <CommandSearch open={searchOpen} onClose={() => setSearchOpen(false)} onGo={go} sections={SECTIONS} />
      </Box>
    </ConsoleContext.Provider>
  );
}
