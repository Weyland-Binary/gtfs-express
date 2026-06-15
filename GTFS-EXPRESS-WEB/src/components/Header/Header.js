import React, { useState, useMemo } from "react";
import LogoSvg from "../../assets/LogoSvg";
import {
  Box,
  Tabs,
  Tab,
  Paper,
  IconButton,
  Tooltip,
  Typography,
  Badge,
  alpha,
} from "@mui/material";
import { styled, useTheme } from "@mui/material/styles";
import ScheduleIcon from "@mui/icons-material/Schedule";
import DashboardOutlinedIcon from "@mui/icons-material/DashboardOutlined";
import LightModeIcon from "@mui/icons-material/LightMode";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import StorageIcon from "@mui/icons-material/Storage";
import EditLocationAltIcon from "@mui/icons-material/EditLocationAlt";
import CompareArrowsIcon from "@mui/icons-material/CompareArrows";
import { useThemeMode } from "../../contexts/ThemeContext";
import GlobalSearch from "../GlobalSearch";
import LanguageSelector from "./LanguageSelector";
import EditModeToggle from "../edit/EditModeToggle";
import ProjectMenu from "../edit/ProjectMenu";
import { TablesBrowserButton } from "../TablesBrowserDrawer";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDestructiveGuard } from "../../contexts/DestructiveGuardContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";

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

