import React, { useRef, useEffect } from "react";
import { Drawer, Box, IconButton, Typography, Chip } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import CloseIcon from "@mui/icons-material/Close";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import PlaceIcon from "@mui/icons-material/Place";
import RouteIcon from "@mui/icons-material/Route";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import CalendarMonthIcon from "@mui/icons-material/CalendarMonth";
import HistoryIcon from "@mui/icons-material/History";
import TimelineIcon from "@mui/icons-material/Timeline";
import ArticleOutlinedIcon from "@mui/icons-material/ArticleOutlined";
import SwapHorizIcon from "@mui/icons-material/SwapHoriz";
import LayersIcon from "@mui/icons-material/Layers";
import AltRouteIcon from "@mui/icons-material/AltRoute";
import TranslateIcon from "@mui/icons-material/Translate";
import VerifiedIcon from "@mui/icons-material/Verified";
import { useDetailPanel } from "../contexts/DetailPanelContext";
import { useEditMode } from "../contexts/EditModeContext";
import { useLanguage } from "../contexts/LanguageContext";
import StopDetail from "./details/StopDetail";
import RouteDetail from "./details/RouteDetail";
import TripDetail from "./details/TripDetail";
import CalendarDetail from "./details/CalendarDetail";
import EditHistoryPanel from "./details/EditHistoryPanel";
import ShapeDetail from "./details/ShapeDetail";
import FeedInfoPanel from "./details/FeedInfoPanel";
import TransfersPanel from "./details/TransfersPanel";
import LevelsPanel from "./details/LevelsPanel";
import PathwaysPanel from "./details/PathwaysPanel";
import TranslationsPanel from "./details/TranslationsPanel";
import AttributionsPanel from "./details/AttributionsPanel";

// MUI portals (Dialog, Menu, Select dropdown, Popover, Tooltip, Autocomplete)
// render outside the Drawer's DOM. A click inside one of these must NOT
// trigger the click-outside-to-close behavior.
const PORTAL_SELECTOR =
  ".MuiModal-root, .MuiPopover-root, .MuiPopper-root, .MuiTooltip-popper, .MuiBackdrop-root";

// `width` (optional) — per-type drawer width in px on sm+ viewports.
// Default: 420px. Metadata panels carry dense tables (translations, pathways,
// transfers) that need more horizontal room to avoid horizontal scroll and
// truncated columns. Full width on xs (mobile) regardless.
//
// Colours are resolved at runtime from `theme.palette.entities[type]` so the
// dark-mode theme can override them centrally — see Theme.js.
const ENTITY_CONFIG = {
  stop: { label: "Stop", icon: PlaceIcon },
  route: { label: "Route", icon: RouteIcon },
  trip: { label: "Trip", icon: DirectionsBusIcon },
  calendar: { label: "Calendar", icon: CalendarMonthIcon },
  edit_history: { label: "Edit History", icon: HistoryIcon },
  shape: { label: "Shape", icon: TimelineIcon },
  feed_info: { label: "Feed info", icon: ArticleOutlinedIcon, width: 560 },
  transfers: { label: "Transfers", icon: SwapHorizIcon, width: 720 },
  levels: { label: "Levels", icon: LayersIcon, width: 520 },
  pathways: { label: "Pathways", icon: AltRouteIcon, width: 780 },
  translations: { label: "Translations", icon: TranslateIcon, width: 1000 },
  attributions: { label: "Attributions", icon: VerifiedIcon, width: 820 },
};

const DEFAULT_PANEL_WIDTH = 420;

