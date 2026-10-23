/**
 * The names laid over a network's day classes for its stop sheets: what the person confirmed (a period's name, a
 * public holiday's name), kept with the working copy as _sheet_calendar.json (the `_` prefix keeps it out of the
 * export), and what the model proposes when asked. The sheets print a name only once it is confirmed: a proposal,
 * from the model or from anyone, is shown beside the dates it names and waits for the person's word. The model never
 * adds a date: it names the blocks of dates and the holidays the network itself shows.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { GTFS_UPLOAD_DIR } = require("../sessionManager");

const FILE_NAME = "_sheet_calendar.json";
const MAX_NAME_CHARS = 80;
const MAX_ENTRIES = 120;
const KINDS = new Set(["school", "other"]);
const SOURCES = new Set(["user", "ai", "network", "official"]);
const MAX_OUTPUT_TOKENS = 1500;
const LANG_NAMES = { en: "English", fr: "French", es: "Spanish", de: "German", pt: "Portuguese", zh: "Chinese (Simplified)", hi: "Hindi" };

const filePath = (sessionId) => path.join(GTFS_UPLOAD_DIR, sessionId, FILE_NAME);
const empty = () => ({ periods: [], holidays: [], updatedAt: null });
const ymd = (v) => {
  const s = String(v ?? "").trim().slice(0, 10).replace(/-/g, "");
  return /^\d{8}$/.test(s) ? s : null;
};
const cleanName = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS) : "");

const load = (sessionId) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(sessionId), "utf8"));
    return { ...empty(), ...sanitize(parsed), updatedAt: parsed.updatedAt || null };
  } catch {
    return empty();
  }
};

const persist = (sessionId, cal) => {
  const dir = path.dirname(filePath(sessionId));
  if (!fs.existsSync(dir)) return cal;
  fs.writeFileSync(filePath(sessionId), JSON.stringify(cal, null, 2));
  return cal;
};

/** The entries as the store keeps them: dates as YYYYMMDD, a kind, a source and whether the person confirmed. */
const sanitize = (input) => {
  const periods = [];
  for (const p of Array.isArray(input?.periods) ? input.periods : []) {
    const from = ymd(p?.from);
    const to = ymd(p?.to);
    const name = cleanName(p?.name);
    if (!from || !to || to < from || !name) continue;
    periods.push({ from, to, name, kind: KINDS.has(p?.kind) ? p.kind : "other", source: SOURCES.has(p?.source) ? p.source : "user", confirmed: p?.confirmed === true, ...(Number.isFinite(Number(p?.confidence)) ? { confidence: Math.max(0, Math.min(1, Number(p.confidence))) } : {}) });
  }
  const holidays = [];
  for (const h of Array.isArray(input?.holidays) ? input.holidays : []) {
    const date = ymd(h?.date);
    const name = cleanName(h?.name);
    if (!date || !name) continue;
    holidays.push({ date, name, source: SOURCES.has(h?.source) ? h.source : "user", confirmed: h?.confirmed === true, ...(Number.isFinite(Number(h?.confidence)) ? { confidence: Math.max(0, Math.min(1, Number(h.confidence))) } : {}) });
  }
  return { periods: periods.slice(0, MAX_ENTRIES), holidays: holidays.slice(0, MAX_ENTRIES) };
};

/** Replaces the calendar with what the person sends (every entry as they left it), dated. */
const save = (sessionId, input) => persist(sessionId, { ...sanitize(input), updatedAt: new Date().toISOString() });

/** The confirmed names, in the engine's shape: { periods, holidays: Map(date → name) }. */
const namesOf = (cal) => ({
  periods: (cal?.periods || []).filter((p) => p.confirmed).map((p) => ({ from: p.from, to: p.to, name: p.name, kind: p.kind })),
  holidays: new Map((cal?.holidays || []).filter((h) => h.confirmed).map((h) => [h.date, h.name])),
});

/** Proposals merged into the store: an unconfirmed entry on the same dates is replaced, a confirmed one is kept. */
const merge = (sessionId, proposals) => {
  const cal = load(sessionId);
  const periods = cal.periods.filter((p) => p.confirmed || !proposals.periods.some((q) => q.from === p.from && q.to === p.to));
  for (const q of proposals.periods) if (!periods.some((p) => p.from === q.from && p.to === q.to)) periods.push({ ...q, source: "ai", confirmed: false });
  const holidays = cal.holidays.filter((h) => h.confirmed || !proposals.holidays.some((q) => q.date === h.date));
  for (const q of proposals.holidays) if (!holidays.some((h) => h.date === q.date)) holidays.push({ ...q, source: "ai", confirmed: false });
  return save(sessionId, { periods, holidays });
};

const iso = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

const systemPrompt = (language) =>
  [
    "You name the periods and public holidays a public transport network's timetable shows. You are given the network's time zone, the blocks of weekdays it runs with another timetable (date ranges) and the weekdays it runs like a Sunday (dates).",
    "Answer with one JSON object and nothing else: { \"periods\": [{ \"from\": \"YYYY-MM-DD\", \"to\": \"YYYY-MM-DD\", \"name\": \"...\", \"kind\": \"school\" | \"other\", \"confidence\": 0..1 }], \"holidays\": [{ \"date\": \"YYYY-MM-DD\", \"name\": \"...\", \"confidence\": 0..1 }] }.",
    "Name only the blocks and dates given, with their exact dates; never add, move or merge a date. A block of school holidays is kind \"school\" and its name is the holiday's usual name in that country (its region when the dates tell it); a summer or special timetable is kind \"other\". When you do not know, give a low confidence rather than a guess, or leave the entry out.",
    `Write every name in ${LANG_NAMES[language] || "English"}, short, as a timetable prints it, without a dash.`,
  ].join("\n");

const userPrompt = ({ timezone, agency, from, to, blocks, holidays }) =>
  JSON.stringify({
    time_zone: timezone || null,
    network: agency || null,
    period: { from: iso(from), to: iso(to) },
    blocks: blocks.map((b) => ({ ranges: b.ranges.map(([a, z]) => ({ from: iso(a), to: iso(z) })), working_dates: b.dates })),
    sunday_like_weekdays: holidays.map(iso),
  });

/** The model's proposals for the classes shown, in the sheet's language; dates it did not get are dropped. */
const suggestNames = async ({ client, model, language, timezone, agency, period, classes, holidays }) => {
  const blocks = classes.filter((c) => c.kind === "alt").map((c) => ({ ranges: c.ranges, dates: c.dates.length }));
  if (!blocks.length && !holidays.length) return { periods: [], holidays: [] };
  const message = await client.messages.create({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: systemPrompt(language),
    messages: [{ role: "user", content: userPrompt({ timezone, agency, from: period.from, to: period.to, blocks, holidays }) }],
  });
  const text = (message.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const json = text.match(/\{[\s\S]*\}/);
  let parsed = null;
  try {
    parsed = json ? JSON.parse(json[0]) : null;
  } catch {
    parsed = null;
  }
  const given = new Set(blocks.flatMap((b) => b.ranges.map(([a, z]) => `${a}|${z}`)));
  const dates = new Set(holidays);
  const out = sanitize(parsed || {});
  return {
    periods: out.periods.filter((p) => given.has(`${p.from}|${p.to}`)).map((p) => ({ ...p, source: "ai", confirmed: false })),
    holidays: out.holidays.filter((h) => dates.has(h.date)).map((h) => ({ ...h, source: "ai", confirmed: false })),
  };
};

module.exports = { load, save, merge, namesOf, sanitize, suggestNames, FILE_NAME, _internals: { systemPrompt, userPrompt } };
