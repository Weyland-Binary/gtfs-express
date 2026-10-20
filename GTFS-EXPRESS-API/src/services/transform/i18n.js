/**
 * i18n — the Change Studio engine speaks the user's language.
 *
 * Every text a user reads from the engine — a step's summary, its warnings,
 * the question a blocked step asks, the error a step fails with — is a
 * template of locales/<lang>.js found by a stable code "<namespace>.<meaning>",
 * the namespace being the operator's type or the helper's file
 * ("set_headway.summary", "resolve.stop_ambiguous", "common.dow_mon"):
 *
 *   tr(lang, code, params) → the text in that language ("fr", "fr-FR", "en"…)
 *
 * English is the reference: its templates are the engine's own text, byte
 * for byte (the tests and the models read it). A code missing in
 * a language falls back to English, then to the code itself. The operators
 * get the language from the contexts they already receive — resolve(model,
 * params, ctx) and apply(db, value, ctx) read ctx.lang, "en" when absent —
 * and hand it to the helpers they call.
 *
 * Templates, a subset of ICU MessageFormat:
 *   {name}                                a parameter: a string as is, a number
 *                                         formatted for the language (fr: 2,5 and 12 345)
 *   {n, plural, =0 {…} one {…} other {…}} the exact value (=0) or the plural
 *                                         category of n (en: 1 is one; fr: 0 and 1
 *                                         are one); # is n, formatted
 *   {k, select, a {…} b {…} other {…}}    by the string value of k
 * Branches nest ({n, plural, one {# stop at {name}} other {…}}). A brace
 * followed by anything but a letter is plain text ("give { from, to }"),
 * so templates never need escapes.
 *
 * A parameter the template needs and `params` lacks (undefined or null) is
 * a bug in the caller: in strict mode (tests: NODE_ENV=test, or setStrict)
 * tr throws; in production it renders "?" and logs the code once — the
 * message degrades, the preview does not fail.
 *
 * Also: number(lang, n, digits) formats a number as the templates do;
 * langOf(v) normalises a language tag; catalogueWords(lang, type, param)
 * is the operators' catalogue in a language (locales/catalogue.<lang>.js:
 * an operation's title and description, a parameter's label and help, as
 * the Change Studio words them), null where the language has no word.
 *
 * Questions in plain words. Three messages name
 * a parameter by the engine's name — "Quelle valeur pour `headway_min` ?",
 * "`headway_min` doit être compris entre 0 et 240.", "`all` vaut true ou
 * false." — and nobody answers a parameter's name: for these codes `tr`
 * asks in words instead (PLAIN below), in every language it speaks, English
 * included — the parameter's own question where there is one ("Toutes les
 * combien de minutes ?"), else the catalogue's label of the parameter in
 * quotes ("Quelle valeur pour « Distance maximale (m) » ?"). Only the words
 * change: the code, the options and the parameter the ambiguity names are
 * the engine's (the models and the web read those), and a parameter the
 * catalogue does not label keeps the template. The words live here, not in
 * locales/<lang>.js, because a locale code must be a literal of an operator
 * (transformI18n.test.js) while these are chosen by the value of `name`.
 */

"use strict";

const LOCALES = { en: require("./locales/en"), fr: require("./locales/fr") };
const CATALOGUES = { en: require("./locales/catalogue.en"), fr: require("./locales/catalogue.fr") };
const LANGS = Object.keys(LOCALES);
const GROUP = " "; // French thousands separator (narrow no-break space)

const state = { strict: null, warned: new Set() };
const strictMode = () => (state.strict != null ? state.strict : process.env.NODE_ENV === "test");
/** Force strict (true) or lenient (false) rendering; null: back to the environment's default. */
const setStrict = (v) => {
  state.strict = v == null ? null : Boolean(v);
};
const warnOnce = (key, text) => {
  if (state.warned.has(key)) return;
  state.warned.add(key);
  console.warn(`transform i18n: ${text}`);
};

/** A language tag → a supported language ("fr-FR", "FR" → "fr"); English otherwise. */
const langOf = (v) => {
  const k = String(v || "")
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0];
  return LOCALES[k] ? k : "en";
};

/**
 * A GTFS date (YYYYMMDD) as the language writes it: « 31/08/2026 » in French. English, the reference the models
 * and the tests read byte for byte, keeps the GTFS form; so does anything that is not such a date.
 */
const ymd = (lang, d) => {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(d ?? ""));
  return m && langOf(lang) === "fr" ? `${m[3]}/${m[2]}/${m[1]}` : String(d ?? "");
};

/** A number as the language writes it; `digits`: fixed decimals (toFixed). */
const number = (lang, n, digits = null) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  const s = digits == null ? String(x) : x.toFixed(digits);
  if (langOf(lang) !== "fr") return s;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return s.replace(".", ",");
  const int = m[2].length > 4 ? m[2].replace(/\B(?=(\d{3})+(?!\d))/g, GROUP) : m[2];
  return `${m[1]}${int}${m[3] != null ? `,${m[3]}` : ""}`;
};

