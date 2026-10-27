/**
 * The reader's overview (« Vue d'ensemble »): the network's name and period, a strip of figures, the map, and a side
 * panel with the validator's verdict, the Diagnostic and the lines. One screen on a desktop. The verdict never reads
 * « not run » beside a Diagnostic of the same feed: GTFSApp runs the validator when a network opens without a report.
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
import { NAVIGATE_EVENT, VALIDATION_REFRESHED_EVENT } from "../utils/appEvents";

const fadeUp = keyframes`
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
`;

const paperSx = (theme) => ({ backgroundColor: theme.palette.background.paper });
const hairline = (theme) => `1px solid ${theme.palette.divider}`;

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

// No repair is offered here: the overview is the reading's door, and « Voir le rapport » leads to the repairs.
function ValidationSection({ report, validation, importAdjustmentsTotal, onReport, sx = {}, children = null }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { showToast } = useEditMode();
  const [retrying, setRetrying] = useState(false);
  // Before the first run the section says it is coming, never that it failed.
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
        new CustomEvent(VALIDATION_REFRESHED_EVENT, {
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
      title={t("home.quality.title")}
      testid="dashboard-validation"
      sx={{ flexShrink: 0, ...sx }}
      aside={
        summary.validated ? (
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
      {children}
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
  // { table: droppedCount } from the tolerant import, announced so a feed cleaned at import is not a dead end.
  importAdjustments = null,
  onNavigateToValidation,
  onNavigateToSchedule,
  agencies = [],
  // { running, seconds, unavailable }
  validation = null,
}) {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const { dataVersion } = useEditMode();
  const fit = useMediaQuery(theme.breakpoints.up("md"));

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

  // The agency is kept on each route to open it in its timetable.
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
    // agencyKey stands for agencyIds, a new array on each render of the parent.
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

  // Number and unit apart: the strip writes the unit smaller.
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
      new CustomEvent(NAVIGATE_EVENT, {
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
  ];
  const periodLength = calendarShort && typeof calendarShort === "object" ? `${calendarShort.n} ${calendarShort.unit}` : calendarShort || null;

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
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            ...(fit ? { flex: 1, minHeight: 0 } : {}),
          }}
        >
          {/* ─── FIGURES ─── */}
          <Box
            component="section"
            aria-label={t("home.inventoryTitle")}
            data-testid="dashboard-inventory"
            sx={{
              ...paperSx(theme),
              borderBottom: hairline(theme),
              flexShrink: 0,
              display: "grid",
              gridTemplateColumns: {
                xs: "repeat(2, minmax(0, 1fr))",
                sm: "repeat(3, minmax(0, 1fr))",
                md: "minmax(0, 1.8fr) repeat(5, minmax(0, 1fr))",
              },
              "& > *": { px: { xs: 2, md: 3 }, py: 1.25, minWidth: 0 },
              "& > * + *": {
                borderLeft: { md: `1px solid ${theme.palette.divider}` },
              },
              animation: `${fadeUp} 0.3s ease-out 0.05s both`,
            }}
          >
            <Box data-testid="dashboard-identity" sx={{ display: "flex", flexDirection: "column", justifyContent: "center", gridColumn: { xs: "1 / -1", md: "auto" } }}>
              <Typography component="h1" noWrap title={name || undefined} sx={{ fontSize: { xs: "1.2rem", md: "1.35rem" }, fontWeight: 750, letterSpacing: "-0.02em", lineHeight: 1.2 }}>
                {name || t("home.heroTitle")}
              </Typography>
              {calendarCoverage && (
                <Typography data-testid="dashboard-period" noWrap sx={{ display: "flex", alignItems: "center", gap: 0.6, mt: 0.25, fontSize: "0.76rem", color: "text.secondary" }}>
                  <EventIcon sx={{ fontSize: 14 }} />
                  {calendarCoverage.from} → {calendarCoverage.to}
                  {periodLength ? ` · ${periodLength}` : ""}
                </Typography>
              )}
            </Box>
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

          {/* ─── BODY: the map and the side panel ─── */}
          <Box
            sx={{
              display: { xs: "flex", md: "grid" },
              flexDirection: "column",
              gridTemplateColumns: {
                md: "minmax(0, 1fr) clamp(340px, 27vw, 420px)",
              },
              gridTemplateRows: { md: "minmax(0, 1fr)" },
              ...(fit ? { flex: 1, minHeight: 0 } : {}),
            }}
          >
            <Box
              data-testid="dashboard-side"
              sx={{
                ...paperSx(theme),
                borderLeft: { md: hairline(theme) },
                borderTop: { xs: hairline(theme), md: "none" },
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
              <ValidationSection report={validationReport} validation={validation} importAdjustmentsTotal={importAdjustmentsTotal} onReport={toReport} sx={fit ? { flex: "0 1 auto", minHeight: 0, maxHeight: "62%" } : {}}>
                <Box
                  data-testid="dashboard-audit"
                  sx={{
                    mt: 0.5,
                    pt: 1.25,
                    borderTop: hairline(theme),
                    display: "flex",
                    flexDirection: "column",
                    minHeight: 0,
                    ...(fit ? { flex: "0 1 auto", minHeight: 120 } : {}),
                  }}
                >
                  <QualityAuditPanel compact dense nested bounded={fit} maxItems={fit ? null : 4} repairAll={false} onSeeAll={() => toReport()} />
                </Box>
              </ValidationSection>
              {routes.length > 0 && <LinesSection routes={routes} onOpen={openLine} />}
            </Box>

            <Paper
              elevation={0}
              component="section"
              aria-label={t("home.map.title")}
              data-testid="dashboard-map"
              sx={{
                ...paperSx(theme),
                borderRadius: 0,
                gridColumn: { md: 1 },
                gridRow: { md: 1 },
                position: "relative",
                overflow: "hidden",
                ...(fit ? { minHeight: 220 } : { height: { xs: 340, md: 440 } }),
                animation: `${fadeUp} 0.3s ease-out 0.1s both`,
              }}
            >
              <Box
                sx={{
                  position: "absolute",
                  inset: 0,
                  "& .leaflet-container": {
                    background: "transparent",
                  },
                }}
              >
                {stats || !statsLoading ? (
                  <ShapesMap height="100%" refit />
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
                  // Beside the zoom buttons, which hold the corner.
                  left: 56,
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
