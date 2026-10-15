/**
 * HomeDashboard — the reader's overview (« Vue d'ensemble »), the first screen of a network loaded or of the demo.
 *
 * A business application's page, everything at a glance and fitted to the screen: few frames, no card inside a
 * card, hairlines between the sections, numbers in the text's own colour and the accents kept for the states that
 * need them. On a desktop the page is one screen —
 *
 *   header      the network's name and its period — modifying is the toolbar's « Modifier » on every tab
 *               (edit/ModifyMenu), which joins the network's draft when one exists;
 *   figures     one strip of six numbers (what the feed holds);
 *   map         the network as a picture (ShapesMap `interactive` false), the height left: exploring it is the
 *               « Horaires & Carte » tab's, one click away;
 *   side panel  three sections under one frame: what the validator says (its verdict, its counts, its most frequent
 *               rules), the Diagnostic (QualityAuditPanel dense: a row per finding, its list scrolling inside), and
 *               the lines (each opening its timetable).
 *
 * The validator's verdict is never « not run » beside a Diagnostic that read the same feed: GTFSApp runs the
 * validator by itself when a network opens without a report; meanwhile the section says the validation is under
 * way; only a server without the validator, or a run that failed (with its retry), says otherwise. On a phone, or
 * with the report of a network built here on top (NetworkReportCard), the sections stand one under the other and
 * the page scrolls.
 */

import React, { useEffect, useState, useMemo } from "react";
import CircularProgress from "@mui/material/CircularProgress";
import { Box, Paper, Button, ButtonBase, Typography, Skeleton, Fade, useTheme, alpha, Tooltip, useMediaQuery } from "@mui/material";
import { keyframes } from "@mui/system";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import VerifiedIcon from "@mui/icons-material/Verified";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import EventIcon from "@mui/icons-material/Event";
import RouteOutlinedIcon from "@mui/icons-material/RouteOutlined";
import PlaceOutlinedIcon from "@mui/icons-material/PlaceOutlined";
import DirectionsBusOutlinedIcon from "@mui/icons-material/DirectionsBusOutlined";
import PolylineOutlinedIcon from "@mui/icons-material/PolylineOutlined";
import ApartmentOutlinedIcon from "@mui/icons-material/ApartmentOutlined";
import DateRangeOutlinedIcon from "@mui/icons-material/DateRangeOutlined";
import CloudOffOutlinedIcon from "@mui/icons-material/CloudOffOutlined";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import TaskAltIcon from "@mui/icons-material/TaskAlt";
import ShapesMap from "./ShapesMap";
import { fetchWithSession } from "../utils/sessionManager";
import { useEditMode } from "../contexts/EditModeContext";
import { useLanguage } from "../contexts/LanguageContext";
import API_BASE_URL from "../config";
import { getRuleTitle } from "./validation/ruleCatalog";
import { summarizeReport, topRules } from "../utils/validationSummary";
import { sortRoutesByPublisherOrder } from "../utils/routeSort";
import QualityAuditPanel from "./validation/QualityAuditPanel";
import NetworkReportCard from "./network/NetworkReportCard";

const fadeUp = keyframes`
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
`;

// One frame, the same everywhere on the page: the paper, a hairline, a soft radius (rule #19: the theme's colours).
const frameSx = (theme) => ({
  backgroundColor: theme.palette.background.paper,
  border: `1px solid ${theme.palette.divider}`,
  borderRadius: "12px",
});

// A section of the side panel: its title in small capitals, its content under it.
function Section({ title, aside = null, testid, children, sx = {} }) {
  return (
    <Box
      component="section"
      aria-label={title}
      data-testid={testid}
      sx={{
        px: 2,
        py: 1.5,
        display: "flex",
        flexDirection: "column",
        gap: 1,
        minHeight: 0,
        ...sx,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, minHeight: 24 }}>
        <Typography
          component="h2"
          sx={{
            flex: 1,
            minWidth: 0,
            fontSize: "0.72rem",
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "text.secondary",
          }}
        >
          {title}
        </Typography>
        {aside}
      </Box>
      {children}
    </Box>
  );
}

