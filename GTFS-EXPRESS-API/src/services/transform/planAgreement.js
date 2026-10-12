/**
 * planAgreement — two readings of one brief compared on what they do to the
 * feed (the previews' semantic diffs), never on the plans' words: an
 * operation split in two, a direction said "both" or left out, a date
 * written two ways read the same. What the two readings do differently
 * becomes the person's question, with no answer of the engine's own.
 *
 * Why (2026-10-10): on 55 pairs of recorded runs of the same briefs, every
 * pair holding a wrong delivery diverged on its plan and no agreeing pair
 * held one — a second reading tells the failures apart, at the price of
 * questions on deliveries that were right (a third of the pairs on the
 * plans' words; fewer on the feed's changes, which this module compares).
 *
 *   divergencesOf(diffA, diffB) → [{ key, a: item | null, b: item | null }]
 *     the items of semanticDiff (engine preview.diff) matched by what they
 *     name (code, line, day type, dates, period, direction, stop): an item
 *     only one reading makes, or made with another value, is a divergence;
 *     the calendar's internals and the fleet (derived figures) are not read.
 *   questionsOf(divergences, { lang, limit }) → the planner's questions
 *     [{ id, text, options: ["A", "B"], param: "reading" }], at most `limit`
 *     (default 6), the rest counted in the last one.
 *   itemText(item, lang) → one sentence of an item in the reader's language.
 */

"use strict";

const { tr } = require("./i18n");

// Codes that say what the feed does for passengers; the rest is derived or internal.
const READ_CODES = new Set(["route_added", "route_removed", "route_attribute", "route_stops_added", "route_stops_removed", "service_trips", "service_first", "service_last", "service_headway", "service_running", "service_retimed", "stop_added", "stop_removed", "stop_renamed", "stop_moved", "validity"]);

const keyOf = (it) => JSON.stringify([it.code, it.label ?? it.id ?? null, it.stop ?? null, it.day ?? null, it.dates ? `${it.dates.from}-${it.dates.to}` : null, it.period ?? null, it.direction ?? null, it.field ?? null]);
const valueOf = (it) => JSON.stringify([it.after ?? null, it.stops ?? null, it.name ?? null, it.meters ?? null]);

/** The divergences of two semantic diffs (null or missing items read as an empty diff). */
const divergencesOf = (diffA, diffB) => {
  const read = (diff) => new Map(((diff && diff.items) || []).filter((it) => READ_CODES.has(it.code)).map((it) => [keyOf(it), it]));
  const a = read(diffA);
  const b = read(diffB);
  const out = [];
  for (const [k, it] of a) {
    const other = b.get(k);
    if (!other) out.push({ key: k, a: it, b: null });
    else if (valueOf(it) !== valueOf(other)) out.push({ key: k, a: it, b: other });
  }
  for (const [k, it] of b) if (!a.has(k)) out.push({ key: k, a: null, b: it });
  return out;
};

const fmt = (lang, v) => (v == null ? tr(lang, "agreement.none") : String(v));
const when = (lang, it) => (it.dates ? tr(lang, "agreement.dates", { from: it.dates.from, to: it.dates.to, count: it.dates.count }) : "");

/** One sentence of an item in the reader's language (the UI phrases the codes itself elsewhere). */
const itemText = (it, lang) => {
  const line = it.label ? tr(lang, "agreement.line", { label: it.label }) : "";
  const words = { line, day: it.day || "", when: when(lang, it), direction: it.direction ?? "", before: fmt(lang, it.before), after: fmt(lang, it.after), period: it.period || "", stops: Array.isArray(it.stops) ? it.stops.join(", ") : "", name: it.name || "", field: it.field || "", meters: it.meters ?? "" };
  switch (it.code) {
    case "route_added": return tr(lang, "agreement.route_added", words);
    case "route_removed": return tr(lang, "agreement.route_removed", words);
    case "route_attribute": return tr(lang, "agreement.route_attribute", words);
    case "route_stops_added": return tr(lang, "agreement.route_stops_added", words);
    case "route_stops_removed": return tr(lang, "agreement.route_stops_removed", words);
    case "service_trips": return tr(lang, "agreement.service_trips", words);
    case "service_first": return tr(lang, "agreement.service_first", words);
    case "service_last": return tr(lang, "agreement.service_last", words);
    case "service_headway": return tr(lang, "agreement.service_headway", words);
    case "service_running": return tr(lang, "agreement.service_running", words);
    case "service_retimed": return tr(lang, "agreement.service_retimed", words);
    case "stop_added": return tr(lang, "agreement.stop_added", words);
    case "stop_removed": return tr(lang, "agreement.stop_removed", words);
    case "stop_renamed": return tr(lang, "agreement.stop_renamed", words);
    case "stop_moved": return tr(lang, "agreement.stop_moved", words);
    case "validity": return tr(lang, "agreement.validity", { before: it.before ? `${it.before.start}–${it.before.end}` : tr(lang, "agreement.none"), after: it.after ? `${it.after.start}–${it.after.end}` : tr(lang, "agreement.none") });
    default: return it.code;
  }
};

/**
 * The questions the divergences make: one per divergence, "reading A does X, reading B does Y (or nothing): which
 * one?", the options A and B; beyond `limit`, the last question counts the rest.
 */
const questionsOf = (divergences, { lang = "en", limit = 6 } = {}) => {
  const out = [];
  const shown = divergences.slice(0, limit);
  shown.forEach((d, i) => {
    const a = d.a ? itemText(d.a, lang) : tr(lang, "agreement.nothing");
    const b = d.b ? itemText(d.b, lang) : tr(lang, "agreement.nothing");
    const rest = i === shown.length - 1 && divergences.length > shown.length ? tr(lang, "agreement.more", { count: divergences.length - shown.length }) : "";
    out.push({ id: `reading_${i + 1}`, text: tr(lang, "agreement.question", { a, b, rest }), options: ["A", "B"], param: "reading", default: null });
  });
  return out;
};

module.exports = { divergencesOf, questionsOf, itemText, READ_CODES, _internals: { keyOf, valueOf } };
