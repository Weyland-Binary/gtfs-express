// src/Theme.js
//
// The two themes of the app (light, dark) and what the accessibility of every
// screen asks of them (target design §11, WP9 — RGAA 3.2, 3.3, 10.7, 13.8):
//
//   contrast       every tone used for text reaches 4.5:1 on the surfaces it
//                  sits on (background.default, background.paper) in both
//                  modes — text.secondary, primary, success, warning (main and
//                  dark: the rail's "partial" and "to redo" words), info and
//                  error — and each of primary, success, warning, info and
//                  error also on its own light tint over those surfaces (the
//                  boxes that say a state in its tone: alpha(tone, 0.07–0.08)
//                  in light, up to 0.12 in dark); the checks are the unit test
//                  themeContrast.test.js and the e2e axe-core run
//                  (a11y.spec.js), light and dark;
//   focus          a visible ring on every focusable element reached by the
//                  keyboard: 2 px, in the primary tone (≥ 3:1 on both
//                  backgrounds), instead of MUI's faint ripple;
//   reduced motion when the system asks for less motion
//                  (prefers-reduced-motion), no animation nor transition
//                  anywhere: the CSS rule below for everything drawn by CSS
//                  (keyframes, the loaders' phases), and `themeFor(mode,
//                  { reducedMotion })` for what MUI animates from JavaScript
//                  (collapses, fades, the ripple);
//   third parties  the map's attribution links (Leaflet) keep their contrast.
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

// Text tones: 4.5:1 on white and on the page's background (WP9).
const SEVERITIES_LIGHT = {
  error: { main: "#c62828" },
  warning: { main: "#b34700" },
  info: { main: "#026aa7" },
};

