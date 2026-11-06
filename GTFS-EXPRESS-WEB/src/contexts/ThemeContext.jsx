/**
 * The colour mode (light, unless the person chose dark with the toggle) and the system's reduced-motion request,
 * followed live: the theme then cuts MUI's transitions, and a `reduced-motion` class on <body> lets the
 * stylesheets outside MUI do the same (RGAA 13.8, WCAG 2.3.3).
 *
 * `LocalizedThemeDefaults` gives every progress indicator a default accessible name (WCAG 4.1.2: an unnamed
 * spinner is announced as a bare "progress bar") and MUI's Autocomplete its words, which it otherwise writes in
 * English. A determinate bar is a gauge: its caller names it by what it measures (shortcutsAndPalette.test.js).
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
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

// Only a choice made with the toggle is kept. The former key was also written for a mode taken from the system, so
// it is not read: everyone starts in light until they choose.
export const THEME_KEY = "gtfs:theme";

const readStored = () => {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
};

const store = (mode) => {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* storage disabled: the mode lives as long as the page */
  }
};

const matches = (query) => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;

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
  const getInitialMode = () => {
    const savedMode = readStored();
    return savedMode === "dark" ? "dark" : "light";
  };

  const [mode, setMode] = useState(getInitialMode);
  const reducedMotion = useMediaPreference(REDUCED_MOTION_QUERY);

  useEffect(() => {
    document.body.classList.remove("light-mode", "dark-mode");
    document.body.classList.add(`${mode}-mode`);
  }, [mode]);

  useEffect(() => {
    document.body.classList.toggle("reduced-motion", reducedMotion);
  }, [reducedMotion]);

  const toggleMode = useCallback(() => {
    setMode((prevMode) => {
      const next = prevMode === "light" ? "dark" : "light";
      store(next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ mode, toggleMode, isDark: mode === "dark", reducedMotion }), [mode, toggleMode, reducedMotion]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

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
