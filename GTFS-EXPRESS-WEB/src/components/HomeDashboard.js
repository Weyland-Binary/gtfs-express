import React, { useEffect, useState, useMemo } from "react";
import {
  Box,
  Paper,
  Button,
  Typography,
  Chip,
  Skeleton,
  Fade,
  useTheme,
  alpha,
  Tooltip,
  Container,
} from "@mui/material";
import { keyframes } from "@mui/system";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import VerifiedIcon from "@mui/icons-material/Verified";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import RouteIcon from "@mui/icons-material/Route";
import PlaceIcon from "@mui/icons-material/Place";
import CalendarTodayIcon from "@mui/icons-material/CalendarToday";
import TimelineIcon from "@mui/icons-material/Timeline";
import BusinessIcon from "@mui/icons-material/Business";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import EventIcon from "@mui/icons-material/Event";
import ShapesMap from "./ShapesMap";
import { fetchWithSession } from "../utils/sessionManager";
import { useEditMode } from "../contexts/EditModeContext";
import { useLanguage } from "../contexts/LanguageContext";
import API_BASE_URL from "../config";
import { getRuleTitle } from "./validation/ruleCatalog";

/* ────────── animations ────────── */
const fadeUp = keyframes`
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
`;

/* ────────── accent palette (solid, no gradients) ──────────
   Resolved at runtime from theme.palette.brand — see Theme.js. */

/* ────────── sub-components ────────── */

