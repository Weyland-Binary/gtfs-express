/**
 * ThemeContext — the display preferences the whole app follows: the colour
 * mode, chosen by the person (the header's toggle, remembered) or else the
 * system's, and the system's request for less motion.
 *
 *   mode           "light" | "dark" (localStorage `themeMode`, else
 *                  prefers-color-scheme); a class `light-mode` / `dark-mode`
 *                  on <body> for the global stylesheets
 *   reducedMotion  true while the system asks for less motion
 *                  (prefers-reduced-motion: reduce), followed live: the theme
 *                  then cuts MUI's transitions and ripples (Theme.themeFor),
 *                  and a class `reduced-motion` on <body> lets the few
 *                  stylesheets outside MUI do the same (RGAA 13.8, WCAG
 *                  2.3.3); the CSS rule of the theme
 *                  covers the keyframes either way
 *
 * Storage can be missing (a private window, a sandboxed frame): the
 * preference then lives as long as the page.
 *
 * `LocalizedThemeDefaults` adds to the theme what needs the interface's
 * language: the name every progress indicator carries by default
 * (« Chargement... », WCAG 4.1.2 — a spinner without a name is announced as
 * a bare "progress bar"), unless its caller names it.
 * That name is only true of a loader: a determinate bar is a gauge (a quality
 * score, a count of fixes, a file being opened) and its caller names it by
 * what it measures — aria-label, or aria-labelledby on the sentence beside it,
 * which wins over this default; shortcutsAndPalette.test.js checks that every
 * determinate bar of the source is named so. And the words of every
 * Autocomplete (« Aucun résultat », clear, open, close, loading), which MUI
 * writes in English unless told (« No options » in a French screen), unless
 * its caller says its own.
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { useLanguage } from "./LanguageContext";

const ThemeContext = createContext();

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export const useThemeMode = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useThemeMode must be used within a ThemeModeProvider");
  }
  return context;
};

const readStored = () => {
  try {
    return localStorage.getItem("themeMode");
  } catch {
    return null;
  }
};

const matches = (query) => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;

/** Follow a media query live; `true` while it matches. */
export function useMediaPreference(query) {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const list = window.matchMedia(query);
    const onChange = () => setValue(list.matches);
    onChange();
    if (typeof list.addEventListener === "function") {
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    }
    // Older engines: the deprecated listener API.
    list.addListener?.(onChange);
    return () => list.removeListener?.(onChange);
  }, [query]);
  return value;
}

export const ThemeModeProvider = ({ children }) => {
  // The saved preference, else the system's.
  const getInitialMode = () => {
    const savedMode = readStored();
    if (savedMode === "light" || savedMode === "dark") return savedMode;
    return matches("(prefers-color-scheme: dark)") ? "dark" : "light";
  };

  const [mode, setMode] = useState(getInitialMode);
  const reducedMotion = useMediaPreference(REDUCED_MOTION_QUERY);

  useEffect(() => {
    try {
      localStorage.setItem("themeMode", mode);
    } catch {
      /* storage disabled: the mode lives as long as the page */
    }
    // A class on the body for the global stylesheets.
    document.body.classList.remove("light-mode", "dark-mode");
    document.body.classList.add(`${mode}-mode`);
  }, [mode]);

  useEffect(() => {
    document.body.classList.toggle("reduced-motion", reducedMotion);
  }, [reducedMotion]);

  const toggleMode = () => {
    setMode((prevMode) => (prevMode === "light" ? "dark" : "light"));
  };

  const value = {
    mode,
    toggleMode,
    isDark: mode === "dark",
    reducedMotion,
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

/** The theme's defaults that speak the interface's language (inside LanguageProvider). */
export function LocalizedThemeDefaults({ children }) {
  const { t } = useLanguage();
  const label = t("app.loading");
  const noOptions = t("app.noOptions");
  const clear = t("app.clear");
  const open = t("app.open");
  const close = t("app.close");
  const withDefaults = useCallback(
    (given) => {
      // Without a theme above (a test, a lone component), MUI's default one.
      const outer = given?.palette ? given : createTheme();
      const named = (name) => ({ ...outer.components?.[name], defaultProps: { "aria-label": label, ...outer.components?.[name]?.defaultProps } });
      const autocomplete = {
        ...outer.components?.MuiAutocomplete,
        defaultProps: { noOptionsText: noOptions, loadingText: label, clearText: clear, openText: open, closeText: close, ...outer.components?.MuiAutocomplete?.defaultProps },
      };
      return { ...outer, components: { ...outer.components, MuiCircularProgress: named("MuiCircularProgress"), MuiLinearProgress: named("MuiLinearProgress"), MuiAutocomplete: autocomplete } };
    },
    [label, noOptions, clear, open, close],
  );
  return <ThemeProvider theme={withDefaults}>{children}</ThemeProvider>;
}

export default ThemeContext;
