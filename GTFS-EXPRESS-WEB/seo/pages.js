// The public content pages (guides and rule pages), written at build by vite.seo.js as static HTML without the app
// bundle, so search engines and assistants read them whole. Each comes from a seo/guides or seo/rules file (front
// matter, then a small Markdown subset), French and English linked as alternates; a rule without a file of its own gets
// a page written from the validator's catalogue. The French rule list is the app's own /regles page.
import fs from "node:fs";
import path from "node:path";

export const CONTENT_LANGUAGES = ["fr", "en"];

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const json = (v) => JSON.stringify(v, null, 2).replace(/</g, "\\u003c");

export const paths = {
  home: (lang) => (lang === "fr" ? "/" : `/${lang}/`),
  guides: (lang) => (lang === "fr" ? "/guides/" : `/${lang}/guides/`),
  guide: (lang, slug) => (lang === "fr" ? `/guides/${slug}` : `/${lang}/guides/${slug}`),
  rules: (lang) => (lang === "fr" ? "/regles" : `/${lang}/rules/`),
  rule: (lang, code) => (lang === "fr" ? `/regles/${code}` : `/${lang}/rules/${code}`),
};

/** Front matter: key: value lines between two ---. */
export const parseContent = (text) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text));
  if (!m) throw new Error("seo: a content file must start with front matter between --- lines");
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    meta[kv[1]] = v;
  }
  return { meta, body: m[2].replace(/\r\n/g, "\n").trim() };
};

/** Escaped first; a link's target is kept as written. */
const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => `<a href="${href.replace(/&amp;/g, "&")}">${text}</a>`);

/**
 * The Markdown subset: ## and ### headings, paragraphs, one-level - and 1. lists, fenced code, inline code, bold and
 * links; anything else reads as text. Also returns the page's ## sections.
 */
export const renderMarkdown = (md) => {
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  const headings = [];
  let para = [];
  let list = null;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      flush();
      const code = [];
      for (i += 1; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{2,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      const id = h[2].toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (level === 2) headings.push({ id, text: h[2] });
      out.push(`<h${level} id="${id}">${inline(h[2])}</h${level}>`);
      continue;
    }
    const li = /^(-|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      if (para.length) flush();
      const tag = li[1] === "-" ? "ul" : "ol";
      if (list && list.tag !== tag) flush();
      list = list || { tag, items: [] };
      list.items.push(li[2]);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (list) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return { html: out.join("\n"), headings };
};

export const readContentDir = (dir) => {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^[a-z0-9_-]+\.(fr|en)\.md$/.test(f))
    .sort()
    .map((f) => {
      const [, key, lang] = /^(.+)\.(fr|en)\.md$/.exec(f);
      const { meta, body } = parseContent(fs.readFileSync(path.join(dir, f), "utf8"));
      for (const k of ["title", "description", "updated"]) if (!meta[k]) throw new Error(`seo: ${f} has no ${k}`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.updated)) throw new Error(`seo: ${f} has no updated date as YYYY-MM-DD`);
      return { key, lang, meta, body };
    });
};

/** With the catalogue, every rule of it has a page in each language: its own file, else one written from the catalogue. */
export const contentOf = ({ guidesDir, rulesDir, catalogue = null }) => {
  const guides = readContentDir(guidesDir).map((g) => {
    if (!g.meta.slug || !/^[a-z0-9-]+$/.test(g.meta.slug)) throw new Error(`seo: guide ${g.key}.${g.lang} has no valid slug`);
    return { ...g, kind: "guide", path: paths.guide(g.lang, g.meta.slug) };
  });
  const written = readContentDir(rulesDir);
  const has = new Set(written.map((r) => `${r.key}.${r.lang}`));
  const fromCatalogue = catalogue ? Object.keys(catalogue.rules).flatMap((code) => CONTENT_LANGUAGES.filter((lang) => !has.has(`${code}.${lang}`)).map((lang) => catalogueRule({ code, lang, catalogue }))) : [];
  const rules = [...written, ...fromCatalogue].map((r) => ({ ...r, kind: "rule", path: paths.rule(r.lang, r.key) }));
  const pairOf = (list, item) => Object.fromEntries(list.filter((x) => x.key === item.key).map((x) => [x.lang, x.path]));
  for (const list of [guides, rules]) for (const item of list) item.alternates = pairOf(list, item);
  return { guides, rules };
};

