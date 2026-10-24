// What crawlers that run no JavaScript read: at build, from the app's translations, each language's Home with its
// head and Home's words in the root (replaced by the app once it runs), the public pages, the sitemap and llms.txt.
// Prices are never written here: the server says them.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { CONTENT_LANGUAGES, articlePage, contentOf, guidesIndex, notFoundPage, organizationOf, paths, rulesIndex, rulesList } from "./seo/pages.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(ROOT, "src/i18n/translations.js");
const GUIDES_DIR = path.join(ROOT, "seo/guides");
const RULES_DIR = path.join(ROOT, "seo/rules");
const CATALOGUE = path.join(ROOT, "seo/rules-catalogue.json");
// For the structured data's sameAs.
const SAME_AS = [String(process.env.VITE_SOURCE_CODE_URL || "https://github.com/Weyland-Binary/gtfs-express")];

/** French first: its page is `/`. */
export const LANGUAGES = [
  { code: "fr", locale: "fr_FR", name: "Français" },
  { code: "en", locale: "en_US", name: "English" },
  { code: "es", locale: "es_ES", name: "Español" },
  { code: "de", locale: "de_DE", name: "Deutsch" },
  { code: "pt", locale: "pt_PT", name: "Português" },
  { code: "zh", locale: "zh_CN", name: "中文" },
  { code: "hi", locale: "hi_IN", name: "हिन्दी" },
];
const PUBLIC_PAGES = [
  ["/regles", "footer.validationRules"],
  ["/accessibilite", "seo.accessibility"],
  ["/conditions/mentions-legales", "legal.tab.mentions-legales"],
  ["/conditions/utilisation", "legal.tab.utilisation"],
  ["/conditions/licence", "legal.tab.licence"],
  ["/conditions/confidentialite", "legal.tab.confidentialite"],
];

export const homePath = (code) => (code === "fr" ? "/" : `/${code}/`);

/** The file is one object literal and its default export: evaluated alone, nothing else runs. */
export const loadTranslations = (file = FILE) => {
  const source = fs.readFileSync(file, "utf8").replace(/export\s+default\s+translations;?\s*$/, "module.exports = translations;");
  const module = { exports: {} };
  vm.runInNewContext(source, { module }, { filename: file });
  return module.exports;
};

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// JSON inside <script>: never a closing tag.
const json = (v) => JSON.stringify(v, null, 2).replace(/</g, "\\u003c");

/** French where a key is missing, so a raw key never reaches the page. */
export const wordsOf = (dict, code) => {
  const own = dict[code] || {};
  const fr = dict.fr || {};
  return (key, params = {}) => {
    const v = own[key] ?? fr[key];
    if (v == null) throw new Error(`seo: no text for "${key}" (${code})`);
    return String(v).replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
  };
};
// A language without its own guides and rules gets the English ones.
const contentLang = (code) => (CONTENT_LANGUAGES.includes(code) ? code : "en");
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

