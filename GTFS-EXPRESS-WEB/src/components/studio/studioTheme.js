/**
 * The studio's look, layered over the app's theme by StudioScope. Geist's weight range stops at 650 (an 800 asked
 * for reads 650); every text tone reaches 4.5:1 on its surfaces, light and dark (studioTheme.test.js). State colours
 * go only in badges, icons and state lines, never whole sentences.
 * `theme.studio` (the tokens) tells a component it is drawn in the studio.
 */

import { alpha, createTheme } from "@mui/material/styles";
import "../../assets/fonts/geist/geist.css";

export const STUDIO_FONT = '"Geist", "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
export const STUDIO_MONO = '"Geist Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

export const STUDIO_TOKENS = Object.freeze({
  light: {
    ground: "#F4F5F7",
    surface: "#FFFFFF",
    subtle: "#F9FAFB",
    hover: "#F2F4F7",
    line: "#E4E7EC",
    lineSoft: "#EAECF0",
    lineStrong: "#D0D5DD",
    ink: "#101828",
    ink2: "#475467",
    ink3: "#5D6679",
    accent: "#2457D6",
    accentDark: "#1D46B3",
    accentSoft: "#EEF3FE",
    accentLine: "#C9D6F5",
    onAccent: "#FFFFFF",
    success: "#12804A",
    successSoft: "#E7F5EC",
    warning: "#B54708",
    warningSoft: "#FEF3E2",
    error: "#C4321F",
    errorSoft: "#FDECEA",
    float: "0 8px 24px -6px rgba(16,24,40,.16), 0 2px 4px -2px rgba(16,24,40,.06)",
    raise: "0 1px 2px rgba(16,24,40,.06)",
  },
  dark: {
    ground: "#0E1116",
    surface: "#161A21",
    subtle: "#1A1F27",
    hover: "#212732",
    line: "#262C36",
    lineSoft: "#222832",
    lineStrong: "#353D4A",
    ink: "#ECEEF2",
    ink2: "#B4BBC7",
    ink3: "#9AA3B2",
    accent: "#7B9BFF",
    accentDark: "#9DB4FF",
    accentSoft: "rgba(123,155,255,0.14)",
    accentLine: "rgba(123,155,255,0.35)",
    onAccent: "#0B1220",
    success: "#4CC38A",
    successSoft: "rgba(76,195,138,0.13)",
    warning: "#F0A44B",
    warningSoft: "rgba(240,164,75,0.13)",
    error: "#FF8A7A",
    errorSoft: "rgba(255,138,122,0.13)",
    float: "0 10px 28px -6px rgba(0,0,0,.55), 0 2px 6px -2px rgba(0,0,0,.4)",
    raise: "0 1px 2px rgba(0,0,0,.4)",
  },
});

export const tokensOf = (theme) => theme?.studio || STUDIO_TOKENS[theme?.palette?.mode === "dark" ? "dark" : "light"];

const STATE_ALERT = (k, soft, tone) => ({ backgroundColor: soft, borderColor: alpha(tone, 0.28), color: k.ink, "& .MuiAlert-icon": { color: tone } });

