/**
 * AdminDashboard — operator telemetry view, reachable at /#admin.
 *
 * Visual style is intentionally aligned with the GTFS Explorer landing:
 * gradient hero header, chip + title section pattern, soft shadows,
 * staggered fadeUp animations, theme-token-only colors.
 *
 * Performance moves baked in here:
 *   • Tabs are mounted once and toggled with display:none, so the heavy
 *     recharts roots don't re-mount on every tab switch (saves ~250 ms
 *     per switch on a cold tab).
 *   • Tab and card components are React.memo so the 30-second auto-refresh
 *     tick only re-renders what actually changed (the active tab content).
 *   • Tables are MUI-native (no PrimeReact theme CSS, ~32 KB CSS chunk
 *     dropped from the admin route).
 */

import React, {
  useEffect,
  useMemo,
  useState,
  useCallback,
  memo,
} from "react";
import {
  Box,
  Paper,
  Typography,
  Grid,
  Chip,
  Stack,
  IconButton,
  Tooltip,
  Button,
  CircularProgress,
  LinearProgress,
  Tabs,
  Tab,
  Alert,
  Divider,
  TextField,
  InputAdornment,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableSortLabel,
  TableContainer,
  TablePagination,
  Skeleton,
  alpha,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from "@mui/material";
import { useTheme, styled } from "@mui/material/styles";
import { keyframes } from "@mui/system";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
} from "recharts";

import RefreshIcon from "@mui/icons-material/Refresh";
import LogoutIcon from "@mui/icons-material/Logout";
import LightModeIcon from "@mui/icons-material/LightMode";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import GroupsIcon from "@mui/icons-material/Groups";
import HubIcon from "@mui/icons-material/Hub";
import ShieldOutlinedIcon from "@mui/icons-material/ShieldOutlined";
import StorageIcon from "@mui/icons-material/Storage";
import SearchIcon from "@mui/icons-material/Search";
import DownloadIcon from "@mui/icons-material/Download";
import TimelineIcon from "@mui/icons-material/Timeline";
import MemoryIcon from "@mui/icons-material/Memory";
import ScienceIcon from "@mui/icons-material/Science";
import DashboardOutlinedIcon from "@mui/icons-material/DashboardOutlined";
import SpeedIcon from "@mui/icons-material/Speed";
import EventNoteOutlinedIcon from "@mui/icons-material/EventNoteOutlined";
import EditIcon from "@mui/icons-material/Edit";
import BuildIcon from "@mui/icons-material/Build";
import ReportProblemOutlinedIcon from "@mui/icons-material/ReportProblemOutlined";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";

import { useThemeMode } from "../../contexts/ThemeContext";
import {
  fetchStats,
  fetchActiveSessions,
  fetchActiveSessionsDetails,
  clearAdminToken,
  resetStats,
} from "./adminApi";

// Polls /admin/active every 10 s for a real-time session count.
const useLiveSessions = () => {
  const [live, setLive] = React.useState(null); // { activeSessions, maxSessions, ts }
  React.useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await fetchActiveSessions();
        if (!cancelled) setLive(data);
      } catch {
        /* silent — token may not be set yet */
      }
    };
    poll();
    const id = setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return live;
};

// Polls /admin/sessions every 10 s for the per-session details surfaced on the
// Live Sessions tab (agency, validation summary, db size).
const useActiveSessionsDetails = (enabled) => {
  const [data, setData] = React.useState(null); // { sessions, count, maxSessions, ts }
  React.useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await fetchActiveSessionsDetails();
        if (!cancelled) setData(next);
      } catch {
        /* silent */
      }
    };
    poll();
    const id = setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);
  return data;
};

// ── Animations ───────────────────────────────────────────────────────────────

const fadeUp = keyframes`
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
`;

// ── Format helpers ───────────────────────────────────────────────────────────

const fmtNum = (n) =>
  n == null || Number.isNaN(n) ? "—" : Number(n).toLocaleString("en-US");

const fmtKb = (kb) => {
  if (kb == null || Number.isNaN(kb)) return "—";
  if (kb >= 1024 * 1024) return (kb / 1024 / 1024).toFixed(2) + " GB";
  if (kb >= 1024) return (kb / 1024).toFixed(1) + " MB";
  return Math.round(kb) + " KB";
};
const fmtBytes = (b) => fmtKb((Number(b) || 0) / 1024);

const fmtDate = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
};

const fmtDuration = (ms) => {
  if (!ms) return "0 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
};

const fmtUptime = (s) => {
  if (!s) return "0s";
  const days = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

// ── Themed sub-components ────────────────────────────────────────────────────

const StyledTabs = styled(Tabs)(({ theme }) => ({
  "& .MuiTabs-indicator": {
    height: 3,
    borderRadius: "3px 3px 0 0",
    background: theme.palette.primary.main,
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
      backgroundColor: alpha(theme.palette.primary.main, 0.04),
    },
    "&.Mui-selected": {
      color: theme.palette.primary.main,
      fontWeight: 600,
    },
  },
}));

const tipStyle = (theme) => ({
  contentStyle: {
    background:
      theme.palette.mode === "dark" ? "#1e293b" : theme.palette.background.paper,
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 10,
    fontSize: "0.78rem",
    boxShadow:
      theme.palette.mode === "dark"
        ? "0 8px 24px rgba(0,0,0,0.5)"
        : "0 8px 24px rgba(15,23,42,0.08)",
  },
  labelStyle: { color: theme.palette.text.primary, fontWeight: 600 },
  itemStyle: { color: theme.palette.text.secondary },
});

// ── KPI card ─────────────────────────────────────────────────────────────────

const KpiCard = memo(function KpiCard({
  icon,
  label,
  value,
  sub,
  color = "primary",
  index = 0,
}) {
  const theme = useTheme();
  const tone = theme.palette[color]?.main || theme.palette.primary.main;
  const isDark = theme.palette.mode === "dark";
  return (
    <Paper
      elevation={0}
      sx={{
        p: 2.25,
        borderRadius: 3,
        border: `1px solid ${theme.palette.divider}`,
        background: theme.palette.background.paper,
        position: "relative",
        overflow: "hidden",
        animation: `${fadeUp} 0.45s ease-out ${0.04 * index}s both`,
        transition: "transform .2s ease, box-shadow .2s ease, border-color .2s ease",
        "&:hover": {
          transform: "translateY(-3px)",
          boxShadow: isDark
            ? `0 12px 28px rgba(0,0,0,0.45)`
            : `0 12px 28px ${alpha(tone, 0.16)}`,
          borderColor: alpha(tone, 0.4),
        },
      }}
    >
      <Box
        sx={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: `linear-gradient(90deg, ${alpha(tone, 0.4)}, ${tone}, ${alpha(tone, 0.4)})`,
        }}
      />
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ mb: 1 }}
      >
        <Typography
          variant="overline"
          sx={{
            fontSize: ".62rem",
            letterSpacing: ".09em",
            color: "text.secondary",
            fontWeight: 700,
            lineHeight: 1.1,
          }}
        >
          {label}
        </Typography>
        <Box
          sx={{
            width: 32,
            height: 32,
            borderRadius: 1.5,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: alpha(tone, isDark ? 0.18 : 0.1),
            color: tone,
          }}
        >
          {icon}
        </Box>
      </Stack>
      <Typography
        variant="h4"
        sx={{
          fontWeight: 800,
          letterSpacing: "-0.025em",
          fontSize: "1.7rem",
          lineHeight: 1.1,
          color: "text.primary",
        }}
      >
        {value}
      </Typography>
      {sub && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            mt: 0.75,
            display: "block",
            fontSize: "0.7rem",
          }}
        >
          {sub}
        </Typography>
      )}
    </Paper>
  );
});

// ── Section card ─────────────────────────────────────────────────────────────

const SectionCard = memo(function SectionCard({
  title,
  subtitle,
  icon,
  action,
  children,
  pad = 2.5,
}) {
  const theme = useTheme();
  return (
    <Paper
      elevation={0}
      sx={{
        p: pad,
        borderRadius: 3,
        border: `1px solid ${theme.palette.divider}`,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: theme.palette.background.paper,
      }}
    >
      <Stack
        direction="row"
        alignItems={subtitle ? "flex-start" : "center"}
        justifyContent="space-between"
        sx={{ mb: 2 }}
        spacing={1}
      >
        <Stack direction="row" alignItems="center" spacing={1.25}>
          {icon && (
            <Box
              sx={{
                width: 28,
                height: 28,
                borderRadius: 1.25,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: alpha(theme.palette.primary.main, 0.1),
                color: theme.palette.primary.main,
              }}
            >
              {icon}
            </Box>
          )}
          <Box>
            <Typography
              variant="subtitle2"
              fontWeight={700}
              sx={{ color: "text.primary", lineHeight: 1.25 }}
            >
              {title}
            </Typography>
            {subtitle && (
              <Typography
                variant="caption"
                sx={{ color: "text.secondary", display: "block", mt: 0.25 }}
              >
                {subtitle}
              </Typography>
            )}
          </Box>
        </Stack>
        {action}
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0 }}>{children}</Box>
    </Paper>
  );
});

