/**
 * The interface language and `t(key, params)`. One language is loaded at a time: all of them together are too
 * heavy for the first chunk, so each language is its own chunk, loaded when chosen, and the first one before the
 * first render by `preloadLanguage` (src/index.jsx), so the app never opens showing keys. English is the fallback
 * for a key missing from the language shown.
 */
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useReducer } from "react";
import ALIASES from "../i18n/aliases";

const DEFAULT_LANGUAGE = "fr";

const LanguageContext = createContext();

const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English", flag: "🇬🇧" },
  { code: "fr", label: "Français", flag: "🇫🇷" },
  { code: "es", label: "Español", flag: "🇪🇸" },
  { code: "de", label: "Deutsch", flag: "🇩🇪" },
  { code: "pt", label: "Português", flag: "🇧🇷" },
  { code: "zh", label: "中文", flag: "🇨🇳" },
  { code: "hi", label: "हिन्दी", flag: "🇮🇳" },
];

// A static map so the bundler can name every chunk.
const LOADERS = {
  fr: () => import("virtual:i18n/fr"),
  en: () => import("virtual:i18n/en"),
  es: () => import("virtual:i18n/es"),
  de: () => import("virtual:i18n/de"),
  pt: () => import("virtual:i18n/pt"),
  zh: () => import("virtual:i18n/zh"),
  hi: () => import("virtual:i18n/hi"),
};
const loaded = {};
const pending = {};
const known = (code) => Boolean(LOADERS[code]);

export const loadLanguage = (code) => {
  if (loaded[code]) return Promise.resolve(loaded[code]);
  if (!LOADERS[code]) return Promise.reject(new Error(`unknown language ${code}`));
  if (!pending[code]) {
    pending[code] = LOADERS[code]()
      .then((m) => {
        loaded[code] = m.default;
        return loaded[code];
      })
      .finally(() => {
        delete pending[code];
      });
  }
  return pending[code];
};

/** Before the first render, so the app never opens showing keys. */
export const preloadLanguage = (code) => (known(code) ? loadLanguage(code).catch(() => null) : Promise.resolve(null));

export const loadedLanguages = () => loaded;

/** VITE_DEFAULT_LANGUAGE: "auto" gives null (follow the browser); unset or unknown gives French. */
const configuredDefault = (value = import.meta.env?.VITE_DEFAULT_LANGUAGE) => {
  const code = String(value || "").trim().toLowerCase();
  if (code === "auto") return null;
  return code && known(code) ? code : DEFAULT_LANGUAGE;
};

/**
 * The address's language (/en/, /es/…), else the person's choice, else the deployment's default, else (with
 * "auto") the browser's, else French.
 */
export const getInitialLanguage = (configured = configuredDefault(), pathname = typeof window !== "undefined" ? window.location.pathname : "/") => {
  // Kept as the person's choice: they came for that language.
  const asked = /^\/([a-z]{2})\/?$/.exec(String(pathname || ""))?.[1];
  if (asked && known(asked)) {
    try {
      localStorage.setItem("appLanguage", asked);
    } catch {
      /* storage blocked: the address still says it */
    }
    return asked;
  }
  const saved = localStorage.getItem("appLanguage");
  if (saved && known(saved)) return saved;
  if (configured) return configured;
  const browserLang = navigator.language?.split("-")[0];
  if (browserLang && known(browserLang)) return browserLang;
  return DEFAULT_LANGUAGE;
};

const lookup = (block, key) => {
  if (!block) return undefined;
  if (block[key] !== undefined) return block[key];
  const alias = ALIASES[key];
  return alias ? block[alias] : undefined;
};

export const useLanguage = () => {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return context;
};

/**
 * For the root error boundary, which sits above the provider and must still speak when the provider itself
 * crashes. Takes no params: the boundary's sentences have none.
 */
const translateOutsideProvider = (key) => {
  let code = DEFAULT_LANGUAGE;
  try {
    code = getInitialLanguage();
  } catch {
    // localStorage blocked: the default language.
  }
  return lookup(loaded[code], key) ?? lookup(loaded.en, key) ?? lookup(loaded[DEFAULT_LANGUAGE], key) ?? key;
};

export const useOptionalT = () => {
  const context = useContext(LanguageContext);
  return context?.t || translateOutsideProvider;
};

export const LanguageProvider = ({ children }) => {
  const [language, setLanguageState] = useState(() => getInitialLanguage());
  // Bumped when a dictionary arrives, so `t` reads again.
  const [tick, bump] = useReducer((n) => n + 1, 0);

  useEffect(() => {
    localStorage.setItem("appLanguage", language);
    document.documentElement.lang = language;
  }, [language]);

  // For a start without the preload (a test).
  useEffect(() => {
    if (loaded[language]) return undefined;
    let live = true;
    loadLanguage(language).then(() => live && bump(), () => {});
    return () => {
      live = false;
    };
  }, [language]);

  // The switch waits for the dictionary, so a screen never shows keys.
  const setLanguage = useCallback((code) => {
    if (!known(code)) return;
    if (loaded[code]) setLanguageState(code);
    else loadLanguage(code).then(() => setLanguageState(code), () => {});
  }, []);

  const t = useCallback(
    (key, params) => {
      // English is loaded the first time a key needs it; a missing key shows itself rather than a blank.
      let value = lookup(loaded[language], key);
      if (value === undefined && language !== "en") {
        value = lookup(loaded.en, key);
        if (value === undefined && !loaded.en) loadLanguage("en").then(() => bump(), () => {});
      }
      value = value || key;
      if (!params) return value;
      // A replacer function: a value holding `$&`, `$'` or `$$` is written as it is, and a missing one as nothing.
      return Object.entries(params).reduce((str, [k, v]) => str.replace(new RegExp(`\\{${k}\\}`, "g"), () => String(v ?? "")), value);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [language, tick],
  );

  // Its parent re-renders on every navigation: a new object would re-render every useLanguage() consumer with it.
  const value = useMemo(() => ({ language, setLanguage, t, languages: SUPPORTED_LANGUAGES }), [language, setLanguage, t]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
};