/** The plural category of n: "one" or "other" (CLDR: en one is 1; fr one is 0 ≤ n < 2). */
const pluralOf = (lang, n) => {
  const x = Math.abs(Number(n));
  if (lang === "fr") return x < 2 ? "one" : "other";
  return x === 1 ? "one" : "other";
};

// ── templates ────────────────────────────────────────────────────────────

/**
 * A template → nodes: text, { type: "arg", name }, { type: "hash" } (# in a
 * plural branch), { type: "plural" | "select", name, branches: { key: nodes } }.
 * Throws on a malformed template (the locale tests parse them all).
 */
const parse = (src) => {
  let i = 0;
  const fail = (why) => {
    throw new Error(`i18n template: ${why} at ${i} in ${JSON.stringify(src)}`);
  };
  // kind: the selector whose branch this is (null at the top); inPlural: # is the count.
  const nodes = (kind, inPlural) => {
    const out = [];
    let text = "";
    let literal = 0; // literal braces opened in the text ("{ from, to }")
    const flush = () => {
      if (text) out.push(text);
      text = "";
    };
    while (i < src.length) {
      const c = src[i];
      if (c === "{" && /[A-Za-z_]/.test(src[i + 1] || "")) {
        flush();
        out.push(arg(inPlural));
      } else if (c === "{") {
        literal += 1;
        text += c;
        i += 1;
      } else if (c === "}" && literal > 0) {
        literal -= 1;
        text += c;
        i += 1;
      } else if (c === "}") {
        if (!kind) fail("unmatched }");
        break;
      } else if (c === "#" && inPlural) {
        flush();
        out.push({ type: "hash" });
        i += 1;
      } else {
        text += c;
        i += 1;
      }
    }
    flush();
    return out;
  };
  const arg = (inPlural) => {
    i += 1; // {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*/.exec(src.slice(i));
    if (!m) fail("a parameter name");
    i += m[0].length;
    const name = m[1];
    if (src[i] === "}") {
      i += 1;
      return { type: "arg", name };
    }
    if (src[i] !== ",") fail("} or ,");
    i += 1;
    const k = /^\s*(plural|select)\s*,/.exec(src.slice(i));
    if (!k) fail("plural or select");
    i += k[0].length;
    const type = k[1];
    const branches = {};
    for (;;) {
      const b = /^\s*(=\d+|[A-Za-z0-9_]+)\s*\{/.exec(src.slice(i));
      if (!b) break;
      i += b[0].length;
      branches[b[1]] = nodes(type, inPlural || type === "plural");
      if (src[i] !== "}") fail("} closing a branch");
      i += 1;
    }
    const end = /^\s*\}/.exec(src.slice(i));
    if (!end) fail("} closing the selector");
    i += end[0].length;
    if (!branches.other) fail(`an "other" branch for ${name}`);
    return { type, name, branches };
  };
  const out = nodes(null, false);
  if (i < src.length) fail("text after the end");
  return out;
};

/** Every parameter a template reads (plain, plural or select, nested ones included). */
const placeholders = (src) => {
  const out = new Set();
  const walk = (list) => {
    for (const n of list) {
      if (typeof n === "string" || n.type === "hash") continue;
      out.add(n.name);
      if (n.branches) Object.values(n.branches).forEach(walk);
    }
  };
  walk(parse(src));
  return out;
};

const _parsed = new Map();
const compiled = (lang, code) => {
  const key = `${lang}\u0000${code}`;
  if (!_parsed.has(key)) {
    const src = Object.prototype.hasOwnProperty.call(LOCALES[lang], code) ? LOCALES[lang][code] : null;
    _parsed.set(key, src == null ? null : parse(src));
  }
  return _parsed.get(key);
};

const render = (list, params, ctx) => {
  let out = "";
  const get = (name) => {
    const v = params ? params[name] : undefined;
    if (v !== undefined && v !== null) return v;
    if (strictMode()) throw new Error(`i18n: ${ctx.code} (${ctx.lang}) needs the parameter "${name}"`);
    warnOnce(`${ctx.code}|${name}`, `${ctx.code} rendered without "${name}"`);
    return null;
  };
  for (const n of list) {
    if (typeof n === "string") out += n;
    else if (n.type === "hash") out += ctx.hash ?? "#";
    else if (n.type === "arg") {
      const v = get(n.name);
      if (v === null) out += "?";
      else if (typeof v === "number") out += number(ctx.lang, v);
      else if (typeof v === "object" && strictMode()) throw new Error(`i18n: ${ctx.code} got an object for "${n.name}"`);
      else out += String(v);
    } else if (n.type === "plural") {
      const v = get(n.name);
      const x = Number(v);
      if (v !== null && !Number.isFinite(x) && strictMode()) throw new Error(`i18n: ${ctx.code} needs a number for "${n.name}"`);
      const branch = (v !== null && n.branches[`=${x}`]) || (v !== null && Number.isFinite(x) && n.branches[pluralOf(ctx.lang, x)]) || n.branches.other;
      out += render(branch, params, { ...ctx, hash: v === null ? "?" : number(ctx.lang, x) });
    } else {
      const v = get(n.name);
      out += render((v !== null && n.branches[String(v)]) || n.branches.other, params, ctx);
    }
  }
  return out;
};

