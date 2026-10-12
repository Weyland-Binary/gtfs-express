/**
 * coverage — G5, the coverage detector: does the contract say everything the
 * brief requires? Deterministic, no model.
 *
 * The brief and the documents' text (Word, OpenDocument, spreadsheets, text,
 * and a PDF's text layer read at ingestion) are split into units — sentences,
 * bullets, table rows; in a spreadsheet's sheets (« ## Sheet: »), a row of
 * three cells or more is a table's row (a timetable, a desserte grid of
 * « oui », an offer or a summary table: values under headers the row does
 * not carry), never a unit on its own: the sheet reader (spreadsheet/parser,
 * step 6) reads its values into clauses that cite their cells, and only its
 * cells of words (a comment beside the values) are units, each alone; a row
 * of two cells reads as a sentence, one unit as before — and a unit is a
 * REQUIREMENT SENTENCE when it carries
 * an obligation (« doit », « devra », « au moins », « au plus », « garantie »,
 * « limitée à », must, shall…) or a commitment stated as a fact (« sera
 * desservi », « est renommé », « deviennent accessibles ») with a measurable
 * fact or something to do, or measurable facts of several kinds (a time — a
 * time range counts twice, its two bounds —, a duration or a frequency, a
 * peak or off-peak period, a day word, a date, a line number, a count of
 * stops, lines or trips, an itinerary, an amount, a fare, coordinates), or a
 * service verb such as « dessert », « circulera », « fonctionne », « est
 * supprimée » with a change marker such as « désormais », « à partir du »,
 * « la fin des ». Each requirement sentence is then mapped:
 *
 *   covered        a clause of the contract quotes it — the quote verifier
 *                  (transform/quotes.verifyQuote) decides, and a quote that is
 *                  not found in the texts never covers anything (a forged quote)
 *                  — and its kind can measure what the sentence states
 *                  (kindAnswers: a sentence stating a clock time, a duration, a
 *                  count of trips or of lines, vehicles or stops, money, a
 *                  distance or a share is answered only by a kind measuring one
 *                  of them; quoted only by other kinds, it stays uncovered with
 *                  `reason: "kind_mismatch"`, the clauses and the quantities);
 *   not_measurable a wish « à vérifier à la main » quotes it (same rule);
 *   dismissed      a named person dismissed it (contract.dismissed, the G4
 *                  acknowledgement shape — contractService refuses an unnamed one);
 *   uncovered      none of the above: listed in ② (« Exigences sans clause »),
 *                  reported in the verdict, and the plan is not deliverable
 *                  until each one is covered, marked or dismissed.
 *
 * A quote covers a sentence only when, the quote being verified in the texts,
 * it stands INSIDE that one sentence (verbatim, fragments or a paraphrase:
 * verifyQuote on the sentence alone). A quote spanning several sentences
 * covers none of them: one clause measures one thing, and a paragraph quoted
 * whole would otherwise answer every requirement in it whatever the clause
 * measures — the sentences it spans stay uncovered (their detail names the
 * clause, `spanned_by`) until the person splits it. A quote of fewer than
 * three words covers nothing: « 15 minutes » is in too many sentences to say
 * which one it answers. Two readings keep a quote and its sentence together
 * where the brief's own layout parts them:
 *   - the marker a line opens with (« - », « 2. », a footnote's call « (1) »)
 *     is not part of the unit (segment), nor of a quote matched against one:
 *     « (1) Ne circule pas pendant les vacances scolaires. » answers the unit
 *     « Ne circule pas pendant les vacances scolaires. »;
 *   - one statement in two sentences is quoted as one: a quote standing
 *     verbatim across sentences of one line answers them when every sentence
 *     after the first goes on with its subject (a pronoun, a possessive, a
 *     demonstrative: « Elle remplace toutes les courses de ce sens le
 *     samedi. »), names nothing the ones before it do not (anchorsOf: no
 *     line, day, time, period, figure or word of its own beyond the words of
 *     an offer) and does nothing they did not but what a clause's kind
 *     measures (ACTS, KIND_ACTS: « Ses autres courses sont supprimées. » is no
 *     headway's), the kind measuring what the statement states as a whole.
 *     Anything else across sentences — a paragraph, a sentence with a subject,
 *     a place, a day or a figure of its own — answers none of them.
 *
 * A HEADING is no requirement on its own: a short line without a final stop
 * that opens what follows, numbered or not (« 2. Ligne D — nouvelle grille
 * horaire en semaine », « Annexes »), after nothing or a sentence and before
 * a paragraph (Word's heading styles do not reach the document's text, nor a
 * PDF's: briefDocumentService.docxText writes one paragraph a line). It is
 * answered with its section — and so is its copy in another source, such as
 * the bullets of an extraction's note — when a requirement sentence of the
 * paragraph right under it says it again: the lines, days, times, periods,
 * figures and words of its own it names are all that sentence's (anchorsOf),
 * the days exactly when it names some (« … pendant les vacances scolaires »
 * is not « le samedi pendant les vacances scolaires »), and what it does to
 * the offer that sentence does too (HEADING_ACTS: a removal, a replacement, a
 * detour, a stop served — a stop it names is one: « nouvel arrêt » —, the
 * offer kept, two lines merged; a word of an act no ACTS reads is an anchor:
 * « simplification »); that sentence is answered as any other. A heading its
 * paragraph does not say again (« Ligne 3 — desserte de l'hôpital » above a
 * frequency, « Ligne 7 — suppression » above the hours it keeps, « Lignes 6
 * et 7 — fusion » above their frequency) stays a requirement sentence, and so
 * does a line stating a quantity (a time, a count, a frequency in figures:
 * « La ligne 6 passe toutes les 10 minutes » is a sentence that lost its
 * stop, never a title). The short lines under a line that opens a list
 * (« … : ») are its items, never headings; a line ending on a word a sentence
 * goes on after (« … toutes les »), or in a PDF a line nearly as long as the
 * one under it (the page wrapped it), is never one.
 *
 * A document the detector cannot read is never skipped silently: an id it
 * cannot resolve (unknown, expired, or a document a project keeps that this
 * caller does not own: `missing`), a document without text (a scanned PDF, a
 * text layer that could not be read: `no_text`), a text cut at the size limit
 * (`truncated`) is listed in `unread`, and — until a named person
 * acknowledges it (contract.dismissed { sentence: "doc:<id>", by: { name } },
 * the G4 shape) — counted as one uncovered entry ({ id: "doc:<id>", unread:
 * reason }): under a decided or assumed contract the plan is not deliverable
 * while a document nobody read may hold a requirement.
 *
 * The work is bounded (the route is public): at most MAX_SENTENCES sentences
 * and MAX_QUOTES quotes per list (the contract's own bound: every clause and
 * every wish a contract may hold is read), each pair pre-filtered on the words
 * before the quote verifier runs, and a time budget past which the sentences
 * not yet checked are reported uncovered (`incomplete: true`, never covered by
 * default); the quotes standing across sentences are read within half of it, the
 * sentences keep the rest.
 *
 *   segment(text, { source, paged? }) → [{ text, source, page, index, line, heading? }]  (line: the line it is read
 *        from; heading: true on a heading's line — answered with its section or not, requirementSentences decides;
 *        paged: a PDF's text, whose lines the page wrapped)
 *   isRequirement(text) → { requirement, markers: [kinds] }
 *   requirementSentences(sources) → [{ id, text, source, page, markers }]  (sources: [{ name, text, paged? }], read in
 *        order until MAX_SENTENCES sentences are kept)
 *   coverageOf({ contract, sources, unread?, budgetMs? }) → { sentences, covered, not_measurable, dismissed,
 *        uncovered: [{ id, text, source, page, unread?, reason?, mismatched?, measures? }],
 *        unread: [{ id, name, reason, acknowledged_by? }],
 *        detail: [{ id, state, by: [clause or wish ids], spanned_by?, reason?: "kind_mismatch", mismatched?, measures? }], incomplete? }
 *   measuresOf(text) → the quantities a sentence states; kindAnswers(kind, measures) → whether a kind measures one
 *   coverageForContract({ contract, documentIds, notes, canRead? }) → coverageOf's answer + gated (null without a contract)
 *   sentenceId(text) → "s_<hash>": the stable id of a sentence (its normalised words)
 *   documentKey(id) → "doc:<id>": the id a named acknowledgement of an unread document carries
 */

"use strict";

const { normalizeText, verifyQuote, _internals: Q } = require("../transform/quotes");
const { PAGE_BREAK } = require("../network/pdfText");
const { MAX_CLAUSES } = require("../network/conformanceService");
const { MAX_WISHES } = require("./contractService");

const MIN_WORDS = 4;
const MIN_QUOTE_WORDS = 3;
const MAX_SENTENCES = 2000;
// Every quote of a contract at its bound is read: as many clauses (conformanceService.MAX_CLAUSES) and as many wishes
// (contractService.MAX_WISHES, ②'s one act records one per sentence no objective answers) — a quote past a smaller
// bound would leave its sentence « uncovered » with its answer in the contract, and hold the delivery on it.
const MAX_QUOTES = Math.max(MAX_CLAUSES, MAX_WISHES);
const BUDGET_MS = 2000;
const THRESHOLD = Q.THRESHOLD; // the quote verifier's paraphrase share: a quote whose words are not there cannot stand there