/* ────────── what the validator says ────────── */

// The verdict, its counts and its most frequent rules — a rule leads to the report; running, unavailable here, or a
// run that failed (with its retry) are said in the same place.
function ValidationSection({ report, validation, importAdjustmentsTotal, onReport }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { showToast } = useEditMode();
  const [retrying, setRetrying] = useState(false);
  // Whether a run was seen: before the first one the section says it is coming, never that it failed.
  const [ran, setRan] = useState(false);
  const running = Boolean(validation?.running) || retrying;
  useEffect(() => {
    if (running) setRan(true);
  }, [running]);
  const summary = useMemo(() => summarizeReport(report), [report]);
  const rules = useMemo(() => [...topRules(summary, "error", 3), ...topRules(summary, "warning", 3)].slice(0, 3), [summary]);

  const retry = async () => {
    setRetrying(true);
    try {
      const startedAt = Date.now();
      const res = await fetchWithSession(`${API_BASE_URL}/edit/validate`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(body.error || t("home.validateFailed"), "error");
        return;
      }
      window.dispatchEvent(
        new CustomEvent("gtfs:validation-refreshed", {
          detail: { report: body, startedAt },
        }),
      );
    } catch (err) {
      showToast(err.message || t("home.validateFailed"), "error");
    } finally {
      setRetrying(false);
    }
  };

  const status = (testid, icon, text, detail = null, action = null) => (
    <Box data-testid={testid} sx={{ display: "flex", alignItems: "center", gap: 1.25, minWidth: 0 }}>
      {icon}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontSize: "0.9rem", fontWeight: 700, lineHeight: 1.3 }}>{text}</Typography>
        {detail && (
          <Typography
            sx={{
              fontSize: "0.76rem",
              color: "text.secondary",
              lineHeight: 1.4,
            }}
          >
            {detail}
          </Typography>
        )}
      </Box>
      {action}
    </Box>
  );
  const round = (Icon, color) => (
    <Box
      sx={{
        width: 32,
        height: 32,
        borderRadius: "50%",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color,
        backgroundColor: alpha(color, theme.palette.mode === "dark" ? 0.2 : 0.1),
      }}
    >
      <Icon sx={{ fontSize: 18 }} />
    </Box>
  );

  let body;
  if (summary.validated) {
    const ok = summary.errors === 0;
    // Nothing to count: the verdict alone, in one line.
    const clean = ok && summary.warnings === 0;
    const tone = ok ? theme.palette.success.main : theme.palette.error.main;
    body = (
      <Box data-testid={clean ? "dashboard-conformant" : "dashboard-validation-card"} sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
        {status(
          ok ? "dashboard-verdict-ok" : "dashboard-verdict-errors",
          round(ok ? VerifiedIcon : ErrorOutlineIcon, tone),
          ok ? t("home.feedConformant") : t("home.errorsTitle"),
          clean ? `${t("home.noErrors")} · ${t("home.noWarnings")}` : null,
        )}
        {!clean && (
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: 1,
            }}
          >
            {[
              {
                testid: "dashboard-errors",
                n: summary.errors,
                label: t("home.validation.errors"),
                color: summary.errors ? theme.palette.error.main : "text.primary",
              },
              {
                testid: "dashboard-warnings",
                n: summary.warnings,
                label: t("home.validation.warnings"),
                color: summary.warnings ? theme.palette.warning.main : "text.primary",
              },
            ].map((c) => (
              <Box
                key={c.testid}
                data-testid={c.testid}
                sx={{
                  px: 1.25,
                  py: 0.9,
                  borderRadius: "10px",
                  backgroundColor: theme.palette.action.hover,
                }}
              >
                <Typography
                  sx={{
                    fontSize: "1.25rem",
                    fontWeight: 700,
                    lineHeight: 1.15,
                    color: c.color,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {c.n.toLocaleString()}
                </Typography>
                <Typography sx={{ fontSize: "0.74rem", color: "text.secondary" }}>{c.label}</Typography>
              </Box>
            ))}
          </Box>
        )}
        {rules.length > 0 && (
          <Box sx={{ display: "flex", flexDirection: "column", mx: -0.75 }}>
            {rules.map((r) => (
              <Tooltip key={`${r.severity}|${r.code}`} title={r.code} placement="left" arrow>
                <ButtonBase
                  onClick={() => onReport(r.code)}
                  data-testid="dashboard-rule"
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    px: 0.75,
                    py: 0.6,
                    borderRadius: "8px",
                    textAlign: "left",
                    "&:hover": { backgroundColor: theme.palette.action.hover },
                  }}
                >
                  <Box
                    sx={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      flexShrink: 0,
                      backgroundColor: r.severity === "error" ? theme.palette.error.main : theme.palette.warning.main,
                    }}
                  />
                  <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: "0.8rem" }}>
                    {getRuleTitle(r.code)}
                  </Typography>
                  <Typography
                    sx={{
                      fontSize: "0.76rem",
                      color: "text.secondary",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {r.count.toLocaleString()}
                  </Typography>
                </ButtonBase>
              </Tooltip>
            ))}
          </Box>
        )}
      </Box>
    );
  } else if (validation?.unavailable) {
    body = status("dashboard-validator-off", round(CloudOffOutlinedIcon, theme.palette.text.secondary), t("home.validatorOffTitle"), t("home.validatorOffBody"));
  } else if (running || !ran) {
    body = status(
      "dashboard-validating",
      <Box
        sx={{
          width: 32,
          height: 32,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <CircularProgress size={22} thickness={5} />
      </Box>,
      t("home.validating"),
      `${t("uploader.phase.validating")}${validation?.seconds ? ` · ${t("uploader.phase.elapsed", { seconds: validation.seconds })}` : ""}`,
    );
  } else {
    body = status(
      "dashboard-not-validated",
      round(ErrorOutlineIcon, theme.palette.warning.main),
      t("home.validateFailed"),
      t("home.validationFailedBody"),
      <Button size="small" onClick={retry} startIcon={<ReplayRoundedIcon sx={{ fontSize: 16 }} />} sx={{ textTransform: "none", fontWeight: 700, flexShrink: 0 }}>
        {t("home.validateNow")}
      </Button>,
    );
  }

  return (
    <Section
      title={t("home.validation.title")}
      testid="dashboard-validation"
      sx={{ flexShrink: 0 }}
      aside={
        summary.validated && (summary.errors > 0 || summary.warnings > 0) ? (
          <Button
            size="small"
            onClick={() => onReport()}
            endIcon={<ArrowForwardIcon sx={{ fontSize: 14 }} />}
            data-testid="dashboard-view-report"
            sx={{
              textTransform: "none",
              fontWeight: 700,
              fontSize: "0.76rem",
              py: 0,
              minHeight: 24,
            }}
          >
            {t("home.viewReport")}
          </Button>
        ) : null
      }
    >
      <Box data-testid="dashboard-validation-health">{body}</Box>
      {importAdjustmentsTotal > 0 && (
        <ButtonBase
          onClick={() => onReport()}
          data-testid="dashboard-import-adjustments"
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.75,
            justifyContent: "flex-start",
            textAlign: "left",
            fontSize: "0.76rem",
            color: "text.secondary",
            borderRadius: "8px",
            px: 0.75,
            py: 0.5,
            mx: -0.75,
            "&:hover": { backgroundColor: theme.palette.action.hover },
          }}
        >
          <TaskAltIcon sx={{ fontSize: 16, color: theme.palette.success.main }} />
          {t("validation.autoFixed.persist", { count: importAdjustmentsTotal })}
        </ButtonBase>
      )}
    </Section>
  );
}