const SEVERITIES_DARK = {
  error: { main: "#ff7961" },
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

// The same accents as text (WP9): BRAND's violet reads 4:1 on the page's
// background; these read 4.5:1 or more on the surfaces of their mode.
const BRAND_TEXT_LIGHT = { violet: "#6d28d9" };
const BRAND_TEXT_DARK = { violet: "#c4b5fd" };

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

const LIGHT_OPTIONS = {
  palette: {
    mode: "light",
    entities: ENTITIES_LIGHT,
    severities: SEVERITIES_LIGHT,
    brand: BRAND,
    brandText: BRAND_TEXT_LIGHT,
    validationEntities: VALIDATION_ENTITIES,
    calendarSchemes: CALENDAR_SCHEMES_LIGHT,
    banner: BANNER_LIGHT,
    routeFallback: ROUTE_FALLBACK,
    ai: AI_LIGHT,
    // WP9: #1976d2 read 4.3:1 on the page's background; one step darker reads 5.3:1.
    primary: {
      main: "#1565c0",
      light: "#42a5f5",
      dark: "#0d47a1",
      contrastText: "#ffffff",
    },
    secondary: {
      main: "#9c27b0",
      light: "#ba68c8",
      dark: "#7b1fa2",
    },
    // WP9: #2e7d32 read 4.35:1 on its own 7% tint over the page's background (the
    // "nothing blocks" line of the checks); one step darker reads 4.9:1 there.
    success: {
      main: "#27732b",
      light: "#4caf50",
      dark: "#1b5e20",
    },
    // WP9: MUI's oranges (#ed6c02, #e65100) read 3.1:1 and 3.8:1 on white as text.
    warning: {
      main: "#b34700",
      light: "#ff9800",
      dark: "#8f4100",
    },
    // WP9: #d32f2f read 4.2:1 on its own 7% tint over the page's background.
    error: {
      main: "#c62828",
      light: "#ef5350",
      dark: "#b71c1c",
    },
    // WP9: #0288d1 read 3.6:1 on the page's background.
    info: {
      main: "#026aa7",
      light: "#03a9f4",
      dark: "#01579b",
    },
    background: {
      default: "#f5f7fa",
      paper: "#ffffff",
    },
    // WP9: #64748b read 4.4:1 on the page's background and 4.1:1 on the grey panels;
    // `disabled` is also the tone of many hints (119 uses): MUI's rgba(0,0,0,0.38) read 2.7:1.
    text: {
      primary: "#1e293b",
      secondary: "#5b6778",
      disabled: "#636e7b",
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
};

const DARK_OPTIONS = {
  palette: {
    mode: "dark",
    entities: ENTITIES_DARK,
    severities: SEVERITIES_DARK,
    brand: BRAND,
    brandText: BRAND_TEXT_DARK,
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
    // WP9: #f44336 read 3.7:1 on the dark paper.
    error: {
      main: "#ff7961",
      light: "#ffa4a2",
      dark: "#f44336",
    },
    background: {
      default: "#0a1929",
      paper: "#132f4c",
    },
    // WP9: the hints' tone (`disabled`) reads 6.5:1 on the dark paper and 5:1 on the lighter dark panels.
    text: {
      primary: "#ffffff",
      secondary: "#b0bec5",
      disabled: "#a8b5c4",
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
};

// ── Accessibility, shared by both modes (WP9) ─────────────────────────────

/** No animation nor transition anywhere, whatever drew it (RGAA 13.8); the rule the system's setting turns on. */
export const REDUCED_MOTION_CSS = {
  "*, *::before, *::after": {
    animationDuration: "0.001ms !important",
    animationIterationCount: "1 !important",
    animationDelay: "0ms !important",
    transitionDuration: "0.001ms !important",
    transitionDelay: "0ms !important",
    scrollBehavior: "auto !important",
  },
};

/** The global rules: the keyboard's focus ring, reduced motion, the map's attribution. */
const globalRules = (palette) => ({
  // A focus ring the keyboard can follow, on everything that is not an MUI button (links, inputs, native selects, the headings the shell focuses stay without one: they are not interactive).
  "a:focus-visible, select:focus-visible, summary:focus-visible, [role='button']:focus-visible, [role='link']:focus-visible, [role='tab']:focus-visible, [role='option']:focus-visible": {
    outline: `2px solid ${palette.primary.main}`,
    outlineOffset: 2,
  },
  "@media (prefers-reduced-motion: reduce)": REDUCED_MOTION_CSS,
  // Leaflet's attribution: its blue on the translucent grey reads 3.2:1; the text tone of the mode reads more than 4.5:1.
  ".leaflet-container .leaflet-control-attribution": {
    backgroundColor: palette.mode === "dark" ? "rgba(10, 25, 41, 0.85)" : "rgba(255, 255, 255, 0.9)",
    color: palette.text.primary,
  },
  ".leaflet-container .leaflet-control-attribution a": {
    color: palette.mode === "dark" ? palette.primary.main : palette.primary.dark,
  },
});

/** The components' part of it: every MUI button shows the ring when the keyboard reaches it. */
const accessibleComponents = (palette, { reducedMotion = false } = {}) => ({
  MuiCssBaseline: { styleOverrides: globalRules(palette) },
  MuiButtonBase: {
    defaultProps: reducedMotion ? { disableRipple: true, disableTouchRipple: true } : {},
    styleOverrides: {
      root: {
        "&.Mui-focusVisible": {
          outline: `2px solid ${palette.primary.main}`,
          outlineOffset: 2,
        },
      },
    },
  },
});

/** MUI's own transitions, cut when the system asks for less motion (collapses, fades, drawers open at once). */
const NO_TRANSITIONS = {
  create: () => "none",
  duration: { shortest: 0, shorter: 0, short: 0, standard: 0, complex: 0, enteringScreen: 0, leavingScreen: 0 },
};

/**
 * The theme of a mode: `themeFor("light" | "dark", { reducedMotion })`.
 * `reducedMotion` is the system's setting (ThemeContext follows it); the CSS
 * rule applies it either way to what CSS animates.
 */
export function themeFor(mode = "light", { reducedMotion = false } = {}) {
  const options = mode === "dark" ? DARK_OPTIONS : LIGHT_OPTIONS;
  const base = createTheme(options);
  const accessible = accessibleComponents(base.palette, { reducedMotion });
  return createTheme({
    ...options,
    components: {
      ...options.components,
      ...accessible,
    },
    ...(reducedMotion ? { transitions: NO_TRANSITIONS } : {}),
  });
}

export const lightTheme = themeFor("light");
export const darkTheme = themeFor("dark");