// Abbreviations that end with a dot inside a sentence (« p. 12 », « M. Dupont », « n° », « av. »).
const ABBREVIATIONS = /(?:^|[\s(])(?:p|pp|m|mm|mme|mlle|dr|st|ste|n|no|art|cf|etc|av|bd|env|ex|réf|ref|vol|chap|fig|tab|min|max|approx|vs|ca|resp|inc|ltd)\.$/i;

// A spreadsheet's sheet, as the document service writes it (network/briefDocumentService.spreadsheetText).
const SHEET_TITLE = /^#{1,6}\s*sheet:/i;
// A Markdown or spreadsheet separator (« --- », « |---|---| »).
const SEPARATOR = /^[|:\-\s]+$/;
// A clock time in a cell (« 7:50 », « 07h50 », « 7h »).
const CELL_CLOCK = "(?:\\d{1,2}\\s?h\\s?\\d{0,2}|\\d{1,2}:\\d{2})";
/**
 * A cell holding an offer value, not words: a clock time, a range (« 7:50 - 20:05 », « 7h-9h : 15 min », « 30 -
 * 60 »), a number, a date (« 12-sept », « 01/09/2026 »), or a desserte mark (« oui », « x », « … », « ..... »,
 * « — », and « / » — the document service writes a « | » inside a cell so).
 */
const VALUE_CELL = new RegExp(
  [
    `^${CELL_CLOCK}$`,
    `^${CELL_CLOCK}\\s?[-–—à>/]\\s?${CELL_CLOCK}(?:\\s?:\\s?\\d+\\s?(?:min|mn|minutes?)?)?$`,
    "^[-+]?\\d+(?:[.,]\\d+)?\\s?(?:%|min|mn|minutes?|€|km)?$",
    "^\\d+\\s?[-–/]\\s?\\d+\\s?(?:min|mn|minutes?)?$",
    "^\\d{1,2}[-/. ](?:\\d{1,2}|[a-z]{3,9}\\.?)(?:[-/. ]\\d{2,4})?$",
    "^\\d{4}-\\d{2}-\\d{2}$",
    "^(?:oui|non|x|yes|no|nc|✓|✔|☑|√|-+|—|–|\\||·|↓|↑|…+|(?:\\.\\s?){2,}|/)$",
  ].join("|"),
);
// (normalizeText turns « … » and « ..... » into nothing: a cell of dots alone is a mark.)
const isValueCell = (cell) => {
  const t = normalizeText(cell).trim();
  return !t || VALUE_CELL.test(t);
};

/**
 * The units of a spreadsheet row (its empty cells aside): `row`, the row as one unit when it holds two cells
 * (« Amplitude de service | 6h30 - 20h30 » reads as a sentence); else `cells` read as prose — its one cell, or, in a
 * table's row (a timetable's stop and its times, a desserte grid's « oui », an offer row, a summary's « Courses |
 * Dir Gare | 12 | 11 | 9 »: values under headers the joined row does not carry, never a requirement sentence on
 * its own — the sheet reader reads it, step 6, and its clauses quote its cells), only its cells of words, each on
 * its own (a comment beside the values).
 */
const sheetRowUnits = (body) => {
  const cells = body.split("|").map((c) => c.trim()).filter(Boolean);
  if (cells.length === 2) return { row: cells.join(" | ") };
  return { cells: cells.length < 2 ? cells : cells.filter((c) => !isValueCell(c)) };
};

// The marker a line opens with — a bullet, a number, a letter, a footnote's call (« - », « 2. », « (1) », « a) »): the
// unit is read without it, and so is a quote matched against a unit (preparedQuote).
const LIST_MARKER = /^(?:[-*•·–—]\s+|\(?\d{1,2}[.)]\s+|[a-z][.)]\s+)/i;

/**
 * The sentences of one line (or of one cell of a sheet's row): cut after a stop, an exclamation or a question mark
 * followed by what opens a sentence, never after an abbreviation. A semicolon does not end a sentence here: annexes
 * list stops « Name lat, lon ; Name lat, lon ; … ».
 */