/* ────────── the lines ────────── */

const hexOf = (value, fallback) => {
  const v = String(value || "")
    .replace(/^#/, "")
    .trim();
  return /^[0-9a-f]{6}$/i.test(v) ? `#${v}` : fallback;
};

// The network's lines in the publisher's order: a badge in the line's colours and its name; a line opens its
// timetable and its map (the reader's tab).
function LinesSection({ routes, onOpen }) {
  const theme = useTheme();
  const { t } = useLanguage();
  return (
    <Section title={`${t("home.routes")} · ${routes.length.toLocaleString()}`} testid="dashboard-lines-section" sx={{ flex: "1 1 0", minHeight: 120 }}>
      <Box component="nav" aria-label={t("home.routes")} data-testid="dashboard-lines" sx={{ flex: 1, minHeight: 0, overflowY: "auto", mx: -1, px: 0.25 }}>
        {routes.map((r) => {
          const short = String(r.route_short_name || "").trim();
          const long = String(r.route_long_name || "").trim();
          const badge = short || long || String(r.route_id);
          const bg = hexOf(r.route_color, theme.palette.routeFallback);
          const fg = hexOf(r.route_text_color, theme.palette.getContrastText(bg));
          return (
            <ButtonBase
              key={`${r.agencyKey}|${r.route_id}`}
              onClick={() => onOpen(r)}
              data-testid="dashboard-line"
              aria-label={[short, long].filter(Boolean).join(" ") || badge}
              sx={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 1.25,
                px: 0.75,
                py: 0.55,
                borderRadius: "8px",
                textAlign: "left",
                "&:hover": { backgroundColor: theme.palette.action.hover },
                "&.Mui-focusVisible": {
                  outline: `2px solid ${theme.palette.primary.main}`,
                  outlineOffset: -2,
                },
              }}
            >
              <Box
                component="span"
                sx={{
                  minWidth: 38,
                  maxWidth: 96,
                  height: 22,
                  px: 0.75,
                  borderRadius: "6px",
                  flexShrink: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: bg,
                  color: fg,
                  fontSize: "0.74rem",
                  fontWeight: 800,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  boxShadow: `inset 0 0 0 1px ${alpha("#000", 0.08)}`,
                }}
              >
                {badge}
              </Box>
              <Typography
                noWrap
                sx={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: "0.8rem",
                  color: short && long ? "text.primary" : "text.secondary",
                }}
              >
                {short && long ? long : ""}
              </Typography>
            </ButtonBase>
          );
        })}
      </Box>
    </Section>
  );
}

