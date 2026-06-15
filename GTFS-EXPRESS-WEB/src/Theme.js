// src/Theme.js
import { createTheme } from "@mui/material/styles";

// ── Domain accent palettes ────────────────────────────────────────────────
// Semantic groups consumed app-wide:
//   • entities — accent colour for each GTFS entity type. Used in
//     DetailPanel header chips, CommandPalette markers, GlobalSearch chips.
//   • severities — error/warning/info accent for validation findings,
//     re-used in HomeDashboard severity cards, ValidationErrorsPage,
//     RuleOccurrenceTable. `main` is the on-light accent; `dark` is the
//     on-dark accent (lighter to clear contrast on dark surfaces).
//   • brand / validationEntities / calendarSchemes / banner / routeFallback
//     — see each block below.
//
// Single source of truth: hardcoded ENTITY_CONFIG / SEVERITY_CONFIG in
// individual components are migrated to read from these.
const ENTITIES_LIGHT = {
  stop: "#f97316",
  route: "#6366f1",
  trip: "#22c55e",
  calendar: "#9c27b0",
  shape: "#0ea5e9",
  edit_history: "#ed6c02",
  feed_info: "#0284c7",
  transfers: "#0891b2",
  levels: "#7c3aed",
  pathways: "#059669",
  translations: "#d97706",
  attributions: "#be185d",
};

// Dark variants: each accent lightened one step (Tailwind 500 → 400 scale
// equivalents) so chips and markers keep AA-ish contrast on dark surfaces
// instead of sinking into the background like the on-light accents do.
const ENTITIES_DARK = {
  stop: "#fb923c",
  route: "#818cf8",
  trip: "#4ade80",
  calendar: "#ce93d8",
  shape: "#38bdf8",
  edit_history: "#ffa726",
  feed_info: "#38bdf8",
  transfers: "#22d3ee",
  levels: "#a78bfa",
  pathways: "#34d399",
  translations: "#fbbf24",
  attributions: "#f472b6",
};

const SEVERITIES_LIGHT = {
  error: { main: "#d32f2f" },
  warning: { main: "#ed6c02" },
  info: { main: "#0288d1" },
};

const SEVERITIES_DARK = {
  error: { main: "#f44336" },
  warning: { main: "#ffa726" },
  info: { main: "#29b6f6" },
};

// ── Brand accents ─────────────────────────────────────────────────────────
// Solid Tailwind-tone accents consumed by HomeDashboard (severity cards,
// inventory tiles, section labels). Decorative by design — intentionally
// distinct from `severities` (MUI tones used for validation findings).
// Identical in both modes: the dashboard adapts the surrounding surfaces
// with alpha() instead of swapping the accent itself.
const BRAND = {
  error: "#ef4444",
  warning: "#f59e0b",
  success: "#10b981",
  info: "#0ea5e9",
  violet: "#8b5cf6",
  indigo: "#6366f1",
  pink: "#ec4899",
};

// ── Validation entity accents ─────────────────────────────────────────────
// ValidationErrorsPage groups findings by GTFS entity using muted Material
// tones — intentionally distinct from `entities` (the brighter detail-panel
// accents). `unknown` is the defensive fallback for entity types the
// backend may introduce before the frontend maps catch up. Identical in
// both modes (historical behaviour, kept colour-accurate).
const VALIDATION_ENTITIES = {
  stop: "#ef6c00",
  route: "#7b1fa2",
  trip: "#2e7d32",
  shape: "#00796b",
  transfer: "#5d4037",
  service: "#455a64",
  unknown: "#607d8b",
};

// ── Calendar service-day schemes ──────────────────────────────────────────
// CalendarPicker day-cell palette, one scheme per computed service type.
// Each scheme: bg (cell fill), text (day number), hover (cell hover fill),
// dot (legend marker).
const CALENDAR_SCHEMES_LIGHT = {
  weekday: {
    bg: "#e3f2fd",
    text: "#1565c0",
    hover: "#bbdefb",
    dot: "#1976d2",
  },
  saturday: {
    bg: "#fff3e0",
    text: "#e65100",
    hover: "#ffe0b2",
    dot: "#ff9800",
  },
  sunday: {
    bg: "#ffebee",
    text: "#c62828",
    hover: "#ffcdd2",
    dot: "#f44336",
  },
  exception: {
    bg: "#f3e5f5",
    text: "#6a1b9a",
    hover: "#e1bee7",
    dot: "#9c27b0",
  },
  "no-service": {
    bg: "transparent",
    text: "#bdbdbd",
    hover: "rgba(0,0,0,0.04)",
    dot: "#e0e0e0",
  },
};