function Header({
  agenciesLoaded,
  selectedMainTab,
  setSelectedMainTab,
  validationReport,
  onShowValidationReport,
}) {
  const { mode, toggleMode, isDark } = useThemeMode();
  const theme = useTheme();
  const { t } = useLanguage();
  const { guard } = useDestructiveGuard();
  const { editing, exitEditMode } = useEditMode();
  const { sqlConsoleVisible, toggleSqlConsole } = useDetailPanel();
  const [logoHovered, setLogoHovered] = useState(false);

  const isHoverActive = agenciesLoaded && logoHovered;

  const reportBadge = useMemo(() => {
    if (!validationReport?.errors) return null;
    let errors = 0,
      warnings = 0,
      infos = 0;
    Object.values(validationReport.errors).forEach((arr) => {
      arr.forEach((e) => {
        const sev = e.severity || "error";
        if (sev === "error") errors++;
        else if (sev === "warning") warnings++;
        else infos++;
      });
    });
    const total = errors + warnings + infos;
    if (total === 0) return null;
    // Pick the highest severity color for the badge
    const color = errors > 0 ? "error" : warnings > 0 ? "warning" : "info";
    return { total, errors, warnings, infos, color };
  }, [validationReport]);

  const handleLogoClick = () => {
    // Logo click = "Load a new file". The real intent is to
    // return to the upload screen — so we must explicitly exit
    // edit mode BEFORE reload, otherwise the backend disk-truthy state
    // brings us back automatically after reload (see auto-hydration GTFSApp).
    guard(
      async () => {
        if (editing) await exitEditMode();
        window.location.reload();
      },
      { reason: "reload" },
    );
  };

  return (
    <HeaderContainer elevation={0}>
      <Box display="flex" alignItems="center" justifyContent="space-between">
        {/* Logo zone — morphs into "New file" on hover when data is loaded */}
        <Box
          onMouseEnter={() => agenciesLoaded && setLogoHovered(true)}
          onMouseLeave={() => setLogoHovered(false)}
          onClick={handleLogoClick}
          sx={{
            position: "relative",
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
          {/* Logo */}
          <Box
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

          {/* "Load new file" overlay */}
          <Box
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
            <UploadFileIcon
              sx={{
                fontSize: 18,
                color: theme.palette.primary.main,
              }}
            />
            <Typography
              variant="body2"
              fontWeight={600}
              sx={{
                color: theme.palette.primary.main,
                fontSize: "0.8rem",
                letterSpacing: "-0.01em",
              }}
            >
              {t("header.loadNewFile")}
            </Typography>
          </Box>
        </Box>

        {agenciesLoaded && (
          <StyledTabs
            // The active tab is derived from two pieces of state: when
            // sqlConsoleVisible is true the Console tab (index 2) is the
            // active one, regardless of selectedMainTab. Switching back to
            // Home or Schedule closes the console.
            value={sqlConsoleVisible ? 2 : selectedMainTab}
            onChange={(e, value) => {
              if (value === 2) {
                if (!sqlConsoleVisible) toggleSqlConsole();
              } else {
                if (sqlConsoleVisible) toggleSqlConsole();
                setSelectedMainTab(value);
              }
            }}
          >
            <Tab
              value={0}
              data-testid="tab-home"
              icon={<DashboardOutlinedIcon sx={{ fontSize: 20 }} />}
              iconPosition="start"
              label={t("home.tab")}
            />
            <Tab
              value={1}
              data-testid="tab-schedules"
              icon={<ScheduleIcon sx={{ fontSize: 20 }} />}
              iconPosition="start"
              label={t("header.tabSchedules")}
            />
            {/* Shape Studio — edit-mode-only dedicated geometry editor */}
            {editing && (
              <Tab
                value={3}
                data-testid="tab-shape-studio"
                icon={<EditLocationAltIcon sx={{ fontSize: 20 }} />}
                iconPosition="start"
                label={t("shapeStudio.tab")}
              />
            )}
            <Tab
              value={2}
              data-testid="tab-sql"
              icon={<StorageIcon sx={{ fontSize: 20 }} />}
              iconPosition="start"
              label={t("sqlConsole.headerBtn")}
            />
            <Tab
              value={4}
              data-testid="tab-compare"
              icon={<CompareArrowsIcon sx={{ fontSize: 20 }} />}
              iconPosition="start"
              label={t("compare.tab")}
            />
          </StyledTabs>
        )}
        <Box
          display="flex"
          alignItems="center"
          gap={1.5}
          justifyContent="flex-end"
        >
          {agenciesLoaded && <GlobalSearch />}
          {agenciesLoaded && <ProjectMenu />}
          {agenciesLoaded && <TablesBrowserButton />}
          {agenciesLoaded && <EditModeToggle />}
          {agenciesLoaded && reportBadge && (
            <Tooltip
              title={
                [
                  reportBadge.errors > 0 &&
                    t("header.reportTooltip", {
                      errors: reportBadge.errors,
                      warnings: reportBadge.warnings,
                      infos: reportBadge.infos,
                    }),
                ]
                  .filter(Boolean)
                  .join("") ||
                `${reportBadge.errors}e ${reportBadge.warnings}w ${reportBadge.infos}i`
              }
              arrow
            >
              <IconButton
                onClick={onShowValidationReport}
                size="small"
                data-testid="validation-report-badge"
                aria-label={t("header.reportTooltip", {
                  errors: reportBadge.errors,
                  warnings: reportBadge.warnings,
                  infos: reportBadge.infos,
                })}
                sx={{
                  padding: 1,
                  borderRadius: 2.5,
                  backgroundColor:
                    reportBadge.color === "error"
                      ? alpha(theme.palette.error.main, isDark ? 0.12 : 0.08)
                      : reportBadge.color === "warning"
                        ? alpha("#ed6c02", isDark ? 0.12 : 0.08)
                        : alpha(theme.palette.info.main, isDark ? 0.12 : 0.08),
                  color:
                    reportBadge.color === "error"
                      ? theme.palette.error.main
                      : reportBadge.color === "warning"
                        ? isDark
                          ? "#ffa726"
                          : "#ed6c02"
                        : theme.palette.info.main,
                  transition: "all 0.2s ease-in-out",
                  "&:hover": {
                    backgroundColor:
                      reportBadge.color === "error"
                        ? alpha(theme.palette.error.main, isDark ? 0.2 : 0.14)
                        : reportBadge.color === "warning"
                          ? alpha("#ed6c02", isDark ? 0.2 : 0.14)
                          : alpha(theme.palette.info.main, isDark ? 0.2 : 0.14),
                    transform: "scale(1.05)",
                  },
                }}
              >
                <Badge
                  badgeContent={reportBadge.total}
                  color={reportBadge.color}
                  max={99}
                  sx={{
                    "& .MuiBadge-badge": {
                      fontSize: "0.65rem",
                      fontWeight: 700,
                      minWidth: 18,
                      height: 18,
                    },
                  }}
                >
                  <FactCheckOutlinedIcon sx={{ fontSize: 20 }} />
                </Badge>
              </IconButton>
            </Tooltip>
          )}
          <LanguageSelector />
          <Tooltip
            title={isDark ? t("header.lightMode") : t("header.darkMode")}
          >
            <ThemeToggleButton onClick={toggleMode} size="small">
              {isDark ? (
                <LightModeIcon sx={{ fontSize: 20 }} />
              ) : (
                <DarkModeIcon sx={{ fontSize: 20 }} />
              )}
            </ThemeToggleButton>
          </Tooltip>
        </Box>
      </Box>
    </HeaderContainer>
  );
}

export default Header;