/* ────────── main component ────────── */

function HomeDashboard({
  validationReport,
  // { table: droppedCount } from the tolerant import: duplicate rows removed
  // automatically. Announced here so a clean-after-import feed is not a
  // dead end.
  importAdjustments = null,
  onNavigateToValidation,
  onNavigateToSchedule,
  // The report of a network built here (network/NetworkReportCard): at the
  // head of the overview until "Explore" folds it.
  networkReport = null,
  onDismissReport = null,
  onRefineReport = null,
  // The network's agencies (GTFSApp's): their lines make the side panel's last section.
  agencies = [],
  // The validator's run, from GTFSApp: { running, seconds, unavailable }.
  validation = null,
}) {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const { dataVersion } = useEditMode();
  // One screen on a desktop; one column that scrolls on a phone or under the report of a network built here.
  const desktop = useMediaQuery(theme.breakpoints.up("md"));
  const fit = desktop && !networkReport;

  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [routes, setRoutes] = useState([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 40);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setStatsLoading(true);
      try {
        const res = await fetchWithSession(`${API_BASE_URL}/statistics`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled && data) setStats(data);
      } catch (err) {
        console.error("HomeDashboard: statistics fetch failed", err);
      } finally {
        if (!cancelled) setStatsLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  // Every agency's lines, in the publisher's order (the agency kept to open a line in its timetable).
  const agencyIds = useMemo(() => (Array.isArray(agencies) ? agencies.map((a) => a?.agency_id || "default_agency_id") : []), [agencies]);
  const agencyKey = agencyIds.join("|");
  useEffect(() => {
    if (!agencyIds.length) return undefined;
    let cancelled = false;
    Promise.all(
      agencyIds.map((id) =>
        fetchWithSession(`${API_BASE_URL}/routes/${encodeURIComponent(id)}`)
          .then((r) => (r.ok ? r.json() : []))
          .then((list) => (Array.isArray(list) ? list.map((route) => ({ ...route, agencyKey: id })) : []))
          .catch(() => []),
      ),
    ).then((lists) => {
      if (!cancelled) setRoutes(sortRoutesByPublisherOrder(lists.flat()));
    });
    return () => {
      cancelled = true;
    };
    // agencyKey stands for agencyIds (a new array each render of the parent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agencyKey, dataVersion]);

  const calendarCoverage = useMemo(() => {
    if (!stats?.calendarPeriod) return null;
    const { startDate, endDate } = stats.calendarPeriod;
    if (!startDate || !endDate) return null;
    const format = (d) =>
      new Date(d).toLocaleDateString(language, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    return { from: format(startDate), to: format(endDate) };
  }, [stats, language]);

  // The period's length, its number and its unit apart (the strip writes the unit smaller).
  const calendarShort = useMemo(() => {
    if (!stats?.calendarPeriod) return null;
    const { startDate, endDate } = stats.calendarPeriod;
    if (!startDate || !endDate) return null;
    const days = Math.max(1, Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000));
    if (days < 60) return { n: String(days), unit: t("home.days") };
    const months = Math.round(days / 30);
    if (months < 18) return { n: String(months), unit: t("home.months") };
    return {
      n: (days / 365).toFixed(1).replace(".0", ""),
      unit: t("home.years"),
    };
  }, [stats, t]);

  const importAdjustmentsTotal = useMemo(() => Object.values(importAdjustments || {}).reduce((acc, n) => acc + (Number(n) || 0), 0), [importAdjustments]);
  const toReport = (ruleCode) => onNavigateToValidation && onNavigateToValidation(ruleCode);
  const openLine = (route) =>
    window.dispatchEvent(
      new CustomEvent("gtfs:navigate", {
        detail: {
          target: "schedule",
          routeId: route.route_id,
          agencyId: route.agencyKey,
        },
      }),
    );
  const name = stats?.agencyNames?.[0] || null;

  const figures = [
    {
      key: "routes",
      label: t("home.routes"),
      value: stats?.totalRoutes,
      icon: RouteOutlinedIcon,
    },
    {
      key: "stops",
      label: t("home.stops"),
      value: stats?.totalStops,
      icon: PlaceOutlinedIcon,
    },
    {
      key: "trips",
      label: t("home.trips"),
      value: stats?.totalTrips,
      icon: DirectionsBusOutlinedIcon,
    },
    {
      key: "shapes",
      label: t("home.shapes"),
      value: stats?.totalShapes,
      icon: PolylineOutlinedIcon,
    },
    {
      key: "agencies",
      label: t("home.agencies"),
      value: stats?.totalAgencies,
      icon: ApartmentOutlinedIcon,
    },
    {
      key: "period",
      label: t("home.period"),
      value: calendarShort,
      icon: DateRangeOutlinedIcon,
    },
  ];

  return (
    <Fade in={mounted} timeout={250}>
      <Box
        sx={{
          backgroundColor: theme.palette.background.default,
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflowY: fit ? "hidden" : "auto",
        }}
      >
        <Box
          data-testid="dashboard"
          data-layout={fit ? "fit" : "flow"}
          sx={{
            width: "100%",
            maxWidth: 1680,
            mx: "auto",
            boxSizing: "border-box",
            px: { xs: 2, md: 3 },
            pt: { xs: 2, md: 2.25 },
            pb: { xs: 4, md: 2 },
            display: "flex",
            flexDirection: "column",
            gap: { xs: 2, md: 1.75 },
            ...(fit ? { flex: 1, minHeight: 0 } : {}),
          }}
        >
          <NetworkReportCard report={networkReport} open={Boolean(networkReport)} onClose={onDismissReport} onRefine={onRefineReport} />

          {/* ─── HEADER: the network, its period; the page's action ─── */}
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              columnGap: 3,
              rowGap: 1.25,
              flexShrink: 0,
              animation: `${fadeUp} 0.3s ease-out both`,
            }}
          >
            <Box sx={{ flex: "1 1 320px", minWidth: 0 }}>
              <Typography
                variant="h3"
                component="h1"
                sx={{
                  fontSize: { xs: "1.35rem", md: "1.6rem" },
                  fontWeight: 750,
                  letterSpacing: "-0.02em",
                  lineHeight: 1.2,
                }}
              >
                {name || t("home.heroTitle")}
              </Typography>
              {calendarCoverage && (
                <Typography
                  data-testid="dashboard-period"
                  sx={{
                    mt: 0.4,
                    display: "flex",
                    alignItems: "center",
                    gap: 0.75,
                    fontSize: "0.82rem",
                    color: "text.secondary",
                  }}
                >
                  <EventIcon sx={{ fontSize: 15 }} />
                  {t("home.period")} · {calendarCoverage.from} → {calendarCoverage.to}
                </Typography>
              )}
            </Box>
          </Box>

          {/* ─── FIGURES: what the feed holds, one strip ─── */}
          <Box
            component="section"
            aria-label={t("home.inventoryTitle")}
            data-testid="dashboard-inventory"
            sx={{
              ...frameSx(theme),
              flexShrink: 0,
              display: "grid",
              gridTemplateColumns: {
                xs: "repeat(2, minmax(0, 1fr))",
                sm: "repeat(3, minmax(0, 1fr))",
                md: "repeat(6, minmax(0, 1fr))",
              },
              "& > *": { px: 2.25, py: 1.4, minWidth: 0 },
              "& > * + *": {
                borderLeft: { md: `1px solid ${theme.palette.divider}` },
              },
              animation: `${fadeUp} 0.3s ease-out 0.05s both`,
            }}
          >
            {figures.map(({ icon: Icon, ...f }) => (
              <Box key={f.key} data-testid={`dashboard-figure-${f.key}`} sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
                <Box
                  aria-hidden
                  sx={{
                    width: 36,
                    height: 36,
                    flexShrink: 0,
                    borderRadius: "10px",
                    display: { xs: "none", lg: "flex" },
                    alignItems: "center",
                    justifyContent: "center",
                    color: theme.palette.primary.main,
                    backgroundColor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.18 : 0.08),
                  }}
                >
                  <Icon sx={{ fontSize: 19 }} />
                </Box>
                <Box sx={{ minWidth: 0 }}>
                  {statsLoading && !stats ? (
                    <Skeleton width="55%" height={30} />
                  ) : (
                    <Typography
                      noWrap
                      sx={{
                        fontSize: "1.45rem",
                        fontWeight: 700,
                        letterSpacing: "-0.02em",
                        lineHeight: 1.2,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {f.value && typeof f.value === "object" ? (
                        <>
                          {f.value.n}{" "}
                          <Box
                            component="span"
                            sx={{
                              fontSize: "0.85rem",
                              fontWeight: 600,
                              letterSpacing: 0,
                            }}
                          >
                            {f.value.unit}
                          </Box>
                        </>
                      ) : f.value != null ? (
                        Number(f.value).toLocaleString(language)
                      ) : (
                        "—"
                      )}
                    </Typography>
                  )}
                  <Typography
                    noWrap
                    title={f.label}
                    sx={{
                      fontSize: "0.76rem",
                      color: "text.secondary",
                      mt: 0.25,
                    }}
                  >
                    {f.label}
                  </Typography>
                </Box>
              </Box>
            ))}
          </Box>

          {/* ─── BODY: the network's picture, and the side panel ─── */}
          <Box
            sx={{
              display: { xs: "flex", md: "grid" },
              flexDirection: "column",
              gridTemplateColumns: {
                md: "minmax(0, 1fr) clamp(340px, 27vw, 420px)",
              },
              gridTemplateRows: { md: "minmax(0, 1fr)" },
              gap: { xs: 2, md: 1.75 },
              ...(fit ? { flex: 1, minHeight: 0 } : {}),
            }}
          >
            <Box
              data-testid="dashboard-side"
              sx={{
                ...frameSx(theme),
                gridColumn: { md: 2 },
                gridRow: { md: 1 },
                display: "flex",
                flexDirection: "column",
                minHeight: 0,
                overflowY: "auto",
                "& > * + *": {
                  borderTop: `1px solid ${theme.palette.divider}`,
                },
                animation: `${fadeUp} 0.3s ease-out 0.1s both`,
              }}
            >
              <ValidationSection report={validationReport} validation={validation} importAdjustmentsTotal={importAdjustmentsTotal} onReport={toReport} />
              <Box
                data-testid="dashboard-audit"
                sx={{
                  px: 2,
                  py: 1.5,
                  display: "flex",
                  flexDirection: "column",
                  minHeight: 0,
                  ...(fit ? { flex: "0 1 auto", minHeight: 150, maxHeight: "46%" } : {}),
                }}
              >
                <QualityAuditPanel compact dense bounded={fit} maxItems={fit ? null : 4} onSeeAll={() => toReport()} />
              </Box>
              {routes.length > 0 && <LinesSection routes={routes} onOpen={openLine} />}
            </Box>

            <Paper
              elevation={0}
              component="section"
              aria-label={t("home.map.title")}
              data-testid="dashboard-map"
              sx={{
                ...frameSx(theme),
                gridColumn: { md: 1 },
                gridRow: { md: 1 },
                position: "relative",
                overflow: "hidden",
                ...(fit ? { minHeight: 220 } : { height: { xs: 340, md: 440 } }),
                animation: `${fadeUp} 0.3s ease-out 0.1s both`,
              }}
            >
              <Box
                onClick={onNavigateToSchedule}
                sx={{
                  position: "absolute",
                  inset: 0,
                  cursor: "pointer",
                  "& .leaflet-container": {
                    cursor: "pointer",
                    background: "transparent",
                  },
                }}
              >
                {stats || !statsLoading ? (
                  <ShapesMap height="100%" interactive={false} />
                ) : (
                  <Box
                    sx={{
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <CircularProgress size={26} />
                  </Box>
                )}
              </Box>
              <Typography
                sx={{
                  position: "absolute",
                  top: 12,
                  left: 12,
                  zIndex: 500,
                  px: 1.25,
                  py: 0.5,
                  borderRadius: "8px",
                  fontSize: "0.76rem",
                  fontWeight: 700,
                  pointerEvents: "none",
                  backgroundColor: alpha(theme.palette.background.paper, 0.92),
                  border: `1px solid ${theme.palette.divider}`,
                }}
              >
                {t("home.map.title")}
              </Typography>
              <Button
                variant="contained"
                disableElevation
                size="small"
                onClick={onNavigateToSchedule}
                endIcon={<ArrowForwardIcon sx={{ fontSize: 16 }} />}
                data-testid="dashboard-open-map"
                sx={{
                  position: "absolute",
                  top: 10,
                  right: 10,
                  zIndex: 500,
                  textTransform: "none",
                  fontWeight: 700,
                  borderRadius: "8px",
                  px: 1.75,
                }}
              >
                {t("home.actionScheduleCta")}
              </Button>
            </Paper>
          </Box>
        </Box>
      </Box>
    </Fade>
  );
}

export default HomeDashboard;
