/**
 * A validator rule's title and description in French or English (the catalogue's only two languages), fetched once per
 * language. A report names a rule by the validator's notice code, which a few catalogue rules hold under another
 * name (`mobilitydata_match`): both lead to the same texts. Until the catalogue answers, or for a code it does not
 * know, the title is the code's English name and the description empty.
 */
import { useEffect, useMemo, useState } from "react";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { getRuleTitle } from "./ruleCatalog";

const EMPTY = Object.freeze({ titles: {}, descriptions: {} });
const loaded = new Map(); // lang → Promise<{ titles, descriptions }>

const textsOf = (body) => {
  const titles = { ...(body?.titles || {}) };
  const descriptions = {};
  for (const [code, rule] of Object.entries(body?.rules || {})) {
    if (rule?.title && !titles[code]) titles[code] = rule.title;
    if (rule?.description) descriptions[code] = String(rule.description);
  }
  for (const [code, rule] of Object.entries(body?.rules || {})) {
    const alias = rule?.mobilitydata_match;
    if (alias && alias !== code && !descriptions[alias] && descriptions[code]) descriptions[alias] = descriptions[code];
  }
  return { titles, descriptions };
};

const load = (lang) => {
  if (!loaded.has(lang)) {
    loaded.set(
      lang,
      fetchWithSession(`${API_BASE_URL}/edit/validate/catalogue?lang=${lang}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => textsOf(body))
        .catch(() => {
          loaded.delete(lang);
          return EMPTY;
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

export default function useRuleTexts() {
  const { language } = useLanguage();
  const lang = language === "fr" ? "fr" : "en";
  const [texts, setTexts] = useState(EMPTY);
  useEffect(() => {
    let live = true;
    load(lang).then((m) => live && setTexts(m || EMPTY));
    return () => {
      live = false;
    };
  }, [lang]);
  return useMemo(
    () => ({
      titleOf: (code) => texts.titles[code] || getRuleTitle(code),
      descriptionOf: (code) => texts.descriptions[code] || "",
      summaryOf: (code) => firstSentence(texts.descriptions[code]),
    }),
    [texts],
  );
}
