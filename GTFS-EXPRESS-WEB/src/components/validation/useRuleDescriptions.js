/**
 * Validator rule descriptions in French or English (the catalogue's only two languages), fetched once per language.
 * `describe(code)` gives the first sentence, or "" while loading or for an unknown rule.
 */
import { useEffect, useState } from "react";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";

const loaded = new Map(); // lang → Promise<{ code: description }>

const load = (lang) => {
  if (!loaded.has(lang)) {
    loaded.set(
      lang,
      fetchWithSession(`${API_BASE_URL}/edit/validate/catalogue?lang=${lang}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => Object.fromEntries(Object.entries(body?.rules || {}).map(([code, r]) => [code, String(r.description || "")])))
        .catch(() => {
          loaded.delete(lang);
          return {};
        }),
    );
  }
  return loaded.get(lang);
};

const firstSentence = (text) => {
  const s = String(text || "").trim();
  const end = s.search(/[.!?](\s|$)/);
  return end > 0 ? s.slice(0, end + 1) : s;
};

export default function useRuleDescriptions() {
  const { language } = useLanguage();
  const lang = language === "fr" ? "fr" : "en";
  const [map, setMap] = useState({});
  useEffect(() => {
    let live = true;
    load(lang).then((m) => live && setMap(m || {}));
    return () => {
      live = false;
    };
  }, [lang]);
  return (code) => firstSentence(map[code]);
}