export const headOf = ({ dict, code, site }) => {
  const t = wordsOf(dict, code);
  const url = `${site}${homePath(code)}`;
  const lang = LANGUAGES.find((l) => l.code === code);
  const title = `${t("seo.title")} | GTFS Express`;
  const description = t("seo.description");
  const alternates = [...LANGUAGES.map((l) => `<link rel="alternate" hreflang="${l.code}" href="${site}${homePath(l.code)}" />`), `<link rel="alternate" hreflang="x-default" href="${site}/" />`];
  const app = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "GTFS Express",
    url,
    description,
    inLanguage: code,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    image: `${site}/img/og-preview.png`,
    // Reading is free; the licence's price is the server's to say.
    offers: { "@type": "Offer", price: "0", priceCurrency: "EUR", description: t("learn.licence.readText") },
    publisher: organizationOf(site, SAME_AS),
  };
  const faq = { "@context": "https://schema.org", "@type": "FAQPage", inLanguage: code, mainEntity: range(8).map((i) => ({ "@type": "Question", name: t(`learn.faq.q${i}`), acceptedAnswer: { "@type": "Answer", text: t(`learn.faq.a${i}`) } })) };
  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    `<meta name="robots" content="index, follow" />`,
    `<link rel="canonical" href="${url}" />`,
    ...alternates,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="GTFS Express" />`,
    `<meta property="og:locale" content="${lang.locale}" />`,
    ...LANGUAGES.filter((l) => l.code !== code).map((l) => `<meta property="og:locale:alternate" content="${l.locale}" />`),
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:image" content="${site}/img/og-preview.png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
    `<meta name="twitter:image" content="${site}/img/og-preview.png" />`,
    `<script type="application/ld+json">${json([app, faq])}</script>`,
  ].join("\n    ");
};

const FEATURE_KEYS = ["reader", "assistant", "hand", "shapes", "brief", "sheets", "quality", "sql"];

export const bodyOf = ({ dict, code }) => {
  const t = wordsOf(dict, code);
  const li = (items) => `<ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul>`;
  const titled = (title, text) => `<strong>${esc(title)}.</strong> ${esc(text)}`;
  const sections = [
    `<header><h1>${esc(`${t("hero.titleBefore")}${t("hero.highlight")}${t("hero.titleAfter")}`)}</h1><p>${esc(t("home.hero.sub"))}</p>${li(["validator", "decision", "files"].map((k) => esc(t(`home.strip.${k}`))))}</header>`,
    // Home's features (home/HomeFeatures).
    `<section><h2>${esc(t("home.features.title"))}</h2><p>${esc(t("home.features.lead"))}</p>${li(FEATURE_KEYS.map((k) => titled(t(`home.features.${k}.title`), t(`home.features.${k}.text`))))}</section>`,
    `<section><h2>${esc(t("learn.journey.title"))}</h2><ol>${range(3).map((i) => `<li>${titled(t(`learn.journey.s${i}.title`), t(`learn.journey.s${i}.text`))}</li>`).join("")}</ol></section>`,
    `<section><h2>${esc(t("learn.trust.title"))}</h2>${li(["learn.trust.t1", "learn.trust.t4", "learn.trust.t6", "learn.data.d2"].map((k) => titled(t(`${k}.title`), t(`${k}.text`))))}</section>`,
    `<section><h2>${esc(t("learn.licence.title"))}</h2>${li([titled(t("learn.licence.read"), t("learn.licence.readText")), titled(t("learn.licence.name"), t("learn.licence.text")), titled(t("learn.licence.quote"), t("learn.licence.quoteText"))])}</section>`,
    `<section><h2>${esc(t("learn.faq.title"))}</h2><dl>${range(8).map((i) => `<dt>${esc(t(`learn.faq.q${i}`))}</dt><dd>${esc(t(`learn.faq.a${i}`))}</dd>`).join("")}</dl></section>`,
  ];
  const lang = contentLang(code);
  const pages = [[paths.guides(lang), t("seo.guides")], [paths.rules(lang), t("footer.validationRules")], ...PUBLIC_PAGES.slice(1).map(([href, key]) => [href, t(key)])];
  const others = LANGUAGES.filter((l) => l.code !== code);
  const footer = `<footer><nav>${pages.map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join(" · ")}</nav><nav aria-label="${esc(t("seo.languages"))}"><p>${esc(t("seo.languages"))}</p>${others.map((l) => `<a href="${homePath(l.code)}" hreflang="${l.code}" lang="${l.code}">${esc(l.name)}</a>`).join(" · ")}</nav></footer>`;
  const style = `<style>#seo-static{max-width:880px;margin:0 auto;padding:40px 20px 64px;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1e293b}#seo-static h1{font-size:2rem;line-height:1.2;margin:0 0 12px}#seo-static h2{font-size:1.3rem;margin:32px 0 8px}#seo-static h3{font-size:1.05rem;margin:16px 0 4px}#seo-static a{color:#1655b8}#seo-static dt{font-weight:600;margin-top:12px}#seo-static dd{margin:2px 0 0}@media (prefers-color-scheme:dark){#seo-static{color:#e2e8f0}#seo-static a{color:#93c5fd}}</style>`;
  return `${style}<div id="seo-static"><a href="${homePath(code)}"><strong>GTFS Express</strong></a>${sections.join("")}${footer}</div>`;
};

