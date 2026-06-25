import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import translations from "../i18n/translations";

const LanguageContext = createContext();

const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English", flag: "🇬🇧" },
  { code: "fr", label: "Français", flag: "🇫🇷" },
  { code: "es", label: "Español", flag: "🇪🇸" },
  { code: "de", label: "Deutsch", flag: "🇩🇪" },
  { code: "pt", label: "Português", flag: "🇧🇷" },
  { code: "zh", label: "中文", flag: "🇨🇳" },
  { code: "ar", label: "العربية", flag: "🇸🇦" },
  { code: "hi", label: "हिन्दी", flag: "🇮🇳" },
];

const getInitialLanguage = () => {
  const saved = localStorage.getItem("appLanguage");
  if (saved && translations[saved]) return saved;

  // Detect from browser
  const browserLang = navigator.language?.split("-")[0];
  if (browserLang && translations[browserLang]) return browserLang;

  return "en";
};

export const useLanguage = () => {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return context;
};

export const LanguageProvider = ({ children }) => {
  const [language, setLanguageState] = useState(getInitialLanguage);

  useEffect(() => {
    localStorage.setItem("appLanguage", language);
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  }, [language]);

  const setLanguage = useCallback((code) => {
    if (translations[code]) setLanguageState(code);
  }, []);

  const t = useCallback(
    (key, params) => {
      const value =
        translations[language]?.[key] || translations.en?.[key] || key;
      if (!params) return value;
      return Object.entries(params).reduce(
        (str, [k, v]) => str.replace(new RegExp(`\\{${k}\\}`, "g"), v),
        value,
      );
    },
    [language],
  );

  const value = {
    language,
    setLanguage,
    t,
    languages: SUPPORTED_LANGUAGES,
  };

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
};