// ── MiniTable: lightweight MUI-native data table (sortable + paginated) ────

function MiniTable({
  columns,
  rows,
  defaultSortKey,
  defaultSortDir = "desc",
  emptyMessage = "No data",
  pageSize = 10,
  rowsPerPageOptions = [10, 25, 50, 100],
  showPagination = true,
}) {
  const theme = useTheme();
  const [orderBy, setOrderBy] = useState(defaultSortKey || null);
  const [order, setOrder] = useState(defaultSortDir);
  const [page, setPage] = useState(0);
  const [rpp, setRpp] = useState(pageSize);

  const handleSort = (key) => {
    if (orderBy === key) {
      setOrder(order === "asc" ? "desc" : "asc");
    } else {
      setOrderBy(key);
      setOrder("desc");
    }
  };

  const sorted = useMemo(() => {
    if (!orderBy) return rows;
    const col = columns.find((c) => c.key === orderBy);
    if (!col) return rows;
    const sortKey = col.sortKey || col.key;
    const arr = [...rows];
    arr.sort((a, b) => {
      const va = typeof sortKey === "function" ? sortKey(a) : a[sortKey];
      const vb = typeof sortKey === "function" ? sortKey(b) : b[sortKey];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return va - vb;
      return String(va).localeCompare(String(vb));
    });
    return order === "desc" ? arr.reverse() : arr;
  }, [rows, columns, orderBy, order]);

  const paged = useMemo(() => {
    if (!showPagination) return sorted;
    const start = page * rpp;
    return sorted.slice(start, start + rpp);
  }, [sorted, page, rpp, showPagination]);

  if (!rows.length) {
    return (
      <Box
        sx={{
          p: 4,
          textAlign: "center",
          color: "text.secondary",
          fontSize: "0.85rem",
        }}
      >
        {emptyMessage}
      </Box>
    );
  }

  return (
    <Box>
      <TableContainer sx={{ overflowX: "auto" }}>
        <Table size="small" sx={{ minWidth: 600 }}>
          <TableHead>
            <TableRow
              sx={{
                "& .MuiTableCell-head": {
                  fontWeight: 700,
                  fontSize: "0.7rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: "text.secondary",
                  borderBottom: `2px solid ${theme.palette.divider}`,
                  background: alpha(theme.palette.text.primary, 0.02),
                  whiteSpace: "nowrap",
                },
              }}
            >
              {columns.map((c) => (
                <TableCell
                  key={c.key}
                  align={c.align || "left"}
                  sx={{ width: c.width, minWidth: c.minWidth }}
                >
                  {c.sortable !== false ? (
                    <TableSortLabel
                      active={orderBy === c.key}
                      direction={orderBy === c.key ? order : "asc"}
                      onClick={() => handleSort(c.key)}
                    >
                      {c.label}
                    </TableSortLabel>
                  ) : (
                    c.label
                  )}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {paged.map((row, i) => (
              <TableRow
                key={row.__key || row.id || row.fingerprint || i}
                sx={{
                  "&:nth-of-type(odd)": {
                    background: alpha(theme.palette.text.primary, 0.015),
                  },
                  "&:hover": {
                    background: alpha(theme.palette.primary.main, 0.05),
                  },
                  "& .MuiTableCell-body": {
                    fontSize: "0.82rem",
                    borderBottomColor: theme.palette.divider,
                  },
                }}
              >
                {columns.map((c) => (
                  <TableCell
                    key={c.key}
                    align={c.align || "left"}
                    sx={{ width: c.width, minWidth: c.minWidth }}
                  >
                    {c.render ? c.render(row) : row[c.key]}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {showPagination && sorted.length > rpp && (
        <TablePagination
          component="div"
          count={sorted.length}
          page={page}
          onPageChange={(_, p) => setPage(p)}
          rowsPerPage={rpp}
          onRowsPerPageChange={(e) => {
            setRpp(parseInt(e.target.value, 10));
            setPage(0);
          }}
          rowsPerPageOptions={rowsPerPageOptions}
          sx={{
            "& .MuiTablePagination-toolbar": { fontSize: "0.78rem" },
            "& .MuiTablePagination-selectLabel, & .MuiTablePagination-displayedRows":
              { fontSize: "0.78rem" },
          }}
        />
      )}
    </Box>
  );
}

// ── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <Box sx={{ p: 3, maxWidth: 1480, mx: "auto" }}>
      <Stack direction="row" spacing={2} sx={{ mb: 3 }}>
        <Skeleton variant="rounded" width={48} height={48} />
        <Box sx={{ flex: 1 }}>
          <Skeleton width={220} height={24} />
          <Skeleton width={300} height={16} />
        </Box>
      </Stack>
      <Grid container spacing={2}>
        {Array.from({ length: 7 }).map((_, i) => (
          <Grid item xs={6} sm={4} md={2} key={i}>
            <Skeleton variant="rounded" height={120} />
          </Grid>
        ))}
        <Grid item xs={12} lg={8}>
          <Skeleton variant="rounded" height={320} />
        </Grid>
        <Grid item xs={12} lg={4}>
          <Skeleton variant="rounded" height={320} />
        </Grid>
      </Grid>
    </Box>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

function AdminDashboard({ onLogout }) {
  const theme = useTheme();
  const { mode, toggleMode, isDark } = useThemeMode();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [tab, setTab] = useState(0);
  const [feedFilter, setFeedFilter] = useState("");
  const liveSessions = useLiveSessions();
  // The Live Sessions tab is index 5 — only poll the heavier /admin/sessions
  // endpoint when that tab is active to avoid background filesystem reads.
  const liveSessionsDetails = useActiveSessionsDetails(tab === 5);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetResult, setResetResult] = useState(null); // { ok, archivedFiles } | null

  const load = useCallback(
    async (fresh = false) => {
      try {
        setRefreshing((prev) => (prev !== undefined ? true : prev));
        const data = await fetchStats(fresh);
        setStats(data);
        setError("");
      } catch (e) {
        if (e.status === 401) {
          clearAdminToken();
          onLogout?.();
          return;
        }
        setError(e.message || "Could not fetch stats.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [onLogout],
  );

  useEffect(() => {
    load();
    // load is stable enough; we only want to fire on mount.
    // eslint-disable-next-line
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => load(true), 30 * 1000);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  const handleLogout = () => {
    clearAdminToken();
    onLogout?.();
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      const result = await resetStats();
      setResetResult(result);
      setResetConfirm(false);
      await load(true);
    } catch (e) {
      setResetResult({ ok: false, error: e.message });
      setResetConfirm(false);
    } finally {
      setResetting(false);
    }
  };

  const filteredFeeds = useMemo(() => {
    if (!stats) return [];
    const q = feedFilter.trim().toLowerCase();
    if (!q) return stats.feeds;
    return stats.feeds.filter(
      (f) =>
        (f.label || "").toLowerCase().includes(q) ||
        (f.ids || "").toLowerCase().includes(q),
    );
  }, [stats, feedFilter]);

  if (loading && !stats) {
    return (
      <Box
        sx={{
          minHeight: "100vh",
          background: theme.palette.background.default,
        }}
      >
        <LoadingSkeleton />
      </Box>
    );
  }

  if (error && !stats) {
    return (
      <Box
        sx={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          p: 3,
          background: theme.palette.background.default,
        }}
      >
        <Paper sx={{ p: 4, maxWidth: 480, borderRadius: 3 }}>
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
          <Stack direction="row" spacing={1}>
            <Button onClick={() => load(true)} variant="contained">
              Retry
            </Button>
            <Button onClick={handleLogout}>Sign out</Button>
          </Stack>
        </Paper>
      </Box>
    );
  }

  if (!stats) return null;

  const k = stats.kpis;

  return (
    <Box
      sx={{
        minHeight: "100vh",
        background: theme.palette.background.default,
        color: theme.palette.text.primary,
      }}
    >
      {/* ── Gradient hero header ───────────────────────────────────────── */}
      <Box
        sx={{
          background: isDark
            ? "linear-gradient(135deg, #0d2137 0%, #1a365d 50%, #0d2137 100%)"
            : "linear-gradient(135deg, #1e3a5f 0%, #1976d2 50%, #1565c0 100%)",
          color: "#fff",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Decorative circles */}
        <Box
          sx={{
            position: "absolute",
            width: 400,
            height: 400,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(255,255,255,0.05) 0%, transparent 70%)",
            top: -180,
            right: -80,
            pointerEvents: "none",
          }}
        />
        <Box
          sx={{
            position: "absolute",
            width: 260,
            height: 260,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(255,255,255,0.04) 0%, transparent 70%)",
            bottom: -120,
            left: -40,
            pointerEvents: "none",
          }}
        />

        <Box
          sx={{
            position: "relative",
            zIndex: 1,
            maxWidth: 1480,
            mx: "auto",
            px: { xs: 2, md: 3 },
            py: { xs: 2.5, md: 3 },
            display: "flex",
            alignItems: "center",
            gap: 2,
            flexWrap: "wrap",
          }}
        >
          <Stack direction="row" alignItems="center" spacing={1.75} sx={{ flex: 1 }}>
            <Box
              sx={{
                width: 44,
                height: 44,
                borderRadius: 2,
                background: "rgba(255,255,255,0.18)",
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 800,
                fontSize: "0.95rem",
                letterSpacing: "0.04em",
                backdropFilter: "blur(6px)",
                border: "1px solid rgba(255,255,255,0.28)",
              }}
            >
              GE
            </Box>
            <Box>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Typography
                  variant="h5"
                  fontWeight={800}
                  sx={{
                    color: "#fff",
                    letterSpacing: "-0.01em",
                    fontSize: { xs: "1.1rem", md: "1.3rem" },
                  }}
                >
                  GTFS Express
                </Typography>
                <Chip
                  label="ADMIN"
                  size="small"
                  sx={{
                    height: 20,
                    fontSize: "0.62rem",
                    fontWeight: 800,
                    letterSpacing: "0.08em",
                    background: "rgba(255,255,255,0.18)",
                    color: "#fff",
                    border: "1px solid rgba(255,255,255,0.28)",
                  }}
                />
              </Stack>
              <Typography
                variant="caption"
                sx={{
                  color: "rgba(255,255,255,0.7)",
                  display: "flex",
                  alignItems: "center",
                  gap: 0.75,
                  mt: 0.25,
                  fontSize: "0.72rem",
                }}
              >
                <Box
                  component="span"
                  sx={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: refreshing ? "#fbbf24" : "#10b981",
                    animation: refreshing
                      ? "pulse 1s ease-in-out infinite"
                      : "none",
                    "@keyframes pulse": {
                      "0%,100%": { opacity: 1 },
                      "50%": { opacity: 0.3 },
                    },
                  }}
                />
                {refreshing
                  ? "Refreshing…"
                  : `Last refresh ${fmtDate(stats.generatedAt)}`}
                {autoRefresh && !refreshing && " · auto every 30 s"}
              </Typography>
            </Box>
          </Stack>

          {/* Live active sessions indicator */}
          {liveSessions != null && (
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                px: 1.25,
                py: 0.5,
                borderRadius: 1.5,
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.18)",
              }}
            >
              <Box
                sx={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  bgcolor:
                    liveSessions.activeSessions > 0
                      ? "#10b981"
                      : "rgba(255,255,255,0.35)",
                  boxShadow:
                    liveSessions.activeSessions > 0
                      ? "0 0 0 0 rgba(16,185,129,0.7)"
                      : "none",
                  animation:
                    liveSessions.activeSessions > 0
                      ? "liveSessionsPulse 2s infinite"
                      : "none",
                  "@keyframes liveSessionsPulse": {
                    "0%": { boxShadow: "0 0 0 0 rgba(16,185,129,0.7)" },
                    "70%": { boxShadow: "0 0 0 8px rgba(16,185,129,0)" },
                    "100%": { boxShadow: "0 0 0 0 rgba(16,185,129,0)" },
                  },
                }}
              />
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 700,
                  color: "#fff",
                  fontSize: "0.78rem",
                  fontVariantNumeric: "tabular-nums",
                  letterSpacing: "0.02em",
                }}
              >
                {liveSessions.activeSessions} / {liveSessions.maxSessions}{" "}
                sessions actives
              </Typography>
            </Box>
          )}

          <Stack direction="row" alignItems="center" spacing={0.75}>
            <Tooltip title={autoRefresh ? "Auto-refresh on" : "Auto-refresh off"}>
              <Chip
                size="small"
                label={autoRefresh ? "AUTO" : "MANUAL"}
                onClick={() => setAutoRefresh((v) => !v)}
                sx={{
                  cursor: "pointer",
                  height: 26,
                  fontSize: "0.66rem",
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  background: autoRefresh
                    ? "rgba(16,185,129,0.22)"
                    : "rgba(255,255,255,0.12)",
                  color: "#fff",
                  border: `1px solid ${autoRefresh ? "rgba(16,185,129,0.5)" : "rgba(255,255,255,0.25)"}`,
                  "&:hover": {
                    background: autoRefresh
                      ? "rgba(16,185,129,0.32)"
                      : "rgba(255,255,255,0.2)",
                  },
                }}
              />
            </Tooltip>
            <HeaderIconButton
              tooltip="Refresh now"
              onClick={() => load(true)}
              disabled={refreshing}
              icon={
                refreshing ? (
                  <CircularProgress size={18} sx={{ color: "#fff" }} />
                ) : (
                  <RefreshIcon fontSize="small" />
                )
              }
            />
            <HeaderIconButton
              tooltip={`Theme: ${mode}`}
              onClick={toggleMode}
              icon={
                isDark ? (
                  <LightModeIcon fontSize="small" />
                ) : (
                  <DarkModeIcon fontSize="small" />
                )
              }
            />
            <HeaderIconButton
              tooltip="Open user app in new tab"
              component="a"
              href={window.location.pathname}
              target="_blank"
              rel="noopener"
              icon={<OpenInNewIcon fontSize="small" />}
            />
            <HeaderIconButton
              tooltip="Reset all telemetry statistics"
              onClick={() => setResetConfirm(true)}
              disabled={resetting}
              icon={<DeleteSweepIcon fontSize="small" />}
              sx={{ color: "rgba(255,120,120,0.85)" }}
            />
            <HeaderIconButton
              tooltip="Sign out"
              onClick={handleLogout}
              icon={<LogoutIcon fontSize="small" />}
            />
          </Stack>
        </Box>
      </Box>

      {refreshing && (
        <LinearProgress
          sx={{
            height: 2,
            "& .MuiLinearProgress-bar": {
              background: theme.palette.primary.main,
            },
          }}
        />
      )}

      <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1480, mx: "auto" }}>
        {/* ── KPI strip ──────────────────────────────────────────────── */}
        <Grid container spacing={2}>
          <Grid item xs={6} sm={4} md={2}>
            <KpiCard
              icon={<CloudUploadIcon fontSize="small" />}
              label="Uploads"
              value={fmtNum(k.totalUploads)}
              sub={`${fmtNum(k.todayUploads)} today · ${fmtNum(k.last7Uploads)} this week`}
              color="primary"
              index={0}
            />
          </Grid>
          <Grid item xs={6} sm={4} md={2}>
            <KpiCard
              icon={<GroupsIcon fontSize="small" />}
              label="Sessions"
              value={
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Box component="span">
                    {fmtNum(
                      liveSessions?.activeSessions ??
                        stats.system?.activeSessions ??
                        k.uniqueSessions,
                    )}
                  </Box>
                  {liveSessions != null && (
                    <Chip
                      label="LIVE"
                      size="small"
                      color="success"
                      sx={{
                        height: 18,
                        fontSize: "0.6rem",
                        fontWeight: 800,
                        letterSpacing: "0.08em",
                      }}
                    />
                  )}
                </Stack>
              }
              sub={
                liveSessions != null
                  ? `${fmtNum(liveSessions.activeSessions)} / ${fmtNum(liveSessions.maxSessions)} active · DAU ${fmtNum(k.dau)} · WAU ${fmtNum(k.wau)}`
                  : `DAU ${fmtNum(k.dau)} · WAU ${fmtNum(k.wau)} · MAU ${fmtNum(k.mau)}`
              }
              color="success"
              index={1}
            />
          </Grid>
          <Grid item xs={6} sm={4} md={2}>
            <KpiCard
              icon={<HubIcon fontSize="small" />}
              label="Distinct feeds"
              value={fmtNum(k.distinctFeeds)}
              sub={`${fmtNum(k.distinctAgencies)} unique agencies`}
              color="secondary"
              index={2}
            />
          </Grid>
          <Grid item xs={6} sm={4} md={2}>
            <KpiCard
              icon={<StorageIcon fontSize="small" />}
              label="Volume processed"
              value={fmtKb(k.totalSizeKb)}
              sub={`avg ${fmtKb(k.avgSizeKb)} per feed`}
              color="warning"
              index={3}
            />
          </Grid>
          <Grid item xs={6} sm={4} md={2}>
            <KpiCard
              icon={<ShieldOutlinedIcon fontSize="small" />}
              label="Validations"
              value={fmtNum(stats.validations.runs)}
              sub={`${fmtNum(stats.validations.errors)} err · ${fmtNum(stats.validations.warnings)} warn`}
              color="error"
              index={4}
            />
          </Grid>
          <Grid item xs={6} sm={4} md={2}>
            <KpiCard
              icon={<DownloadIcon fontSize="small" />}
              label="Exports"
              value={fmtNum(stats.exports.runs)}
              sub={`avg ${fmtDuration(stats.exports.avgDurationMs)} · ${fmtKb(stats.exports.avgSizeKb)}`}
              color="info"
              index={5}
            />
          </Grid>
          <Grid item xs={6} sm={4} md={2}>
            <KpiCard
              icon={<EditIcon fontSize="small" />}
              label="Mutations"
              value={fmtNum(stats.mutations?.total || 0)}
              sub={`${fmtNum(stats.mutations?.byKind?.sql_console || 0)} via Console SQL`}
              color="warning"
              index={6}
            />
          </Grid>
        </Grid>

        {/* ── Tabs ──────────────────────────────────────────────────── */}
        <Paper
          elevation={0}
          sx={{
            mt: 3,
            borderRadius: 2,
            border: `1px solid ${theme.palette.divider}`,
            background: theme.palette.background.paper,
            overflow: "hidden",
          }}
        >
          <StyledTabs
            value={tab}
            onChange={(_, v) => setTab(v)}
            variant="scrollable"
            scrollButtons="auto"
          >
            <Tab
              icon={<DashboardOutlinedIcon sx={{ fontSize: 18 }} />}
              iconPosition="start"
              label="Overview"
            />
            <Tab
              icon={<HubIcon sx={{ fontSize: 18 }} />}
              iconPosition="start"
              label="Feeds & Agencies"
            />
            <Tab
              icon={<TimelineIcon sx={{ fontSize: 18 }} />}
              iconPosition="start"
              label="Users & Funnel"
            />
            <Tab
              icon={<SpeedIcon sx={{ fontSize: 18 }} />}
              iconPosition="start"
              label="System"
            />
            <Tab
              icon={<EventNoteOutlinedIcon sx={{ fontSize: 18 }} />}
              iconPosition="start"
              label="Activity Stream"
            />
            <Tab
              icon={<GroupsIcon sx={{ fontSize: 18 }} />}
              iconPosition="start"
              label="Live Sessions"
            />
          </StyledTabs>
        </Paper>

        {/*
          Tab content is mount-once and toggled with display:none. This avoids
          remounting the recharts roots on every tab switch (was ~250 ms per
          switch on a cold tab).
        */}
        <Box sx={{ mt: 3 }}>
          <TabPanel hidden={tab !== 0}>
            <OverviewTab stats={stats} theme={theme} />
          </TabPanel>
          <TabPanel hidden={tab !== 1}>
            <FeedsTab
              stats={stats}
              filter={feedFilter}
              setFilter={setFeedFilter}
              filtered={filteredFeeds}
            />
          </TabPanel>
          <TabPanel hidden={tab !== 2}>
            <UsersTab stats={stats} theme={theme} />
          </TabPanel>
          <TabPanel hidden={tab !== 3}>
            <SystemTab stats={stats} theme={theme} />
          </TabPanel>
          <TabPanel hidden={tab !== 4}>
            <ActivityTab stats={stats} />
          </TabPanel>
          <TabPanel hidden={tab !== 5}>
            <LiveSessionsTab data={liveSessionsDetails} theme={theme} />
          </TabPanel>
        </Box>

        <Box sx={{ textAlign: "center", py: 4 }}>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            GTFS Express · Admin telemetry · {fmtNum(stats.system.eventsLogged)}{" "}
            events logged
          </Typography>
        </Box>

        {/* ── Reset stats confirmation dialog ───────────────────────── */}
        <Dialog
          open={resetConfirm}
          onClose={() => !resetting && setResetConfirm(false)}
          maxWidth="xs"
          fullWidth
        >
          <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
            <DeleteSweepIcon sx={{ color: "error.main" }} />
            Reset all statistics?
          </DialogTitle>
          <DialogContent>
            <DialogContentText sx={{ fontSize: "0.9rem" }}>
              This will archive <strong>_events.jsonl</strong>,{" "}
              <strong>_upload_stats.jsonl</strong> and{" "}
              <strong>beta/usage.jsonl</strong> with a timestamp suffix, then reset
              all counters to zero. Archives are preserved on disk. The dashboard
              will reload fresh data after reset.
            </DialogContentText>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button
              onClick={() => setResetConfirm(false)}
              color="inherit"
              disabled={resetting}
            >
              Cancel
            </Button>
            <Button
              onClick={handleReset}
              variant="contained"
              color="error"
              disabled={resetting}
              startIcon={
                resetting ? (
                  <CircularProgress size={14} color="inherit" />
                ) : (
                  <DeleteSweepIcon fontSize="small" />
                )
              }
            >
              {resetting ? "Resetting…" : "Reset"}
            </Button>
          </DialogActions>
        </Dialog>

        {/* ── Reset result banner ────────────────────────────────────── */}
        {resetResult && (
          <Box
            sx={{
              position: "fixed",
              bottom: 24,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 2000,
            }}
          >
            <Alert
              severity={resetResult.ok ? "success" : "error"}
              onClose={() => setResetResult(null)}
              sx={{ minWidth: 320, boxShadow: 4 }}
            >
              {resetResult.ok
                ? `Statistics reset. ${resetResult.archivedFiles?.length ?? 0} file(s) archived.`
                : `Reset failed: ${resetResult.error}`}
            </Alert>
          </Box>
        )}
      </Box>
    </Box>
  );
}