const withHead = (html, { head, code, root = "" }) => {
  const start = html.indexOf("<!-- seo:start -->");
  const end = html.indexOf("<!-- seo:end -->");
  if (start < 0 || end < start) throw new Error("seo: index.html has no <!-- seo:start --> … <!-- seo:end --> block");
  if (!html.includes('<div id="root"></div>')) throw new Error('seo: index.html has no empty <div id="root"></div>');
  return (html.slice(0, start) + `<!-- seo:start -->\n    ${head}\n    ` + html.slice(end))
    .replace(/<html lang="[^"]*">/, `<html lang="${code}">`)
    .replace('<div id="root"></div>', `<div id="root">${root}</div>`);
};

export const pageOf = ({ html, dict, code, site }) => withHead(html, { head: headOf({ dict, code, site }), code, root: bodyOf({ dict, code }) });

/** Its own title and canonical address, so that an index keeps it as a page of its own. */
export const publicPageOf = ({ html, dict, href, key, site, root = "" }) => {
  const t = wordsOf(dict, "fr");
  const title = `${t(key)} | GTFS Express`;
  const head = [`<title>${esc(title)}</title>`, `<meta name="description" content="${esc(t("seo.description"))}" />`, `<link rel="canonical" href="${site}${href}" />`, `<meta property="og:title" content="${esc(title)}" />`, `<meta property="og:url" content="${site}${href}" />`].join("\n    ");
  return withHead(html, { head, code: "fr", root });
};

/**
 * No canonical and no Home words in the root, so that reloading a network never flashes Home's text; never indexed, as
 * its addresses are a person's networks and projects.
 */
export const appPageOf = ({ html, dict }) => withHead(html, { head: [`<title>GTFS Express</title>`, `<meta name="description" content="${esc(wordsOf(dict, "fr")("seo.description"))}" />`, `<meta name="robots" content="noindex, follow" />`].join("\n    "), code: "fr" });

export const sitemapOf = ({ site, date, content = { guides: [], rules: [] } }) => {
  const alt = (pairs) => pairs.map(([l, p]) => `<xhtml:link rel="alternate" hreflang="${l}" href="${site}${p}"/>`).join("");
  const url = (p, lastmod, priority, alternates = "") => `  <url><loc>${site}${p}</loc><lastmod>${lastmod}</lastmod><priority>${priority}</priority>${alternates}</url>`;
  const homeAlternates = alt([...LANGUAGES.map((l) => [l.code, homePath(l.code)]), ["x-default", "/"]]);
  const homes = LANGUAGES.map((l) => url(homePath(l.code), date, l.code === "fr" ? "1.0" : "0.8", homeAlternates));
  const pages = PUBLIC_PAGES.map(([p]) => url(p, date, "0.5"));
  // The French list of the rules is /regles, among the public pages.
  const lists = [...CONTENT_LANGUAGES.map((l) => url(paths.guides(l), date, "0.7", alt(CONTENT_LANGUAGES.map((x) => [x, paths.guides(x)])))), url(paths.rules("en"), date, "0.6", alt(CONTENT_LANGUAGES.map((x) => [x, paths.rules(x)])))];
  const items = [...content.guides, ...content.rules].map((i) => url(i.path, i.meta.updated, i.kind === "guide" ? "0.8" : "0.6", alt(Object.entries(i.alternates))));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${[...homes, ...pages, ...lists, ...items].join("\n")}\n</urlset>\n`;
};

export const llmsOf = ({ dict, site, content = { guides: [], rules: [] } }) => {
  const part = (code) => {
    const t = wordsOf(dict, code);
    return [`## ${t("seo.title")}`, "", t("seo.description"), "", ...range(3).map((i) => `- ${t(`learn.journey.s${i}.title`)}. ${t(`learn.journey.s${i}.text`)}`), `- ${t("learn.trust.title")}`, `- ${t("learn.licence.title")}`].join("\n");
  };
  const pages = [["Accueil (fr)", "/"], ["Home (en)", "/en/"], ["Règles de validation (fr)", "/regles"], ["Validation rules (en)", "/en/rules/"], ["Guides (fr)", "/guides/"], ["Guides (en)", "/en/guides/"], ["Accessibilité", "/accessibilite"], ["Mentions légales", "/conditions/mentions-legales"]];
  const guides = CONTENT_LANGUAGES.flatMap((l) => content.guides.filter((g) => g.lang === l).map((g) => `- [${g.meta.title}](${site}${g.path}): ${g.meta.description}`));
  return [`# GTFS Express`, "", `> ${wordsOf(dict, "en")("seo.description")}`, "", part("fr"), "", part("en"), "", "## Pages", "", ...pages.map(([label, p]) => `- [${label}](${site}${p})`), "", ...(guides.length ? ["## Guides", "", ...guides, ""] : [])].join("\n");
};