// ── A rule's page written from the catalogue

const FILES = {
  agency: "agency.txt",
  stops: "stops.txt",
  routes: "routes.txt",
  trips: "trips.txt",
  calendar: "calendar.txt",
  calendar_dates: "calendar_dates.txt",
  stop_times: "stop_times.txt",
  shapes: "shapes.txt",
  frequencies: "frequencies.txt",
  transfers: "transfers.txt",
  feed_info: "feed_info.txt",
  pathways: "pathways.txt",
  levels: "levels.txt",
  translations: "translations.txt",
  attributions: "attributions.txt",
  timeframes: "timeframes.txt",
};

const MOBILITYDATA_RULES = "https://gtfs-validator.mobilitydata.org/rules.html";

// Rules on the format of a value, whatever the file: their catalogue section is only where the list shows them.
const VALUE_FORMAT = new Set(["invalid_boolean_value", "invalid_currency", "invalid_currency_amount", "invalid_date", "invalid_language_code", "invalid_phone_number", "invalid_timezone", "invalid_url", "number_out_of_range"]);

const filesNamed = (text) => [...new Set(String(text).match(/\b[a-z_]+\.(?:txt|geojson)\b/g) || [])];

const RULE_WORDS = {
  fr: {
    title: (code, where) => `${code} : règle de validation GTFS${where ? ` (${where})` : ""}`,
    shortTitle: (code) => `${code} : règle GTFS`,
    checks: "Ce que vérifie la règle",
    severity: { error: "Gravité : erreur", warning: "Gravité : avertissement", info: "Gravité : information" },
    severityText: {
      error: "Une erreur signale une donnée contraire à la spécification GTFS. Un calculateur d'itinéraires ou une application de voyageurs peut refuser le fichier, ou en montrer une version fausse. Elle se corrige avant de publier le GTFS.",
      warning: "Un avertissement signale une donnée que la spécification permet mais qui paraît douteuse, ou une information recommandée qui manque. Le GTFS reste publiable, mais les voyageurs peuvent en voir l'effet : chaque cas s'examine.",
      info: "Une information signale une particularité du GTFS sans effet sur sa conformité. Elle aide à comprendre les données et ne demande pas de correction.",
    },
    where: "Où elle s'applique",
    files: (names) => `La règle porte sur ${names.map((n) => `\`${n}\``).join(" et ")}.`,
    valueFormat: "La règle porte sur le format d'une valeur : elle s'applique à chaque champ de ce type, dans tout fichier du GTFS qui en contient un.",
    sections: {
      structure: ["structure de l'archive", "La règle porte sur la structure de l'archive GTFS : les fichiers présents, leurs en-têtes, leur encodage et la forme de leurs lignes."],
      fare: ["tarifs", "La règle porte sur les fichiers tarifaires : `fare_attributes.txt` et `fare_rules.txt`, ou ceux de Fares v2 comme `fare_products.txt`, `fare_leg_rules.txt` et `fare_media.txt`."],
      cross_file: ["cohérence entre fichiers", "La règle croise plusieurs fichiers : une valeur déclarée dans l'un doit correspondre à ce qu'un autre déclare."],
      data_quality: ["qualité des données", "La règle mesure la qualité des données plutôt que leur stricte conformité : elle relève des valeurs permises mais peu vraisemblables."],
    },
    fileText: {
      agency: "Ce fichier décrit les exploitants du réseau : nom, site, fuseau horaire et langue.",
      stops: "Ce fichier décrit les arrêts, les stations, leurs entrées et leurs quais, avec leurs coordonnées.",
      routes: "Ce fichier décrit les lignes : leurs noms, leur mode de transport et leurs couleurs.",
      trips: "Ce fichier décrit les courses de chaque ligne : leur service, leur direction et leur tracé.",
      calendar: "Ce fichier, avec `calendar_dates.txt`, dit les jours où chaque service circule.",
      calendar_dates: "Ce fichier ajoute des dates aux services ou en retire.",
      stop_times: "Ce fichier donne, pour chaque course, ses arrêts dans l'ordre avec leurs horaires.",
      shapes: "Ce fichier décrit le tracé géographique des courses, point par point.",
      frequencies: "Ce fichier décrit les courses données par une fréquence plutôt qu'horaire par horaire.",
      transfers: "Ce fichier décrit les correspondances entre arrêts, lignes ou courses.",
      feed_info: "Ce fichier décrit le jeu de données lui-même : son éditeur, sa langue et sa période de validité.",
      pathways: "Ce fichier décrit les cheminements à l'intérieur des stations : couloirs, escaliers, ascenseurs, portes.",
      levels: "Ce fichier décrit les niveaux d'une station.",
      translations: "Ce fichier donne les textes du GTFS dans d'autres langues.",
      attributions: "Ce fichier crédite les organisations qui produisent ou exploitent les données.",
      timeframes: "Ce fichier décrit les plages horaires sur lesquelles un tarif s'applique.",
    },
    fix: "La trouver et la corriger",
    fixText: (code) => `Ouvrez le GTFS dans GTFS Express. La lecture est gratuite, et la validation, faite par le validateur de MobilityData et les règles propres à GTFS Express, liste les occurrences de \`${code}\` avec le fichier et les lignes en cause. La correction se fait dans un brouillon, à la main ou à partir d'un cahier des charges, avec la licence : le GTFS corrigé est validé de nouveau avant d'être livré, et la modification reste annulable.`,
    md: "Dans le validateur de MobilityData",
    mdSame: (code) => `Le validateur GTFS de MobilityData emploie le même code, \`${code}\`. Sa documentation décrit chaque règle : [règles du validateur de MobilityData](${MOBILITYDATA_RULES}).`,
    mdOther: (code, md) => `Le validateur GTFS de MobilityData signale ce défaut sous le code \`${md}\`, que GTFS Express précise en \`${code}\`. Sa documentation décrit chaque règle : [règles du validateur de MobilityData](${MOBILITYDATA_RULES}).`,
    related: "Règles du même domaine",
    all: "Toutes les règles de validation",
  },
  en: {
    title: (code, where) => `${code}: GTFS validation rule${where ? ` (${where})` : ""}`,
    shortTitle: (code) => `${code}: GTFS rule`,
    checks: "What the rule checks",
    severity: { error: "Severity: error", warning: "Severity: warning", info: "Severity: information" },
    severityText: {
      error: "An error marks data that breaks the GTFS specification. A journey planner or a rider app may refuse the file, or show a wrong version of it. Correct it before publishing the GTFS.",
      warning: "A warning marks data the specification allows but that looks doubtful, or recommended information that is missing. The GTFS can still be published, but riders may see the effect, so each case deserves a look.",
      info: "An information notice marks a feature of the GTFS that does not affect its conformity. It helps to understand the data and asks for no correction.",
    },
    where: "Where it applies",
    files: (names) => `The rule applies to ${names.map((n) => `\`${n}\``).join(" and ")}.`,
    valueFormat: "The rule checks the format of a value: it applies to every field of that type, in any GTFS file that has one.",
    sections: {
      structure: ["archive structure", "The rule applies to the structure of the GTFS archive: the files it holds, their headers, their encoding and the shape of their rows."],
      fare: ["fares", "The rule applies to the fare files: `fare_attributes.txt` and `fare_rules.txt`, or the Fares v2 ones such as `fare_products.txt`, `fare_leg_rules.txt` and `fare_media.txt`."],
      cross_file: ["consistency across files", "The rule reads several files together: a value declared in one must match what another declares."],
      data_quality: ["data quality", "The rule measures the quality of the data rather than strict conformity: it points at values that are allowed but unlikely."],
    },
    fileText: {
      agency: "This file describes the network's operators: name, website, time zone and language.",
      stops: "This file describes the stops, stations, their entrances and platforms, with their coordinates.",
      routes: "This file describes the routes: their names, transport mode and colours.",
      trips: "This file describes each route's trips: their service, direction and shape.",
      calendar: "This file, with `calendar_dates.txt`, says on which days each service runs.",
      calendar_dates: "This file adds dates to services or removes them.",
      stop_times: "This file gives, for each trip, its stops in order with their times.",
      shapes: "This file describes the geographic path of the trips, point by point.",
      frequencies: "This file describes trips given by a headway rather than time by time.",
      transfers: "This file describes the transfers between stops, routes or trips.",
      feed_info: "This file describes the dataset itself: its publisher, language and validity period.",
      pathways: "This file describes the paths inside stations: walkways, stairs, elevators, gates.",
      levels: "This file describes the levels of a station.",
      translations: "This file gives the GTFS texts in other languages.",
      attributions: "This file credits the organisations that produce or operate the data.",
      timeframes: "This file describes the time ranges over which a fare applies.",
    },
    fix: "Finding and correcting it",
    fixText: (code) => `Open the GTFS in GTFS Express. Reading is free, and the validation, by the MobilityData validator and the rules of GTFS Express itself, lists the occurrences of \`${code}\` with the file and rows involved. The correction is made in a draft, by hand or from a brief, with the licence: the corrected GTFS is validated again before it is delivered, and the change can be undone.`,
    md: "In the MobilityData validator",
    mdSame: (code) => `The MobilityData GTFS validator uses the same code, \`${code}\`. Its documentation describes each rule: [MobilityData validator rules](${MOBILITYDATA_RULES}).`,
    mdOther: (code, md) => `The MobilityData GTFS validator reports this defect as \`${md}\`, which GTFS Express narrows down to \`${code}\`. Its documentation describes each rule: [MobilityData validator rules](${MOBILITYDATA_RULES}).`,
    related: "Rules of the same domain",
    all: "All the validation rules",
  },
};