// Dark variants: translucent fills over dark surfaces + lightened text/dot
// tones, mirroring the on-dark treatment of `entities`/`severities`.
const CALENDAR_SCHEMES_DARK = {
  weekday: {
    bg: "rgba(25, 118, 210, 0.18)",
    text: "#90caf9",
    hover: "rgba(25, 118, 210, 0.3)",
    dot: "#42a5f5",
  },
  saturday: {
    bg: "rgba(255, 152, 0, 0.18)",
    text: "#ffb74d",
    hover: "rgba(255, 152, 0, 0.3)",
    dot: "#ffa726",
  },
  sunday: {
    bg: "rgba(244, 67, 54, 0.18)",
    text: "#ef9a9a",
    hover: "rgba(244, 67, 54, 0.3)",
    dot: "#ef5350",
  },
  exception: {
    bg: "rgba(156, 39, 176, 0.18)",
    text: "#ce93d8",
    hover: "rgba(156, 39, 176, 0.3)",
    dot: "#ab47bc",
  },
  "no-service": {
    bg: "transparent",
    text: "#555",
    hover: "rgba(255,255,255,0.05)",
    dot: "#555",
  },
};

// ── Mobile gate banner ────────────────────────────────────────────────────
// MobileBanner full-screen gate: backdrop/icon gradients plus the few text
// and border tones that deliberately deviate from `text.primary` /
// `text.secondary` in dark mode. glow / cta / ctaShadow* are mode-invariant.
const BANNER_LIGHT = {
  backdrop: "linear-gradient(170deg, #f8fafc 0%, #e2e8f0 50%, #f8fafc 100%)",
  glow: "radial-gradient(circle, rgba(25,118,210,0.12) 0%, transparent 70%)",
  iconBg:
    "linear-gradient(135deg, rgba(25,118,210,0.10) 0%, rgba(66,165,245,0.08) 100%)",
  iconBorder: "rgba(25,118,210,0.15)",
  title: "#1e293b",
  subtitle: "#64748b",
  cta: "linear-gradient(135deg, #1565c0 0%, #42a5f5 100%)",
  ctaShadow: "0 8px 24px rgba(25,118,210,0.3)",
  ctaShadowHover: "0 12px 32px rgba(25,118,210,0.4)",
};

const BANNER_DARK = {
  backdrop: "linear-gradient(170deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)",
  glow: "radial-gradient(circle, rgba(25,118,210,0.12) 0%, transparent 70%)",
  iconBg:
    "linear-gradient(135deg, rgba(144,202,249,0.15) 0%, rgba(25,118,210,0.10) 100%)",
  iconBorder: "rgba(144,202,249,0.2)",
  title: "#e2e8f0",
  subtitle: "#94a3b8",
  cta: "linear-gradient(135deg, #1565c0 0%, #42a5f5 100%)",
  ctaShadow: "0 8px 24px rgba(25,118,210,0.3)",
  ctaShadowHover: "0 12px 32px rgba(25,118,210,0.4)",
};

// ── Route colour fallback ─────────────────────────────────────────────────
// Default GTFS route colour applied when routes.txt carries no route_color
// (ShapesMap polylines). LineSelector/ScheduleGrid still hardcode the same
// value pending their own migration. Mode-invariant.
const ROUTE_FALLBACK = "#2781BB";

// ── AI identity ───────────────────────────────────────────────────────────
// Visual identity of the AI companion (FAB, avatar, empty-state hero,
// NL2SQL accents). Indigo/violet pair, with a lighter main in dark mode for
// contrast on dark surfaces. Consumed via theme.palette.ai.* (rule #19 —
// chat components must not hardcode these hex values).
const AI_LIGHT = {
  main: "#6366f1", // indigo-500
  dark: "#4f46e5", // indigo-700
  gradientStart: "#7c3aed", // violet-600
  gradientEnd: "#6366f1",
  contrastText: "#ffffff",
};
const AI_DARK = {
  main: "#818cf8", // indigo-400
  dark: "#6366f1",
  gradientStart: "#7c3aed",
  gradientEnd: "#6366f1",
  contrastText: "#ffffff",
};

