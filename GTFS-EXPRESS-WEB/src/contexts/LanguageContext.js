/**
 * LanguageContext — the interface language and `t(key, params)`.
 *
 * `t()` looks a key up in the active language, then in English, then
 * returns the key itself so a missing string is visible, not blank. The
 * alias table of renamed keys (i18n/aliases.js) is read here too; it stays
 * empty.
 * The app opens in French, the source text, unless the person or the
 * deployment chose otherwise (getInitialLanguage).
 *
 * One language at a time: the eight blocks of src/i18n/translations.js
 * weigh 3.4 MB, too much for the app's first chunk. French travels with the app (`virtual:i18n/fr`, vite.i18n.js); the
 * seven others are chunks of their own, loaded when chosen — the switch waits
 * for the dictionary, so a screen never shows keys — and the one saved
 * before the app renders (`preloadLanguage`, index.js). The English fallback
 * of a missing key loads itself the first time it is needed.
 */
import React, { createContext, useContext, useState, useEffect, useCallback, useReducer } from "react";
import fr from "virtual:i18n/fr";
import ALIASES from "../i18n/aliases";

// French is the source text of the interface and the language it opens in,
// before the browser's: the person's choice (localStorage.appLanguage)
// comes first, then the deployment's VITE_DEFAULT_LANGUAGE (default "fr");
// only a deployment that sets it to "auto" follows the browser's language.
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

// Each language's dictionary, its own chunk (a static map: the bundler names every chunk from here).
const LOADERS = {
  en: () => import("virtual:i18n/en"),
  es: () => import("virtual:i18n/es"),
  de: () => import("virtual:i18n/de"),
  pt: () => import("virtual:i18n/pt"),
  zh: () => import("virtual:i18n/zh"),
  hi: () => import("virtual:i18n/hi"),
};
// The dictionaries at hand: French from the start, the others once loaded.
const loaded = { fr };
const pending = {};
const known = (code) => code === DEFAULT_LANGUAGE || Boolean(LOADERS[code]);

/** The dictionary of a language, loaded once (French is in the app itself); an unknown code rejects. */
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

/** Before the first render: the saved language's dictionary, so the app opens in it (never in keys). */
export const preloadLanguage = (code) => (known(code) ? loadLanguage(code).catch(() => null) : Promise.resolve(null));

/** What the dictionaries hold right now (tests, the fallback): the loaded languages by code. */
export const loadedLanguages = () => loaded;

/**
 * The deployment's default language (VITE_DEFAULT_LANGUAGE): a language we
 * have, "auto" (null: follow the browser), or — unset or unknown — French.
 */
const configuredDefault = (value = import.meta.env?.VITE_DEFAULT_LANGUAGE) => {
  const code = String(value || "").trim().toLowerCase();
  if (code === "auto") return null;
  return code && known(code) ? code : DEFAULT_LANGUAGE;
};

/**
 * The language the app opens in: the person's choice, else the deployment's
 * default, else (with "auto") the browser's, else French.
 */
export const getInitialLanguage = (configured = configuredDefault()) => {
  const saved = localStorage.getItem("appLanguage");
  if (saved && known(saved)) return saved;
  // The deployment's choice comes before the browser's: a French product
  // opens in French, whatever the browser says.
  if (configured) return configured;
  // "auto": detect from the browser.
  const browserLang = navigator.language?.split("-")[0];
  if (browserLang && known(browserLang)) return browserLang;
  return DEFAULT_LANGUAGE;
};

/**
 * One key in one language: the key itself, else its alias (i18n/aliases.js,
 * kept empty). Returns undefined when the block has neither.
 */
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
 * `t` where a LanguageProvider may be missing: the root error boundary sits
 * above it (index.js), and a crash of the provider itself must still say
 * something. Inside a provider, its `t`; outside, the saved language's
 * dictionary when it is loaded (preloadLanguage, before the first render),
 * then English, then French (always in the app), then the key. No params:
 * the boundary's sentences have none.
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
  // Bumped when a dictionary arrives (the active language's, or English for a fallback): `t` reads again.
  const [tick, bump] = useReducer((n) => n + 1, 0);

  useEffect(() => {
    localStorage.setItem("appLanguage", language);
    document.documentElement.lang = language;
  }, [language]);

  // The language the app opened in, not preloaded (a test, a deployment without index.js's preload): loaded here.
  useEffect(() => {
    if (loaded[language]) return undefined;
    let live = true;
    loadLanguage(language).then(() => live && bump(), () => {});
    return () => {
      live = false;
    };
  }, [language]);

  // The switch waits for the dictionary: a screen never shows keys.
  const setLanguage = useCallback((code) => {
    if (!known(code)) return;
    if (loaded[code]) setLanguageState(code);
    else loadLanguage(code).then(() => setLanguageState(code), () => {});
  }, []);

  const t = useCallback(
    (key, params) => {
      // The active language, then the English fallback (loaded the first time a key needs it), then the key
      // itself so a missing string is visible, not blank.
      let value = lookup(loaded[language], key);
      if (value === undefined && language !== "en") {
        value = lookup(loaded.en, key);
        if (value === undefined && !loaded.en) loadLanguage("en").then(() => bump(), () => {});
      }
      value = value || key;
      if (!params) return value;
      return Object.entries(params).reduce((str, [k, v]) => str.replace(new RegExp(`\\{${k}\\}`, "g"), v), value);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [language, tick],
  );

  const value = {
    language,
    setLanguage,
    t,
    languages: SUPPORTED_LANGUAGES,
  };

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
};