const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, text.lastIndexOf(" ", max - 1))}…`);

/** A content item like a file's, its body in the same Markdown, written from the catalogue's facts about the rule only. */
export const catalogueRule = ({ code, lang, catalogue }) => {
  if (!catalogue.updated) throw new Error("seo: the rules catalogue has no updated date (run scripts/sync-rules-catalogue.js)");
  const rule = catalogue.rules[code];
  const w = RULE_WORDS[lang];
  const text = rule[lang] || rule.en || "";
  const section = w.sections[rule.section];
  // The files the rule's own text names, else its section's file; a format rule applies wherever its field type does.
  const named = filesNamed(rule.en || text);
  const files = VALUE_FORMAT.has(code) ? [] : named.length ? named : FILES[rule.section] ? [FILES[rule.section]] : [];
  const about = (name) => w.fileText[Object.keys(FILES).find((k) => FILES[k] === name)];
  const where = VALUE_FORMAT.has(code) ? w.valueFormat : files.length ? [w.files(files), files.length === 1 ? about(files[0]) : null].filter(Boolean).join(" ") : section?.[1] || "";
  const titles = [w.title(code, files.length === 1 ? files[0] : files.length || VALUE_FORMAT.has(code) ? null : section?.[0]), w.title(code), w.shortTitle(code)];
  const related = Object.keys(catalogue.rules).filter((c) => c !== code && catalogue.rules[c].section === rule.section).slice(0, 12);
  const body = [
    `## ${w.checks}`,
    "",
    text,
    "",
    `## ${w.severity[rule.severity]}`,
    "",
    w.severityText[rule.severity],
    "",
    `## ${w.where}`,
    "",
    where,
    "",
    `## ${w.fix}`,
    "",
    w.fixText(code),
    ...(rule.mobilitydata ? ["", `## ${w.md}`, "", rule.mobilitydata === code ? w.mdSame(code) : w.mdOther(code, rule.mobilitydata)] : []),
    "",
    `## ${w.related}`,
    "",
    ...related.map((c) => `- [${c}](${paths.rule(lang, c)})`),
    `- [${w.all}](${paths.rules(lang)})`,
  ].join("\n");
  return { key: code, lang, generated: true, meta: { title: titles.find((t) => t.length <= 80) || code, description: clip(text, 200), updated: catalogue.updated }, body };
};

