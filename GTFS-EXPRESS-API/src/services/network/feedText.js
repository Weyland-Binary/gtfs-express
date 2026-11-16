/**
 * feedText — a stop name as a person reads it (nameKey), the same for the judge and the engine.
 */

"use strict";

const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

// Accents, case and punctuation apart, and a ligature written out (« Cœur d'O » is « COEUR D'O », as a feed writes
// it), so the measure finds the stops the engine's resolver finds.
const nameKey = (s) => str(s).replace(/œ/gi, "oe").replace(/æ/gi, "ae").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

module.exports = { nameKey };