/** A function for MUI's nested ThemeProvider: stable, so the theme is made once per outer theme. */
export function studioTheme(outer) {
  const dark = outer.palette.mode === "dark";
  const k = STUDIO_TOKENS[dark ? "dark" : "light"];
  const theme = createTheme({
    ...outer,
    studio: k,
    palette: {
      ...outer.palette,
      primary: { main: k.accent, light: dark ? "#A9BCFF" : "#5B82E8", dark: k.accentDark, contrastText: k.onAccent },
      success: { main: k.success, light: dark ? "#7AD6A9" : "#3FA36F", dark: dark ? "#3AA674" : "#0E6B3B", contrastText: dark ? "#0B1220" : "#FFFFFF" },
      warning: { main: k.warning, light: dark ? "#F5BE7E" : "#DC8A2E", dark: dark ? "#F5BE7E" : "#8E3A0B", contrastText: dark ? "#0B1220" : "#FFFFFF" },
      error: { main: k.error, light: dark ? "#FFB0A5" : "#E5533F", dark: dark ? "#FFB0A5" : "#A42B1F", contrastText: dark ? "#0B1220" : "#FFFFFF" },
      info: { main: k.accent, light: dark ? "#A9BCFF" : "#5B82E8", dark: k.accentDark, contrastText: k.onAccent },
      background: { default: k.ground, paper: k.surface },
      text: { primary: k.ink, secondary: k.ink2, disabled: k.ink3 },
      divider: k.line,
      action: { ...outer.palette.action, hover: k.hover, selected: k.accentSoft },
    },
    // A fresh typography (never the outer one spread: its variants would keep the app's font).
    typography: {
      fontFamily: STUDIO_FONT,
      fontSize: 13,
      button: { textTransform: "none", fontWeight: 500, letterSpacing: 0 },
      h6: { fontWeight: 600, letterSpacing: "-0.01em" },
    },
    shape: { borderRadius: 8 },
    components: {
      ...outer.components,
      // The app's keyboard focus ring (Theme.js), in the studio's accent.
      MuiButtonBase: {
        ...outer.components?.MuiButtonBase,
        styleOverrides: { root: { "&.Mui-focusVisible": { outline: `2px solid ${k.accent}`, outlineOffset: 2 } } },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { borderRadius: 7, textTransform: "none", fontWeight: 500, letterSpacing: 0, minHeight: 32, lineHeight: 1.2, boxShadow: "none", "&:hover": { boxShadow: "none" } },
          sizeSmall: { minHeight: 28, padding: "3px 10px", fontSize: "0.78rem" },
          sizeMedium: { padding: "5px 12px", fontSize: "0.8125rem" },
          containedPrimary: { fontWeight: 600, boxShadow: dark ? "none" : "0 1px 2px rgba(16,24,40,.14), inset 0 1px 0 rgba(255,255,255,.14)", "&:hover": { backgroundColor: k.accentDark, boxShadow: "none" } },
          outlined: { borderColor: k.lineStrong, backgroundColor: k.surface, "&:hover": { borderColor: k.lineStrong, backgroundColor: k.hover } },
          outlinedPrimary: { color: k.ink },
          textPrimary: { color: dark ? k.accent : k.accentDark },
        },
      },
      MuiIconButton: { styleOverrides: { root: { borderRadius: 7 }, sizeSmall: { padding: 5 } } },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: 7,
            backgroundColor: k.surface,
            "& .MuiOutlinedInput-notchedOutline": { borderColor: k.lineStrong },
            "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: k.ink3 },
            "&.Mui-focused .MuiOutlinedInput-notchedOutline": { borderColor: k.accent, borderWidth: 1 },
            "&.Mui-focused": { boxShadow: `0 0 0 3px ${alpha(k.accent, dark ? 0.25 : 0.16)}` },
          },
          inputSizeSmall: { paddingTop: 7.5, paddingBottom: 7.5, fontSize: "0.8125rem" },
        },
      },
      MuiInputLabel: { styleOverrides: { root: { color: k.ink2, "&.Mui-focused": { color: dark ? k.accent : k.accentDark } } } },
      MuiChip: { styleOverrides: { root: { borderRadius: 999, fontWeight: 500 }, outlined: { borderColor: k.lineStrong } } },
      MuiTabs: { styleOverrides: { root: { minHeight: 40 }, indicator: { height: 2, borderRadius: 2 } } },
      MuiTab: { styleOverrides: { root: { textTransform: "none", fontWeight: 500, minHeight: 40, fontSize: "0.8125rem", color: k.ink2, "&.Mui-selected": { color: k.ink, fontWeight: 600 } } } },
      MuiAlert: {
        styleOverrides: {
          root: { borderRadius: 8, border: "1px solid", fontSize: "0.8125rem", padding: "2px 12px", alignItems: "flex-start" },
          icon: { padding: "8px 0", marginRight: 10, opacity: 1, fontSize: 18 },
          message: { padding: "8px 0" },
          action: { paddingTop: 2 },
          standardInfo: STATE_ALERT(k, k.accentSoft, k.accent),
          standardSuccess: STATE_ALERT(k, k.successSoft, k.success),
          standardWarning: STATE_ALERT(k, k.warningSoft, k.warning),
          standardError: STATE_ALERT(k, k.errorSoft, k.error),
        },
      },
      MuiTooltip: { styleOverrides: { tooltip: { backgroundColor: dark ? "#2A303B" : "#101828", color: "#FFFFFF", fontSize: "0.75rem", fontWeight: 500, borderRadius: 6, padding: "5px 8px" } } },
      MuiPaper: { styleOverrides: { root: { backgroundImage: "none" }, rounded: { borderRadius: 10 } } },
      MuiPopover: { styleOverrides: { paper: { border: `1px solid ${k.line}`, boxShadow: k.float, borderRadius: 10 } } },
      MuiMenu: { styleOverrides: { paper: { border: `1px solid ${k.line}`, boxShadow: k.float, borderRadius: 10 } } },
      MuiDialog: { styleOverrides: { paper: { borderRadius: 12, border: `1px solid ${k.line}` } } },
      MuiDivider: { styleOverrides: { root: { borderColor: k.line } } },
      MuiLinearProgress: { styleOverrides: { root: { borderRadius: 4 }, bar: { borderRadius: 4 } } },
      MuiToggleButton: { styleOverrides: { root: { borderRadius: 7, textTransform: "none", fontWeight: 500 } } },
    },
  });
  return theme;
}

export const studioGlobalStyles = (theme) => {
  const k = tokensOf(theme);
  return {
    body: { fontFamily: STUDIO_FONT, backgroundColor: k.ground, fontSynthesisWeight: "none" },
    // Buttons keep one shape, even where a component of the studio still asks for a pill.
    ".MuiButton-root": { borderRadius: "7px !important" },
    ".leaflet-container": { fontFamily: STUDIO_FONT },
    // The zoom at the bottom right: the top of the map holds the studio's own controls.
    ".leaflet-top.leaflet-left": { top: "auto", bottom: "26px", left: "auto", right: "12px" },
    ".leaflet-bar": { border: `1px solid ${k.line} !important`, borderRadius: "10px !important", boxShadow: `${k.float} !important`, overflow: "hidden" },
    ".leaflet-bar a, .leaflet-bar a:hover": { width: "32px !important", height: "32px !important", lineHeight: "30px !important", backgroundColor: k.surface, color: k.ink, borderBottomColor: `${k.lineSoft} !important` },
    ".leaflet-bar a:hover": { backgroundColor: `${k.hover} !important` },
    ".leaflet-control-attribution": { fontSize: "10.5px", backgroundColor: `${alpha(k.surface, 0.85)} !important`, borderRadius: "6px 0 0 0" },
  };
};