/** One page for both languages: the address is unknown, so is the reader's language. Never indexed. */
export const notFoundPage = ({ t }) => {
  const part = (lang, title, text) => `<section lang="${lang}"><h1>${esc(title)}</h1><p class="lead">${esc(text)}</p><ul class="cards"><li><a href="${paths.home(lang)}">GTFS Express</a></li><li><a href="${paths.rules(lang)}">${esc(t[lang]("footer.validationRules"))}</a></li><li><a href="${paths.guides(lang)}">${esc(t[lang]("seo.guides"))}</a></li></ul></section>`;
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<meta name="theme-color" content="#1565C0" />
<title>Page introuvable | GTFS Express</title>
${ICONS}
<style>${STYLE}</style>
</head>
<body>
<header class="top"><div class="in"><a class="brand" href="/">GTFS Express</a></div></header>
<main>
${part("fr", "Page introuvable", "Cette adresse ne mène à aucune page de GTFS Express. Elle a peut-être changé, ou le lien est incomplet.")}
${part("en", "Page not found", "This address leads to no page of GTFS Express. It may have changed, or the link is incomplete.")}
</main>
</body>
</html>
`;
};

// ── The page's frame

const STYLE = `
:root{--bg:#f7f8fa;--paper:#fff;--ink:#16202c;--ink2:#4b5869;--line:#dfe4ea;--accent:#1655b8;--code:#eef2f7}
@media (prefers-color-scheme:dark){:root{--bg:#0f141b;--paper:#161d27;--ink:#e6ebf1;--ink2:#a7b3c2;--line:#2a3442;--accent:#93c5fd;--code:#1e2733}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}a:hover{text-decoration:none}
.top{background:var(--paper);border-bottom:1px solid var(--line)}
.top .in{max-width:1080px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;gap:20px;flex-wrap:wrap}
.brand{font-weight:800;font-size:18px;color:var(--ink);text-decoration:none;letter-spacing:-.01em}
.top nav{display:flex;gap:18px;flex-wrap:wrap;font-size:15px}.top nav a{color:var(--ink2);text-decoration:none}.top nav a:hover{color:var(--accent)}
.top .cta{margin-left:auto;background:var(--accent);color:#fff;padding:8px 14px;border-radius:9px;text-decoration:none;font-weight:600;font-size:15px}
@media (prefers-color-scheme:dark){.top .cta{color:#0f141b}}
main{max-width:760px;margin:0 auto;padding:32px 20px 48px}
.crumbs{font-size:14px;color:var(--ink2);margin-bottom:14px}.crumbs a{color:var(--ink2)}
h1{font-size:32px;line-height:1.2;margin:0 0 10px;letter-spacing:-.02em}h2{font-size:23px;margin:36px 0 10px}h3{font-size:19px;margin:26px 0 8px}
.lead{color:var(--ink2);font-size:18px;margin:0 0 6px}.meta{color:var(--ink2);font-size:14px;margin-bottom:24px}
code{background:var(--code);padding:1px 5px;border-radius:5px;font:14.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
pre{background:var(--code);padding:14px 16px;border-radius:10px;overflow-x:auto}pre code{padding:0;background:none}
ul,ol{padding-left:24px}li{margin:4px 0}
.cards{list-style:none;padding:0;display:grid;gap:12px}.cards li{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:0}
.cards a{font-weight:650;text-decoration:none}.cards p{margin:4px 0 0;color:var(--ink2);font-size:15.5px}
.rules dt{font-weight:600;margin-top:14px}.rules dd{margin:2px 0 0;color:var(--ink2)}
.sev{display:inline-block;font-size:12.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:1px 8px;border-radius:99px;margin-left:8px;vertical-align:2px}
.sev-error{background:#fde2e1;color:#a4161a}.sev-warning{background:#fdf0d5;color:#8a5300}.sev-info{background:#e1ecfd;color:#1a4c9c}
@media (prefers-color-scheme:dark){.sev-error{background:#4a1d1d;color:#ffb4ab}.sev-warning{background:#45320f;color:#ffd68a}.sev-info{background:#1c2f4d;color:#a8c7fa}}
.try{margin-top:40px;background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:18px 20px}.try p{margin:0 0 10px}
.try a{font-weight:650}
footer{border-top:1px solid var(--line);color:var(--ink2);font-size:14px}footer .in{max-width:1080px;margin:0 auto;padding:18px 20px;display:flex;gap:16px;flex-wrap:wrap}
footer a{color:var(--ink2)}footer .pub{display:inline-flex;align-items:center;gap:6px}
`;

const ICONS = `<link rel="icon" href="/img/favicon.ico" sizes="any" /><link rel="icon" type="image/svg+xml" href="/img/favicon.svg" /><link rel="apple-touch-icon" sizes="180x180" href="/img/apple-touch-icon.png" />`;

/** `t` gives the language's words, `alternates` { lang: path } the same page in each language. */
export const pageShell = ({ lang, t, site, path: here, title, description, alternates = {}, crumbs = [], jsonld = [], content }) => {
  const other = CONTENT_LANGUAGES.find((l) => l !== lang);
  const otherPath = alternates[other] || null;
  const links = [
    ...Object.entries(alternates).map(([l, p]) => `<link rel="alternate" hreflang="${l}" href="${site}${p}" />`),
    alternates.fr ? `<link rel="alternate" hreflang="x-default" href="${site}${alternates.fr}" />` : "",
  ].join("");
  const crumbList = [{ name: "GTFS Express", path: paths.home(lang) }, ...crumbs];
  const breadcrumb = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: crumbList.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: `${site}${c.path}` })) };
  const legal = [
    ["/conditions/mentions-legales", t("legal.tab.mentions-legales")],
    ["/conditions/confidentialite", t("legal.tab.confidentialite")],
    ["/accessibilite", t("seo.accessibility")],
  ];
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#1565C0" />
<title>${esc(title)} | GTFS Express</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${site}${here}" />
${links}
<meta property="og:type" content="article" />
<meta property="og:site_name" content="GTFS Express" />
<meta property="og:locale" content="${lang === "fr" ? "fr_FR" : "en_US"}" />
<meta property="og:url" content="${site}${here}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:image" content="${site}/img/og-preview.png" />
${ICONS}
<script type="application/ld+json">${json([...jsonld, breadcrumb])}</script>
<style>${STYLE}</style>
</head>
<body>
<header class="top"><div class="in">
<a class="brand" href="${paths.home(lang)}">GTFS Express</a>
<nav aria-label="GTFS Express">
<a href="${paths.guides(lang)}">${esc(t("seo.guides"))}</a>
<a href="${paths.rules(lang)}">${esc(t("footer.validationRules"))}</a>
${otherPath ? `<a href="${otherPath}" hreflang="${other}" lang="${other}">${other === "fr" ? "Français" : "English"}</a>` : ""}
</nav>
<a class="cta" href="${paths.home(lang)}">${esc(t("seo.open"))}</a>
</div></header>
<main>
<nav class="crumbs" aria-label="${esc(t("seo.crumbs"))}">${crumbList.map((c, i) => (i < crumbList.length - 1 ? `<a href="${c.path}">${esc(c.name)}</a>` : `<span aria-current="page">${esc(c.name)}</span>`)).join(" / ")}</nav>
${content}
<aside class="try"><p>${esc(t("seo.try.text"))}</p><a href="${paths.home(lang)}">${esc(t("seo.open"))}</a></aside>
</main>
<footer><div class="in">${legal.map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join("")}<span class="pub"><svg viewBox="0 0 52 24" width="22" height="10" aria-hidden="true"><g fill="currentColor"><rect x="0" y="0" width="4" height="4"/><rect x="20" y="0" width="4" height="4"/><rect x="0" y="5" width="4" height="4"/><rect x="20" y="5" width="4" height="4"/><rect x="0" y="10" width="4" height="4"/><rect x="10" y="10" width="4" height="4"/><rect x="20" y="10" width="4" height="4"/><rect x="0" y="15" width="4" height="4"/><rect x="10" y="15" width="4" height="4"/><rect x="20" y="15" width="4" height="4"/><rect x="5" y="20" width="4" height="4"/><rect x="15" y="20" width="4" height="4"/></g><g fill="#0486d3"><rect x="28" y="0" width="4" height="4"/><rect x="33" y="0" width="4" height="4"/><rect x="38" y="0" width="4" height="4"/><rect x="43" y="0" width="4" height="4"/><rect x="28" y="5" width="4" height="4"/><rect x="48" y="5" width="4" height="4"/><rect x="28" y="10" width="4" height="4"/><rect x="33" y="10" width="4" height="4"/><rect x="38" y="10" width="4" height="4"/><rect x="43" y="10" width="4" height="4"/><rect x="28" y="15" width="4" height="4"/><rect x="48" y="15" width="4" height="4"/><rect x="28" y="20" width="4" height="4"/><rect x="33" y="20" width="4" height="4"/><rect x="38" y="20" width="4" height="4"/><rect x="43" y="20" width="4" height="4"/></g></svg>© Weyland-Binary</span></div></footer>
</body>
</html>
`;
};

export const organizationOf = (site, sameAs = []) => ({ "@type": "Organization", name: "Weyland-Binary", url: `${site}/`, logo: { "@type": "ImageObject", url: `${site}/img/weyland-binary-512.png`, width: 512, height: 512 }, ...(sameAs.length ? { sameAs } : {}) });

export const articlePage = ({ item, t, site, sameAs = [], catalogue = null }) => {
  const { html } = renderMarkdown(item.body);
  const date = new Date(`${item.meta.updated}T12:00:00Z`).toLocaleDateString(item.lang === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const rule = item.kind === "rule" && catalogue ? catalogue.rules[item.key] : null;
  const sev = rule ? ` <span class="sev sev-${rule.severity}">${esc(t(`seo.severity.${rule.severity}`))}</span>` : "";
  const crumbs = item.kind === "rule" ? [{ name: t("footer.validationRules"), path: paths.rules(item.lang) }, { name: item.key, path: item.path }] : [{ name: t("seo.guides"), path: paths.guides(item.lang) }, { name: item.meta.title, path: item.path }];
  const article = { "@context": "https://schema.org", "@type": "TechArticle", headline: item.meta.title, description: item.meta.description, inLanguage: item.lang, dateModified: item.meta.updated, datePublished: item.meta.published || item.meta.updated, mainEntityOfPage: `${site}${item.path}`, author: organizationOf(site, sameAs), publisher: organizationOf(site, sameAs) };
  const content = `<article><h1>${esc(item.meta.title)}${sev}</h1><p class="lead">${esc(item.meta.description)}</p><p class="meta">${esc(t("seo.updated", { date }))}</p>${html}</article>`;
  return pageShell({ lang: item.lang, t, site, path: item.path, title: item.meta.title, description: item.meta.description, alternates: item.alternates, crumbs, jsonld: [article], content });
};

export const guidesIndex = ({ lang, guides, t, site }) => {
  const own = guides.filter((g) => g.lang === lang);
  const content = `<h1>${esc(t("seo.guides.title"))}</h1><p class="lead">${esc(t("seo.guides.lead"))}</p><ul class="cards">${own.map((g) => `<li><a href="${g.path}">${esc(g.meta.title)}</a><p>${esc(g.meta.description)}</p></li>`).join("")}</ul>`;
  const alternates = Object.fromEntries(CONTENT_LANGUAGES.map((l) => [l, paths.guides(l)]));
  return pageShell({ lang, t, site, path: paths.guides(lang), title: t("seo.guides.title"), description: t("seo.guides.lead"), alternates, crumbs: [{ name: t("seo.guides"), path: paths.guides(lang) }], content });
};

export const rulesList = ({ lang, catalogue, rules, t }) => {
  const detailed = new Set(rules.filter((r) => r.lang === lang).map((r) => r.key));
  const groups = ["error", "warning", "info"].map((sev) => {
    const codes = Object.keys(catalogue.rules).filter((c) => catalogue.rules[c].severity === sev);
    const items = codes.map((c) => `<dt id="${c}"><code>${c}</code>${detailed.has(c) ? ` <a href="${paths.rule(lang, c)}">${esc(t("seo.rules.detail"))}</a>` : ""}</dt><dd>${esc(catalogue.rules[c][lang] || catalogue.rules[c].en || "")}</dd>`);
    return `<h2 id="${sev}">${esc(t(`seo.severity.${sev}.many`))} (${codes.length})</h2><dl class="rules">${items.join("")}</dl>`;
  });
  return `<h1>${esc(t("seo.rules.title"))}</h1><p class="lead">${esc(t("seo.rules.lead", { count: Object.keys(catalogue.rules).length }))}</p>${groups.join("")}`;
};

export const rulesIndex = ({ lang, catalogue, rules, t, site }) => {
  const alternates = Object.fromEntries(CONTENT_LANGUAGES.map((l) => [l, paths.rules(l)]));
  return pageShell({ lang, t, site, path: paths.rules(lang), title: t("seo.rules.title"), description: t("seo.rules.lead", { count: Object.keys(catalogue.rules).length }), alternates, crumbs: [{ name: t("footer.validationRules"), path: paths.rules(lang) }], content: rulesList({ lang, catalogue, rules, t }) });
};