/** The codes of the rules with a detailed page; a plugin of its own because it runs in every mode, not at build only. */
export function seoRulePages() {
  const ID = "virtual:seo/rule-pages";
  const RESOLVED = `\0${ID}`;
  return {
    name: "seo-rule-pages",
    resolveId(id) {
      return id === ID ? RESOLVED : null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      // Every rule of the catalogue has its page, written from it when no file describes the rule.
      const codes = Object.keys(JSON.parse(fs.readFileSync(CATALOGUE, "utf8")).rules).sort();
      return `export default ${JSON.stringify(codes)};`;
    },
  };
}

/** dist/app.html is what nginx serves for the app's own addresses, dist/404.html for any other unknown one. */
export default function seo() {
  let outDir = "dist";
  return {
    name: "seo",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const site = String(process.env.VITE_SITE_URL || "https://gtfsexpress.com").replace(/\/+$/, "");
      const dict = loadTranslations();
      const catalogue = JSON.parse(fs.readFileSync(CATALOGUE, "utf8"));
      const content = contentOf({ guidesDir: GUIDES_DIR, rulesDir: RULES_DIR, catalogue });
      const index = path.join(outDir, "index.html");
      const html = fs.readFileSync(index, "utf8");
      const write = (file, text) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      };
      write(path.join(outDir, "app.html"), appPageOf({ html, dict }));
      write(path.join(outDir, "404.html"), notFoundPage({ t: Object.fromEntries(CONTENT_LANGUAGES.map((l) => [l, wordsOf(dict, l)])) }));
      for (const { code } of LANGUAGES) write(code === "fr" ? index : path.join(outDir, code, "index.html"), pageOf({ html, dict, code, site }));
      // /regles carries every rule in its root for a reader without JavaScript.
      const frRules = rulesList({ lang: "fr", catalogue, rules: content.rules, t: wordsOf(dict, "fr") });
      for (const [href, key] of PUBLIC_PAGES) write(path.join(outDir, ...href.split("/").filter(Boolean), "index.html"), publicPageOf({ html, dict, href, key, site, root: href === "/regles" ? `<div id="seo-static">${frRules}</div>` : "" }));
      const at = (p) => path.join(outDir, ...p.split("/").filter(Boolean), "index.html");
      for (const item of [...content.guides, ...content.rules]) write(at(item.path), articlePage({ item, t: wordsOf(dict, item.lang), site, sameAs: SAME_AS, catalogue }));
      for (const lang of CONTENT_LANGUAGES) write(at(paths.guides(lang)), guidesIndex({ lang, guides: content.guides, t: wordsOf(dict, lang), site }));
      write(at(paths.rules("en")), rulesIndex({ lang: "en", catalogue, rules: content.rules, t: wordsOf(dict, "en"), site }));
      fs.writeFileSync(path.join(outDir, "sitemap.xml"), sitemapOf({ site, date: new Date().toISOString().slice(0, 10), content }));
      fs.writeFileSync(path.join(outDir, "llms.txt"), llmsOf({ dict, site, content }));
    },
  };
}