const splitSentences = (body) => {
  const out = [];
  let start = 0;
  const re = /([.!?])\s+(?=[«"(A-ZÀ-ÝŒ0-9])/g;
  let m;
  while ((m = re.exec(body))) {
    const piece = body.slice(start, m.index + 1).trim();
    if (m[1] === "." && ABBREVIATIONS.test(piece)) continue;
    if (piece) out.push(piece);
    start = re.lastIndex;
  }
  const rest = body.slice(start).trim();
  if (rest) out.push(rest);
  return out;
};

// ── Headings (see the header) ──
const HEADING_MAX_WORDS = 16;
// A line ending a sentence (a stop, before a closing quote or bracket), or opening a list (« : », « ; »).
const ENDS_SENTENCE = /[.!?…]["'»”’)\]]*$/;
const OPENS_LIST = /[:;]["'»”’)\]]*$/;
const BULLET = /^[-*•·–—]\s+/;
// A line ending on a word a sentence goes on after (« … toutes les », « … vers »): a wrapped line (a PDF's), never a
// heading. Read on the line as written: « Ligne A » ends on a line's name, « … jusqu'à » on a preposition.
const GOES_ON = /(?:^|[\s'’])(?:le|la|les|l|un|une|des|du|de|d|à|au|aux|en|et|ou|par|pour|sur|sous|dans|avec|vers|entre|chez|sans|que|qui|dont|the|an?|of|to|and|or|for|with|at|by|in|on|from|into)['’]?$/;

// In a text whose lines a page wrapped (a PDF's), a heading is this much shorter than the line under it at most: a
// wrapped line is as long as the column (« La ligne 3 dessert désormais l'arrêt » / « Hôpital Nord … »).
const WRAPPED_HEADING_SHARE = 0.6;

/**
 * The merged lines of a text that are headings: each line is `short` (one sentence of HEADING_MAX_WORDS words at
 * most, ending neither with a stop nor with « : » or « ; », nor on a word a sentence goes on after; never a bullet, a
 * table row or a sheet's row), `body` (a sentence's end, a bullet, a table row, a sheet's row), `opens` (« : »,
 * « ; ») or `loose` (anything else: a long line without a stop). A run of short lines — a heading and its
 * sub-headings — after nothing or a body line, before a line that is not short, is headings; under a line that
 * opens a list they are its items, and a run that ends the text introduces nothing. `wrapped`: the lines are a
 * page's (a PDF), each heading of a run is then WRAPPED_HEADING_SHARE of the line after it at most. → Set of indexes.
 */
const headingLines = (merged, { wrapped = false } = {}) => {
  const kindOf = (l) => {
    if (l.sheet || /\|/.test(l.line) || SEPARATOR.test(l.line)) return "body";
    if (OPENS_LIST.test(l.line)) return "opens";
    if (ENDS_SENTENCE.test(l.line) || BULLET.test(l.line)) return "body";
    const body = l.line.replace(LIST_MARKER, "").trim();
    return !GOES_ON.test(body) && splitSentences(body).length === 1 && Q.words(body).length <= HEADING_MAX_WORDS ? "short" : "loose";
  };
  const lines = merged.map((l, i) => ({ i, kind: l.line ? kindOf(l) : null })).filter((l) => l.kind);
  const out = new Set();
  for (let a = 0; a < lines.length; ) {
    let b = a;
    if (lines[a].kind === "short") {
      while (b + 1 < lines.length && lines[b + 1].kind === "short") b += 1;
      const before = a > 0 ? lines[a - 1].kind : "body";
      const run = lines.slice(a, b + 1).map((l) => l.i);
      const under = b + 1 < lines.length ? merged[lines[b + 1].i].line.length : 0;
      if (before === "body" && under && (!wrapped || run.every((i) => merged[i].line.length <= WRAPPED_HEADING_SHARE * under))) run.forEach((i) => out.add(i));
    }
    a = b + 1;
  }
  return out;
};

/**
 * The units of a text: its lines (a wrapped line joined to the previous one), then sentences inside a line. In a
 * spreadsheet's sheets (« ## Sheet: name »), a table row is split by sheetRowUnits, and a row is never the rest of
 * the line above it. Each unit names its line (`line`); a heading's line is marked (`heading`, headingLines; `paged`:
 * a PDF's text, whose lines the page wrapped).
 */
const segment = (text, { source = "brief", paged = false } = {}) => {
  const out = [];
  const raw = String(text || "");
  let page = 1;
  const lines = [];
  for (const chunk of raw.split(PAGE_BREAK)) {
    for (const line of chunk.split(/\r?\n/)) lines.push({ line: line.replace(/\s+/g, " ").trim(), page });
    page += 1;
  }
  // A line that does not end a sentence, followed by one that starts with a lower-case letter, is a wrapped line.
  const merged = [];
  let inSheet = false;
  for (const l of lines) {
    const prev = merged[merged.length - 1];
    if (!l.line) {
      merged.push({ line: "", page: l.page, sheet: inSheet });
      continue;
    }
    if (SHEET_TITLE.test(l.line)) inSheet = true;
    if (!inSheet && prev && prev.line && !/[.!?:;»"]$/.test(prev.line) && /^[a-zàâäéèêëîïôöùûüç(«"]/.test(l.line) && !/\|/.test(prev.line)) prev.line = `${prev.line} ${l.line}`;
    else merged.push({ ...l, sheet: inSheet });
  }
  const headings = headingLines(merged, { wrapped: paged });
  merged.forEach(({ line, page: p, sheet }, i) => {
    if (!line) return;
    // Markdown and spreadsheet separators, sheet titles: no requirement there.
    if (SEPARATOR.test(line) || SHEET_TITLE.test(line)) return;
    const heading = headings.has(i);
    const push = (t) => out.push(heading ? { text: t, source, page: p, line: i, heading } : { text: t, source, page: p, line: i });
    const body = line.replace(LIST_MARKER, "").trim();
    // A spreadsheet's row: its units (sheetRowUnits) — a row of two cells one unit, else its cells of words.
    if (sheet && /\|/.test(body)) {
      const units = sheetRowUnits(body);
      if (units.row) push(units.row);
      else for (const u of units.cells) splitSentences(u).forEach(push);
      return;
    }
    // A table row (" | " between cells) is one unit.
    if (/\s\|\s/.test(body)) {
      push(body);
      return;
    }
    splitSentences(body).forEach(push);
  });
  out.forEach((u, index) => {
    u.index = index;
  });
  return out;
};

// ── What a requirement sentence carries (on the normalised text: lower case, no accents) ──

const MONTHS = "janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|january|february|march|april|june|july|august|september|october|november|december";
// A clock time as the briefs write it (« 6h30 », « 7 h », « 07:40 »).
const CLOCK = "(?:\\d{1,2}\\s?h\\s?\\d{0,2}|\\d{1,2}:\\d{2})";
const MARKERS = {
  obligation: /(?<![a-z])(?:doit|doivent|devra|devront|devrait|devraient|il faut|il faudra|faudra|est tenue?s?|sont tenue?s|obligatoire|imperati[fv]e?s?|exig[eé]e?s?|exigence|requise?s?|necessaire|impose|imposee|s'engage|garanti[rs]?|garantie?s|garantit|assurer|assurera|assuree?s?|limitee?s?|plafonnee?s?|plafond|au moins|au plus|au minimum|au maximum|pas plus de|pas moins de|ne pas depasser|ne depasse|must|shall|required|requires|mandatory|need to|needs to|has to|have to|at least|at most|no more than|no less than|not exceed|guaranteed|should)(?![a-z])/,
  // A commitment stated as a fact or in the future: « le quartier sera desservi », « l'arrêt est renommé », « deviennent accessibles ».
  commitment: /(?<![a-z])(?:(?:est|sont|sera|seront|restera|resteront)\s(?:\S+\s)?(?:renommee?s?|creee?s?|supprimee?s?|desservie?s?|maintenue?s?|prolongee?s?|completee?s?|deplacee?s?|ajoutee?s?|en correspondance|mise? en place|mises en place)|devient|deviennent|deviendra|deviendront)(?![a-z])/,
  time: /(?<![a-z0-9])(?:\d{1,2}\s?h\s?\d{0,2}|\d{1,2}:\d{2}|midi|minuit|noon|midnight)(?![a-z0-9])/,
  // A time range is two facts (« de 6h30 à 20h30 », « entre 7h et 9h », « 6h30-20h30 »): the first and the last bound.
  range: new RegExp(`(?<![a-z0-9])(?:(?:de|entre|from|between)\\s${CLOCK}\\s(?:a|et|jusqu'a|to|and|until)\\s${CLOCK}|${CLOCK}\\s?-\\s?${CLOCK})(?![a-z0-9])`),
  frequency: /(?<![a-z])(?:\d+\s?(?:min|mn)|minutes?|toutes les|tous les|chaque|every|frequence|cadence|headway|par heure|par jour|par sens|allers?-retours?|round trips?|courses?|departs?|trips?|passages?|renforts?|doublage|(?:une|deux|trois|\d+)\s+heures?\s+(?:avant|apres|before))(?![a-z])/,
  // A period of the day a frequency or a span is stated for.
  period: /(?<![a-z])(?:heures? de pointe|heures? creuses?|hors pointe|pointe du (?:matin|soir)|periodes? de pointe|peak hours?|off-peak|rush hours?)(?![a-z])/,
  day: /(?<![a-z])(?:lundis?|mardis?|mercredis?|jeudis?|vendredis?|samedis?|dimanches?|semaine|jours? feries?|feries?|week-?ends?|vacances|scolaires?|7\s?j(?:ours)?\s?(?:sur|\/)\s?7|weekdays?|saturdays?|sundays?|mondays?|fridays?|holidays?|school)(?![a-z])/,
  date: new RegExp(`(?<![a-z0-9])(?:\\d{1,2}(?:er)?\\s+(?:${MONTHS})|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?|rentree|septembre|janvier)(?![a-z])`),
  line: /(?<![a-z])(?:(?:lignes?|lines?|navettes?|shuttles?|routes?)\s+(?:[a-z]{0,3}\d+[a-z]?|[a-z]{1,2}(?![a-z])|« |")|(?:lignes?|lines?)\s+(?:[a-z]+\s+){0,2}n[°o]?\s?\d+|bus\s+\d+[a-z]?(?!\s?%|\d))/,
  // A count of stops, lines, vehicles or trips (« 8 arrêts de correspondance », « 5 lignes fortes »).
  count: /(?<![a-z0-9])\d+\s+(?:arrets?|lignes?|courses?|vehicules?|bus|cars?|communes?|allers?-retours?|departs?|trajets?|navettes?|circuits?|stations?)(?![a-z])/,
  // Where a line goes: « relie A à B », « en passant par », a list of stops served (« dessert X, Y et Z »), an itinerary
  // given as a list (« Retour : A, B, C », « Ligne 9 : A – B – C »).
  itinerary: /(?<![a-z])(?:(?:relie|relient|reliera|relieront|reliant)\s.+?\sa\s|en passant (?:notamment )?par|(?:dessert|desservent|desservira|desserviront|desservant|desservies?)\s[^.]*?,[^.,]*(?:,|\set\s)|(?:aller|retour)\s?:\s?[^,]+,[^,]+,|lignes?\s\S+\s?:\s?[^:]+?\s-\s[^:]+?\s-\s)/,
  service: /(?<![a-z])(?:dessert|desservent|desservant|desservie?s?|desservira|desserviront|desservir|desserte|terminus|arrets?|prolongee?s?|prolonger|prolongement|supprimee?s?|supprimer|suppression|ajoutee?s?|ajouter|ajout|nouvel|nouvelle|nouveaux|creee?s?|creer|creation|circule|circulent|circulera|circuleront|circulation|fonctionne|fonctionnent|fonctionnera|fonctionneront|fonctionnement|amplitude|reliera|relie|relient|remplace|remplacera|remplacee?s?|remplacer|echangent|fusionnee?s?|fusion|avancee?s?|avancer|retardee?s?|decalee?s?|decaler|renforcee?s?|renforcer|renforcement|completee?s?|itineraires?|parcours|trajets?|horaires?|passage|renommee?s?|renommer|accessibles?|accessibilite|pmr|fauteuils? roulants?|correspondances?|deploie|deploiera|mise? en place|en vigueur|applicables?|valables?|validite|s'appliquent|s'applique|s'arreteront|s'arretera|arreteront|serves?|served|extended|removed|added|runs?|stops?|timetables?)(?![a-z])/,
  change: /(?<![a-z])(?:desormais|a partir d[ue]|a compter d[ue]|des le|jusqu'au|jusqu'a|au lieu de|contre|ne \S+ plus|n'\S+ plus|plus tot|plus tard|plus rapides?|plus courts?|plus directs?|plus frequente?s?|passant de|passe de|(?:la |le )?fin d[eu]s?|fin de la|concernee?s?|inchangee?s?|conservee?s?|conserver[a]?|maintenue?s?|reconduite?s?|ne changent pas|ne change pas|aucun changement|restent|reste a|pas de service|aucune circulation|ne circulen?t? pas|instead of|from now|no longer|unchanged|as of|until)(?![a-z])/,
  coordinates: /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/,
  amount: /(?:€|(?<![a-z])(?:euros?|budget|vehicules?|vehicles?|fleet|flotte|km)(?![a-z]))/,
  fare: /(?<![a-z])(?:tarifs?|tickets?|abonnements?|titres? de transport|gratuit(?:e|es|s)?|gratuite|fares?)(?![a-z])/,
};
const FACTS = ["time", "range", "frequency", "period", "day", "date", "line", "count", "itinerary", "amount", "fare", "coordinates"];

/** Whether a unit is a requirement sentence, and the markers it carries. */
const isRequirement = (text) => {
  const t = normalizeText(text);
  const words = t.split(/[^a-z0-9]+/).filter(Boolean);
  // « Nouvelle ligne K. »: a line and what happens to it say enough in three words.
  const short = words.length === MIN_WORDS - 1 && MARKERS.line.test(t) && MARKERS.service.test(t);
  if (words.length < MIN_WORDS && !short) return { requirement: false, markers: [] };
  const markers = Object.entries(MARKERS)
    .filter(([, re]) => re.test(t))
    .map(([k]) => k);
  const facts = markers.filter((k) => FACTS.includes(k)).length;
  const obligation = markers.includes("obligation") || markers.includes("commitment");
  // A unit that introduces what follows (« … à compter du lundi 28 avril, tous les jours : », a source cited
  // « Page de la Ville …, publiée le 1er septembre 2026 : ») states nothing by itself.
  if (/:\s*$/.test(String(text).trim()) && !obligation) return { requirement: false, markers };
  // An itinerary (« relie A à B », « Retour : A, B, C ») is both what the line does and where: an act and a fact.
  const acts = markers.includes("service") || markers.includes("change") || markers.includes("itinerary");
  // An obligation (or a commitment: « sera desservi », « est assurée ») with something to measure or to do; a change
  // stated as a fact (the notices' style: « la ligne H ne dessert plus… », « à compter du 4 janvier ») with a
  // measurable fact; or two measurable facts together (a timetable line; a time range is two).
  const requirement = (obligation && (facts >= 1 || acts)) || (acts && facts >= 1) || (markers.includes("service") && markers.includes("change")) || facts >= 2 || short;
  return { requirement, markers };
};

// ── Which clause kinds can answer a sentence (G5: a clause covers a sentence it can measure) ──

/**
 * The quantities a requirement sentence states, which a clause must be able to
 * measure to answer it: a clock time, a duration (a headway, a running time,
 * a wait), a count of trips, a count of lines, vehicles or stops, an amount of
 * money, a distance, a share. A sentence without any (a stop served, a line
 * created, a scope) can be answered by any kind; one with some, only by a
 * clause whose kind measures at least one of them — a line_exists clause
 * quoting « un bus toutes les 15 minutes » leaves the frequency unmeasured.
 */
const MEASURES = {
  clock: new RegExp(`(?<![a-z0-9])(?:${CLOCK}|midi|minuit|noon|midnight)(?![a-z0-9])`),
  duration: /(?<![a-z0-9])(?:\d+\s?(?:min|mn|minutes?)|\d+\s?(?:h|heures?)\s+(?:de trajet|de parcours|d'amplitude|de service)|toutes les \d+|tous les \d+|every \d+|frequence|cadence|headway|par heure|(?:une|deux|trois|\d+)\s+heures?\s+(?:avant|apres))(?![a-z])/,
  trips: /(?<![a-z0-9])(?:\d+|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s+(?:\S+\s)?(?:courses?|departs?|passages?|allers?-retours?|trajets?|rotations?|trips?|round trips?|services? (?:par|a|quotidiens?))(?![a-z])/,
  lines: /(?<![a-z0-9])\d+\s+(?:\S+\s)?(?:lignes?|lines?)(?![a-z])/,
  vehicles: /(?<![a-z0-9])\d+\s+(?:\S+\s)?(?:vehicules?|bus|cars?|vehicles?)(?![a-z])/,
  stops: /(?<![a-z0-9])\d+\s+(?:\S+\s)?(?:arrets?|stations?|stops?)(?![a-z])/,
  money: /(?:€|(?<![a-z])(?:euros?|budget|eur)(?![a-z]))/,
  distance: /(?<![a-z0-9])\d[\d\s.,]*\s?(?:km|kilometres?)(?![a-z])/,
  share: /(?<![a-z0-9])\d+(?:[.,]\d+)?\s?(?:%|pour ?cent|percent)/,
};
// What each clause kind measures among them (conformanceService.KINDS; a kind not listed measures none).
const KIND_MEASURES = {
  headway_max: ["clock", "duration", "trips"],
  span: ["clock", "duration"],
  od_max_time: ["clock", "duration"],
  running_time: ["clock", "duration"],
  trips_count: ["clock", "duration", "trips"],
  departure_at: ["clock", "duration", "trips"],
  same_as: ["clock"],
  unchanged_except: ["clock", "duration", "trips"],
  transfer_max_wait: ["clock", "duration"],
  // The lines a brief counts are answered by the clauses naming them (« 7 lignes urbaines (1 à 7) »: line_exists each).
  line_exists: ["lines"],
  lines_max: ["lines"],
  lines_min: ["lines"],
  fleet_max: ["vehicles"],
  budget_max: ["money"],
  service_km_max: ["distance"],
  vehicle_hours_max: ["duration"],
  population_coverage: ["share", "distance"],
  accessibility: ["share", "stops"],
  via: ["stops"],
  stop_pattern: ["stops"],
  pickup_dropoff: ["stops"],
  serves: ["distance"],
};

/** The quantities a sentence states (MEASURES), on its normalised text. */
const measuresOf = (text) => {
  const t = normalizeText(text);
  return Object.entries(MEASURES)
    .filter(([, re]) => re.test(t))
    .map(([k]) => k);
};

/**
 * Whether a clause of `kind` can answer a sentence stating `measures`: yes when the sentence states no quantity,
 * when the kind is not given (a wish, an older caller), or when the kind measures one of them.
 */
const kindAnswers = (kind, measures) => !kind || !measures.length || (KIND_MEASURES[kind] || []).some((m) => measures.includes(m));

/**
 * What a sentence does to the offer, beside the quantities it states: trips removed, replaced or added, stops
 * served, a route changed, a line running, the offer kept. A sentence going on with another (« Elle remplace toutes
 * les courses de ce sens le samedi. ») is answered with it only by a clause whose kind measures what it does
 * (KIND_ACTS), or when the sentence before already did it: « Ses autres courses sont supprimées. » is no headway's.
 */
const ACTS = {
  remove: /(?<![a-z])(?:supprim\w*|suppressions?|retir\w*|ne \S+ plus|n'\S+ plus|plus de (?:service|courses?|departs?)|no longer|removed?|removals?)(?![a-z])/,
  replace: /(?<![a-z])(?:remplac\w*|replac\w*)(?![a-z])/,
  add: /(?<![a-z])(?:ajout\w*|nouvel\w*|nouveaux?|cree\w*|creations?|renfor\w*|supplementaires?|doubl\w*|mise?s? en place|added|new)(?![a-z])/,
  serve: /(?<![a-z])(?:dessert|desserv\w*|dessertes?|passe(?:nt|ra|ront)? par|s'arret\w*|terminus|serves?|served)(?![a-z])/,
  route: /(?<![a-z])(?:prolong\w*|devi(?:e|ee|es|ees|ation|ations)|itineraires?|parcours|reli(?:e|ent|era|eront|ant)|extended|diverted)(?![a-z])/,
  run: /(?<![a-z])(?:circul\w*|fonctionn\w*|runs?)(?![a-z])/,
  keep: /(?<![a-z])(?:inchang\w*|maintien|maintenu\w*|conserv\w*|ne change(?:nt)? pas|pas modifi\w*|identiques?|unchanged)(?![a-z])/,
  // Two lines made one (« fusion des lignes 6 et 7 », « les lignes 6 et 7 fusionnent »): no kind measures it.
  merge: /(?<![a-z])(?:fusion\w*|regroup\w*|merg\w*)(?![a-z])/,
};
// What each clause kind measures among them (a kind not listed measures none).
const KIND_ACTS = {
  trips_count: ["remove", "replace", "add", "run"],
  departure_at: ["remove", "replace", "add"],
  headway_max: ["add", "run"],
  span: ["run"],
  days: ["run"],
  no_service: ["remove", "run"],
  unchanged_except: ["keep"],
  same_as: ["keep", "replace"],
  line_exists: ["add", "run"],
  termini: ["route", "serve"],
  via: ["serve", "route"],
  stop_pattern: ["serve", "route"],
  pickup_dropoff: ["serve", "route", "add"],
  serves: ["serve"],
};
const actsOf = (text) => {
  const t = normalizeText(text);
  return Object.keys(ACTS).filter((k) => ACTS[k].test(t));
};

const hash = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};
const sentenceId = (text) => `s_${hash(Q.words(text).join(" "))}`;

// ── What a statement names of its own (a heading said again by its section, a sentence that goes on with another) ──

// Words naming nothing of their own: articles, prepositions, pronouns, auxiliaries, adverbs (normalised).
const FUNCTION_WORDS = new Set(
  (
    "le la les un une des du de au aux a en et ou par pour sur sous dans avec vers entre chez sans que qui dont ce cet " +
    "cette ces se sa son ses leur leurs il elle ils elles on y ne pas plus moins tres tout tous toute toutes autre autres " +
    "meme aussi deja encore ensuite puis est sont sera seront etre ete ont avait fait font peut peuvent doit doivent devra " +
    "devront selon apres avant depuis jusqu jusque pendant hors sauf compris inclus notamment actuel actuelle actuellement " +
    "aujourd hui desormais ci celle celui ceux ici the an of to and or for with at by in on from into is are be will " +
    "this that these those it its their there all other each every not no as per than also"
  ).split(" "),
);
// The words of an offer that say what changes, not where nor when (« nouvelle grille horaire », « renfort »,
// « suppression du service »): a heading announces them, the sentences of its section state them. A word naming an
// act is one only when ACTS reads that act (« suppression », « fusion », « maintien », « terminus »; a stop named by
// a heading is a stop served, headingActsOf), so that its paragraph must do it too; a word naming what no act reads
// (« simplification », « accessibilité », « correspondance ») is an anchor its paragraph must name.
const OFFER_WORDS = new Set(
  (
    "ligne reseau offre service course depart arrivee passage trajet horaire grille fiche sens direction itineraire " +
    "parcours arret terminus desserte dessert desservent desservi desservie nouveau nouvel nouvelle nouveaux renfort " +
    "renforcement renforce renforcee suppression supprime supprimee supprimer modification modifie modifiee modifier " +
    "changement change changent evolution evolue creation cree creee ajout ajoute ajoutee remplace remplacent remplacee " +
    "remplacement circule circulent circulation fonctionne fonctionnent fonctionnement maintien maintenu maintenue " +
    "prolongement prolonge prolongee prolonger deviation devie deviee fusion fusionne fusionnee " +
    "inchange inchangee adaptation ajustement amenagement organisation mise place general generale principal principale " +
    "annexe cahier charge document avenant article chapitre partie section titre objet contexte presentation generalite " +
    "suit suivent assure assurent propose proposee prevu prevue line route trip departure timetable schedule new removal " +
    "removed added extended stop"
  ).split(" "),
);
const stem = (w) => (w.length > 3 && !/\d/.test(w) ? w.replace(/[sx]$/, "") : w);
const isPlainWord = (w) => FUNCTION_WORDS.has(w) || OFFER_WORDS.has(w) || FUNCTION_WORDS.has(stem(w)) || OFFER_WORDS.has(stem(w));

// A line's name, read where the brief writes it (« ligne D », « lignes B, E et R », « ligne n° 12 »): capitals or
// figures (« la ligne a été… » names none), or one lower-case letter but « a » and « y ».
const LINE_ID = "(?:[A-Z0-9][A-Za-z0-9]{0,4}|[b-xz])";
const LINE_WORD = "(?:[Ll]ignes?|LIGNES?|[Ll]ines?|LINES?|[Nn]avettes?|NAVETTES?|[Ss]huttles?|[Rr]outes?|ROUTES?)";
const LINE_NAMES = new RegExp(`(?<![A-Za-z])${LINE_WORD}\\s(?:[Nn][°o]\\s?)?(${LINE_ID}(?:\\s?(?:,|&|\\/|et|ET|and|ou|OU|or)\\s?(?:(?:[Ll]a|LA)\\s)?(?:${LINE_WORD}\\s)?${LINE_ID})*)(?![A-Za-z0-9])`, "g");
const LINE_LIST = /\s?(?:,|&|\/|\bet\b|\bET\b|\band\b|\bou\b|\bOU\b|\bor\b)\s?/;
const LINE_LIST_ITEM = /^(?:(?:la|lignes?|lines?|navettes?|shuttles?|routes?)\s+)+/i;
const DAY_INDEX = { dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6, sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const DAY_NAME = `(${Object.keys(DAY_INDEX).join("|")})s?`;
const daysFrom = (a, b) => Array.from({ length: ((b - a + 7) % 7) + 1 }, (_, k) => (a + k) % 7);
// Read in this order, each consumed once read: a range of days, the words for several days, a day's own name.
const DAY_WORDS = [
  [new RegExp(`(?<![a-z])${DAY_NAME}\\s?(?:au|a|-|to|through)\\s?${DAY_NAME}(?![a-z])`, "g"), (m) => daysFrom(DAY_INDEX[m[1]], DAY_INDEX[m[2]])],
  [/(?<![a-z])(?:week-?ends?|fins? de semaine)(?![a-z])/g, () => [0, 6]],
  [/(?<![a-z])(?:vacances(?: scolaires)?|school holidays?)(?![a-z])/g, () => ["vacation"]],
  [/(?<![a-z])(?:jours? feries?|feries?|(?:public |bank )?holidays?)(?![a-z])/g, () => ["holiday"]],
  [/(?<![a-z])(?:periodes? scolaires?|scolaires?|school days?|term time)(?![a-z])/g, () => ["school"]],
  [/(?<![a-z])(?:semaines?|jours? ouvres|jours? ouvrables|weekdays?)(?![a-z])/g, () => [1, 2, 3, 4, 5]],
  [/(?<![a-z])(?:tous les jours|chaque jour|7\s?j(?:ours)?\s?(?:sur|\/)\s?7|quotidien(?:ne)?s?|daily|every day)(?![a-z])/g, () => [0, 1, 2, 3, 4, 5, 6]],
  [new RegExp(`(?<![a-z])${DAY_NAME}(?![a-z])`, "g"), (m) => [DAY_INDEX[m[1]]]],
];
const CLOCK_TIME = /(?<![a-z0-9:])(\d{1,2})\s?(?:h|:)\s?(\d{2})?(?![a-z0-9])|(?<![a-z])(midi|minuit|noon|midnight)(?![a-z])/g;
// The periods of a day, and the clock times that say them (« pointe du matin » is said by « de 7h00 à 9h00 »).
const PERIODS = [
  [/(?<![a-z])(?:(?:heures? de )?pointe du matin|morning peak)(?![a-z])/g, "morning"],
  [/(?<![a-z])(?:(?:heures? de )?pointe du soir|evening peak)(?![a-z])/g, "evening"],
  [/(?<![a-z])(?:heures? de pointe|heures? creuses?|periodes? de pointe|hors pointe|pointe|off-peak|peak(?: hours?)?|rush hours?|journees?|daytime)(?![a-z])/g, "day"],
  [/(?<![a-z])(?:apres-midi|afternoons?)(?![a-z])/g, "afternoon"],
  [/(?<![a-z])(?:matin(?:ee)?s?|mornings?)(?![a-z])/g, "morning"],
  [/(?<![a-z])(?:soir(?:ee)?s?|evenings?)(?![a-z])/g, "evening"],
  [/(?<![a-z])(?:nuits?|nights?)(?![a-z])/g, "night"],
];
const PERIOD_HOURS = { morning: (m) => m < 720, afternoon: (m) => m >= 720 && m < 1080, evening: (m) => m >= 960 || m < 180, night: (m) => m >= 1200 || m < 360, day: () => true };

/**
 * What a statement names of its own: its lines, its days (a range « du lundi au vendredi », « en semaine », « le
 * samedi », the holidays, the school days), its clock times, its periods of the day, and every other word that is
 * neither a function word nor a word of an offer (OFFER_WORDS) — the places, stops, figures, months it names.
 *   → { lines, days, clocks, periods, words } (sets)
 */
const anchorsOf = (raw) => {
  const lines = new Set();
  const plain = String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(LINE_NAMES, (_, ids) => {
      for (const id of ids.split(LINE_LIST)) if (id.trim()) lines.add(id.replace(LINE_LIST_ITEM, "").trim().toLowerCase());
      return " ";
    });
  const days = new Set();
  const clocks = new Set();
  const periods = new Set();
  let t = ` ${normalizeText(plain)} `;
  for (const [re, of] of DAY_WORDS)
    t = t.replace(re, (...m) => {
      for (const d of of(m)) days.add(d);
      return " ";
    });
  t = t.replace(CLOCK_TIME, (_, h, mm, word) => {
    clocks.add(word ? (/^(?:midi|noon)$/.test(word) ? 720 : 0) : Number(h) * 60 + Number(mm || 0));
    return " ";
  });
  for (const [re, p] of PERIODS)
    t = t.replace(re, () => {
      periods.add(p);
      return " ";
    });
  const words = new Set(
    t
      .split(/[^a-z0-9]+/)
      .filter((w) => w && (w.length > 1 || /\d/.test(w)) && !isPlainWord(w))
      .map(stem),
  );
  return { lines, days, clocks, periods, words };
};
const every = (set, ok) => [...set].every(ok);
/** Whether every anchor of `a` is one of `b` (a period said by the same words, or by a clock time of its hours). */
const within = (a, b) =>
  every(a.lines, (x) => b.lines.has(x)) &&
  every(a.days, (x) => b.days.has(x)) &&
  every(a.clocks, (x) => b.clocks.has(x)) &&
  every(a.periods, (p) => b.periods.has(p) || [...b.clocks].some(PERIOD_HOURS[p])) &&
  every(a.words, (w) => b.words.has(w));
const union = (a, b) => ({ lines: new Set([...a.lines, ...b.lines]), days: new Set([...a.days, ...b.days]), clocks: new Set([...a.clocks, ...b.clocks]), periods: new Set([...a.periods, ...b.periods]), words: new Set([...a.words, ...b.words]) });

// A heading's own number (« 2.1 », « IV. », « Article 3 : »): no anchor of what it announces.
const SECTION_NUMBER = /^(?:\d{1,2}(?:\.\d{1,2})+\.?|[IVXLC]{1,6}[.)]|(?:article|chapitre|titre|partie|section|annexe|art\.)\s+[\w.]+\s*[:.–—-]?)\s*/i;
// A sentence going on with the subject of the one before it: it opens on a pronoun, a possessive, a demonstrative.
const GOES_ON_WITH = /^(?:elle|il|elles|ils|celle-ci|celui-ci|celles-ci|ceux-ci|son|sa|ses|leur|leurs|cette|ces|cet|ce|it|its|they|their|this|these|those)(?![a-z])/;

// What a heading does that its paragraph must do too (ACTS): trips removed or replaced, a route changed, stops served
// (a stop it names: « Ligne 6 — arrêts supprimés », « nouvel arrêt »), the offer kept, two lines merged — « Ligne 7 —
// suppression » above « La ligne 7 garde ses horaires jusqu'au 31 décembre » stays to answer. What it adds
// (« nouvelle grille », « renfort ») its paragraph says again or details in figures: a frequency, a number of trips
// (« … suit la grille de l'annexe 1 (19 courses) »), never a span alone; the stops or the route it adds, by serving
// them or changing the route (HEADING_ACTS already asks for it), never by a removal.
const HEADING_ACTS = ["remove", "replace", "route", "serve", "keep", "merge"];
const STOP_NOUN = /(?<![a-z])(?:arrets?|stations?|stops?)(?![a-z])/;
const headingActsOf = (text) => {
  const acts = actsOf(text);
  return STOP_NOUN.test(normalizeText(text)) && !acts.includes("serve") ? [...acts, "serve"] : acts;
};
const detailsWhatItAdds = (text) => actsOf(text).includes("add") || measuresOf(text).some((m) => m === "duration" || m === "trips");
/**
 * Whether a line states a quantity (MEASURES: a clock time, a count, an amount, a frequency in figures): « La ligne 6
 * passe toutes les 10 minutes », a sentence that lost its stop, is a requirement whatever the paragraph under it says
 * — a title names what changes, a figure says how much. « nouvelle fréquence » states none.
 */
const statesQuantity = (text) => measuresOf(text).some((m) => m !== "duration") || /\d\s?(?:min|mn|minutes?)(?![a-z])|(?:toutes|tous) les \d|every \d/.test(normalizeText(text));

/**
 * Whether heading unit `i` is answered with its section (see the header): the paragraph right under its run (the
 * first line after it) holds a requirement sentence naming all the heading names (anchorsOf, the heading read without
 * its number) — the same days when it names some (« … pendant les vacances scolaires » is not said again by « le
 * samedi pendant les vacances scolaires »: a narrower rule is not the line's) — and doing what it does (HEADING_ACTS,
 * detailsWhatItAdds); a sentence further down never answers it, and no sentence answers a heading stating a quantity
 * (statesQuantity). `isReq(j)`: whether unit j is a requirement sentence.
 */
const headingAnswered = (units, i, isReq) => {
  const u = units[i];
  const text = u.text.replace(SECTION_NUMBER, "");
  if (statesQuantity(text)) return false;
  const acts = headingActsOf(text);
  const names = anchorsOf(text);
  const does = acts.filter((a) => HEADING_ACTS.includes(a));
  const adds = acts.includes("add");
  // Whether a sentence says the heading again: all it names (its days exactly), what it does, what it adds detailed.
  const saysAgain = (sentence) => {
    const a = anchorsOf(sentence);
    if (!within(names, a)) return false;
    if (names.days.size && !every(a.days, (d) => names.days.has(d))) return false;
    const its = actsOf(sentence);
    return does.every((x) => its.includes(x)) && (!adds || detailsWhatItAdds(sentence) || (does.some((x) => x === "serve" || x === "route") && !its.includes("remove")));
  };
  let j = i + 1;
  while (j < units.length && units[j].si === u.si && units[j].heading) j += 1;
  const under = j < units.length && units[j].si === u.si ? units[j].line : null;
  // A sentence that IS the heading again (the same words: « Ligne 7 — suppression … » over « Ligne 7 : suppression …
  // . ») shares its id — kept once, as the heading's: it never answers it, or the one requirement would go with it.
  const own = sentenceId(u.text);
  for (; j < units.length && units[j].si === u.si && units[j].line === under; j++) if (isReq(j) && sentenceId(units[j].text) !== own && saysAgain(units[j].text)) return true;
  return false;
};

/**
 * The requirement sentences of the sources ([{ name, text, paged? }]), each once (the same sentence twice is one
 * requirement), up to MAX_SENTENCES; a heading answered with its section is none, in any source read (its copy in a
 * note shares its id). The sources are read in order, each one whole (segment), until MAX_SENTENCES sentences are
 * kept: the work follows the sentences kept, never the whole of twenty documents. A heading is read
 * (headingAnswered) only when a sentence of its id is met.
 *   → { sentences, units: the units read (each with its source's index `si` and `paged`), isReq(i) }
 */
const sentencesOf = (sources) => {
  const list = Array.isArray(sources) ? sources : [];
  const units = [];
  const memo = new Map();
  const reqAt = (i) => {
    if (!memo.has(i)) memo.set(i, isRequirement(units[i].text));
    return memo.get(i);
  };
  const isReq = (i) => reqAt(i).requirement;
  // The heading units read, by id: an id is a heading's answered with its section when one of them is (each read once).
  const headingUnits = new Map();
  const answeredAt = new Map();
  const answered = (i) => {
    if (!answeredAt.has(i)) answeredAt.set(i, isReq(i) && headingAnswered(units, i, isReq));
    return answeredAt.get(i);
  };
  const isHeading = (id) => (headingUnits.get(id) || []).some(answered);
  const found = [];
  const seen = new Set();
  const kept = () => found.filter((x) => !isHeading(x.id));
  for (let si = 0; si < list.length; si++) {
    const src = list[si];
    if (!src || typeof src.text !== "string" || !src.text.trim()) continue;
    const from = units.length;
    const paged = Boolean(src.paged);
    for (const u of segment(src.text, { source: src.name || "brief", paged })) {
      u.si = si;
      u.paged = paged;
      units.push(u);
    }
    for (let i = from; i < units.length; i++) {
      if (!units[i].heading) continue;
      const id = sentenceId(units[i].text);
      if (!headingUnits.has(id)) headingUnits.set(id, []);
      headingUnits.get(id).push(i);
    }
    for (let i = from; i < units.length; i++) {
      const r = reqAt(i);
      if (!r.requirement) continue;
      const u = units[i];
      const id = sentenceId(u.text);
      if (seen.has(id)) continue;
      seen.add(id);
      found.push({ id, text: u.text, source: u.source, page: u.paged ? u.page : null, markers: r.markers });
    }
    if (found.length >= MAX_SENTENCES && kept().length >= MAX_SENTENCES) break;
  }
  return { sentences: kept().slice(0, MAX_SENTENCES), units, isReq };
};

/** The requirement sentences of the sources ([{ name, text }]), each once (the same sentence twice is one requirement). */
const requirementSentences = (sources) => sentencesOf(sources).sentences;

/** A text prepared once for the quote checks: its compact form and its words (list and set). */
const prepared = (text) => {
  const list = Q.words(text);
  return { text, compact: Q.compact(text), list, words: new Set(list) };
};
/** A quote prepared once; `bare`: the same quote without the marker its line opens with (LIST_MARKER), when it has one. */
const preparedQuote = (quote) => {
  const q = { quote, compact: Q.compact(quote), words: Q.words(quote), elided: /…|\.{3,}/.test(quote) };
  const bare = quote.trim().replace(LIST_MARKER, "");
  return bare !== quote.trim() && bare ? { ...q, bare: preparedQuote(bare) } : q;
};

/**
 * Whether a prepared quote stands in a prepared text — verifyQuote's rule (transform/quotes) on texts read once:
 * verbatim (compact substring), else a paraphrase (Q.paraphraseIn: most words within one window, every number
 * included), after a cheap necessary condition — at least THRESHOLD of its words, and every number, among the
 * text's. An elided quote (« … »: pieces in order, which may start inside a word) goes to the verifier itself.
 */
const standsIn = (q, t) => {
  if (!q.compact || !q.words.length) return false;
  if (t.compact.includes(q.compact)) return true;
  if (q.elided) return verifyQuote(q.quote, [t.text]).verified;
  if (t.list.length < THRESHOLD * q.words.length) return false;
  let hits = 0;
  for (const w of q.words) {
    if (t.words.has(w)) hits += 1;
    else if (/\d/.test(w)) return false;
  }
  return hits >= THRESHOLD * q.words.length && Q.paraphraseIn(q.words, t.list);
};

/** Whether a quote answers a sentence: it stands inside that one sentence, read with or without its marker (see the header). */
const coversPrepared = (q, s) => (q.words.length >= MIN_QUOTE_WORDS && standsIn(q, s)) || Boolean(q.bare && coversPrepared(q.bare, s));
const quoteCovers = (quote, sentence) => coversPrepared(preparedQuote(String(quote || "")), prepared(String(sentence || "")));

// A quote that may stand across sentences: it holds a sentence's end and what follows it.
const CROSSES_SENTENCES = /[.!?]["')\]]*\s/;

/** The first `n` words of a text as written (accents aside): the part of a unit a quote entering it holds. */
const firstWords = (text, n) => {
  const plain = String(text).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const re = /[A-Za-z0-9]+/g;
  let end = 0;
  for (let k = 0, m; k < n && (m = re.exec(plain)); k++) end = m.index + m[0].length;
  return plain.slice(0, end);
};

/**
 * Each source as its units read, for the quotes standing across sentences: the units' compact forms (Q.compact) in
 * order, a space between two units of one line and a line break between two lines — no compact form holds one, so a
 * quote found in it never stands across lines. `starts`/`ends`: where each unit is in the text; `idx`: its index in
 * `units` (the units of the sources sentencesOf read). One text per source: a quote is looked for once in each.
 *   → [{ si, text, starts, ends, idx }]
 */
const unitTexts = (units) => {
  const bySource = new Map();
  units.forEach((u, i) => {
    let s = bySource.get(u.si);
    if (!s) bySource.set(u.si, (s = { si: u.si, parts: [], starts: [], ends: [], idx: [], at: 0, line: null }));
    const part = Q.compact(u.text);
    if (s.parts.length) {
      s.parts.push(s.line === u.line ? " " : "\n");
      s.at += 1;
    }
    s.starts.push(s.at);
    s.parts.push(part);
    s.at += part.length;
    s.ends.push(s.at);
    s.idx.push(i);
    s.line = u.line;
  });
  return [...bySource.values()].map(({ si, parts, starts, ends, idx }) => ({ si, text: parts.join(""), starts, ends, idx }));
};
/** The first unit ending after offset `at` (`ends` ascending): where a quote found at `at` enters. */
const firstEndingAfter = (ends, at) => {
  let lo = 0;
  let hi = ends.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ends[mid] > at) hi = mid;
    else lo = mid + 1;
  }
  return lo;
};

/**
 * The sentences quotes answer as ONE statement across sentences of one line (see the header): a quote standing
 * verbatim across units of a line is one statement when every unit after the first goes on with the subject of the
 * ones before (GOES_ON_WITH) and, in the words quoted, names nothing they do not (anchorsOf) and does nothing they
 * did not but what the clause's kind measures (ACTS, KIND_ACTS); it then answers the first unit, and each unit after
 * it that names and does nothing more as a whole (« Cette grille remplace … y compris celles qui partent de la
 * Mairie », quoted up to « … vers la Gare », stays to answer) — each of them held by MIN_QUOTE_WORDS words at
 * least, and, a clause, its kind measuring what the units state together (kindAnswers on their measures). `items`:
 * [{ id, kind, q }] (the clauses or the wishes: a wish marks, it measures nothing); `textsOf()`: the sources read
 * as their units (unitTexts, built once when a quote crosses sentences), each quote looked for once per source, never
 * once per line; `isReq(i)`: whether unit i is a requirement sentence; `overBudget()`: checked once per quote and
 * source, the pass stops there.
 *   → Map(sentence id → Set(item))
 */
const statementsQuoted = (units, textsOf, items, isReq, overBudget) => {
  const out = new Map();
  // Each item's quote as written, and without its marker (the units are read without theirs).
  const crossing = items.flatMap((x) => [x.q, x.q.bare].filter((q) => q && !q.elided && CROSSES_SENTENCES.test(q.compact)).map((q) => ({ x, compact: q.compact })));
  if (!crossing.length) return out;
  const texts = textsOf();
  const anchors = new Map();
  const anchorsAt = (i) => {
    if (!anchors.has(i)) anchors.set(i, anchorsOf(units[i].text));
    return anchors.get(i);
  };
  // The units a statement answers (see above), or none when the quote is no one statement.
  const answeredIn = (run, kind) => {
    let named = anchorsAt(run[0].i);
    const did = new Set(actsOf(units[run[0].i].text));
    const measured = (acts) => acts.every((a) => did.has(a) || !kind || (KIND_ACTS[kind] || []).includes(a));
    const answered = [run[0]];
    for (const r of run.slice(1)) {
      const part = firstWords(units[r.i].text, r.held);
      const quoted = anchorsOf(part);
      if (!GOES_ON_WITH.test(normalizeText(units[r.i].text)) || !within(quoted, named) || !measured(actsOf(part))) return [];
      if (within(anchorsAt(r.i), named) && measured(actsOf(units[r.i].text))) answered.push(r);
      named = union(named, quoted);
      for (const a of actsOf(part)) did.add(a);
    }
    return answered;
  };
  for (const { x, compact } of crossing) {
    for (const src of texts) {
      if (overBudget()) return out;
      for (let at = src.text.indexOf(compact); at >= 0; at = src.text.indexOf(compact, at + 1)) {
        // The units the quote stands across (one line: a line break parts two), and how many of their words it holds.
        const end = at + compact.length;
        const run = [];
        for (let k = firstEndingAfter(src.ends, at); k < src.idx.length && src.starts[k] < end; k++) {
          const from = Math.max(at, src.starts[k]);
          const to = Math.min(end, src.ends[k]);
          if (from < to) run.push({ i: src.idx[k], held: Q.words(src.text.slice(from, to)).length });
        }
        if (run.length < 2) continue;
        const answered = answeredIn(run, x.kind);
        if (!answered.length || !kindAnswers(x.kind, [...new Set(run.flatMap((r) => measuresOf(units[r.i].text)))])) continue;
        for (const r of answered) {
          if (r.held < MIN_QUOTE_WORDS || !isReq(r.i)) continue;
          const id = sentenceId(units[r.i].text);
          if (!out.has(id)) out.set(id, new Set());
          out.get(id).add(x);
        }
      }
    }
  }
  return out;
};

/**
 * The annexes a sentence sends the reader to (« suit la grille de l'annexe 1 », « selon l'annexe B », a document's own
 * name: « (Annexe_ligne_4_dimanche.csv) »): their keys, as annexKeysOfDocument reads a document's name. A sentence that
 * goes on with the one before (« Cette grille remplace… », « Ces 12 courses… », « Elle… ») sends to that one's.
 */
const ANNEX_REF = /(?<![a-z])annexe?s?\s*(?:n[°o]\s*)?([0-9]{1,2}|[a-h])(?![a-z0-9])/g;
const fileKey = (name) => `file:${normalizeText(String(name || "").replace(/[_.\-]+/g, " ")).trim()}`;
/** A document's keys: its name, and the annex it is (« Annexe1_Ligne_D_semaine.xlsx », « Annexe 2 - Ligne F » → annexe1, annexe2). */
const annexKeysOfDocument = (name) => {
  const keys = new Set([fileKey(name)]);
  const m = /(?<![a-z])annexe?\s*(?:n[°o]\s*)?([0-9]{1,2}|[a-h])(?![a-z0-9])/.exec(normalizeText(String(name || "").replace(/[_.\-]+/g, " ")));
  if (m) keys.add(`annexe${m[1]}`);
  return keys;
};
const annexKeysOf = (text, files) => {
  const t = normalizeText(text);
  const spaced = ` ${normalizeText(String(text || "").replace(/[_.\-]+/g, " "))} `;
  const keys = new Set();
  for (const m of t.matchAll(ANNEX_REF)) keys.add(`annexe${m[1]}`);
  for (const f of files) if (f.length > 10 && spaced.includes(` ${f.slice(5)} `)) keys.add(f);
  return keys;
};
// The days a clause runs (0 Sunday … 6 Saturday) and the periods it names, as anchorsOf reads a sentence's.
const CLAUSE_DAYS = { weekday: [1, 2, 3, 4, 5], weekend: [0, 6], daily: [0, 1, 2, 3, 4, 5, 6], saturday: [6], sunday: [0], mon: [1], tue: [2], wed: [3], thu: [4], fri: [5], sat: [6], sun: [0] };
const CLAUSE_PERIODS = { school_holidays: "vacation", school_days: "school", public_holidays: "holiday" };
const clauseDaysOf = (c) => {
  const p = c?.params && typeof c.params === "object" ? c.params : {};
  const out = new Set();
  for (const d of [p.day, ...(Array.isArray(p.days) ? p.days : [p.days])].filter(Boolean)) for (const x of CLAUSE_DAYS[String(d)] || []) out.add(x);
  if (CLAUSE_PERIODS[p.period]) out.add(CLAUSE_PERIODS[p.period]);
  return out;
};
/**
 * The clauses that answer a sentence by its annex (2026-10-07: « Du lundi au vendredi, la ligne D suit la grille de
 * l'annexe 1 (19 courses…) » was « à vérifier à la main » beside the annex's own objectives): the contract's clauses
 * read from that annex — `annexed`: [{ id, keys, days }], none set aside — when their days hold every day and period
 * the sentence names. A sentence of an annex no clause was read from is answered by none.
 */
const annexAnswers = (text, before, annexed, files) => {
  let keys = annexKeysOf(text, files);
  if (!keys.size && before && GOES_ON_WITH.test(normalizeText(text).trim())) keys = annexKeysOf(before, files);
  if (!keys.size) return [];
  const of = annexed.filter((c) => [...c.keys].some((k) => keys.has(k)));
  if (!of.length) return [];
  const days = new Set(of.flatMap((c) => [...c.days]));
  return [...anchorsOf(text).days].every((d) => days.has(d)) ? of.map((c) => c.id) : [];
};

/**
 * The coverage of the contract over the sources' requirement sentences (see the header). `sources`:
 * [{ name, text, paged? }] — the brief's note and the documents' text; `unread`: the documents that could not be
 * read ([{ id, name, reason }], coverageForContract).
 */
const coverageOf = ({ contract = null, sources = [], unread = [], budgetMs = BUDGET_MS, now = Date.now } = {}) => {
  const started = now();
  let incomplete = false;
  const overBudget = () => incomplete || (now() - started > budgetMs && (incomplete = true));
  const { sentences, units, isReq } = sentencesOf(sources);
  const whole = (sources || []).map((s) => s?.text).filter((t) => typeof t === "string" && t.trim()).map(prepared);
  // A quote is verified once in the texts (never per sentence); past the budget, a quote not found verbatim covers nothing.
  const verified = (raw) => {
    if (typeof raw !== "string" || !raw.trim() || !whole.length) return null;
    const q = preparedQuote(raw.slice(0, 1000));
    if (!q.words.length) return null;
    if (whole.some((t) => t.compact.includes(q.compact))) return q;
    if (overBudget()) return null;
    return whole.some((t) => standsIn(q, t)) ? q : null;
  };
  const quoted = (list) =>
    (list || [])
      .slice(0, MAX_QUOTES)
      .map((x) => ({ id: x.id, kind: typeof x.kind === "string" ? x.kind : null, q: verified(x.quote) }))
      .filter((x) => x.q);
  const clauses = quoted(contract?.clauses);
  const wishes = quoted(contract?.wishes);
  // The statements a quote holds across sentences (statementsQuoted): they only add answers. Their pass stops at half
  // the budget — the sentences keep the rest, never all left unchecked for it — and a pass cut short is said
  // (`incomplete`): a sentence only such a statement answers is then reported uncovered, never covered by default.
  let statementsCut = false;
  const statementsOver = () => statementsCut || overBudget() || (now() - started > budgetMs / 2 && (statementsCut = true));
  let texts = null;
  const textsOf = () => texts || (texts = unitTexts(units));
  const clauseStatements = statementsQuoted(units, textsOf, clauses, isReq, statementsOver);
  const wishStatements = statementsQuoted(units, textsOf, wishes, isReq, statementsOver);
  const dismissed = new Map((contract?.dismissed || []).map((d) => [d.sentence, d]));
  // The clauses read from a document of the contract (an annex): what a sentence sending to it is answered by
  // (annexAnswers); one set aside answers nothing.
  const annexed = (contract?.clauses || []).filter((c) => c && typeof c.document === "string" && c.document && c.status !== "waived" && c.decision?.action !== "waive").map((c) => ({ id: c.id, keys: annexKeysOfDocument(c.document), days: clauseDaysOf(c) }));
  const files = [...new Set(annexed.flatMap((c) => [...c.keys].filter((k) => k.startsWith("file:"))))];
  const unitAt = new Map();
  if (annexed.length) units.forEach((u, i) => unitAt.has(sentenceId(u.text)) || unitAt.set(sentenceId(u.text), i));
  const beforeOf = (id) => {
    const i = unitAt.get(id);
    return i > 0 && units[i - 1].si === units[i].si ? units[i - 1].text : null;
  };
  const detail = [];
  const uncovered = [];
  let covered = 0;
  let notMeasurable = 0;
  let dismissedCount = 0;
  for (const raw of sentences) {
    if (overBudget()) {
      // Past the budget: never covered by default — reported, and the person splits the brief or the contract.
      uncovered.push({ id: raw.id, text: raw.text, source: raw.source, page: raw.page, unchecked: true });
      detail.push({ id: raw.id, state: "uncovered", by: [], unchecked: true });
      continue;
    }
    const s = prepared(raw.text);
    // The clauses quoting the sentence cover it only when one of them can measure what it states (kindAnswers).
    const measures = measuresOf(raw.text);
    const quoting = clauses.filter((c) => coversPrepared(c.q, s));
    const answering = new Set(quoting.filter((c) => kindAnswers(c.kind, measures)));
    // …or quote it within one statement across sentences, the kind measuring the statement (statementsQuoted).
    const inStatement = clauseStatements.get(raw.id);
    const quotedBy = clauses.filter((c) => answering.has(c) || inStatement?.has(c)).map((c) => c.id);
    const byClauses = quotedBy.length || !annexed.length ? quotedBy : annexAnswers(raw.text, beforeOf(raw.id), annexed, files);
    const mismatched = byClauses.length ? [] : quoting.map((c) => c.id);
    const wishStatement = wishStatements.get(raw.id);
    const byWishes = byClauses.length ? [] : wishes.filter((w) => coversPrepared(w.q, s) || wishStatement?.has(w)).map((w) => w.id);
    const dismissal = !byClauses.length && !byWishes.length ? dismissed.get(raw.id) || null : null;
    const state = byClauses.length ? "covered" : byWishes.length ? "not_measurable" : dismissal ? "dismissed" : "uncovered";
    // A verified quote holding the whole sentence among others: the clause to split (said, never counted as covering);
    // read without its line's marker, a quote of the sentence alone holds nothing more.
    const holdsMore = (q) => q.compact.length > s.compact.length && q.compact.includes(s.compact);
    const spannedBy = state === "uncovered" && s.compact ? clauses.filter((c) => holdsMore(c.q.bare || c.q)).map((c) => c.id) : [];
    // Quoted only by clauses whose kind measures none of its quantities: said, with the clauses and what is left unmeasured.
    const mismatch = state === "uncovered" && mismatched.length ? { reason: "kind_mismatch", mismatched, measures } : null;
    if (state === "covered") covered += 1;
    else if (state === "not_measurable") notMeasurable += 1;
    else if (state === "dismissed") dismissedCount += 1;
    else uncovered.push({ id: raw.id, text: raw.text, source: raw.source, page: raw.page, ...(mismatch || {}) });
    detail.push({ id: raw.id, state, by: byClauses.length ? byClauses : byWishes, ...(dismissal ? { dismissed_by: dismissal.by.name } : {}), ...(spannedBy.length ? { spanned_by: spannedBy } : {}), ...(mismatch || {}) });
  }
  // The documents nobody could read: one uncovered entry each until a named person acknowledges it.
  const unreadOut = (Array.isArray(unread) ? unread : []).map((u) => {
    const ack = dismissed.get(documentKey(u.id));
    return { id: u.id, name: u.name || null, reason: u.reason, ...(ack ? { acknowledged_by: ack.by.name } : {}) };
  });
  for (const u of unreadOut) if (!u.acknowledged_by) uncovered.push({ id: documentKey(u.id), text: u.name || u.id, source: u.name || null, page: null, unread: u.reason });
  return { sentences: sentences.length, covered, not_measurable: notMeasurable, dismissed: dismissedCount, uncovered, unread: unreadOut, detail, ...(incomplete || statementsCut ? { incomplete: true } : {}) };
};

/** The sources of a coverage: the notes (the brief the contract was extracted from) and the documents' text. */
const sourcesOf = ({ notes = [], documents = [] } = {}) => [
  ...(Array.isArray(notes) ? notes : []).filter((n) => typeof n === "string" && n.trim()).map((text) => ({ name: "brief", text })),
  ...(Array.isArray(documents) ? documents : []).filter((d) => d && typeof d.text === "string" && d.text.trim()).map((d) => ({ name: d.name || "document", text: d.text, paged: d.kind === "pdf" })),
];

const documentKey = (id) => `doc:${id}`;
const DOCUMENT_ID = /^[a-f0-9]{24}$/;

/** What could not be read of the documents asked for: [{ id, name, reason: missing | no_text | truncated }]. */
const unreadOf = (ids, docs) => {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const out = [];
  for (const id of ids) {
    const d = byId.get(id);
    if (!d) out.push({ id, name: null, reason: "missing" });
    else if (typeof d.text !== "string" || !d.text.trim()) out.push({ id, name: d.name || null, reason: "no_text" });
    else if (d.truncated) out.push({ id, name: d.name || null, reason: "truncated" });
  }
  return out;
};

/**
 * The coverage of a request's contract: its sources are the brief the person typed at ② (contract.brief), the
 * brief the contract was extracted from (contract.extracted.note), the notes the request adds (a pasted brief) and
 * the documents' text — the ids the request names and those the extraction read (contract.extracted.documents),
 * up to 20; each one that cannot be read is reported (`unread`, see the header). `canRead(id)`: whether this caller
 * may read a document (the coverage route's ownership rule; the other routes read by id). `gated`: whether the
 * uncovered sentences hold the delivery (a decided or assumed contract; an empty one is reported, D15).
 *   → { sentences, covered, not_measurable, dismissed, uncovered, unread, detail, gated } | null (no contract)
 */
const coverageForContract = ({ contract = null, documentIds = [], notes = [], canRead = null } = {}) => {
  if (!contract) return null;
  const { documentTexts } = require("../network/briefDocumentService");
  const { gatesCoverage } = require("./contractService");
  const extracted = contract.extracted && typeof contract.extracted === "object" ? contract.extracted : {};
  const ids = [...new Set([...(Array.isArray(documentIds) ? documentIds : []), ...(Array.isArray(extracted.documents) ? extracted.documents.map((d) => (typeof d === "string" ? d : d?.id)) : [])].filter((id) => typeof id === "string" && DOCUMENT_ID.test(id)))].slice(0, 20);
  const docs = documentTexts(ids, { canRead });
  const sources = sourcesOf({ notes: [typeof contract.brief === "string" ? contract.brief : "", typeof extracted.note === "string" ? extracted.note : "", ...(Array.isArray(notes) ? notes : [])], documents: docs });
  return { ...coverageOf({ contract, sources, unread: unreadOf(ids, docs) }), gated: gatesCoverage(contract) };
};

module.exports = { coverageForContract, segment, isRequirement, requirementSentences, coverageOf, sourcesOf, sentenceId, documentKey, quoteCovers, measuresOf, kindAnswers, _internals: { MARKERS, FACTS, MEASURES, KIND_MEASURES, MIN_WORDS, MIN_QUOTE_WORDS, MAX_SENTENCES, MAX_QUOTES, BUDGET_MS, HEADING_MAX_WORDS, unreadOf, isValueCell, sheetRowUnits, anchorsOf, within } };