export const lightTheme = createTheme({
  palette: {
    mode: "light",
    entities: ENTITIES_LIGHT,
    severities: SEVERITIES_LIGHT,
    brand: BRAND,
    validationEntities: VALIDATION_ENTITIES,
    calendarSchemes: CALENDAR_SCHEMES_LIGHT,
    banner: BANNER_LIGHT,
    routeFallback: ROUTE_FALLBACK,
    ai: AI_LIGHT,
    primary: {
      main: "#1976d2",
      light: "#42a5f5",
      dark: "#1565c0",
      contrastText: "#ffffff",
    },
    secondary: {
      main: "#9c27b0",
      light: "#ba68c8",
      dark: "#7b1fa2",
    },
    success: {
      main: "#2e7d32",
      light: "#4caf50",
      dark: "#1b5e20",
    },
    warning: {
      main: "#ed6c02",
      light: "#ff9800",
      dark: "#e65100",
    },
    error: {
      main: "#d32f2f",
      light: "#ef5350",
      dark: "#c62828",
    },
    background: {
      default: "#f5f7fa",
      paper: "#ffffff",
    },
    text: {
      primary: "#1e293b",
      secondary: "#64748b",
    },
  },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    h6: {
      fontWeight: 600,
    },
    button: {
      textTransform: "none",
      fontWeight: 500,
    },
  },
  shape: {
    borderRadius: 12,
  },
  shadows: [
    "none",
    "0px 2px 4px rgba(0,0,0,0.05)",
    "0px 4px 8px rgba(0,0,0,0.08)",
    "0px 8px 16px rgba(0,0,0,0.10)",
    "0px 12px 24px rgba(0,0,0,0.12)",
    "0px 16px 32px rgba(0,0,0,0.14)",
    "0px 2px 4px rgba(0,0,0,0.05)",
    "0px 4px 8px rgba(0,0,0,0.08)",
    "0px 8px 16px rgba(0,0,0,0.10)",
    "0px 12px 24px rgba(0,0,0,0.12)",
    "0px 16px 32px rgba(0,0,0,0.14)",
    "0px 2px 4px rgba(0,0,0,0.05)",
    "0px 4px 8px rgba(0,0,0,0.08)",
    "0px 8px 16px rgba(0,0,0,0.10)",
    "0px 12px 24px rgba(0,0,0,0.12)",
    "0px 16px 32px rgba(0,0,0,0.14)",
    "0px 2px 4px rgba(0,0,0,0.05)",
    "0px 4px 8px rgba(0,0,0,0.08)",
    "0px 8px 16px rgba(0,0,0,0.10)",
    "0px 12px 24px rgba(0,0,0,0.12)",
    "0px 16px 32px rgba(0,0,0,0.14)",
    "0px 2px 4px rgba(0,0,0,0.05)",
    "0px 4px 8px rgba(0,0,0,0.08)",
    "0px 8px 16px rgba(0,0,0,0.10)",
    "0px 12px 24px rgba(0,0,0,0.12)",
  ],
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          padding: "8px 16px",
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 12,
          boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
        },
      },
    },
  },
});

export const darkTheme = createTheme({
  palette: {
    mode: "dark",
    entities: ENTITIES_DARK,
    severities: SEVERITIES_DARK,
    brand: BRAND,
    validationEntities: VALIDATION_ENTITIES,
    calendarSchemes: CALENDAR_SCHEMES_DARK,
    banner: BANNER_DARK,
    routeFallback: ROUTE_FALLBACK,
    ai: AI_DARK,
    primary: {
      main: "#90caf9",
      light: "#e3f2fd",
      dark: "#42a5f5",
      contrastText: "#0a1929",
    },
    secondary: {
      main: "#ce93d8",
      light: "#f3e5f5",
      dark: "#ab47bc",
    },
    success: {
      main: "#66bb6a",
      light: "#81c784",
      dark: "#388e3c",
    },
    warning: {
      main: "#ffa726",
      light: "#ffb74d",
      dark: "#f57c00",
    },
    error: {
      main: "#f44336",
      light: "#e57373",
      dark: "#d32f2f",
    },
    background: {
      default: "#0a1929",
      paper: "#132f4c",
    },
    text: {
      primary: "#ffffff",
      secondary: "#b0bec5",
    },
    divider: "rgba(255, 255, 255, 0.08)",
  },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    h6: {
      fontWeight: 600,
    },
    button: {
      textTransform: "none",
      fontWeight: 500,
    },
  },
  shape: {
    borderRadius: 12,
  },
  shadows: [
    "none",
    "0px 2px 4px rgba(0,0,0,0.2)",
    "0px 4px 8px rgba(0,0,0,0.25)",
    "0px 8px 16px rgba(0,0,0,0.3)",
    "0px 12px 24px rgba(0,0,0,0.35)",
    "0px 16px 32px rgba(0,0,0,0.4)",
    "0px 2px 4px rgba(0,0,0,0.2)",
    "0px 4px 8px rgba(0,0,0,0.25)",
    "0px 8px 16px rgba(0,0,0,0.3)",
    "0px 12px 24px rgba(0,0,0,0.35)",
    "0px 16px 32px rgba(0,0,0,0.4)",
    "0px 2px 4px rgba(0,0,0,0.2)",
    "0px 4px 8px rgba(0,0,0,0.25)",
    "0px 8px 16px rgba(0,0,0,0.3)",
    "0px 12px 24px rgba(0,0,0,0.35)",
    "0px 16px 32px rgba(0,0,0,0.4)",
    "0px 2px 4px rgba(0,0,0,0.2)",
    "0px 4px 8px rgba(0,0,0,0.25)",
    "0px 8px 16px rgba(0,0,0,0.3)",
    "0px 12px 24px rgba(0,0,0,0.35)",
    "0px 16px 32px rgba(0,0,0,0.4)",
    "0px 2px 4px rgba(0,0,0,0.2)",
    "0px 4px 8px rgba(0,0,0,0.25)",
    "0px 8px 16px rgba(0,0,0,0.3)",
    "0px 12px 24px rgba(0,0,0,0.35)",
  ],
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          padding: "8px 16px",
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 12,
          boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
        },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: {
          borderRadius: 12,
        },
      },
    },
  },
});