function DetailPanel() {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { panelOpen, entity, history, closePanel, goBack } = useDetailPanel();
  const { editing } = useEditMode();
  const { t } = useLanguage();
  const paperRef = useRef(null);

  // Close on outside click — but ignore clicks in MUI portals (Dialog, Menu, Select, Tooltip…)
  // that are rendered outside the Drawer DOM.
  useEffect(() => {
    if (!panelOpen) return;
    const handleClickOutside = (e) => {
      if (!paperRef.current) return;
      if (paperRef.current.contains(e.target)) return;
      if (e.target.closest && e.target.closest(PORTAL_SELECTOR)) return;
      closePanel();
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [panelOpen, closePanel]);

  if (!entity) return null;

  const config = ENTITY_CONFIG[entity.type] || ENTITY_CONFIG.stop;
  const Icon = config.icon;
  const accentColor =
    theme.palette.entities[entity.type] || theme.palette.entities.stop;

  const renderContent = () => {
    switch (entity.type) {
      case "stop":
        return <StopDetail stopId={entity.id} data={entity.data} />;
      case "route":
        return <RouteDetail routeId={entity.id} data={entity.data} />;
      case "trip":
        return <TripDetail tripId={entity.id} data={entity.data} />;
      case "calendar":
        return <CalendarDetail serviceId={entity.id} />;
      case "edit_history":
        return <EditHistoryPanel />;
      case "shape":
        return <ShapeDetail shapeId={entity.id} />;
      case "feed_info":
        return <FeedInfoPanel />;
      case "transfers":
        return <TransfersPanel />;
      case "levels":
        return <LevelsPanel />;
      case "pathways":
        return <PathwaysPanel />;
      case "translations":
        return <TranslationsPanel />;
      case "attributions":
        return <AttributionsPanel />;
      default:
        return <Typography color="text.secondary">Unknown entity</Typography>;
    }
  };

  return (
    <Drawer
      anchor="right"
      open={panelOpen}
      onClose={closePanel}
      variant="temporary"
      transitionDuration={{ enter: 360, exit: 240 }}
      SlideProps={{
        easing: {
          enter: "cubic-bezier(0.22, 1, 0.36, 1)",
          exit: "cubic-bezier(0.55, 0, 1, 0.45)",
        },
      }}
      hideBackdrop
      PaperProps={{ ref: paperRef }}
      sx={{
        pointerEvents: "none",
        "& .MuiDrawer-paper": {
          pointerEvents: "auto",
          width: {
            xs: "100%",
            sm: config.width || DEFAULT_PANEL_WIDTH,
          },
          maxWidth: "100vw",
          background: isDark ? "#141820" : "#f8fafc",
          borderLeft: editing
            ? `2px solid ${theme.palette.warning.main}`
            : isDark
              ? "1px solid rgba(255,255,255,0.08)"
              : "1px solid rgba(0,0,0,0.06)",
          boxShadow: editing
            ? `-12px 0 48px ${isDark ? "rgba(237,108,2,0.25)" : "rgba(237,108,2,0.18)"}`
            : isDark
              ? "-12px 0 48px rgba(0,0,0,0.55)"
              : "-12px 0 48px rgba(0,0,0,0.12)",
          overflow: "hidden",
          transition: "border-color 0.25s ease, box-shadow 0.25s ease",
        },
      }}
    >
      {/* Colored accent strip — slides in from right */}
      <Box
        sx={{
          height: 3,
          background: `linear-gradient(90deg, ${accentColor}00, ${accentColor}, ${accentColor}88)`,
          flexShrink: 0,
          animation: "accentSlide 0.5s cubic-bezier(0.22, 1, 0.36, 1) forwards",
          "@keyframes accentSlide": {
            from: { transform: "scaleX(0)", transformOrigin: "right" },
            to: { transform: "scaleX(1)", transformOrigin: "right" },
          },
        }}
      />

      {/* Header */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          px: 2,
          py: 1.5,
          borderBottom: isDark
            ? "1px solid rgba(255,255,255,0.08)"
            : "1px solid rgba(0,0,0,0.06)",
          background: isDark ? "#1a1f2e" : "#ffffff",
          animation:
            "fadeSlideDown 0.35s cubic-bezier(0.22, 1, 0.36, 1) 0.06s both",
          "@keyframes fadeSlideDown": {
            from: { opacity: 0, transform: "translateY(-8px)" },
            to: { opacity: 1, transform: "translateY(0)" },
          },
        }}
      >
        <Box display="flex" alignItems="center" gap={1}>
          {history.length > 0 && (
            <IconButton
              size="small"
              onClick={goBack}
              aria-label={t("app.back")}
              sx={{
                mr: 0.5,
                transition: "transform 0.2s ease",
                "&:hover": { transform: "translateX(-2px)" },
              }}
            >
              <ArrowBackIcon fontSize="small" />
            </IconButton>
          )}
          <Chip
            icon={<Icon sx={{ fontSize: 16 }} />}
            label={config.label}
            size="small"
            sx={{
              background: `${accentColor}18`,
              color: accentColor,
              fontWeight: 700,
              fontSize: 11,
              letterSpacing: "0.04em",
              border: `1px solid ${accentColor}30`,
              "& .MuiChip-icon": { color: accentColor },
            }}
          />
          <Typography
            variant="subtitle2"
            fontWeight={600}
            sx={{
              maxWidth: 200,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: isDark ? "#e2e8f0" : "#1e293b",
              // Metadata panels use GTFS filenames as IDs — render in monospace
              fontFamily: [
                "feed_info",
                "transfers",
                "levels",
                "pathways",
                "translations",
                "attributions",
              ].includes(entity.type)
                ? "ui-monospace, SFMono-Regular, Menlo, monospace"
                : "inherit",
              fontSize: [
                "feed_info",
                "transfers",
                "levels",
                "pathways",
                "translations",
                "attributions",
              ].includes(entity.type)
                ? 11
                : undefined,
            }}
          >
            {entity.id}
          </Typography>
        </Box>
        <IconButton
          size="small"
          onClick={closePanel}
          aria-label={t("app.close")}
          sx={{
            transition: "transform 0.2s ease, background 0.2s ease",
            "&:hover": {
              transform: "rotate(90deg)",
              background: isDark
                ? "rgba(255,255,255,0.08)"
                : "rgba(0,0,0,0.06)",
            },
          }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Content — fades up with slight delay */}
      <Box
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          // TranslationsPanel manages its own internal scroll — the container
          // must be overflow:hidden to constrain flex:1 of the child.
          // The other panels can scroll freely.
          overflow: entity.type === "translations" ? "hidden" : "auto",
          p: 2,
          animation:
            "fadeSlideUp 0.4s cubic-bezier(0.22, 1, 0.36, 1) 0.12s both",
          "@keyframes fadeSlideUp": {
            from: { opacity: 0, transform: "translateY(12px)" },
            to: { opacity: 1, transform: "translateY(0)" },
          },
        }}
      >
        {renderContent()}
      </Box>
    </Drawer>
  );
}

export default DetailPanel;