/** The message `code` in `lang`, its parameters filled in (a question on a parameter in plain words: PLAIN). */
// French: the direction_id of the timetable texts (the summary and warnings of departures added or removed,
// which the person reads under each operation) in the app's words — « aller », « retour », « aller et
// retour » — never « sens 0/1 ». English keeps the ids: a model reads them, the tests quote them.
const DIRECTION_WORDS_FR = { 0: "aller", 1: "retour" };
const frenchDirection = (code, params) => {
  const d = params ? params.direction : null;
  if (!String(code).startsWith("timetable.") || d === undefined || d === null) return params;
  const ids = String(d).split("/");
  if (!ids.length || !ids.every((x) => x === "0" || x === "1")) return params;
  return { ...params, direction: [...new Set(ids)].sort().map((x) => DIRECTION_WORDS_FR[x]).join(" et ") };
};

const tr = (lang, code, params = {}) => {
  let l = langOf(lang);
  if (l === "fr") params = frenchDirection(code, params);
  const plain = plainOf(l, code, params);
  if (plain) return render(plain.nodes, plain.params, { lang: l, code, hash: null });
  let nodes = compiled(l, code);
  if (!nodes && l !== "en") {
    l = "en";
    nodes = compiled("en", code);
  }
  if (!nodes) {
    if (strictMode()) throw new Error(`i18n: unknown message code "${code}"`);
    warnOnce(code, `unknown message code "${code}"`);
    return code;
  }
  return render(nodes, params, { lang: l, code, hash: null });
};

const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null);
/**
 * The catalogue's words in `lang`: for an operation { title, description },
 * for one of its parameters { label, description } (the operation's own
 * wording of it first, then the parameter's); null when the language has none.
 */
const catalogueWords = (lang, type, param = null) => {
  const c = CATALOGUES[langOf(lang)];
  if (!c) return null;
  if (param == null) return own(c.ops, type);
  return own(c.opParams, `${type}.${param}`) || own(c.params, param);
};

// ── questions in plain words ─────────────────────────────────────────────

/**
 * Per language, per code that names a parameter (`{name}`): the question of
 * a parameter by its name, and `_label` — the question for any other
 * parameter, `{label}` being the catalogue's label of it. Same template
 * syntax as the locales; the same parameters as the code, plus `label`.
 */
const PLAIN = {
  en: {
    "resolve.amount_missing": {
      _label: "What value for “{label}”?",
      headway_min: "Every how many minutes?",
      minutes: "How many minutes?",
      max_wait_min: "How many minutes may the wait last at most?",
      max_shift_min: "By how many minutes at most may a trip move?",
      transfer_duration_min: "For how many minutes does a ticket allow a transfer?",
      max_distance_m: "How many metres apart at most?",
      layover_min: "How many minutes of layover at least, at the end of a trip?",
    },
    "resolve.amount_invalid": {
      _label: "“{label}” must be more than 0 and at most {max}.",
      headway_min: "The interval between two departures must be more than 0 and at most {max} minutes.",
    },
    "common.flag_invalid": { _label: "“{label}”: yes or no?" },
  },
  fr: {
    "resolve.amount_missing": {
      _label: "Quelle valeur pour « {label} » ?",
      headway_min: "Toutes les combien de minutes ?",
      minutes: "Combien de minutes ?",
      max_wait_min: "Combien de minutes d'attente au plus ?",
      max_shift_min: "De combien de minutes au plus une course peut-elle être décalée ?",
      transfer_duration_min: "Pendant combien de minutes un titre permet-il la correspondance ?",
      max_distance_m: "À combien de mètres au plus ?",
      layover_min: "Combien de minutes de battement au moins, en fin de course ?",
    },
    "resolve.amount_invalid": {
      _label: "« {label} » doit être supérieur à 0 et d'au plus {max}.",
      headway_min: "L'intervalle entre deux départs doit être supérieur à 0 et d'au plus {max} minutes.",
    },
    "common.flag_invalid": { _label: "« {label} » : oui ou non ?" },
  },
};

const _plainParsed = new Map();
const plainNodes = (src) => {
  if (!_plainParsed.has(src)) _plainParsed.set(src, parse(src));
  return _plainParsed.get(src);
};

/**
 * The question on a parameter in plain words, for a code of PLAIN in `lang`:
 * { nodes, params } — the parameter's own question, else `_label` with the
 * catalogue's label of it; null when the code names no parameter, or the
 * parameter has neither (the locale's template is kept).
 */
const plainOf = (lang, code, params) => {
  const table = own(PLAIN[lang], code);
  const name = params && typeof params.name === "string" ? params.name : null;
  if (!table || !name) return null;
  const mine = own(table, name);
  if (mine) return { nodes: plainNodes(mine), params };
  const label = catalogueWords(lang, null, name)?.label;
  if (!label || !table._label) return null;
  return { nodes: plainNodes(table._label), params: { ...params, label } };
};

module.exports = { tr, number, ymd, langOf, catalogueWords, LANGS, setStrict, _internals: { parse, placeholders, pluralOf, LOCALES, CATALOGUES, PLAIN } };