// ── Header icon button ───────────────────────────────────────────────────────

function HeaderIconButton({ tooltip, icon, ...rest }) {
  return (
    <Tooltip title={tooltip}>
      <IconButton
        size="small"
        sx={{
          color: "rgba(255,255,255,0.85)",
          background: "rgba(255,255,255,0.06)",
          border: "1px solid rgba(255,255,255,0.18)",
          width: 34,
          height: 34,
          borderRadius: 1.5,
          transition: "all 0.18s ease",
          "&:hover": {
            background: "rgba(255,255,255,0.18)",
            borderColor: "rgba(255,255,255,0.35)",
            color: "#fff",
            transform: "translateY(-1px)",
          },
          "&.Mui-disabled": {
            color: "rgba(255,255,255,0.5)",
            background: "rgba(255,255,255,0.03)",
          },
        }}
        {...rest}
      >
        {icon}
      </IconButton>
    </Tooltip>
  );
}

function TabPanel({ hidden, children }) {
  return (
    <Box
      role="tabpanel"
      sx={{
        display: hidden ? "none" : "block",
        animation: hidden ? "none" : `${fadeUp} 0.35s ease-out`,
      }}
    >
      {children}
    </Box>
  );
}

const LiveSessionsTab = memo(function LiveSessionsTab({ data, theme }) {
  const sessions = (data && Array.isArray(data.sessions) && data.sessions) || [];
  if (!data) {
    return (
      <Paper sx={{ p: 4, textAlign: "center" }}>
        <CircularProgress size={24} />
        <Typography variant="body2" sx={{ mt: 2, color: "text.secondary" }}>
          Chargement des sessions live…
        </Typography>
      </Paper>
    );
  }
  if (sessions.length === 0) {
    return (
      <Paper sx={{ p: 4, textAlign: "center" }}>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          Aucune session active actuellement.
        </Typography>
      </Paper>
    );
  }
  return (
    <Paper sx={{ p: 0, overflow: "hidden" }}>
      <Box
        sx={{
          px: 2,
          py: 1.5,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: `1px solid ${theme.palette.divider}`,
        }}
      >
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {sessions.length} / {data.maxSessions} sessions actives
        </Typography>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          Mise à jour : {new Date(data.ts).toLocaleTimeString()}
        </Typography>
      </Box>
      <TableContainer>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell>Session</TableCell>
              <TableCell>Source</TableCell>
              <TableCell>Créée</TableCell>
              <TableCell>Agence(s)</TableCell>
              <TableCell align="right">Routes</TableCell>
              <TableCell align="right">Stops</TableCell>
              <TableCell align="right">Trips</TableCell>
              <TableCell align="right">Errors</TableCell>
              <TableCell align="right">Warnings</TableCell>
              <TableCell align="right">Notices</TableCell>
              <TableCell align="right">DB&nbsp;(KB)</TableCell>
              <TableCell>Top codes</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sessions.map((s) => {
              const meta = s.meta;
              const validation = meta && meta.validation;
              const topCodes =
                (validation &&
                  Array.isArray(validation.top_codes) &&
                  validation.top_codes) ||
                [];
              const topCodesTooltip = topCodes
                .map((c) => `${c.severity}: ${c.code} ×${c.count}`)
                .join("\n");
              const created = meta && meta.created_at
                ? new Date(meta.created_at).toLocaleString()
                : new Date(s.folder_mtime).toLocaleString();
              return (
                <TableRow key={s.session_id} hover>
                  <TableCell>
                    <Tooltip title={s.session_id}>
                      <Typography
                        variant="caption"
                        sx={{ fontFamily: "monospace" }}
                      >
                        {s.session_id.slice(0, 8)}
                      </Typography>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    {meta ? (
                      <Chip
                        size="small"
                        label={meta.source || "?"}
                        color={meta.source === "sample" ? "info" : "default"}
                        sx={{ height: 20, fontSize: "0.65rem" }}
                      />
                    ) : (
                      <Chip
                        size="small"
                        label="legacy"
                        sx={{ height: 20, fontSize: "0.65rem" }}
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption">{created}</Typography>
                  </TableCell>
                  <TableCell sx={{ maxWidth: 240 }}>
                    {meta && meta.agency ? (
                      <Tooltip title={meta.agency.ids || ""}>
                        <Typography
                          variant="body2"
                          noWrap
                          sx={{ textOverflow: "ellipsis", overflow: "hidden" }}
                        >
                          {meta.agency.names || "—"}
                        </Typography>
                      </Tooltip>
                    ) : (
                      <Typography variant="caption" sx={{ color: "text.secondary" }}>
                        métadonnées indisponibles
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell align="right">
                    {meta && meta.counts ? meta.counts.routes : "—"}
                  </TableCell>
                  <TableCell align="right">
                    {meta && meta.counts ? meta.counts.stops : "—"}
                  </TableCell>
                  <TableCell align="right">
                    {meta && meta.counts ? meta.counts.trips : "—"}
                  </TableCell>
                  <TableCell align="right">
                    {validation ? (
                      <Chip
                        size="small"
                        label={validation.errors_count}
                        sx={{
                          height: 20,
                          fontSize: "0.7rem",
                          bgcolor: alpha(theme.palette.error.main, 0.15),
                          color: theme.palette.error.main,
                        }}
                      />
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell align="right">
                    {validation ? (
                      <Chip
                        size="small"
                        label={validation.warnings_count}
                        sx={{
                          height: 20,
                          fontSize: "0.7rem",
                          bgcolor: alpha(theme.palette.warning.main, 0.15),
                          color: theme.palette.warning.main,
                        }}
                      />
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell align="right">
                    {validation ? (
                      <Chip
                        size="small"
                        label={validation.notices_count}
                        sx={{
                          height: 20,
                          fontSize: "0.7rem",
                          bgcolor: alpha(theme.palette.info.main, 0.15),
                          color: theme.palette.info.main,
                        }}
                      />
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell align="right">
                    {s.has_db ? s.db_size_kb : "—"}
                  </TableCell>
                  <TableCell>
                    {topCodes.length > 0 ? (
                      <Tooltip title={<Box sx={{ whiteSpace: "pre" }}>{topCodesTooltip}</Box>}>
                        <Typography
                          variant="caption"
                          sx={{ color: "text.secondary" }}
                        >
                          {topCodes[0].code} +{topCodes.length - 1}
                        </Typography>
                      </Tooltip>
                    ) : (
                      <Typography variant="caption" sx={{ color: "text.secondary" }}>
                        —
                      </Typography>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Tab: Overview
// ────────────────────────────────────────────────────────────────────────────

const OverviewTab = memo(function OverviewTab({ stats, theme }) {
  const tip = tipStyle(theme);
  const palette = {
    primary: theme.palette.primary.main,
    success: theme.palette.success.main,
    warning: theme.palette.warning.main,
    secondary: theme.palette.secondary.main,
    info: theme.palette.info.main,
  };

  const hourData = useMemo(
    () => stats.hourBuckets.map((c, h) => ({ hour: `${h}h`, count: c })),
    [stats.hourBuckets],
  );

  return (
    <Grid container spacing={2}>
      {/* Trend 30 days */}
      <Grid item xs={12} lg={8}>
        <SectionCard
          title="Activity, last 30 days"
          subtitle="Real uploads, samples, and unique sessions per day."
          icon={<TimelineIcon fontSize="small" />}
        >
          <Box sx={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={stats.trend}
                margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="gUploads" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={palette.primary} stopOpacity={0.5} />
                    <stop
                      offset="100%"
                      stopColor={palette.primary}
                      stopOpacity={0.04}
                    />
                  </linearGradient>
                  <linearGradient id="gSessions" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={palette.success} stopOpacity={0.4} />
                    <stop
                      offset="100%"
                      stopColor={palette.success}
                      stopOpacity={0.04}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={theme.palette.divider} vertical={false} />
                <XAxis
                  dataKey="day"
                  tick={{ fill: theme.palette.text.secondary, fontSize: 11 }}
                  tickFormatter={(v) => v.slice(5)}
                />
                <YAxis
                  tick={{ fill: theme.palette.text.secondary, fontSize: 11 }}
                  allowDecimals={false}
                />
                <RTooltip {...tip} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area
                  type="monotone"
                  dataKey="uploads"
                  stroke={palette.primary}
                  strokeWidth={2}
                  fill="url(#gUploads)"
                  name="Real uploads"
                />
                <Area
                  type="monotone"
                  dataKey="samples"
                  stroke={palette.secondary}
                  strokeWidth={1.5}
                  fillOpacity={0.15}
                  fill={palette.secondary}
                  name="Samples"
                />
                <Area
                  type="monotone"
                  dataKey="sessions"
                  stroke={palette.success}
                  strokeWidth={2}
                  fill="url(#gSessions)"
                  name="Sessions"
                />
              </AreaChart>
            </ResponsiveContainer>
          </Box>
        </SectionCard>
      </Grid>

      {/* Size distribution */}
      <Grid item xs={12} sm={6} lg={4}>
        <SectionCard
          title="Feed size distribution"
          subtitle="How big are the GTFS feeds being uploaded."
        >
          <Box sx={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={stats.sizeBuckets}
                  dataKey="count"
                  nameKey="label"
                  innerRadius={60}
                  outerRadius={95}
                  paddingAngle={2}
                  label={(e) => (e.count > 0 ? `${e.label}: ${e.count}` : "")}
                  labelLine={false}
                >
                  {stats.sizeBuckets.map((b, i) => (
                    <Cell
                      key={b.label}
                      fill={
                        [
                          palette.primary,
                          palette.success,
                          palette.warning,
                          palette.secondary,
                        ][i]
                      }
                    />
                  ))}
                </Pie>
                <RTooltip {...tip} />
              </PieChart>
            </ResponsiveContainer>
          </Box>
        </SectionCard>
      </Grid>

      {/* Cumulative growth */}
      <Grid item xs={12} lg={6}>
        <SectionCard
          title="Cumulative unique sessions"
          subtitle="Distinct session ids seen since day one."
        >
          <Box sx={{ height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={stats.cumulative}
                margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
              >
                <CartesianGrid stroke={theme.palette.divider} vertical={false} />
                <XAxis
                  dataKey="day"
                  tick={{ fill: theme.palette.text.secondary, fontSize: 11 }}
                  tickFormatter={(v) => v.slice(5)}
                />
                <YAxis
                  tick={{ fill: theme.palette.text.secondary, fontSize: 11 }}
                  allowDecimals={false}
                />
                <RTooltip {...tip} />
                <Line
                  type="monotone"
                  dataKey="total"
                  stroke={palette.secondary}
                  strokeWidth={2.5}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </Box>
        </SectionCard>
      </Grid>

      {/* Hour-of-day */}
      <Grid item xs={12} lg={6}>
        <SectionCard
          title="Activity by hour of day"
          subtitle="UTC. Tells you when uploads, validations and SQL queries cluster."
        >
          <Box sx={{ height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={hourData}
                margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
              >
                <CartesianGrid stroke={theme.palette.divider} vertical={false} />
                <XAxis
                  dataKey="hour"
                  tick={{ fill: theme.palette.text.secondary, fontSize: 10 }}
                  interval={1}
                />
                <YAxis
                  tick={{ fill: theme.palette.text.secondary, fontSize: 10 }}
                  allowDecimals={false}
                />
                <RTooltip {...tip} />
                <Bar dataKey="count" fill={palette.info} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Box>
        </SectionCard>
      </Grid>

      {/* Top feeds */}
      <Grid item xs={12} lg={6}>
        <SectionCard
          title={`Top 10 feeds`}
          subtitle={`${stats.feeds.length} distinct feed fingerprints in total.`}
          icon={<HubIcon fontSize="small" />}
        >
          <Box sx={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={stats.feeds.slice(0, 10)}
                layout="vertical"
                margin={{ top: 4, right: 12, left: 8, bottom: 0 }}
              >
                <CartesianGrid
                  stroke={theme.palette.divider}
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  tick={{ fill: theme.palette.text.secondary, fontSize: 10 }}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={140}
                  tick={{ fill: theme.palette.text.secondary, fontSize: 11 }}
                  tickFormatter={(v) =>
                    v?.length > 18 ? v.slice(0, 18) + "…" : v
                  }
                />
                <RTooltip {...tip} />
                <Bar
                  dataKey="uploads"
                  fill={palette.primary}
                  radius={[0, 4, 4, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </Box>
        </SectionCard>
      </Grid>

      {/* Top agencies */}
      <Grid item xs={12} lg={6}>
        <SectionCard
          title={`Top 10 agencies`}
          subtitle={`${stats.agencies.length} unique agencies seen across all feeds.`}
          icon={<GroupsIcon fontSize="small" />}
        >
          <Box sx={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={stats.agencies.slice(0, 10)}
                layout="vertical"
                margin={{ top: 4, right: 12, left: 8, bottom: 0 }}
              >
                <CartesianGrid
                  stroke={theme.palette.divider}
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  tick={{ fill: theme.palette.text.secondary, fontSize: 10 }}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={140}
                  tick={{ fill: theme.palette.text.secondary, fontSize: 11 }}
                  tickFormatter={(v) =>
                    v?.length > 18 ? v.slice(0, 18) + "…" : v
                  }
                />
                <RTooltip {...tip} />
                <Bar
                  dataKey="uploads"
                  fill={palette.success}
                  radius={[0, 4, 4, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </Box>
        </SectionCard>
      </Grid>
    </Grid>
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Tab: Feeds & Agencies
// ────────────────────────────────────────────────────────────────────────────

const FeedsTab = memo(function FeedsTab({
  stats,
  filter,
  setFilter,
  filtered,
}) {
  const theme = useTheme();

  const feedColumns = useMemo(
    () => [
      {
        key: "label",
        label: "Agencies",
        render: (row) => (
          <Tooltip title={row.ids || ""} placement="top-start">
            <Box>
              <Typography
                variant="body2"
                fontWeight={600}
                noWrap
                sx={{ fontSize: "0.84rem" }}
              >
                {row.label || "—"}
              </Typography>
              {row.urls?.length > 0 && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  noWrap
                  sx={{ fontSize: "0.7rem" }}
                >
                  {row.urls[0]}
                </Typography>
              )}
            </Box>
          </Tooltip>
        ),
        minWidth: 220,
      },
      {
        key: "agencyCount",
        label: "Agencies",
        align: "right",
        width: 90,
        render: (row) => fmtNum(row.agencyCount),
      },
      {
        key: "uploads",
        label: "Uploads",
        align: "right",
        width: 110,
        render: (row) => (
          <Chip
            size="small"
            label={fmtNum(row.uploads)}
            sx={{
              fontWeight: 700,
              background: alpha(theme.palette.primary.main, 0.12),
              color: theme.palette.primary.main,
              height: 22,
              fontSize: "0.7rem",
            }}
          />
        ),
      },
      {
        key: "sessions",
        label: "Sessions",
        align: "right",
        width: 100,
        render: (row) => fmtNum(row.sessions),
      },
      {
        key: "lastRoutes",
        label: "Routes",
        align: "right",
        width: 90,
        render: (row) => fmtNum(row.lastRoutes),
      },
      {
        key: "lastStops",
        label: "Stops",
        align: "right",
        width: 90,
        render: (row) => fmtNum(row.lastStops),
      },
      {
        key: "lastTrips",
        label: "Trips",
        align: "right",
        width: 100,
        render: (row) => fmtNum(row.lastTrips),
      },
      {
        key: "lastSize",
        label: "Size",
        align: "right",
        width: 100,
        render: (row) => fmtKb(row.lastSize),
      },
      {
        key: "hasShapes",
        label: "Shapes",
        align: "center",
        width: 80,
        render: (row) =>
          row.hasShapes ? (
            <Chip
              size="small"
              label="✓"
              sx={{
                background: alpha(theme.palette.success.main, 0.15),
                color: theme.palette.success.main,
                height: 22,
                fontWeight: 700,
              }}
            />
          ) : (
            <Box component="span" sx={{ color: "text.disabled" }}>
              —
            </Box>
          ),
      },
      {
        key: "lastSeen",
        label: "Last seen",
        width: 170,
        render: (row) => fmtDate(row.lastSeen),
      },
    ],
    [theme],
  );

  const agencyColumns = useMemo(
    () => [
      { key: "name", label: "Agency", minWidth: 200 },
      {
        key: "url",
        label: "URL",
        minWidth: 220,
        render: (row) =>
          row.url ? (
            <a
              href={row.url}
              target="_blank"
              rel="noreferrer"
              style={{
                color: theme.palette.primary.main,
                textDecoration: "none",
              }}
            >
              {row.url.replace(/^https?:\/\//, "").slice(0, 40)}
            </a>
          ) : (
            <Box component="span" sx={{ color: "text.disabled" }}>
              —
            </Box>
          ),
      },
      {
        key: "uploads",
        label: "Uploads",
        align: "right",
        width: 110,
        render: (row) => fmtNum(row.uploads),
      },
      {
        key: "sessions",
        label: "Sessions",
        align: "right",
        width: 110,
        render: (row) => fmtNum(row.sessions),
      },
      {
        key: "firstSeen",
        label: "First seen",
        width: 170,
        render: (row) => fmtDate(row.firstSeen),
      },
      {
        key: "lastSeen",
        label: "Last seen",
        width: 170,
        render: (row) => fmtDate(row.lastSeen),
      },
    ],
    [theme],
  );

  return (
    <Grid container spacing={2}>
      <Grid item xs={12}>
        <SectionCard
          title={`Feeds (${filtered.length} of ${stats.feeds.length})`}
          subtitle="Click any column header to sort."
          icon={<HubIcon fontSize="small" />}
          action={
            <TextField
              size="small"
              placeholder="Filter feeds…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              }}
              sx={{ width: 240 }}
            />
          }
        >
          <MiniTable
            columns={feedColumns}
            rows={filtered}
            defaultSortKey="uploads"
            defaultSortDir="desc"
            emptyMessage="No feeds match the filter."
          />
        </SectionCard>
      </Grid>

      <Grid item xs={12}>
        <SectionCard
          title={`Agencies (${stats.agencies.length})`}
          subtitle="Aggregated across every feed seen."
          icon={<GroupsIcon fontSize="small" />}
        >
          <MiniTable
            columns={agencyColumns}
            rows={stats.agencies}
            defaultSortKey="uploads"
            defaultSortDir="desc"
            emptyMessage="No agencies yet."
          />
        </SectionCard>
      </Grid>
    </Grid>
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Tab: Users & Funnel
// ────────────────────────────────────────────────────────────────────────────

const UsersTab = memo(function UsersTab({ stats, theme }) {
  const f = stats.funnel;
  const palette = {
    primary: theme.palette.primary.main,
    success: theme.palette.success.main,
    warning: theme.palette.warning.main,
    secondary: theme.palette.secondary.main,
    info: theme.palette.info.main,
  };
  const funnelData = useMemo(
    () => [
      { stage: "Uploaded", count: f.uploaded, color: palette.primary },
      { stage: "Validated", count: f.validated, color: palette.info },
      { stage: "Edited", count: f.edited, color: palette.success },
      { stage: "Used SQL", count: f.usedSql, color: palette.warning },
      { stage: "Exported", count: f.exported, color: palette.secondary },
    ],
    [f, palette.primary, palette.info, palette.success, palette.warning, palette.secondary],
  );
  const pct = (n) => (f.sessions ? Math.round((n / f.sessions) * 100) : 0);

  const max = Math.max(1, ...stats.heatmap.flat());
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const betaColumns = useMemo(
    () => [
      { key: "code", label: "Code", minWidth: 140 },
      {
        key: "count",
        label: "Uses",
        align: "right",
        width: 90,
        render: (r) => fmtNum(r.count),
      },
      {
        key: "lastSeen",
        label: "Last seen",
        width: 180,
        render: (r) => fmtDate(r.lastSeen),
      },
    ],
    [],
  );

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} md={5}>
        <SectionCard
          title="Conversion funnel"
          subtitle="Of all distinct sessions, how many reach each step."
          icon={<TimelineIcon fontSize="small" />}
        >
          <Stack spacing={1.75} sx={{ mt: 1 }}>
            {funnelData.map((s) => {
              const ratio = f.sessions ? s.count / f.sessions : 0;
              return (
                <Box key={s.stage}>
                  <Stack
                    direction="row"
                    justifyContent="space-between"
                    sx={{ mb: 0.5 }}
                  >
                    <Typography
                      variant="body2"
                      fontWeight={500}
                      sx={{ fontSize: "0.82rem" }}
                    >
                      {s.stage}
                    </Typography>
                    <Typography
                      variant="body2"
                      sx={{
                        color: "text.secondary",
                        fontSize: "0.78rem",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {fmtNum(s.count)} ({pct(s.count)}%)
                    </Typography>
                  </Stack>
                  <Box
                    sx={{
                      height: 22,
                      borderRadius: 1.25,
                      background: alpha(theme.palette.text.secondary, 0.08),
                      overflow: "hidden",
                    }}
                  >
                    <Box
                      sx={{
                        height: "100%",
                        width: `${ratio * 100}%`,
                        background: `linear-gradient(90deg, ${alpha(s.color, 0.7)}, ${s.color})`,
                        transition: "width .5s ease",
                      }}
                    />
                  </Box>
                </Box>
              );
            })}
            <Divider sx={{ my: 1 }} />
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                Total tracked sessions
              </Typography>
              <Typography variant="caption" fontWeight={700}>
                {fmtNum(f.sessions)}
              </Typography>
            </Stack>
          </Stack>
        </SectionCard>
      </Grid>

      <Grid item xs={12} md={7}>
        <SectionCard
          title="Activity heatmap"
          subtitle="Day of week × hour of day, in UTC."
        >
          <Box sx={{ overflowX: "auto" }}>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: `40px repeat(24, 1fr)`,
                gap: "3px",
                minWidth: 720,
              }}
            >
              <Box />
              {Array.from({ length: 24 }).map((_, h) => (
                <Box key={h} sx={{ textAlign: "center" }}>
                  <Typography
                    variant="caption"
                    sx={{ fontSize: ".58rem", color: "text.secondary" }}
                  >
                    {h}
                  </Typography>
                </Box>
              ))}
              {dayNames.map((dn, dow) => (
                <React.Fragment key={dn}>
                  <Box sx={{ display: "flex", alignItems: "center" }}>
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                        fontSize: "0.66rem",
                        fontWeight: 600,
                      }}
                    >
                      {dn}
                    </Typography>
                  </Box>
                  {stats.heatmap[dow].map((v, h) => {
                    const ratio = v / max;
                    const bg =
                      v === 0
                        ? alpha(theme.palette.text.secondary, 0.06)
                        : alpha(palette.primary, Math.max(0.14, ratio));
                    return (
                      <Tooltip
                        key={h}
                        title={`${dn} ${String(h).padStart(2, "0")}:00 · ${v} events`}
                      >
                        <Box
                          sx={{
                            aspectRatio: "1 / 1",
                            borderRadius: 0.75,
                            background: bg,
                            cursor: "default",
                            transition: "transform .12s ease",
                            "&:hover": { transform: "scale(1.18)" },
                          }}
                        />
                      </Tooltip>
                    );
                  })}
                </React.Fragment>
              ))}
            </Box>
          </Box>
        </SectionCard>
      </Grid>

      <Grid item xs={12} md={6}>
        <SectionCard
          title="SQL Console usage"
          subtitle="Read-only vs mutation queries."
          icon={<StorageIcon fontSize="small" />}
        >
          <Stack spacing={1.25} sx={{ mt: 0.5 }}>
            <KpiInline
              label="Total queries"
              value={fmtNum(stats.sql.total)}
              color={palette.primary}
            />
            {Object.entries(stats.sql.byKind).map(([k, v]) => (
              <KpiInline
                key={k}
                label={`${k} queries`}
                value={fmtNum(v)}
                color={k === "edit" ? palette.warning : palette.success}
              />
            ))}
          </Stack>
        </SectionCard>
      </Grid>

      <Grid item xs={12} md={6}>
        <SectionCard
          title="Beta program"
          subtitle="Code redemptions for the edit beta."
          icon={<ScienceIcon fontSize="small" />}
        >
          {stats.beta.codes.length === 0 ? (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ p: 2, textAlign: "center" }}
            >
              No beta-code redemptions yet.
            </Typography>
          ) : (
            <MiniTable
              columns={betaColumns}
              rows={stats.beta.codes.map((r, i) => ({ ...r, __key: r.code || i }))}
              defaultSortKey="count"
              defaultSortDir="desc"
              pageSize={5}
              rowsPerPageOptions={[5, 10, 25]}
            />
          )}
        </SectionCard>
      </Grid>

      {/* Mutations — Dialog vs Console SQL */}
      <Grid item xs={12} md={6}>
        <SectionCard
          title="Mutations — Dialog vs Console SQL"
          subtitle={`Total: ${fmtNum(stats.mutations?.total || 0)} mutations · ${fmtNum(stats.mutations?.totalRows || 0)} rows`}
          icon={<EditIcon fontSize="small" />}
        >
          <Box sx={{ mt: 0.5 }}>
            {["dialog", "sql_console"].map((kind) => {
              const count = stats.mutations?.byKind?.[kind] || 0;
              const total = Math.max(stats.mutations?.total || 1, 1);
              const widthPct = Math.round((count / total) * 100);
              const tone =
                kind === "dialog"
                  ? theme.palette.primary.main
                  : theme.palette.warning.main;
              return (
                <Box
                  key={kind}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    mb: 1,
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{
                      width: 110,
                      flexShrink: 0,
                      fontSize: "0.78rem",
                      color: "text.secondary",
                      fontWeight: 600,
                    }}
                  >
                    {kind === "dialog" ? "Dialog" : "Console SQL"}
                  </Typography>
                  <Box
                    sx={{
                      flex: 1,
                      bgcolor: alpha(theme.palette.text.secondary, 0.08),
                      borderRadius: 0.75,
                      overflow: "hidden",
                      height: 18,
                    }}
                  >
                    <Box
                      sx={{
                        width: `${widthPct}%`,
                        minWidth: count > 0 ? 4 : 0,
                        height: "100%",
                        background: `linear-gradient(90deg, ${alpha(tone, 0.7)}, ${tone})`,
                        borderRadius: 0.75,
                        transition: "width .5s ease",
                      }}
                    />
                  </Box>
                  <Typography
                    variant="caption"
                    sx={{
                      width: 56,
                      textAlign: "right",
                      fontSize: "0.78rem",
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 600,
                    }}
                  >
                    {fmtNum(count)}
                  </Typography>
                </Box>
              );
            })}
          </Box>
        </SectionCard>
      </Grid>

      {/* Session engagement (bounce rate + avg duration) */}
      <Grid item xs={12} md={6}>
        <SectionCard
          title="Session engagement"
          subtitle="Bounce rate and average session duration."
          icon={<TimelineIcon fontSize="small" />}
        >
          <Stack direction="row" spacing={4} sx={{ mt: 0.5 }}>
            <Box>
              <Typography
                variant="h4"
                sx={{
                  fontWeight: 800,
                  letterSpacing: "-0.025em",
                  fontSize: "1.7rem",
                  lineHeight: 1.1,
                  color:
                    (stats.funnel?.bounceRate ?? 0) > 60
                      ? theme.palette.error.main
                      : theme.palette.text.primary,
                }}
              >
                {stats.funnel?.bounceRate != null
                  ? `${stats.funnel.bounceRate}%`
                  : "—"}
              </Typography>
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  display: "block",
                  mt: 0.5,
                  fontSize: "0.72rem",
                }}
              >
                Bounce rate
                {stats.funnel?.bouncedSessions != null
                  ? ` · ${fmtNum(stats.funnel.bouncedSessions)} sessions`
                  : ""}
              </Typography>
            </Box>
            <Box>
              <Typography
                variant="h4"
                sx={{
                  fontWeight: 800,
                  letterSpacing: "-0.025em",
                  fontSize: "1.7rem",
                  lineHeight: 1.1,
                  color: "text.primary",
                }}
              >
                {stats.sessions?.avgDurationSec != null
                  ? stats.sessions.avgDurationSec >= 60
                    ? `${Math.round(stats.sessions.avgDurationSec / 60)} min`
                    : `${stats.sessions.avgDurationSec}s`
                  : "—"}
              </Typography>
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  display: "block",
                  mt: 0.5,
                  fontSize: "0.72rem",
                }}
              >
                Average session duration
              </Typography>
            </Box>
          </Stack>
        </SectionCard>
      </Grid>
    </Grid>
  );
});

function KpiInline({ label, value, color }) {
  const theme = useTheme();
  const tone = color || theme.palette.primary.main;
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center">
      <Typography variant="body2" sx={{ color: "text.secondary", fontSize: "0.82rem" }}>
        {label}
      </Typography>
      <Chip
        size="small"
        label={value}
        sx={{
          fontWeight: 700,
          background: alpha(tone, 0.14),
          color: tone,
          height: 24,
          fontSize: "0.74rem",
          fontVariantNumeric: "tabular-nums",
        }}
      />
    </Stack>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Tab: System
// ────────────────────────────────────────────────────────────────────────────

const SystemTab = memo(function SystemTab({ stats, theme }) {
  const sys = stats.system;
  const tip = tipStyle(theme);
  const eventTypes = useMemo(
    () =>
      Object.entries(sys.eventTypes || {})
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count),
    [sys.eventTypes],
  );

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} md={4}>
        <SectionCard
          title="Runtime"
          subtitle="Live process metrics."
          icon={<MemoryIcon fontSize="small" />}
        >
          <Stack spacing={1.25}>
            <Row label="Node" value={sys.nodeVersion} />
            <Row label="Uptime" value={fmtUptime(sys.uptimeSec)} />
            <Row label="RSS memory" value={fmtBytes(sys.memoryRssBytes)} />
            <Row label="Heap used" value={fmtBytes(sys.memoryHeapUsedBytes)} />
            <Row
              label="CPU load (1/5/15 min)"
              value={
                (sys.cpuLoad || []).map((v) => v.toFixed(2)).join(" / ") || "—"
              }
            />
            <Row label="Active sessions" value={fmtNum(sys.activeSessions)} />
            <Row label="Events logged" value={fmtNum(sys.eventsLogged)} />
          </Stack>
        </SectionCard>
      </Grid>

      <Grid item xs={12} md={4}>
        <SectionCard
          title="On-disk storage"
          subtitle="What lives in uploads_data."
          icon={<StorageIcon fontSize="small" />}
        >
          <Stack spacing={1.25}>
            <Row label="Session folders" value={fmtNum(sys.disk.folderCount)} />
            <Row label="Total bytes" value={fmtBytes(sys.disk.totalBytes)} />
            <Row
              label="Largest session"
              value={fmtBytes(sys.disk.largestFolderBytes)}
            />
            <Row label="Edit DBs (gtfs.db)" value={fmtNum(sys.disk.editDbCount)} />
            <Row label="Edit DBs total" value={fmtBytes(sys.disk.editDbBytes)} />
          </Stack>
        </SectionCard>
      </Grid>

      <Grid item xs={12} md={4}>
        <SectionCard
          title="Validation & export"
          subtitle="Aggregates over all runs."
          icon={<ShieldOutlinedIcon fontSize="small" />}
        >
          <Stack spacing={1.25}>
            <Row label="Validation runs" value={fmtNum(stats.validations.runs)} />
            <Row
              label="Total errors found"
              value={fmtNum(stats.validations.errors)}
            />
            <Row label="Total warnings" value={fmtNum(stats.validations.warnings)} />
            <Row
              label="Avg validation time"
              value={fmtDuration(stats.validations.avgDurationMs)}
            />
            <Divider />
            <Row label="Export runs" value={fmtNum(stats.exports.runs)} />
            <Row label="Avg export size" value={fmtKb(stats.exports.avgSizeKb)} />
            <Row
              label="Avg export time"
              value={fmtDuration(stats.exports.avgDurationMs)}
            />
          </Stack>
        </SectionCard>
      </Grid>

      <Grid item xs={12}>
        <SectionCard
          title="Event types breakdown"
          subtitle="What gets recorded into _events.jsonl."
        >
          <Box sx={{ height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={eventTypes}
                layout="vertical"
                margin={{ top: 4, right: 12, left: 8, bottom: 0 }}
              >
                <CartesianGrid
                  stroke={theme.palette.divider}
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  tick={{ fill: theme.palette.text.secondary, fontSize: 11 }}
                />
                <YAxis
                  type="category"
                  dataKey="type"
                  width={170}
                  tick={{ fill: theme.palette.text.secondary, fontSize: 11 }}
                />
                <RTooltip {...tip} />
                <Bar
                  dataKey="count"
                  fill={theme.palette.secondary.main}
                  radius={[0, 4, 4, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </Box>
        </SectionCard>
      </Grid>

      {/* Top validation errors */}
      {stats.topValidationErrors?.length > 0 && (
        <Grid item xs={12} md={6}>
          <SectionCard
            title="Top 10 GTFS validation rules"
            subtitle="Most-frequent failing rules across all validation runs."
            icon={<ReportProblemOutlinedIcon fontSize="small" />}
          >
            <Stack spacing={0.5} sx={{ mt: 0.5 }}>
              {stats.topValidationErrors.map(({ rule, count }) => (
                <Stack
                  key={rule}
                  direction="row"
                  justifyContent="space-between"
                  alignItems="center"
                  sx={{ py: 0.25 }}
                >
                  <Typography
                    variant="caption"
                    sx={{
                      fontFamily: "monospace",
                      fontSize: "0.76rem",
                      color: "text.primary",
                    }}
                  >
                    {rule}
                  </Typography>
                  <Chip
                    size="small"
                    label={fmtNum(count)}
                    sx={{
                      height: 20,
                      fontSize: "0.7rem",
                      fontWeight: 700,
                      background: alpha(theme.palette.error.main, 0.14),
                      color: theme.palette.error.main,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  />
                </Stack>
              ))}
            </Stack>
          </SectionCard>
        </Grid>
      )}

      {/* Quickfixes */}
      {stats.quickfixes?.total > 0 && (
        <Grid item xs={12} md={6}>
          <SectionCard
            title={`Auto-fixes applied — ${fmtNum(stats.quickfixes.total)} total`}
            subtitle="Quickfix corrections grouped by GTFS rule."
            icon={<BuildIcon fontSize="small" />}
          >
            <Stack spacing={0.5} sx={{ mt: 0.5 }}>
              {Object.entries(stats.quickfixes.byRule || {})
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([rule, count]) => (
                  <Stack
                    key={rule}
                    direction="row"
                    justifyContent="space-between"
                    alignItems="center"
                    sx={{ py: 0.25 }}
                  >
                    <Typography
                      variant="caption"
                      sx={{
                        fontFamily: "monospace",
                        fontSize: "0.76rem",
                        color: "text.primary",
                      }}
                    >
                      {rule}
                    </Typography>
                    <Chip
                      size="small"
                      label={fmtNum(count)}
                      sx={{
                        height: 20,
                        fontSize: "0.7rem",
                        fontWeight: 700,
                        background: alpha(theme.palette.success.main, 0.14),
                        color: theme.palette.success.main,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    />
                  </Stack>
                ))}
            </Stack>
          </SectionCard>
        </Grid>
      )}
    </Grid>
  );
});

function Row({ label, value }) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center">
      <Typography
        variant="body2"
        sx={{ color: "text.secondary", fontSize: "0.82rem" }}
      >
        {label}
      </Typography>
      <Typography
        variant="body2"
        fontWeight={600}
        sx={{
          fontVariantNumeric: "tabular-nums",
          fontSize: "0.84rem",
          textAlign: "right",
        }}
      >
        {value}
      </Typography>
    </Stack>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Tab: Activity Stream
// ────────────────────────────────────────────────────────────────────────────

const TYPE_COLORS = {
  upload: "primary",
  "validation.run": "warning",
  "edit.entered": "secondary",
  "edit.exited": "default",
  "export.completed": "success",
  "sql.query": "info",
  "session.created": "info",
  "mutation.applied": "warning",
  "quickfix.applied": "success",
};

const ActivityTab = memo(function ActivityTab({ stats }) {
  const theme = useTheme();
  const [filter, setFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");

  const filtered = useMemo(() => {
    return stats.recent.filter((e) => {
      if (typeFilter && e.type !== typeFilter) return false;
      if (filter) {
        const q = filter.toLowerCase();
        return (
          (e.summary || "").toLowerCase().includes(q) ||
          (e.session || "").toLowerCase().includes(q) ||
          (e.type || "").toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [stats.recent, filter, typeFilter]);

  const types = useMemo(
    () => Array.from(new Set(stats.recent.map((e) => e.type))),
    [stats.recent],
  );

  const columns = useMemo(
    () => [
      {
        key: "ts",
        label: "When",
        width: 180,
        render: (r) => (
          <Typography
            variant="caption"
            sx={{
              fontSize: "0.74rem",
              color: "text.secondary",
              whiteSpace: "nowrap",
            }}
          >
            {fmtDate(r.ts)}
          </Typography>
        ),
      },
      {
        key: "type",
        label: "Type",
        width: 170,
        render: (r) => (
          <Chip
            size="small"
            label={r.type}
            color={TYPE_COLORS[r.type] || "default"}
            sx={{ fontWeight: 600, fontSize: "0.7rem", height: 22 }}
          />
        ),
      },
      {
        key: "session",
        label: "Session",
        width: 110,
        sortable: false,
        render: (r) =>
          r.session ? (
            <Box
              component="code"
              sx={{
                fontSize: ".72rem",
                color: "text.secondary",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {r.session}…
            </Box>
          ) : (
            <Box component="span" sx={{ color: "text.disabled" }}>
              —
            </Box>
          ),
      },
      {
        key: "ip_hash",
        label: "IP hash",
        width: 130,
        sortable: false,
        render: (r) =>
          r.ip_hash ? (
            <Tooltip title="HMAC of source IP, anonymized for privacy">
              <Box
                component="code"
                sx={{
                  fontSize: ".7rem",
                  color: "text.secondary",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {r.ip_hash}
              </Box>
            </Tooltip>
          ) : (
            <Box component="span" sx={{ color: "text.disabled" }}>
              —
            </Box>
          ),
      },
      {
        key: "summary",
        label: "Summary",
        sortable: false,
        render: (r) => (
          <Typography
            variant="caption"
            sx={{ fontSize: "0.78rem", color: "text.primary" }}
          >
            {r.summary}
          </Typography>
        ),
      },
    ],
    [],
  );

  return (
    <SectionCard
      title={`Recent events (${filtered.length} of ${stats.recent.length})`}
      subtitle="Last 100 events. Filter by free text or by event type."
      icon={<EventNoteOutlinedIcon fontSize="small" />}
      action={
        <TextField
          size="small"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
          sx={{ width: 220 }}
        />
      }
    >
      <Stack
        direction="row"
        spacing={0.75}
        flexWrap="wrap"
        useFlexGap
        sx={{ mb: 1.5 }}
      >
        <Chip
          size="small"
          label="All"
          variant={typeFilter === "" ? "filled" : "outlined"}
          color="primary"
          onClick={() => setTypeFilter("")}
          sx={{ fontWeight: 600 }}
        />
        {types.map((tp) => (
          <Chip
            key={tp}
            size="small"
            label={tp}
            variant={typeFilter === tp ? "filled" : "outlined"}
            color={TYPE_COLORS[tp] || "default"}
            onClick={() => setTypeFilter(tp)}
            sx={{ fontWeight: 500 }}
          />
        ))}
      </Stack>
      <MiniTable
        columns={columns}
        rows={filtered.map((r, i) => ({ ...r, __key: `${r.ts}-${i}` }))}
        defaultSortKey="ts"
        defaultSortDir="desc"
        pageSize={20}
        rowsPerPageOptions={[20, 50, 100]}
        emptyMessage="No events match the filter."
      />
    </SectionCard>
  );
});

export default AdminDashboard;
