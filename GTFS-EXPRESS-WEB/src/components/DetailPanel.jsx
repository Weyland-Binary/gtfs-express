import React, { Suspense, lazy, useCallback, useRef, useEffect, useState } from "react";
import {
  Drawer,
  Box,
  IconButton,
  Typography,
  Chip,
  Tooltip,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import CloseIcon from "@mui/icons-material/Close";
import PushPinOutlinedIcon from "@mui/icons-material/PushPinOutlined";
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
import { useFormDirty, useGuard } from "../contexts/DestructiveGuardContext";
import { useLanguage } from "../contexts/LanguageContext";
import { useExpertMode } from "../utils/expertMode";
import ErrorBoundary from "./ErrorBoundary";

// The file panels are named by their file; the others carry their own title, so the bar says their id to an expert only.
const FILE_PANELS = ["feed_info", "transfers", "levels", "pathways", "translations", "attributions"];
import { groundOf } from "./common/ground";
import LinearProgress from "@mui/material/LinearProgress";
// Each panel (and the edit dialogs it carries) loads the first time it opens: never in the app's first chunk.
const StopDetail = lazy(() => import("./details/StopDetail"));
const RouteDetail = lazy(() => import("./details/RouteDetail"));
const TripDetail = lazy(() => import("./details/TripDetail"));
const CalendarDetail = lazy(() => import("./details/CalendarDetail"));
const EditHistoryPanel = lazy(() => import("./details/EditHistoryPanel"));
const ShapeDetail = lazy(() => import("./details/ShapeDetail"));
const FeedInfoPanel = lazy(() => import("./details/FeedInfoPanel"));
const TransfersPanel = lazy(() => import("./details/TransfersPanel"));
const LevelsPanel = lazy(() => import("./details/LevelsPanel"));
const PathwaysPanel = lazy(() => import("./details/PathwaysPanel"));
const TranslationsPanel = lazy(() => import("./details/TranslationsPanel"));
const AttributionsPanel = lazy(() => import("./details/AttributionsPanel"));

// MUI portals render outside the Drawer's DOM: a click inside one must not close the panel.
const PORTAL_SELECTOR =
  ".MuiModal-root, .MuiPopover-root, .MuiPopper-root, .MuiTooltip-popper, .MuiBackdrop-root";

// `width`: the type's drawer width in px (default 420): the metadata panels' dense tables need more room.
const ENTITY_CONFIG = {
  // The chip's name, in the interface's language (never an English word in every language).
  stop: { labelKey: "detail.entity.stop", icon: PlaceIcon },
  route: { labelKey: "detail.entity.route", icon: RouteIcon },
  trip: { labelKey: "detail.entity.trip", icon: DirectionsBusIcon },
  calendar: { labelKey: "detail.entity.calendar", icon: CalendarMonthIcon },
  edit_history: { labelKey: "detail.entity.edit_history", icon: HistoryIcon },
  shape: { labelKey: "detail.entity.shape", icon: TimelineIcon },
  feed_info: { labelKey: "detail.entity.feed_info", icon: ArticleOutlinedIcon, width: 560 },
  transfers: { labelKey: "detail.entity.transfers", icon: SwapHorizIcon, width: 720 },
  levels: { labelKey: "detail.entity.levels", icon: LayersIcon, width: 520 },
  pathways: { labelKey: "detail.entity.pathways", icon: AltRouteIcon, width: 780 },
  translations: { labelKey: "detail.entity.translations", icon: TranslateIcon, width: 1000 },
  attributions: { labelKey: "detail.entity.attributions", icon: VerifiedIcon, width: 820 },
};

const DEFAULT_PANEL_WIDTH = 420;
const PIN_KEY = "gtfs_detail_panel_pinned";

function DetailPanel() {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { panelOpen, entity, history, closePanel: closeAtOnce, goBack: backAtOnce, asksRef } = useDetailPanel();
  // What the person does to leave the panel asks first while a form in it holds unsaved input; a close its own
  // content asks for (a row deleted) does not come through here.
  const guard = useGuard();
  const isFormDirty = useFormDirty();
  const closePanel = useCallback(() => guard(closeAtOnce, { scope: "form", reason: "leaveForm" }), [guard, closeAtOnce]);
  const goBack = useCallback(() => guard(backAtOnce, { scope: "form", reason: "leaveForm" }), [guard, backAtOnce]);
  const { editing } = useEditMode();
  const { t } = useLanguage();
  const [expert] = useExpertMode();
  const paperRef = useRef(null);
  const [paper, setPaper] = useState(null);
  const holdPaper = useCallback((element) => {
    paperRef.current = element;
    setPaper(element);
  }, []);
  // What is on screen: a new object each time a panel is asked, the same entity again included.
  const shown = panelOpen ? entity : null;
  const shownRef = useRef(shown);
  shownRef.current = shown;

  // Pinned, the panel stays open while the person clicks the grid or the map, so a trip can be read while its cells
  // are edited. Remembered per browser.
  const [pinned, setPinned] = useState(() => {
    try {
      return localStorage.getItem(PIN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const togglePinned = () => {
    setPinned((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PIN_KEY, next ? "1" : "0");
      } catch {
        /* private mode — in-memory state still applies */
      }
      return next;
    });
  };

  // A click outside closes the panel, unless that very click asked for a panel: read where it lands before any
  // handler runs (a handler may remove what was clicked), decided once they all have. A press begun inside the panel
  // and let go outside (a text selected) is no click outside.
  useEffect(() => {
    if (!panelOpen || pinned) return undefined;
    let pending = null;
    let pressedOutside = null;
    const isOutside = (target) => Boolean(paperRef.current) && !paperRef.current.contains(target) && !(target.closest && target.closest(PORTAL_SELECTOR));
    const handlePress = (e) => {
      pressedOutside = isOutside(e.target);
    };
    const handleClick = (e) => {
      const began = pressedOutside;
      pressedOutside = null;
      if (began === false || !isOutside(e.target)) return;
      const before = shownRef.current;
      const asks = asksRef?.current;
      clearTimeout(pending);
      pending = setTimeout(() => {
        if (shownRef.current === before && asksRef?.current === asks) closePanel();
      }, 0);
    };
    document.addEventListener("mousedown", handlePress, true);
    document.addEventListener("click", handleClick, true);
    return () => {
      clearTimeout(pending);
      document.removeEventListener("mousedown", handlePress, true);
      document.removeEventListener("click", handleClick, true);
    };
  }, [panelOpen, pinned, closePanel, asksRef]);

  // The focus goes into the panel when one is asked, so the keyboard reads it and Escape closes it; it is not held
  // there (the grid stays one click away), and it goes back to what opened the panel when the panel closes, unless
  // the person has put it elsewhere meanwhile.
  const openerRef = useRef(null);
  // Escape is still down when the panel it closed is gone: the opener takes the focus once the key is up, or the
  // key's release would land on it (a chip drops the focus on Escape).
  const escapeRef = useRef({ down: false, giveBack: false });
  const giveFocusBack = useCallback(() => {
    const opener = openerRef.current;
    openerRef.current = null;
    const active = document.activeElement;
    if (opener && opener.isConnected && (!active || active === document.body)) opener.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!shown) {
      if (escapeRef.current.down) escapeRef.current.giveBack = true;
      else giveFocusBack();
      return;
    }
    escapeRef.current.giveBack = false;
    const active = document.activeElement;
    if (active && active !== document.body && !paperRef.current?.contains(active)) openerRef.current = active;
  }, [shown, giveFocusBack]);
  useEffect(() => {
    if (shown && paper) paper.focus({ preventScroll: true });
  }, [shown, paper]);

  // The one Escape of the panel. A dialog or a menu it opened is drawn outside its element and keeps its own.
  const handleKeyDown = (e) => {
    // While a form of the panel holds unsaved input, Ctrl+Z and Ctrl+Y are its own: they never reach the journal's
    // undo, which would change the saved network under what is being typed.
    if ((e.ctrlKey || e.metaKey) && /^[zy]$/i.test(e.key) && isFormDirty()) {
      e.stopPropagation();
      return;
    }
    if (e.key !== "Escape" || e.defaultPrevented || !e.currentTarget.contains(e.target)) return;
    e.stopPropagation();
    const escape = escapeRef.current;
    if (!escape.down) {
      escape.down = true;
      const release = (up) => {
        if (up.key !== "Escape") return;
        window.removeEventListener("keyup", release, true);
        escape.down = false;
        if (escape.giveBack) {
          escape.giveBack = false;
          giveFocusBack();
        }
      };
      window.addEventListener("keyup", release, true);
    }
    closePanel();
  };

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
        return <Typography color="text.secondary">{t("detail.unknownEntity")}</Typography>;
    }
  };

  return (
    <Drawer
      anchor="right"
      open={panelOpen}
      variant="temporary"
      transitionDuration={{ enter: 360, exit: 240 }}
      SlideProps={{
        easing: {
          enter: "cubic-bezier(0.22, 1, 0.36, 1)",
          exit: "cubic-bezier(0.55, 0, 1, 0.45)",
        },
      }}
      hideBackdrop
      // The panel is a side inspector, not a modal: the focus is never held in it (the grid and its arrow keys stay
      // reachable while it is open) and the page keeps scrolling. Its focus and its Escape are handled above.
      ModalProps={{
        disableEnforceFocus: true,
        disableAutoFocus: true,
        disableRestoreFocus: true,
        disableScrollLock: true,
        disableEscapeKeyDown: true,
      }}
      PaperProps={{ ref: holdPaper, tabIndex: -1, role: "region", "aria-label": t(config.labelKey), onKeyDown: handleKeyDown }}
      sx={{
        pointerEvents: "none",
        "& .MuiDrawer-paper": {
          pointerEvents: "auto",
          outline: "none",
          width: {
            xs: "100%",
            sm: config.width || DEFAULT_PANEL_WIDTH,
          },
          maxWidth: "100vw",
          // A ground a shade darker than its white cards (and lighter-on-darker in dark mode): the sections read as cards,
          // never white on white.
          background: groundOf(theme),
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
            label={t(config.labelKey)}
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
              // Metadata panels use GTFS file names as ids.
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
            {expert || FILE_PANELS.includes(entity.type) ? entity.id : ""}
          </Typography>
        </Box>
        <Box display="flex" alignItems="center" gap={0.25}>
          <Tooltip title={pinned ? t("detail.unpin") : t("detail.pin")} arrow>
            <IconButton
              size="small"
              onClick={togglePinned}
              aria-label={pinned ? t("detail.unpin") : t("detail.pin")}
              aria-pressed={pinned}
              data-testid="detail-panel-pin"
              sx={{
                color: pinned ? accentColor : "text.secondary",
                transform: pinned ? "rotate(-45deg)" : "none",
                transition: "transform 0.2s ease, color 0.2s ease",
              }}
            >
              <PushPinOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
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
      </Box>

      <Box
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          // TranslationsPanel scrolls inside: overflow hidden constrains its flex:1.
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
        {/* A panel that fails says so here, the rest of the app stays; another entity opens on a fresh boundary. */}
        <ErrorBoundary key={`${entity.type}:${entity.id ?? ""}`}>
          <Suspense fallback={<LinearProgress sx={{ flexShrink: 0 }} />}>{renderContent()}</Suspense>
        </ErrorBoundary>
      </Box>
    </Drawer>
  );
}

export default DetailPanel;