const SeverityCard = ({
  severity,
  titleKey,
  count,
  topRules,
  ctaLabelKey,
  noIssuesKey,
  onCta,
  onChipClick,
  animationDelay,
  isDark,
  surface,
  border,
  textPrimary,
  textSecondary,
  onNavigateToSchedule,
}) => {
  const theme = useTheme();
  const brand = theme.palette.brand;
  const { t } = useLanguage();
  const isError = severity === "error";
  const accent = isError ? brand.error : brand.warning;
  const Icon = isError ? ErrorOutlineIcon : WarningAmberIcon;
  const isClean = count === 0;
  const displayAccent = isClean ? brand.success : accent;

  return (
    <Paper
      elevation={0}
      sx={{
        borderRadius: "14px",
        border: `1px solid ${alpha(displayAccent, isDark ? 0.24 : 0.15)}`,
        borderLeft: `3px solid ${displayAccent}`,
        backgroundColor: surface,
        p: 2,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        animation: `${fadeUp} 0.45s ease-out ${animationDelay}s both`,
        transition: "all 0.2s ease",
        "&:hover": {
          borderColor: alpha(displayAccent, isDark ? 0.4 : 0.28),
          boxShadow: `0 4px 20px ${alpha(displayAccent, isDark ? 0.14 : 0.1)}`,
          transform: "translateY(-1px)",
        },
      }}
    >
      {/* Row: icon + label */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, mb: 2 }}>
        <Box
          sx={{
            width: 30,
            height: 30,
            borderRadius: "8px",
            backgroundColor: alpha(displayAccent, isDark ? 0.24 : 0.14),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {isClean ? (
            <CheckCircleOutlineIcon
              sx={{ fontSize: 18, color: displayAccent }}
            />
          ) : (
            <Icon sx={{ fontSize: 18, color: displayAccent }} />
          )}
        </Box>
        <Typography
          sx={{
            color: textSecondary,
            fontSize: "0.78rem",
            fontWeight: 600,
            letterSpacing: "0.02em",
          }}
        >
          {t(titleKey)}
        </Typography>
      </Box>

      {/* Big count */}
      <Typography
        component="div"
        sx={{
          color: textPrimary,
          fontSize: "2.35rem",
          fontWeight: 800,
          letterSpacing: "-0.035em",
          lineHeight: 1,
          mb: 1,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {count.toLocaleString()}
      </Typography>

      {isClean ? (
        <Typography
          variant="body2"
          sx={{ color: textSecondary, fontSize: "0.82rem", mb: 2, flex: 1 }}
        >
          {t(noIssuesKey)}
        </Typography>
      ) : (
        <>
          <Typography
            sx={{
              color: textSecondary,
              fontSize: "0.7rem",
              letterSpacing: "0.08em",
              fontWeight: 700,
              textTransform: "uppercase",
              display: "block",
              mb: 1,
            }}
          >
            {t(isError ? "home.topErrors" : "home.topWarnings")}
          </Typography>
          <Box
            sx={{
              display: "flex",
              flexWrap: "wrap",
              gap: 0.75,
              mb: 2,
              flex: 1,
              alignContent: "flex-start",
            }}
          >
            {topRules.length === 0 ? (
              <Typography variant="caption" sx={{ color: textSecondary }}>
                {t("home.nRuleViolations").replace("{n}", count)}
              </Typography>
            ) : (
              topRules.map(({ ruleCode, count: c }) => {
                const label = getRuleTitle(ruleCode);
                return (
                  <Tooltip
                    key={ruleCode}
                    title={ruleCode}
                    placement="top"
                    arrow
                  >
                    <Chip
                      label={`${label} · ${c}`}
                      size="small"
                      onClick={() => onChipClick && onChipClick(ruleCode)}
                      sx={{
                        fontSize: "0.68rem",
                        height: 20,
                        cursor: "pointer",
                        backgroundColor: alpha(accent, isDark ? 0.14 : 0.08),
                        color: accent,
                        border: "none",
                        fontWeight: 600,
                        "& .MuiChip-label": { px: 1 },
                        "&:hover": {
                          backgroundColor: alpha(accent, isDark ? 0.22 : 0.14),
                        },
                      }}
                    />
                  </Tooltip>
                );
              })
            )}
          </Box>
        </>
      )}

      <Button
        fullWidth
        variant="contained"
        onClick={isClean && severity === "error" ? onNavigateToSchedule : onCta}
        disableElevation
        disabled={isClean && severity !== "error"}
        endIcon={
          isClean ? (
            <CheckCircleOutlineIcon sx={{ fontSize: 16 }} />
          ) : (
            <ArrowForwardIcon sx={{ fontSize: 16 }} />
          )
        }
        sx={{
          backgroundColor: displayAccent,
          color: "#ffffff",
          fontWeight: 700,
          fontSize: "0.8rem",
          borderRadius: "10px",
          textTransform: "none",
          py: 0.9,
          boxShadow: "none",
          "&:hover": {
            backgroundColor: alpha(displayAccent, 0.88),
            boxShadow: `0 4px 14px ${alpha(displayAccent, 0.35)}`,
          },
          "&.Mui-disabled": {
            backgroundColor: alpha(brand.success, isDark ? 0.35 : 0.4),
            color: "#ffffff",
          },
        }}
      >
        {isClean && severity === "error"
          ? t("home.actionScheduleTitle")
          : isClean
            ? t("home.allClear")
            : t(ctaLabelKey)}
      </Button>
    </Paper>
  );
};

const InventoryTile = ({
  icon: Icon,
  label,
  value,
  color,
  loading,
  animationDelay,
  isDark,
  surface,
  border,
  textPrimary,
  textSecondary,
}) => (
  <Paper
    elevation={0}
    sx={{
      p: 1.5,
      borderRadius: "12px",
      border: `1px solid ${alpha(color, isDark ? 0.2 : 0.13)}`,
      backgroundColor: surface,
      animation: `${fadeUp} 0.4s ease-out ${animationDelay}s both`,
      transition: "border-color 0.2s ease, transform 0.2s ease",
      "&:hover": {
        borderColor: alpha(color, isDark ? 0.35 : 0.25),
        transform: "translateY(-1px)",
      },
    }}
  >
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1.25 }}>
      <Box
        sx={{
          width: 24,
          height: 24,
          borderRadius: "7px",
          backgroundColor: alpha(color, isDark ? 0.24 : 0.13),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon sx={{ fontSize: 14, color }} />
      </Box>
      <Typography
        sx={{
          color: textSecondary,
          fontSize: "0.7rem",
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </Typography>
    </Box>
    {loading ? (
      <Skeleton width="70%" height={26} />
    ) : (
      <Typography
        sx={{
          color: textPrimary,
          fontSize: "1.35rem",
          fontWeight: 700,
          letterSpacing: "-0.02em",
          lineHeight: 1.1,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value ?? "—"}
      </Typography>
    )}
  </Paper>
);

const ConformanceInfoCard = ({
  onNavigateToSchedule,
  animationDelay,
  isDark,
  surface,
  textPrimary,
  textSecondary,
  hideWarningsOk = false,
  compact = false,
}) => {
  const theme = useTheme();
  const brand = theme.palette.brand;
  const { t } = useLanguage();
  return (
    <Paper
      elevation={0}
      sx={{
        gridColumn: compact ? undefined : { xs: "1", md: "span 2" },
        borderRadius: "14px",
        border: `1px solid ${alpha(brand.success, isDark ? 0.24 : 0.15)}`,
        borderLeft: `3px solid ${brand.success}`,
        backgroundColor: surface,
        p: 2,
        height: "100%",
        display: "flex",
        flexDirection: compact ? "column" : { xs: "column", sm: "row" },
        alignItems: compact ? "stretch" : "flex-start",
        gap: 2,
        animation: `${fadeUp} 0.45s ease-out ${animationDelay}s both`,
        transition: "all 0.2s ease",
        "&:hover": {
          borderColor: alpha(brand.success, isDark ? 0.4 : 0.28),
          boxShadow: `0 4px 20px ${alpha(brand.success, isDark ? 0.14 : 0.1)}`,
          transform: "translateY(-1px)",
        },
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "flex-start",
          gap: 2,
          flex: compact ? undefined : { xs: undefined, sm: 1 },
          minWidth: 0,
          width: compact ? "100%" : undefined,
        }}
      >
        <Box
          sx={{
            width: 44,
            height: 44,
            borderRadius: "12px",
            backgroundColor: alpha(brand.success, isDark ? 0.24 : 0.14),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <VerifiedIcon sx={{ fontSize: 24, color: brand.success }} />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            sx={{
              color: textPrimary,
              fontSize: compact ? "0.95rem" : "1rem",
              fontWeight: 700,
              letterSpacing: "-0.01em",
              lineHeight: 1.3,
              mb: 0.5,
            }}
          >
            {t("home.feedConformant")}
          </Typography>
          <Typography
            sx={{
              color: textSecondary,
              fontSize: "0.82rem",
              lineHeight: 1.5,
            }}
          >
            {hideWarningsOk
              ? t("home.noErrors")
              : `${t("home.noErrors")} · ${t("home.noWarnings")}`}
          </Typography>
        </Box>
      </Box>
      <Button
        fullWidth={compact}
        variant="contained"
        onClick={onNavigateToSchedule}
        disableElevation
        endIcon={<ArrowForwardIcon sx={{ fontSize: 16 }} />}
        sx={{
          backgroundColor: brand.success,
          color: "#ffffff",
          fontWeight: 700,
          fontSize: "0.8rem",
          borderRadius: "10px",
          textTransform: "none",
          py: 0.9,
          px: compact ? undefined : 2,
          whiteSpace: "nowrap",
          flex: compact ? undefined : { xs: undefined, sm: 1 },
          alignSelf: compact ? "stretch" : { xs: "stretch", sm: "flex-end" },
          mt: compact ? "auto" : undefined,
          boxShadow: "none",
          "&:hover": {
            backgroundColor: alpha(brand.success, 0.88),
            boxShadow: `0 4px 14px ${alpha(brand.success, 0.35)}`,
          },
        }}
      >
        {t("home.actionScheduleCta")}
      </Button>
    </Paper>
  );
};

/* ────────── main component ────────── */

function HomeDashboard({
  validationReport,
  onNavigateToValidation,
  onNavigateToSchedule,
}) {
  const theme = useTheme();
  const brand = theme.palette.brand;
  const { t, language } = useLanguage();
  const { dataVersion } = useEditMode();
  const isDark = theme.palette.mode === "dark";

  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
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

  const { errorCount, warningCount, topErrors, topWarnings } = useMemo(() => {
    if (!validationReport?.errors) {
      return { errorCount: 0, warningCount: 0, topErrors: [], topWarnings: [] };
    }
    let eCount = 0;
    let wCount = 0;
    const errorsMap = {};
    const warningsMap = {};
    Object.entries(validationReport.errors).forEach(([ruleCode, findings]) => {
      if (!Array.isArray(findings)) return;
      findings.forEach((f) => {
        const sev = f.severity || "error";
        if (sev === "warning") {
          wCount++;
          warningsMap[ruleCode] = (warningsMap[ruleCode] || 0) + 1;
        } else if (sev === "error") {
          eCount++;
          errorsMap[ruleCode] = (errorsMap[ruleCode] || 0) + 1;
        }
      });
    });
    const top = (map) =>
      Object.entries(map)
        .map(([ruleCode, count]) => ({ ruleCode, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 4);
    return {
      errorCount: eCount,
      warningCount: wCount,
      topErrors: top(errorsMap),
      topWarnings: top(warningsMap),
    };
  }, [validationReport]);

  const calendarCoverage = useMemo(() => {
    if (!stats?.calendarPeriod) return null;
    const { startDate, endDate } = stats.calendarPeriod;
    if (!startDate || !endDate) return null;
    const start = new Date(startDate);
    const end = new Date(endDate);
    return {
      from: start.toLocaleDateString(language, {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
      to: end.toLocaleDateString(language, {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    };
  }, [stats, language]);

  const calendarShort = useMemo(() => {
    if (!stats?.calendarPeriod) return null;
    const { startDate, endDate } = stats.calendarPeriod;
    if (!startDate || !endDate) return null;
    const start = new Date(startDate);
    const end = new Date(endDate);
    const ms = end.getTime() - start.getTime();
    const days = Math.max(1, Math.round(ms / 86400000));
    if (days < 60) return `${days} ${t("home.days")}`;
    const months = Math.round(days / 30);
    if (months < 18) return `${months} ${t("home.months")}`;
    const years = (days / 365).toFixed(1).replace(".0", "");
    return `${years} ${t("home.years")}`;
  }, [stats, t]);

  const firstAgencyName = useMemo(() => {
    if (!stats?.agencyNames?.length) return null;
    return stats.agencyNames[0];
  }, [stats]);

  const isFullyConformant = errorCount === 0 && warningCount === 0;

  const bg = isDark ? "#0a1929" : "#f8fafc";
  const surface = isDark ? "#132f4c" : "#ffffff";
  const border = isDark ? "rgba(255,255,255,0.08)" : "rgba(15,23,42,0.07)";
  const textPrimary = isDark ? "#ffffff" : "#0f172a";
  const textSecondary = isDark ? "#94a3b8" : "#64748b";

  return (
    <Fade in={mounted} timeout={300}>
      <Box
        sx={{
          backgroundColor: bg,
          flex: 1,
          minHeight: 0,
          overflowY: { xs: "auto", md: "hidden" },
          pb: { xs: 4, md: 2.5 },
        }}
      >
        <Container
          maxWidth="xl"
          sx={{
            pt: { xs: 3, md: 2.5 },
            px: { xs: 2, md: 3 },
            display: { md: "flex" },
            flexDirection: { md: "column" },
            height: { md: "100%" },
            minHeight: { md: 0 },
          }}
        >
          {/* ─── HEADER (no gradient, clean typography) ─── */}
          <Box
            sx={{
              mb: { xs: 3, md: 2.5 },
              animation: `${fadeUp} 0.4s ease-out both`,
            }}
          >
            <Typography
              variant="h3"
              component="h1"
              sx={{
                color: textPrimary,
                fontSize: { xs: "1.5rem", md: "1.9rem" },
                fontWeight: 800,
                letterSpacing: "-0.025em",
                lineHeight: 1.12,
                mb: 0.75,
              }}
            >
              {firstAgencyName
                ? t("home.heroTitleWithName").replace("{name}", firstAgencyName)
                : t("home.heroTitle")}
            </Typography>
            <Typography
              sx={{
                color: textSecondary,
                fontSize: { xs: "0.9rem", md: "1rem" },
                lineHeight: 1.5,
                maxWidth: 560,
              }}
            >
              {t("home.heroSubtitle")}
            </Typography>
            {calendarCoverage && (
              <Box
                sx={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 0.75,
                  mt: 1.25,
                  px: 1,
                  py: 0.4,
                  borderRadius: "8px",
                  border: `1px solid ${border}`,
                  backgroundColor: surface,
                }}
              >
                <EventIcon sx={{ fontSize: 15, color: textSecondary }} />
                <Typography
                  sx={{
                    color: textSecondary,
                    fontSize: "0.8rem",
                    fontWeight: 500,
                  }}
                >
                  {t("home.period")} · {calendarCoverage.from} →{" "}
                  {calendarCoverage.to}
                </Typography>
              </Box>
            )}
          </Box>

          {/* ─── TOP ROW: validation health (errors / warnings / conformant) ─── */}
          <Box
            data-testid="dashboard-validation-health"
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", md: "repeat(2, 1fr)" },
              gap: 2,
              mb: 2,
            }}
          >
            {isFullyConformant ? (
              <ConformanceInfoCard
                onNavigateToSchedule={onNavigateToSchedule}
                animationDelay={0.04}
                isDark={isDark}
                surface={surface}
                textPrimary={textPrimary}
                textSecondary={textSecondary}
              />
            ) : errorCount === 0 ? (
              <>
                <ConformanceInfoCard
                  onNavigateToSchedule={onNavigateToSchedule}
                  animationDelay={0.04}
                  isDark={isDark}
                  surface={surface}
                  textPrimary={textPrimary}
                  textSecondary={textSecondary}
                  hideWarningsOk
                  compact
                />
                <SeverityCard
                  severity="warning"
                  titleKey="home.warningsTitle"
                  count={warningCount}
                  topRules={topWarnings}
                  ctaLabelKey="home.reviewWarnings"
                  noIssuesKey="home.noWarnings"
                  onCta={() =>
                    onNavigateToValidation && onNavigateToValidation()
                  }
                  onChipClick={(rc) =>
                    onNavigateToValidation && onNavigateToValidation(rc)
                  }
                  animationDelay={0.08}
                  isDark={isDark}
                  surface={surface}
                  border={border}
                  textPrimary={textPrimary}
                  textSecondary={textSecondary}
                />
              </>
            ) : (
              <>
                <SeverityCard
                  severity="error"
                  titleKey="home.errorsTitle"
                  count={errorCount}
                  topRules={topErrors}
                  ctaLabelKey="home.reviewAllErrors"
                  noIssuesKey="home.noErrors"
                  onCta={() =>
                    onNavigateToValidation && onNavigateToValidation()
                  }
                  onChipClick={(rc) =>
                    onNavigateToValidation && onNavigateToValidation(rc)
                  }
                  onNavigateToSchedule={onNavigateToSchedule}
                  animationDelay={0.04}
                  isDark={isDark}
                  surface={surface}
                  border={border}
                  textPrimary={textPrimary}
                  textSecondary={textSecondary}
                />
                <SeverityCard
                  severity="warning"
                  titleKey="home.warningsTitle"
                  count={warningCount}
                  topRules={topWarnings}
                  ctaLabelKey="home.reviewWarnings"
                  noIssuesKey="home.noWarnings"
                  onCta={() =>
                    onNavigateToValidation && onNavigateToValidation()
                  }
                  onChipClick={(rc) =>
                    onNavigateToValidation && onNavigateToValidation(rc)
                  }
                  animationDelay={0.08}
                  isDark={isDark}
                  surface={surface}
                  border={border}
                  textPrimary={textPrimary}
                  textSecondary={textSecondary}
                />
              </>
            )}
          </Box>

          {/* ─── INVENTORY STRIP — single full-width row ─── */}
          <Box>
            <Typography
              sx={{
                color: brand.violet,
                fontSize: "0.7rem",
                letterSpacing: "0.1em",
                fontWeight: 700,
                textTransform: "uppercase",
                mb: 1.2,
                ml: 0.5,
                animation: `${fadeUp} 0.45s ease-out 0.16s both`,
              }}
            >
              {t("home.inventoryTitle")}
            </Typography>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: {
                  xs: "repeat(2, 1fr)",
                  sm: "repeat(3, 1fr)",
                  md: "repeat(6, 1fr)",
                },
                gap: 1.25,
              }}
            >
              <InventoryTile
                icon={BusinessIcon}
                label={t("home.agencies")}
                value={stats?.totalAgencies?.toLocaleString(language)}
                color={brand.indigo}
                loading={statsLoading}
                animationDelay={0.2}
                isDark={isDark}
                surface={surface}
                border={border}
                textPrimary={textPrimary}
                textSecondary={textSecondary}
              />
              <InventoryTile
                icon={RouteIcon}
                label={t("home.routes")}
                value={stats?.totalRoutes?.toLocaleString(language)}
                color={brand.violet}
                loading={statsLoading}
                animationDelay={0.23}
                isDark={isDark}
                surface={surface}
                border={border}
                textPrimary={textPrimary}
                textSecondary={textSecondary}
              />
              <InventoryTile
                icon={DirectionsBusIcon}
                label={t("home.trips")}
                value={stats?.totalTrips?.toLocaleString(language)}
                color={brand.success}
                loading={statsLoading}
                animationDelay={0.26}
                isDark={isDark}
                surface={surface}
                border={border}
                textPrimary={textPrimary}
                textSecondary={textSecondary}
              />
              <InventoryTile
                icon={PlaceIcon}
                label={t("home.stops")}
                value={stats?.totalStops?.toLocaleString(language)}
                color={brand.warning}
                loading={statsLoading}
                animationDelay={0.29}
                isDark={isDark}
                surface={surface}
                border={border}
                textPrimary={textPrimary}
                textSecondary={textSecondary}
              />
              <InventoryTile
                icon={TimelineIcon}
                label={t("home.shapes")}
                value={
                  stats?.totalShapes != null
                    ? stats.totalShapes.toLocaleString(language)
                    : undefined
                }
                color={brand.info}
                loading={statsLoading}
                animationDelay={0.32}
                isDark={isDark}
                surface={surface}
                border={border}
                textPrimary={textPrimary}
                textSecondary={textSecondary}
              />
              <InventoryTile
                icon={CalendarTodayIcon}
                label={t("home.period")}
                value={calendarShort}
                color={brand.pink}
                loading={statsLoading}
                animationDelay={0.35}
                isDark={isDark}
                surface={surface}
                border={border}
                textPrimary={textPrimary}
                textSecondary={textSecondary}
              />
            </Box>
          </Box>

          {/* ─── NETWORK MAP — fills remaining viewport (no scroll on desktop) ─── */}
          {stats && (
            <Box
              sx={{
                mt: 2,
                flex: { md: 1 },
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <Paper
                elevation={0}
                sx={{
                  borderRadius: "14px",
                  border: `1px solid ${border}`,
                  backgroundColor: surface,
                  overflow: "hidden",
                  flex: { md: 1 },
                  minHeight: 0,
                  display: "flex",
                  flexDirection: "column",
                  boxShadow: isDark
                    ? `0 8px 24px ${alpha("#000", 0.25)}`
                    : `0 8px 24px ${alpha("#0f172a", 0.05)}`,
                  animation: `${fadeUp} 0.45s ease-out 0.4s both`,
                }}
              >
                {/* Map header */}
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    px: 2,
                    py: 1.25,
                    borderBottom: `1px solid ${border}`,
                    flexShrink: 0,
                  }}
                >
                  <Typography
                    sx={{
                      color: textSecondary,
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      letterSpacing: "0.02em",
                    }}
                  >
                    {t("home.map.title")}
                    {stats.totalShapes != null && (
                      <Box
                        component="span"
                        sx={{ ml: 1, color: textSecondary, fontWeight: 400 }}
                      >
                        · {stats.totalShapes.toLocaleString(language)}{" "}
                        {t("home.map.shapesCount")}
                      </Box>
                    )}
                  </Typography>
                </Box>
                {/* Map body — fills remaining space. On small screens the
                    dashboard scrolls, so the map gets a generous viewport-
                    relative height instead of a cramped fixed 360px. */}
                <Box
                  sx={{
                    flex: 1,
                    minHeight: { xs: "58vh", md: 0 },
                    height: { xs: "58vh", md: "auto" },
                    position: "relative",
                  }}
                >
                  <ShapesMap height="100%" />
                </Box>
              </Paper>
            </Box>
          )}
        </Container>
      </Box>
    </Fade>
  );
}

export default HomeDashboard;
