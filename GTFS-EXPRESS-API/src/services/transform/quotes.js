/**
 * Checks that the quote an operation cites (source.quote) is really in what the user
 * wrote: the brief, earlier messages, the text of attached documents. A model can
 * invent quotes. A quote is verified when, normalized, it is a substring of a source;
 * or 85 % of its words stand within one window with every number among them (a figure
 * is never paraphrased); or its pieces around "…" stand in a source in order. A PDF is
 * not read here, so a quote it may come from is reported "pdf", not "not_found".
 */

"use strict";

const THRESHOLD = 0.85;
const MAX_QUOTE_CHARS = 1000;

const normalizeText = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‘’‚‛′´`]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…|\.{3,}/g, " ")
    .replace(/[\s  ]+/g, " ")
    .trim();

// Punctuation that hugs French quotes and colons ("« texte »", "ligne :") is noise.
const compact = (s) => normalizeText(s).replace(/\s*(["'])\s*/g, "$1").replace(/\s+([:;!?,.])/g, "$1");
const words = (s) => normalizeText(s).split(/[^a-z0-9]+/).filter(Boolean);
const hasDigit = (w) => /\d/.test(w);

/** A window of the quote's length + 25 % (at least + 2) holding 85 % of its words and all its numbers; a sliding multiset count, linear in the source. */
const paraphraseIn = (q, source) => {
  const need = new Map();
  for (const w of q) need.set(w, (need.get(w) || 0) + 1);
  const digits = q.filter(hasDigit).length;
  const size = q.length + Math.max(2, Math.ceil(q.length * 0.25));
  const have = new Map();
  let matched = 0;
  let matchedDigits = 0;
  const add = (w, d) => {
    const n = need.get(w);
    if (!n) return;
    const h = have.get(w) || 0;
    // An occurrence counts while the window holds no more of that word than the quote.
    if (d > 0 ? h < n : h <= n) {
      matched += d;
      if (hasDigit(w)) matchedDigits += d;
    }
    have.set(w, h + d);
  };
  for (let i = 0; i < source.length; i++) {
    add(source[i], 1);
    if (i >= size) add(source[i - size], -1);
    if (matched >= THRESHOLD * q.length && matchedDigits === digits) return true;
  }
  return false;
};

const verifyQuote = (quote, texts) => {
  const raw = String(quote ?? "").slice(0, MAX_QUOTE_CHARS);
  const q = compact(raw);
  if (!q) return { verified: false };
  const sources = (texts || []).filter((t) => typeof t === "string" && t.trim());
  const compacted = sources.map(compact);
  if (compacted.some((s) => s.includes(q))) return { verified: true, how: "exact" };
  const pieces = raw.split(/…|\.{3,}|\[\s*\.\.\.\s*\]/).map(compact).filter(Boolean);
  if (pieces.length >= 2 && pieces.some((p) => words(p).length >= 3)) {
    for (const s of compacted) {
      let at = 0;
      const ok = pieces.every((p) => {
        const i = s.indexOf(p, at);
        if (i < 0) return false;
        at = i + p.length;
        return true;
      });
      if (ok) return { verified: true, how: "fragments" };
    }
  }
  const qw = words(raw);
  if (!qw.length) return { verified: false };
  if (sources.some((s) => paraphraseIn(qw, words(s)))) return { verified: true, how: "paraphrase" };
  return { verified: false };
};

/** Records the verdict on each operation's source; `trusted` holds quotes verified earlier whose message left the history. */
const verifyOperations = (operations, { texts = [], pdfNames = [], textNames = [], trusted = null } = {}) => {
  const out = [];
  const trust = trusted instanceof Set ? trusted : new Set();
  for (const op of Array.isArray(operations) ? operations : []) {
    if (!op || typeof op !== "object") continue;
    const source = op.source && typeof op.source === "object" ? op.source : null;
    let verdict;
    if (source?.generated_by === "optimizer") verdict = { verified: null, reason: "generated" };
    else if (!source || typeof source.quote !== "string" || !source.quote.trim()) verdict = { verified: false, reason: "missing" };
    else if (trust.has(compact(source.quote)) || verifyQuote(source.quote, texts).verified) verdict = { verified: true, reason: null };
    else {
      // Not in the text the server can read: from a PDF it may be (unverifiable), unless the operation names a text document.
      const doc = typeof source.document === "string" ? source.document.trim().toLowerCase() : "";
      const namesText = doc && textNames.some((n) => String(n).toLowerCase() === doc);
      const namesPdf = doc && pdfNames.some((n) => String(n).toLowerCase() === doc);
      verdict = pdfNames.length && !namesText && (namesPdf || !doc) ? { verified: false, reason: "pdf" } : { verified: false, reason: "not_found" };
    }
    if (source) {
      source.verified = verdict.verified;
      if (verdict.reason) source.verify_reason = verdict.reason;
      else delete source.verify_reason;
    }
    out.push({ id: op.id || null, quote: source?.quote || null, ...verdict });
  }
  return out;
};

const quoteVerdictOf = (op) => {
  const s = op?.source && typeof op.source === "object" ? op.source : null;
  if (s?.generated_by === "optimizer") return { quote_verified: null, quote_reason: "generated" };
  if (s && typeof s.verified === "boolean") return s.verified ? { quote_verified: true } : { quote_verified: false, quote_reason: s.verify_reason || "not_found" };
  return { quote_verified: null, quote_reason: s?.quote ? "unchecked" : "missing" };
};

module.exports = { normalizeText, verifyQuote, verifyOperations, quoteVerdictOf, _internals: { compact, words, paraphraseIn, THRESHOLD } };
