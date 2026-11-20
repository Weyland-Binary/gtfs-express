/**
 * The product's features as the operator's console counts them: one key per feature, read from a route's template, a
 * step the web reports, or the act that opened the offer. A feature is counted by one source only, so a use is never
 * counted twice.
 */

"use strict";

const FEATURES = Object.freeze([
  { key: "overview", label: "Overview and map", area: "Reader", access: "free" },
  { key: "timetables", label: "Timetables", area: "Reader", access: "free" },
  { key: "validation", label: "Validation report", area: "Reader", access: "free" },
  { key: "sheets", label: "Stop sheets and line plans", area: "Reader · documents", access: "free" },
  { key: "shapes", label: "Shapes", area: "Reader", access: "free" },
  { key: "assistant", label: "Assistant", area: "Assistant", access: "free" },
  { key: "validation_export", label: "Validation report export", area: "Documents", access: "free" },
  { key: "share", label: "Shared link", area: "Sharing", access: "free" },
  { key: "brief", label: "Change with a brief", area: "Modify", access: "licence" },
  { key: "hand", label: "Change by hand", area: "Modify", access: "licence" },
  { key: "repairs", label: "Report corrections (safe repairs, quick fixes, workshop)", area: "Modify · validation report", access: "licence" },
  { key: "delivery", label: "Delivery: export and package", area: "Deliver", access: "licence" },
  { key: "print", label: "Print stop sheets and plans", area: "Documents", access: "licence" },
  { key: "shape_editor", label: "Shape editor", area: "Modify", access: "licence" },
  { key: "notices", label: "Change notices", area: "Documents", access: "licence" },
  { key: "aggregate", label: "Aggregate of several networks", area: "Projects", access: "licence" },
  { key: "sql", label: "SQL console", area: "Expert tools", access: "expert" },
  { key: "offer", label: "Offer in kilometres and hours", area: "Expert tools", access: "expert" },
  { key: "compare", label: "Compare two versions", area: "Expert tools", access: "expert" },
]);
const KEYS = new Set(FEATURES.map((f) => f.key));

// Hand editing is every write under /edit that is not one of these.
const EDIT_NOT_HAND = /^\/gtfs\/edit\/(enter|exit|validate|validate\.canonical|undo|redo|jump|export|quickfix|repair|aside|shapes|route|match|sql\/preview)(\/|$)/i;
const ROUTES = [
  [/^POST \/gtfs\/transform\/direct$/i, "brief"],
  [/^POST \/gtfs\/edit\/quickfix\/apply(-safe)?$/i, "repairs"],
  [/^POST \/gtfs\/edit\/aside\//i, "repairs"],
  [/^(POST|DELETE) \/gtfs\/edit\/repair\/(choices|proposals|cell|accept|replay)(\/|$)/i, "repairs"],
  [/^(POST|PUT|DELETE) \/gtfs\/edit\/shapes(\/|$)/i, "shape_editor"],
  [/^GET \/gtfs\/edit\/export$/i, "delivery"],
  [/^POST \/gtfs\/workspace\/projects\/:projectId\/versions\/:versionId\/(package|delivered)$/i, "delivery"],
  [/^POST \/gtfs\/documents\/sheets\/(changes|notices)$/i, "notices"],
  [/^POST \/gtfs\/share$/i, "share"],
  [/^POST \/gtfs\/sql\/nl2sql-chat$/i, "assistant"],
  [/^POST \/gtfs\/workspace\/projects\/:projectId\/aggregate\/build$/i, "aggregate"],
];

/** The feature a request used, by its method and route template; null for most routes. */
const ofRoute = (method, template) => {
  const key = `${method} ${template}`;
  for (const [pattern, feature] of ROUTES) if (pattern.test(key)) return feature;
  if (method !== "GET" && /^\/gtfs\/edit\//i.test(template) && !EDIT_NOT_HAND.test(template)) return "hand";
  return null;
};

const SCREENS = Object.freeze({ apercu: "overview", horaires: "timetables", validation: "validation", sql: "sql", comparer: "compare" });
const PRINTED = new Set(["licence", "trial"]);

/** The feature a step of the web names; null when the step is no use of a feature. */
const ofStep = (step, source) => {
  if (step === "screen.open") return SCREENS[source] || null;
  if (step === "sheets.open") return "sheets";
  if (step === "shapes.open") return "shapes";
  if (step === "service.open") return "offer";
  if (step === "validation.export") return "validation_export";
  if (step === "sheets.print") return PRINTED.has(source) ? "print" : null;
  if (step === "sheets.plan" || step === "sheets.leaflet") return "print";
  return null;
};

// The acts that open the offer, and the feature each one asks for.
const ACTS = Object.freeze({
  modify: "hand",
  edit_mode: "hand",
  repairs: "repairs",
  print: "print",
  assistant_change: "brief",
  assistant: "assistant",
  reader_quota: "assistant",
  shapes: "shape_editor",
  offer_export: "offer",
  calendar_ai: "sheets",
  aggregate: "aggregate",
  brief: "brief",
  deliver: "delivery",
  trial_button: null,
  pricing: null,
  refusal: null,
  other: null,
});

module.exports = { FEATURES, KEYS, ofRoute, ofStep, ACTS };
