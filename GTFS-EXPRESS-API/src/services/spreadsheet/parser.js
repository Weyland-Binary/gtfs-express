/**
 * spreadsheet/parser — an operator's offer order, read deterministically
 * from its spreadsheet (mission step 6; no model).
 *
 * An offer order often comes as a sheet in the operator's « service
 * méthode » format: per line and direction, per day type (and period), the
 * first and the last departure and the headway by time band — or a full
 * timetable (stops in rows, trips in columns). This module recognises those
 * layouts from their headers and their cells and returns a typed model in
 * which EVERY value carries the sheet and the cell it was read from:
 *
 *   {
 *     file: { name, format },
 *     lines: [{ line, direction, destination, origin, sens?,
 *               day_types: [{ day_type, period?, region?, bands: [{ from, to, headway_min }], first, last, trips?,
 *                             no_service?, span?, headway?,
 *                             timetable?: { range, grid?, stops: [v], trips: [{ number?, day_type?, untimed?, note?: { text, ref },
 *                                                                              times: [v | null] }] } }] }],
 *     unread: [{ sheet, cell, reason, text }],     // every non-empty cell the parser did not read, and why
 *     labels: [{ sheet, cell, role, text }],       // the cells read as structure: headers, titles
 *     sheets: [{ name, layout, cells, read, unread, unsure? }]   // unsure: timetables left unread (orientation uncertain)
 *   }
 *   v = { value, sheet, cell, text } — the cell's address ("B4"; a merged range is cited at its first cell),
 *       `cells` when a value is read from several cells (a period « Du » … « Au »); in a timetable a stop the
 *       trip does not serve (« | », « — », « … ») is { value: null, pass: true, … }, an empty cell null — in a
 *       desserte grid a stop served without a time (« oui ») is { value: null, served: true, … } and an empty cell
 *       the stop the trip does not serve ({ value: null, pass: true, empty: true }: no address, nothing written)
 *
 * Every non-empty cell is either read (a value of the model or a label) or listed in `unread` with its reason:
 * unknown_header, unknown_column, not_recognised, invalid_time, not_a_time, no_time, invalid_headway,
 * headway_range, unknown_day_type, invalid_date, invalid_period, not_a_number, error_value,
 * formula_without_value, conflicting_value (a second value for what another cell already states: a headway for
 * the same band, a first departure, a block stating another timetable of a day already read — other stops, another
 * sheet, a timed timetable beside a grid: said cell by cell, the first timetable never replaced), band_incomplete (a band row with its range and no headway, or a headway and
 * no range), unknown_direction, too_many, comment (beside a summary table, a cell of a column headed « Date »,
 * « Qui », « Commentaires »…: no offer value — an author's name is not repeated in `text`). Nothing is guessed: a
 * cell that cannot be read is said, never filled.
 *
 * Directions: a « Sens » written in words (« Aller », « Retour », « les deux sens ») is `direction`; a « Sens »
 * written as a number (« 1 », « 2 ») is the operator's own numbering, kept as `sens` — never a GTFS direction_id,
 * which only a column headed « direction_id » states (0 or 1). Neither is tied to the feed here: the clauses and
 * the operations resolve a direction through the destination against the feed, or say they could not.
 *
 * Layouts
 *   offer table   a header row (two at most: a group row over the band row) naming at least two of: line, sens,
 *                 destination, origine, type de jour, période (or Du / Au), premier départ, dernier départ,
 *                 courses (« par sens » or « total » in its header says what the count is per), a band (« 6h-9h » as a header: its cells are headways), or the band as rows
 *                 (« Plage horaire » « 6h-9h », or « Début » / « Fin », and « Fréquence » / « Intervalle »).
 *                 The rows below, until an empty row: a value left blank under a line, a direction or a day
 *                 type is the one above it (the way such sheets are written; a merged cell says it explicitly).
 *   timetable     a column of stop names with clock times to their right (stops × trips); a row of day types
 *                 above the times gives each trip its day type, a « Course » / « N° » row its number (« 301 »,
 *                 « Course 3 » its digits, « D01 » as written). A time
 *                 before 06:00 read after a time past 18:00 (the trips left to right, each one's stops top to
 *                 bottom) is past midnight: the service day's 24:40, as GTFS writes it — a grid's band too
 *                 (« 0h30 - 1h30 » after the evening's trips is 24:30–25:30). A day written in two blocks of the
 *                 same stops (a morning, then an afternoon below an empty row, on one sheet) is one timetable of
 *                 both (its range « A5:C7,A9:C11 », its first and last departure and its count those of the whole);
 *                 a second block of other stops for that day never replaces the first: it is said (conflicting_value).
 *                 A column whose « stops » are all trips' labels (« F1 », « 12 », « Course 3 ») or day types is no
 *                 stop column: never read as one — unless « Arrêts » heads it (stops named by codes, « P1 », « P2 »).
 *                 A row of destinations over the trips (« Zone Nord | Hôpital | Zone Nord ») keeps the timetable
 *                 read down, however frequent its trips. A note's mark beside a trip (« (1) » in a « Renvois » row under
 *                 it, « * » above it) is not read — the trip keeps it (`note`: its text and its address, the cell
 *                 listed unread), and no clause states that trip as if it ran on every day of the timetable. In a
 *                 « Renvois » row any cell under a trip is its note, however long (« Sauf vacances »), and only its:
 *                 never a title (« Scolaire »), nor a mark or a day type of the next block's trips below it.
 *   written across a timetable with its stops across one row and one trip per row (« Course | Gare | Mairie … »
 *                 over « F1 | 07:30 | 07:36 … »): read the right way — each row a trip, its number the label at its
 *                 left, its stops the header's, its titles above its header or in its corner (« Samedi | Gare … ») —
 *                 only when that is certain: every trip labelled by a trip's label
 *                 (and the cells beside it labels or day types), every header a stop's name (no label, day type,
 *                 header word, time or date), every trip's times running forward along the stops, timed (no
 *                 « oui » marks), and — when the loaded feed's stop names are given (stopNames) — half the headers
 *                 at least among them and no trip label. Broken by an empty row or a sub-heading naming nothing
 *                 (« Après-midi ») between its trips, it is one timetable of all of them; broken by anything else (a
 *                 day's title, trips without a label, an empty column between its stops, a stop without its header),
 *                 it is not read in part. Otherwise none of its cells is read (no timetable, no clause, `unsure`
 *                 counted on its sheet): the assistant reads it — never a timetable inverted, nor a part as the whole.
 *   desserte grid a timetable whose stops are marked rather than timed (an authority's line specification): « oui »,
 *                 « x », « ✓ » a stop served without a time, an empty cell or « … », « ..... » a stop the trip does
 *                 not serve, clock times (Excel fractions of a day or « 7:50 ») on its timing stops — the first
 *                 row, the last, or any between (the times are where the sheet writes them, never moved to the
 *                 first stop); a cell « 7h-9h : 15 min » merged over trips states a band and its headway for
 *                 trips it gives no time (`untimed`) — the band is the day type's of the columns under its cell
 *                 alone, never the block's other day types' (a Saturday column beside it is no column of the
 *                 band). Its trips are the columns it marks: a time, such a band, or
 *                 « oui » marks alone (a trip without a time, `untimed` too: never built — and a grid holding
 *                 one states no count of its trips by its columns: a band's columns are not a number of trips).
 *                 Blocks are stacked down the stop column, separated by empty rows: each is one direction read
 *                 top to bottom (its destination its last stop, unless a « Direction X » title stands between it
 *                 and the block above) under the nearest section title above it in that column (« SEMAINE PS »,
 *                 « SAMEDI »): a title naming no day type (« FHD ») is said (unknown_day_type) and its blocks get
 *                 none — never the day type of the section before — but keep the title as written (`day_title`),
 *                 for the person to say which days they run; two such titles (« FHD », « XYZ ») are two entries,
 *                 the same title twice one.
 *   summary       a header row of day types (« Semaine PS », « Samedi »; a cell naming several, « Semaine PS
 *                 PVS », gives its column to those no other header names alone) over rows labelled at their left
 *                 « Fréquence » (minutes), « Courses » (trips), « Amplitude » (« 7:50 - 20:05 », first and last
 *                 departure; a row of such ranges needs no label), a label merged over the rows of each direction
 *                 (« Dir Gare », « Direction Mairie »): per direction and day type, `headway` (a frequency stated
 *                 without the hours it holds), `trips`, `span` ({ first, last }, `at_stop` when the label says it is
 *                 measured at a stop: « (arrêt de cadencement) »). A summary is what the line must offer, not a
 *                 timetable: it gives clauses, never an operation. Its line is the sheet's title, else the one line
 *                 the workbook's other sheets name.
 *   titles        the other cells may name the line (« Ligne 4 — Direction Gare », « Ligne 4 : du lundi au
 *                 vendredi »), the direction or the
 *                 destination (« Vers Hôpital », « Sens : Aller »; « Sens Gare → Stade » towards Stade), the day
 *                 type (« Type de jour : LàV »), the period (« du 01/09/2026 au 03/07/2027 ») or both (« Horaires du
 *                 lundi au vendredi, à compter du 4 janvier 2027 »: the words before the dates name the day type;
 *                 « À compter du lundi 4 janvier 2027 » the period alone, its « lundi » the date's own)
 *                 or the school zone (« zone B »): they complete the
 *                 tables below them (the nearest title above — on its row, the one over the table's columns —,
 *                 else the sheet's first), and the sheet's name may name the line (« Ligne 4 », cited with cell null).
 *
 * Day types (values.dayTypeOf, one vocabulary): « PS », « période scolaire » school_days; « PVS », « petites
 * vacances », « vacances » school_holidays; « GVS », « grandes vacances », « été » summer_holidays (a period the
 * engine does not define: the plan's calendars may, else it is asked); « Semaine » the weekdays; « SAMEDI »,
 * « DIMANCHE », « DIM. ET FÊTES » (Sundays and public holidays); « forte », « faible » qualify a period the
 * engine cannot date: read as an assumption.
 *
 * Bounded: the workbook reader refuses more than MAX_CELLS cells, or cells spanning more than MAX_AREA addresses,
 * and every walk here goes through its row and column indexes (the cells there are, never every address of the
 * box); at most MAX_LINES lines and MAX_TRIPS trips per timetable are returned (every cell of the rest listed as
 * unread « too_many »).
 */

"use strict";

const { readWorkbook, cellAt, cellsOfRow, indexOf, key: cellKey } = require("./workbook");
const V = require("./values");

const MAX_LINES = 200;
const MAX_TRIPS = 400;
const MAX_UNREAD = 5000;

// ── Headers ─────────────────────────────────────────────────────────────────

const ROLE_WORDS = [
  ["line", ["ligne", "line", "n ligne", "no ligne", "n° ligne", "num ligne", "numero de ligne", "lig", "route", "ligne n°", "code ligne"]],
  ["direction", ["sens", "sens de circulation"]],
  ["direction_id", ["direction id", "direction_id", "id direction", "gtfs direction_id"]],
  ["destination", ["destination", "vers", "terminus", "towards", "dest", "direction", "terminus d'arrivee", "arrivee"]],
  ["origin", ["origine", "depart de", "origin", "point de depart", "arret de depart", "terminus de depart", "from stop", "depart"]],
  ["day_type", ["type de jour", "jour", "jours", "type jour", "day type", "days", "day", "calendrier", "regime", "jours de circulation", "jours de fonctionnement", "jt", "type"]],
  ["period", ["periode", "period", "validite", "periode de validite", "dates", "periode d'application"]],
  ["period_from", ["du", "date debut", "date de debut", "a partir du", "start date", "valable du", "debut de periode", "from date"]],
  ["period_to", ["au", "date fin", "date de fin", "jusqu'au", "end date", "valable au", "fin de periode", "to date"]],
  ["first", ["premier depart", "1er depart", "1er dep", "premier dep", "first departure", "first", "premier", "1ere course", "premiere course", "debut de service", "1er dep.", "1° depart"]],
  ["last", ["dernier depart", "dern depart", "dernier dep", "last departure", "last", "dernier", "derniere course", "fin de service", "dern. depart", "dern dep"]],
  ["trips", ["nb courses", "nombre de courses", "courses", "nb de courses", "trips", "number of trips", "nb services", "nombre de services", "nombre de departs", "nb departs", "nb de departs", "nb voyages"]],
  ["band_range", ["plage horaire", "plage", "tranche horaire", "creneau", "time band", "band", "periode horaire"]],
  ["band_from", ["debut plage", "debut de plage", "heure de debut", "de", "band start", "from time", "debut"]],
  ["band_to", ["fin plage", "fin de plage", "heure de fin", "a", "band end", "to time", "fin"]],
  ["headway", ["frequence", "intervalle", "headway", "cadence", "toutes les", "frequence (min)", "intervalle (min)", "frequence min", "intervalle min", "every", "interval"]],
];
const ROLE_OF = new Map();
for (const [role, words] of ROLE_WORDS) for (const w of words) if (!ROLE_OF.has(w)) ROLE_OF.set(w, role);
const IDENTITY = ["line", "direction", "direction_id", "sens", "destination", "origin", "day_type", "period", "period_from", "period_to"];
// A « Nb courses » header that says what the count is per: each direction, or both directions together.
const TRIPS_PER = new Map([
  ...["nb courses par sens", "courses par sens", "nombre de courses par sens", "nb de courses par sens", "trips per direction", "nb departs par sens"].map((w) => [w, "direction"]),
  ...["nb courses total", "courses total", "total courses", "nombre total de courses", "total des courses", "nb courses les deux sens", "trips total", "total trips"].map((w) => [w, "total"]),
]);
const DATA_ROLES = new Set(["first", "last", "trips", "band", "band_range", "band_from", "band_to", "headway"]);

/** The role a header cell names: a known word (its unit and punctuation aside), or a band (« 6h-9h »). */
const headerRole = (text) => {
  const f = V.fold(text).replace(/[()[\]*:.]+/g, " ").replace(/\b(en )?(min|minutes|mn|hh:mm|h:mm)\b/g, " ").replace(/\s+/g, " ").trim();
  if (!f) return null;
  if (ROLE_OF.has(f)) return { role: ROLE_OF.get(f) };
  if (TRIPS_PER.has(f)) return { role: "trips", per: TRIPS_PER.get(f) };
  const band = V.bandOf(text);
  if (band && !V.timeOf({ t: "s", v: String(text) })?.sec) return { role: "band", band };
  return null;
};

// ── Accounting ──────────────────────────────────────────────────────────────

const makeLedger = () => {
  const state = new Map(); // "sheet!A1" → "read" | { reason }
  const unread = [];
  const labels = [];
  const id = (sheet, cell) => `${sheet.name}!${cell.at}`;
  return {
    state,
    unread,
    labels,
    isDone: (sheet, cell) => state.has(id(sheet, cell)),
    read: (sheet, cell) => {
      if (cell) state.set(id(sheet, cell), "read");
    },
    label: (sheet, cell, role) => {
      if (!cell || state.get(id(sheet, cell)) === "read") return;
      state.set(id(sheet, cell), "read");
      labels.push({ sheet: sheet.name, cell: cell.at, role, text: V.textOf(cell) });
    },
    // `redact`: the cell is said (its address, its reason) without its text — an author's name stays in the sheet.
    skip: (sheet, cell, reason, { redact = false } = {}) => {
      if (!cell || state.has(id(sheet, cell))) return;
      state.set(id(sheet, cell), { reason });
      unread.push({ sheet: sheet.name, cell: cell.at, reason, text: redact ? "" : (V.textOf(cell) || (cell.f ? `=${cell.f}` : "")).slice(0, 120) });
    },
  };
};

const val = (sheet, cell, value, extra = {}) => ({ value, sheet: sheet.name, cell: cell ? cell.at : null, text: cell ? V.textOf(cell) : sheet.name, ...extra });

// A formula without a cached value, or an error value: said before any reading.
const unreadable = (cell) => (cell.f && cell.v == null ? "formula_without_value" : cell.t === "e" ? "error_value" : null);

// ── Titles (context) ────────────────────────────────────────────────────────

const SPLIT = /\s+[—–\-|·•]\s+|\s*[|·•;]\s*/;
// Each keyword a whole word (« Lignes régulières », « Tous les jours », « Versailles », « Toussaint » name nothing;
// « Ligne4 » still names line 4).
const LINE_TITLE = /^(?:ligne|line)(?:\b|(?=\d))\s*(?:n[°o]\s*)?[:\-–]?\s*([A-Za-z0-9][\w'.+]*)\s*(.*)$/i;
const DEST_TITLE = /^(?:direction|vers|destination|towards|to|terminus)\b\s*:?\s*(.+)$/i;
const SENS_TITLE = /^sens\b\s*:?\s*(.+)$/i;
const DAY_TITLE = /^(?:type de jour|types? de jours?|jours?|day type|days|calendrier|regime)\b\s*:?\s*(.+)$/i;
const PERIOD_TITLE = /^(?:periode|period|validite|valable|applicable)\b\s*:?\s*/i;
const ZONE = /\bzone\s+([abc])\b/i;
const WEEKDAY_WORD = "(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)";
// The dates of a folded title — with the day of the week written before one (« à compter du lundi 4 janvier 2027 »: no
// day type of the title), unless that day ends a range of days (« du lundi au vendredi 04/01/2027 - … »: the weekdays).
const DATE_WORDS = new RegExp(`(?:(?<!${WEEKDAY_WORD}\\s*(?:\\bau|\\ba|-|–|—)\\s*)\\b${WEEKDAY_WORD}\\s+(?=\\d))?(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.]\\d{1,2}[/.]\\d{2,4}|\\d{1,2}(?:er)?\\s+[a-z]+\\.?\\s+\\d{4})`, "g");
const PERIOD_WORDS = /\b(du|au|a partir du|a partir de|a compter du|a compter de|a compter d'|jusqu'?au|valables?|periode|period|validite|applicables?|en vigueur|from|to|until|des le|depuis le)\b/g;
// Where a period begins in a title as written: the words before its first date (« , à compter du 4 », « du 01/09 »,
// « dès le lundi 4 »), each a word of its own (« Mode 2 » holds no « de 2 »). What stands before them may name the day
// type, kept as written (its label).
const PERIOD_START = /[\s,;:]*(?<![\p{L}\p{N}])(?:(?:valables?|applicables?|en vigueur)\s+)?(?:(?:[aà]\s+(?:compter|partir)\s+)?(?:du|de|d['’])|d[eè]s\s+le|depuis\s+le|jusqu['’]?\s*au|from|until)\s+(?:(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+)?\d/iu;
// The way trips run from a place to another (« Gare → Stade », « Gare > Stade »): towards the last one.
const ARROW = /\s*(?:→|⟶|➔|➜|➝|⇒|=>|->)\s*|\s+>\s+/;

/** The place a direction written « A → B » goes to (B); a text without an arrow, as written. */
const towardsOf = (text) => {
  const parts = String(text).split(ARROW).map((s) => s.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : String(text).trim();
};

/** A « Sens » a title or a cell writes: a direction word, the operator's number (sens), else a destination. */
const sensFacts = (text) => {
  const dir = V.directionOf(text);
  if (dir) return { direction: dir };
  if (/^\d{1,3}$/.test(String(text).trim())) return { sens: String(text).trim() };
  // « Sens Renaudié → Portes d'Albi »: the trips run towards Portes d'Albi — a destination the feed knows, never
  // the two names together (no direction of the feed goes towards them).
  return { destination: towardsOf(text) };
};

/** The facts a title cell names: { line?, destination?, direction?, sens?, day_type?, period?, region? } or null. */
const titleFacts = (text) => {
  const out = {};
  const parts = String(text).split(SPLIT).map((s) => s.trim()).filter(Boolean);
  for (const raw of parts) {
    const f = V.fold(raw);
    let m;
    if ((m = LINE_TITLE.exec(raw))) {
      out.line = m[1];
      const rest = m[2].replace(/^[,:\-–—]\s*/, "").trim();
      const d = rest && DEST_TITLE.exec(rest);
      if (d) out.destination = towardsOf(d[1]);
      else if (rest && V.directionOf(rest)) out.direction = V.directionOf(rest);
      else if (rest) {
        // What the rest names, read as a title of its own (« Ligne D : du lundi au vendredi, à compter du 4 janvier
        // 2027 »: the day type and the period) — never another line.
        const { line: _other, ...more } = titleFacts(rest) || {}; // eslint-disable-line no-unused-vars
        Object.assign(out, more);
      }
      continue;
    }
    // A day type is checked before a destination (« Tous les jours » names no place): after its keyword (« Type de
    // jour : LàV »), or in words on its own.
    // eslint-disable-next-line no-cond-assign -- the match is read in the same expression
    const dayWords = (m = DAY_TITLE.exec(raw)) ? V.dayTypeOf(m[1]) : null;
    const whole = dayWords || (!PERIOD_TITLE.test(f) && !V.periodOf(raw) ? V.dayTypeOf(raw) : null);
    if (whole) {
      out.day_type = whole;
      continue;
    }
    if ((m = DEST_TITLE.exec(raw)) && !V.periodOf(raw)) {
      const dir = V.directionOf(m[1]);
      if (dir) out.direction = dir;
      else out.destination = towardsOf(m[1]);
      continue;
    }
    if ((m = SENS_TITLE.exec(raw))) {
      Object.assign(out, sensFacts(m[1]));
      continue;
    }
    if (ZONE.test(f)) out.region = ZONE.exec(f)[1].toUpperCase();
    const p = V.periodOf(raw);
    if (p && !p.error) {
      out.period = { ...p };
      // The words around the dates may name the period or the day type: those before the dates as written (« Horaires
      // du lundi au vendredi, à compter du 4 janvier 2027 », its label), else what is left once the dates and the
      // words that introduce them are taken out (« Période scolaire, du … au … », « du … au …, LàV »). Words no
      // reading knows name nothing (« Horaires spéciaux, à compter du … »: the period alone).
      const at = raw.search(PERIOD_START);
      const before = at > 0 ? V.dayTypeOf(raw.slice(0, at).replace(/\b(?:valables?|applicables?|en vigueur)\b/gi, " ").replace(/\s+/g, " ").trim()) : null;
      const d = before || V.dayTypeOf(f.replace(DATE_WORDS, " ").replace(PERIOD_WORDS, " ").replace(/[,:]/g, " ").replace(/\s+/g, " ").trim());
      if (d && d.assumed && d.period) out.period.name = d.period;
      else if (d) out.day_type = d;
      continue;
    }
    if ((m = DAY_TITLE.exec(raw))) {
      const d = V.dayTypeOf(m[1]);
      if (d) out.day_type = d;
      continue;
    }
    if (PERIOD_TITLE.test(f)) {
      const d = V.dayTypeOf(f.replace(PERIOD_TITLE, ""));
      if (d && d.period && d.assumed) out.period = { name: d.period };
      else if (d) out.day_type = d;
      continue;
    }
    const d = V.dayTypeOf(raw);
    if (d) out.day_type = d;
  }
  return Object.keys(out).length ? out : null;
};

/**
 * The context a table starting at row `row` reads: per kind, the nearest title fact above it — on that nearest row of
 * titles, one standing over the table's columns `cols` ([first, last]; a title merged over them counts) before one
 * beside them, so that two tables side by side each read their own title (« Samedi » over the one, « Dimanche » over
 * the other); a title further up never outranks a nearer one beside the columns (« Samedi » in column A between two
 * tables in column B is the second's) — else the sheet's first. `leftOf` (a timetable written across, whose header
 * row is `row`): the cells of that row left of its first stop — its corner, over the trips' labels — stand above it
 * too, the nearest (« Samedi | Gare | Mairie … » is a Saturday's timetable, « Dimanche | … » below it a Sunday's).
 */
const contextFor = (facts, row, cols = null, { leftOf = null } = {}) => {
  const over = (x) => {
    if (!cols || !x.raw) return false;
    const m = /^[A-Z]+\d+:([A-Z]+)\d+$/.exec(x.raw.merged || "");
    return x.raw.c <= cols[1] && (m ? colIndex(m[1]) : x.raw.c) >= cols[0];
  };
  const before = (x) => x.r < row || (leftOf != null && x.r === row && x.raw && x.raw.c < leftOf);
  const out = {};
  for (const kind of ["line", "destination", "direction", "sens", "day_type", "period", "region"]) {
    const above = facts.filter((x) => x.facts[kind] != null && before(x));
    const nearest = above.length ? above[above.length - 1] : null;
    const mine = nearest ? above.filter((x) => x.r === nearest.r && over(x)) : [];
    const pick = mine.length ? mine[mine.length - 1] : nearest || facts.find((x) => x.facts[kind] != null);
    if (pick) out[kind] = { value: pick.facts[kind], sheet: pick.sheet, cell: pick.cell, text: pick.text };
  }
  return out;
};

// ── The offer table (layout A) ──────────────────────────────────────────────

// The cells of a row, left to right: the row index of the workbook, never every column of the sheet's box.
const rowCells = (sheet, r) => cellsOfRow(sheet, r);

/** A header row: at least two known roles, one of them data (first, last, a band…) or line + day type. */
const headerOf = (sheet, r) => {
  const cols = new Map();
  let texts = 0;
  for (const cell of rowCells(sheet, r)) {
    // A merged header counts once, where it is written.
    if (cell.copy) continue;
    if (cell.t === "n") return null;
    texts += 1;
    const h = headerRole(V.textOf(cell));
    if (h) cols.set(cell.c, { ...h, cell });
  }
  const roles = new Set([...cols.values()].map((x) => x.role));
  if (cols.size < 2 || cols.size < texts / 2) return null;
  const data = [...roles].some((x) => DATA_ROLES.has(x));
  if (!data && !(roles.has("line") && roles.has("day_type"))) return null;
  return cols;
};

/** Is every cell of row r (within cols) empty? (a merged copy counts as content) */
const emptyRow = (sheet, r, cs) => cs.every((c) => !cellAt(sheet, r, c));

/**
 * The offer tables of a sheet, found before anything is read: [{ top, row (the last header row), cols, below,
 * span, rows }] — so the titles are looked for outside them, and the timetables too. The rows of a summary table
 * (`skipRows`, found first: its range row would read as a header of bands) are never one's.
 */
const offerRegions = (sheet, skipRows = new Set()) => {
  const out = [];
  let after = -Infinity; // the rows before it belong to a table already found
  for (const r0 of sheet.rows.keys()) {
    if (r0 < after || skipRows.has(r0)) continue;
    let r = r0;
    const head = headerOf(sheet, r);
    if (!head) continue;
    const top = r;
    const below = !skipRows.has(r + 1) && headerOf(sheet, r + 1);
    if (below) r += 1;
    const cols = below ? new Map([...head, ...below]) : head;
    const span = [...new Set([...rowCells(sheet, top), ...rowCells(sheet, r)].map((c) => c.c))].sort((a, b) => a - b);
    const rows = [];
    let rr = r + 1;
    // A row without any cell is empty: the table ends there (the index holds only rows with cells).
    for (; sheet.rows.has(rr); rr++) {
      if (skipRows.has(rr) || emptyRow(sheet, rr, span) || headerOf(sheet, rr)) break;
      rows.push(rr);
    }
    out.push({ top, row: r, head, below, cols, span, rows });
    after = rr;
  }
  return out;
};

const readOfferTables = (sheet, ledger, facts, regions) => {
  const records = [];
  for (const g of regions) {
    const { top, row, head, below, cols, span } = g;
    // The group row over the bands (« Heures de pointe »), or a row above the header naming nothing: structure.
    if (below) for (const cell of rowCells(sheet, top)) if (!head.has(cell.c) && !cell.copy) ledger.label(sheet, cell, "group");
    for (const [, h] of cols) ledger.label(sheet, h.cell, h.role === "band" ? "band" : h.role);
    for (const cell of rowCells(sheet, row)) if (!cols.has(cell.c) && !cell.copy) ledger.skip(sheet, cell, "unknown_header");
    if (!below) for (const cell of rowCells(sheet, top)) if (!head.has(cell.c) && !cell.copy) ledger.skip(sheet, cell, "unknown_header");
    const ctx = contextFor(facts, top, [span[0], span[span.length - 1]]);
    // Identity columns left to right: a blank cell is the value above only while the cells to its left are blank too.
    const identityCols = span.filter((c) => cols.has(c) && IDENTITY.includes(cols.get(c).role));
    let prev = null;
    for (const rr of g.rows) {
      const rec = { row: rr, ctx, bands: [] };
      let data = false;
      for (const c of span) {
        const cell = cellAt(sheet, rr, c);
        if (!cell) continue;
        const h = cols.get(c);
        const bad = unreadable(cell);
        if (bad) {
          ledger.skip(sheet, cell, bad);
          continue;
        }
        if (!h) {
          ledger.skip(sheet, cell, "unknown_column");
          continue;
        }
        if (readOfferCell(sheet, ledger, rec, h, cell)) data = data || DATA_ROLES.has(h.role) || h.role === "day_type";
      }
      if (prev) {
        for (const c of identityCols) {
          if (cellAt(sheet, rr, c)) break;
          const role = cols.get(c).role;
          const k = ["direction", "direction_id", "destination"].includes(role) ? ["direction", "destination", "sens"] : [role];
          for (const x of k) if (!rec[x] && prev[x]) rec[x] = prev[x];
        }
      }
      if (data || Object.keys(rec).some((k) => IDENTITY.includes(k))) records.push(rec);
      prev = rec;
    }
  }
  return records;
};

/** One cell of an offer table read into its record by its column's role. → whether it was read. */
const readOfferCell = (sheet, ledger, rec, h, cell) => {
  const text = V.textOf(cell);
  const ok = (k, value, extra) => {
    if (rec[k] && rec[k].value !== undefined && JSON.stringify(rec[k].value) !== JSON.stringify(value) && rec[k].cell !== cell.at) {
      ledger.skip(sheet, cell, "conflicting_value");
      return false;
    }
    rec[k] = val(sheet, cell, value, extra);
    ledger.read(sheet, cell);
    return true;
  };
  switch (h.role) {
    case "line": {
      const l = V.lineOf(text);
      return l ? ok("line", l) : (ledger.skip(sheet, cell, "not_recognised"), false);
    }
    case "direction_id": {
      // A column headed « direction_id » states the GTFS direction: 0 or 1, nothing else.
      const n = text.trim();
      if (n === "0" || n === "1") return ok("direction", n);
      const d = V.directionOf(text);
      return d ? ok("direction", d) : (ledger.skip(sheet, cell, "unknown_direction"), false);
    }
    case "direction":
    case "destination": {
      // « Sens 1 », « Sens 2 »: the operator's numbering (sens), never read as a GTFS direction_id.
      const f = h.role === "direction" ? sensFacts(text) : V.directionOf(text) ? { direction: V.directionOf(text) } : { destination: text.trim() };
      const [k, v] = Object.entries(f)[0];
      return ok(k, v);
    }
    case "origin":
      return ok("origin", text.trim());
    case "day_type": {
      const d = V.dayTypeOf(text);
      return d ? ok("day_type", d) : (ledger.skip(sheet, cell, "unknown_day_type"), false);
    }
    case "period": {
      const p = V.periodOf(text);
      if (p && !p.error) return ok("period", p);
      if (p?.error) return ledger.skip(sheet, cell, p.error), false;
      // « Scolaire », « Vacances » in a « Période » column: the period's name.
      const d = V.dayTypeOf(text);
      if (d && d.period && d.assumed) return ok("period", { name: d.period });
      return ledger.skip(sheet, cell, "invalid_period"), false;
    }
    case "period_from":
    case "period_to": {
      const d = V.dateOf(cell);
      if (typeof d === "string") return ok(h.role, d);
      return ledger.skip(sheet, cell, d?.error || "invalid_date"), false;
    }
    case "first":
    case "last": {
      const t = V.timeOf(cell);
      if (t && t.sec != null) return ok(h.role, V.hhmm(t.sec), { sec: t.sec });
      const hw = V.headwayOf(cell);
      // « — », « pas de service » where a first departure is expected: no service that day type.
      if (hw && hw.none && cell.t !== "n") {
        if (rec.no_service) cite(rec.no_service, val(sheet, cell, true));
        else rec.no_service = val(sheet, cell, true);
        ledger.read(sheet, cell);
        return true;
      }
      return ledger.skip(sheet, cell, t?.error || "not_a_time"), false;
    }
    case "trips": {
      const n = cell.t === "n" ? cell.v : /^\d+$/.test(text) ? parseInt(text, 10) : null;
      if (Number.isInteger(n) && n >= 0 && n < 2000) return ok("trips", n, h.per ? { per: h.per } : undefined);
      return ledger.skip(sheet, cell, "not_a_number"), false;
    }
    case "band": {
      const hw = V.headwayOf(cell);
      if (!hw || hw.error) return ledger.skip(sheet, cell, hw?.error || "invalid_headway"), false;
      rec.bands.push({ from: val(sheet, h.cell, V.hhmm(h.band.from), { sec: h.band.from }), to: val(sheet, h.cell, V.hhmm(h.band.to), { sec: h.band.to }), headway_min: val(sheet, cell, hw.none ? null : hw.min, hw.none ? { no_service: true } : {}) });
      ledger.read(sheet, cell);
      return true;
    }
    case "band_range": {
      const b = V.bandOf(text);
      if (!b) return ledger.skip(sheet, cell, "invalid_time"), false;
      rec.band_from = val(sheet, cell, V.hhmm(b.from), { sec: b.from });
      rec.band_to = val(sheet, cell, V.hhmm(b.to), { sec: b.to });
      ledger.read(sheet, cell);
      return true;
    }
    case "band_from":
    case "band_to": {
      const t = V.timeOf(cell);
      if (t && t.sec != null) return ok(h.role, V.hhmm(t.sec), { sec: t.sec });
      return ledger.skip(sheet, cell, t?.error || "not_a_time"), false;
    }
    case "headway": {
      const hw = V.headwayOf(cell);
      if (!hw || hw.error) return ledger.skip(sheet, cell, hw?.error || "invalid_headway"), false;
      rec.headway = val(sheet, cell, hw.none ? null : hw.min, hw.none ? { no_service: true } : {});
      ledger.read(sheet, cell);
      return true;
    }
    default:
      ledger.skip(sheet, cell, "unknown_column");
      return false;
  }
};

// ── The full timetable (layout B) ───────────────────────────────────────────

// The head of a stop column (« Arrêts »): structure.
const STOP_HEADERS = new Set(["arrets", "arret", "arrets desservis", "points d'arret", "point d'arret", "stops", "stop", "stations", "station", "gares", "communes"]);

const isTimeCell = (cell) => {
  const t = V.timeOf(cell);
  return Boolean(t && t.sec != null);
};
const isStopName = (cell) => cell && cell.t === "s" && !isTimeCell(cell) && V.textOf(cell).length >= 2 && V.textOf(cell).length <= 80 && !V.isPassMark(V.textOf(cell)) && !V.isServedMark(V.textOf(cell));

/** Whether a cell names a trip or a day, not a place: a trip's label (« F1 », « 12 », « Course 3 ») or a day type. */
const tripOrDay = (cell) => Boolean(V.tripLabelOf(cell) || V.dayTypeOf(V.textOf(cell)));

/** Whether « Arrêts » (a stop column's head) is the first cell above row r in column c, three rows up at most. */
const stopHeaded = (sheet, r, c) => {
  for (let k = r - 1; k >= Math.max(sheet.bounds.s.r, r - 3); k--) {
    const head = cellAt(sheet, k, c);
    if (head) return STOP_HEADERS.has(V.fold(V.textOf(head)).replace(/[:.]+$/, "").trim());
  }
  return false;
};

/**
 * The timetable blocks of a sheet, found before anything is read: [{ c (the stop column), rows, tripCols, grid }] —
 * cells of the offer tables (`taken`) are never part of one, nor a cell of a block found before (a time is one
 * trip's, read once). A run of stop rows is a timetable when two of them hold times, a desserte grid (`grid`) when
 * one holds « oui » marks and another times or a band cell — unless every « stop » of the run is a trip's label or a
 * day type: such a column is no stop column (its rows are trips: a timetable written across, see acrossRegions), the
 * run is listed in `refused` when given. `contiguous` (the sheet read across): the trips are the columns right after
 * the stops' one, up to the first that holds no time — a timetable further on has its own header. Walked through the
 * column and row indexes: the cells there are, never the sheet's box.
 */
const timetableRegions = (sheet, taken, { contiguous = false, refused = null } = {}) => {
  const blocks = [];
  const used = new Set();
  const free = (r, c) => !taken.has(`${r},${c}`) && !used.has(`${r},${c}`);
  // Per row, the columns of its free time cells, « not here » marks, « served » marks and band cells (sorted): what
  // lies right of c. A band cell merged over trips counts on each column it covers.
  const marksOf = new Map();
  const rowMarks = (r) => {
    if (!marksOf.has(r)) {
      const m = { times: [], marks: [], served: [], bands: [] };
      for (const x of cellsOfRow(sheet, r)) {
        if (!free(r, x.c)) continue;
        const t = V.textOf(x);
        if (isTimeCell(x)) m.times.push(x.c);
        else if (V.isPassMark(t)) m.marks.push(x.c);
        else if (V.isServedMark(t)) m.served.push(x.c);
        else if (V.bandHeadwayOf(t)) m.bands.push(x.c);
      }
      marksOf.set(r, m);
    }
    return marksOf.get(r);
  };
  // How many columns of a sorted list lie right of c (a binary search: a long row is never walked per column).
  const rightOf = (list, c) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] > c) hi = mid;
      else lo = mid + 1;
    }
    return list.length - lo;
  };
  for (const [c, rowsOfC] of sheet.cols) {
    let i = 0;
    while (i < rowsOfC.length) {
      // A run of consecutive rows naming a stop in column c with times (or marks, or a band cell) to its right.
      const rows = [];
      let j = i;
      for (; j < rowsOfC.length; j++) {
        const rr = rowsOfC[j];
        if (rows.length && rr !== rows[rows.length - 1].r + 1) break;
        const name = cellAt(sheet, rr, c);
        if (!isStopName(name) || !free(rr, c)) break;
        const m = rowMarks(rr);
        const t = rightOf(m.times, c);
        const s = rightOf(m.served, c);
        const b = rightOf(m.bands, c);
        if (!t && !s && !b && !rightOf(m.marks, c)) break;
        rows.push({ r: rr, times: t, served: s, bands: b });
      }
      // A desserte grid: « oui » marks on a row, times (or a band cell) on another — its timing stop.
      const grid = rows.length >= 2 && rows.some((x) => x.served > 0) && rows.some((x) => x.times > 0 || x.bands > 0);
      if (rows.filter((x) => x.times > 0).length >= 2 || grid) {
        const rs = rows.map((x) => x.r);
        // Its trips: the columns holding a time — in a grid, every column it marks: a band cell stands for trips
        // without times, and a column of « oui » under no time is a trip the sheet gives no time for (`untimed`).
        let tripCols = [...new Set(rs.flatMap((x) => [...rowMarks(x).times, ...(grid ? [...rowMarks(x).bands, ...rowMarks(x).served] : [])].filter((cc) => cc > c)))].sort((a, b) => a - b);
        if (contiguous) tripCols = tripCols.filter((cc, k) => cc === c + 1 + k);
        // « F1, F2… » or « Sa, Sa… » down the column: the trips' labels or day types of a timetable written across —
        // never its stops (a timetable read the wrong way round builds stops named after trips). Under « Arrêts »
        // the codes are stops' (« P1 », « P2 » — a timetable written across with « Arrêts » in its corner is set
        // aside before: acrossReading); on the sheet read across, « Arrêts » there heads the column at its left.
        const coded = rs.every((x) => tripOrDay(cellAt(sheet, x, c))) && !(!sheet.across && stopHeaded(sheet, rs[0], c) && rs.every((x) => !V.dayTypeOf(V.textOf(cellAt(sheet, x, c)))));
        if (!tripCols.length || coded) {
          if (tripCols.length && refused) refused.push({ c, rows: rs, tripCols });
          i = Math.max(j, i + 1);
          continue;
        }
        blocks.push({ c, rows: rs, tripCols, grid });
        const inBlock = new Set(tripCols);
        for (const x of rs) {
          used.add(`${x},${c}`);
          for (const cell of cellsOfRow(sheet, x)) if (inBlock.has(cell.c)) used.add(`${x},${cell.c}`);
          marksOf.delete(x);
        }
        i = Math.max(j, i + 1);
      } else i += 1;
    }
  }
  return blocks;
};

// The label of a row of notes under the trips (« Renvois », « Notes »): its cells are notes' marks or notes.
const NOTE_LABELS = new Set(["renvoi", "renvois", "note", "notes", "nota", "remarque", "remarques", "observation", "observations", "particularites", "legende"]);

// The labels a stop column may hold above a block that are no section title (« Arrêts », « Course », « Horaires »;
// « Renvois » under the block above, NOTE_LABELS: its notes, never a title naming no day type over the next block).
const NOT_SECTION = new Set([...STOP_HEADERS, "course", "courses", "n°", "no", "n° course", "jour", "jours", "type de jour", "horaire", "horaires", "grille", "grille horaire", "fiche horaire", "desserte", "itineraire", "parcours"]);

/**
 * The section a grid block stands in, walking its stop column up (the rows of other blocks skipped): `own`, the
 * titles between it and the block above (a « Direction X » of its own); `day`, the nearest title naming a day type;
 * `barrier`, a short title naming nothing (« FHD ») met first — the blocks under it have no day type, said.
 */
const sectionOf = (sheet, block, blockCells) => {
  const rowsOfC = sheet.cols.get(block.c) || [];
  const out = { own: [], day: null, barrier: null };
  let crossed = false;
  for (let k = rowsOfC.indexOf(block.rows[0]) - 1; k >= 0; k--) {
    const r = rowsOfC[k];
    if (blockCells.has(`${r},${block.c}`)) {
      crossed = true;
      continue;
    }
    const cell = cellAt(sheet, r, block.c);
    const text = V.textOf(cell);
    if (!cell || cell.t !== "s" || !text || NOT_SECTION.has(V.fold(text)) || NOTE_LABELS.has(headWord(cell)) || text.length > 60) continue;
    const f = titleFacts(text);
    if (f && !crossed) out.own.push({ cell, facts: f });
    if (f?.day_type) return { ...out, day: { cell, facts: f } };
    if (!f && text.split(/\s+/).length <= 4) return { ...out, barrier: { cell } };
  }
  return out;
};

/** A grid block's context: the line, the period and the zone as for any table; its day type and direction its section's. */
const gridContext = (facts, row, section, sheet, cols) => {
  const base = contextFor(facts, row, cols);
  const out = {};
  for (const k of ["line", "period", "region"]) if (base[k]) out[k] = base[k];
  const cite = (x, k) => ({ value: x.facts[k], sheet: sheet.name, cell: x.cell.at, text: V.textOf(x.cell) });
  if (section.day) out.day_type = cite(section.day, "day_type");
  else if (!section.barrier && base.day_type) out.day_type = base.day_type;
  // The title that names no day type, kept as written: the person can say which days its blocks run (day_title).
  // (its address as one reference: the cell stays listed unread, never cited — a cell is one or the other)
  else if (section.barrier) out.day_title = { text: V.textOf(section.barrier.cell), ref: `${sheet.name}!${section.barrier.cell.at}` };
  for (const k of ["destination", "direction", "sens"]) {
    const x = section.own.find((t) => t.facts[k] != null);
    if (x) out[k] = cite(x, k);
  }
  return out;
};

// After midnight: a time before 06:00 read after one past 18:00 belongs to the same service day (« 0:40 » → 24:40).
const NIGHT_BEFORE = 6 * 3600;
const EVENING_AFTER = 18 * 3600;

/** A trip's number beside its times: « 301 », « N° 12 », « Course 3 » → its digits; « D01 », « F1 » → as written. */
const tripNumberOf = (cell) => {
  const text = V.textOf(cell);
  if (/^(n°|no|#|course|c)?\s*\d{1,6}$/i.test(text)) return text.replace(/^\D+/, "");
  return V.tripLabelOf(cell);
};

/** A cell's "r,c" key on the sheet itself, whether it is read there or on the sheet read across (acrossOf). */
const sheetKeyOf = (sheet, cell) => (sheet.across ? `${cell.c},${cell.r}` : `${cell.r},${cell.c}`);

/**
 * The notes under a block's trips, found before the titles are (a note is its trip's, never a title, nor a mark of
 * the next block's trips read again above them): the rows right under its last stop, two at most, up to one holding
 * none. In a row labelled as notes (« Renvois », « Notes ») any cell under a trip is its note, whatever it says or
 * however long (« Scolaire », « Sauf vacances »), a merged one under each trip it covers; elsewhere a note's mark
 * alone (« (1) », « * »). → { marks: [{ cc, cell }], cells: every cell of those rows right of the stops, kept out of
 * the titles }. `free(cell)`: no other table's cell.
 */
const notesBelow = (sheet, { c, rows, tripCols }, free) => {
  const last = rows[rows.length - 1];
  const marks = [];
  const cells = new Set();
  for (let r = last + 1; r <= last + 2 && sheet.rows.has(r); r++) {
    const noteRow = NOTE_LABELS.has(headWord(cellAt(sheet, r, c)));
    let any = false;
    for (const cc of tripCols) {
      const cell = cellAt(sheet, r, cc);
      if (!cell || !free(cell) || (cell.copy && !noteRow)) continue;
      const text = V.textOf(cell);
      if (V.isNoteMark(text) || (noteRow && text)) {
        marks.push({ cc, cell });
        cells.add(cell);
        any = true;
      }
    }
    if (noteRow) for (const cell of cellsOfRow(sheet, r)) if (cell.c > c && free(cell)) cells.add(cell);
    if (!any && !noteRow) break;
  }
  return { marks, cells: [...cells] };
};

/**
 * One timetable block: stops in column c, rows `rows`; trips in the columns to the right holding times. `ctxRow`: the
 * row its titles are looked for above (a timetable written across: its header's row, the sheet's own). `below`: the
 * notes under its trips (notesBelow); `noted`: the sheet's "r,c" of every block's notes — none of them is a mark
 * above another block's trips.
 */
const readBlock = (sheet, ledger, facts, { c, rows, tripCols, grid, ctxRow }, section = null, { below = [], noted = null } = {}) => {
  const first = rows[0];
  const last = rows[rows.length - 1];
  const end = tripCols[tripCols.length - 1] ?? c;
  // The sheet's columns the block stands over (written across: its trips' labels, then its stops). Written across,
  // its header row's corner (left of its first stop) is a title of its own: « Samedi » over the trips' labels.
  const cols = sheet.across ? [first - 1, last] : [c, end];
  const ctx = grid && section ? gridContext(facts, first, section, sheet, cols) : contextFor(facts, ctxRow ?? first, cols, sheet.across ? { leftOf: first } : {});
  if (grid && section?.barrier && !section.day) ledger.skip(sheet, section.barrier.cell, "unknown_day_type");
  const stops = rows.map((r) => {
    const cell = cellAt(sheet, r, c);
    ledger.read(sheet, cell);
    return val(sheet, cell, V.textOf(cell));
  });
  // Above the stops: a row of day types (one per trip) and a row of trip numbers, three rows at most — and the marks
  // of notes (« (1) », « * »): what a note says of its trip is not read (the trip keeps the mark, the cell is said).
  const perTrip = new Map();
  const numbers = new Map();
  const notes = new Map();
  const noteOf = (cc, cell) => {
    if (!notes.has(cc)) notes.set(cc, { text: V.textOf(cell).slice(0, 60), ref: `${sheet.name}!${cell.at}` });
  };
  for (let r = first - 1; r >= Math.max(sheet.bounds.s.r, first - 3); r--) {
    const head = cellAt(sheet, r, c);
    // A row headed by another column's word (« Ligne », « Sens », « Destination ») holds no trips' numbers.
    const role = head ? headerRole(V.textOf(head))?.role : null;
    const numbered = !role || role === "trips" || TRIP_HEADERS.has(headWord(head));
    let any = false;
    for (const cc of tripCols) {
      const cell = cellAt(sheet, r, cc);
      // A note under the block above (« PS » in its « Renvois » row) is its trip's: no day type, number nor mark here.
      if (!cell || ledger.isDone(sheet, cell) || noted?.has(sheetKeyOf(sheet, cell))) continue;
      const d = V.dayTypeOf(V.textOf(cell));
      const n = d || !numbered ? null : tripNumberOf(cell);
      if (d && !perTrip.has(cc)) {
        perTrip.set(cc, val(sheet, cell, d));
        ledger.read(sheet, cell);
        any = true;
      } else if (n != null && !numbers.has(cc)) {
        numbers.set(cc, val(sheet, cell, n));
        ledger.read(sheet, cell);
        any = true;
      } else if (!cell.copy && V.isNoteMark(V.textOf(cell))) noteOf(cc, cell);
    }
    if (head && !ledger.isDone(sheet, head) && (any || STOP_HEADERS.has(V.fold(V.textOf(head))))) ledger.label(sheet, head, "timetable_header");
  }
  // Below the stops: a row of notes (« Renvois » … « (1) » under a trip), found with the sheet's tables (notesBelow).
  for (const { cc, cell } of below) noteOf(cc, cell);
  const trips = [];
  // The bands a grid states over trips it gives no time (« 7h-9h : 15 min »), each read once where it is written.
  const bands = new Map();
  let latest = -Infinity;
  for (const cc of tripCols.slice(0, MAX_TRIPS)) {
    const times = rows.map((r) => {
      const cell = cellAt(sheet, r, cc);
      // In a grid an empty cell is a stop the trip does not serve (nothing written: no address cited).
      if (!cell) return grid ? { value: null, pass: true, empty: true } : null;
      const bad = unreadable(cell);
      if (bad) return ledger.skip(sheet, cell, bad), null;
      const t = V.timeOf(cell);
      if (t && t.sec != null) {
        ledger.read(sheet, cell);
        const sec = t.sec < NIGHT_BEFORE && latest >= EVENING_AFTER ? t.sec + 86400 : t.sec;
        latest = Math.max(latest, sec);
        return val(sheet, cell, V.hhmm(sec), { sec });
      }
      const text = V.textOf(cell);
      // « | », « — », « … »: the trip does not stop here — read, cited, no time.
      if (V.isPassMark(text)) {
        ledger.read(sheet, cell);
        return val(sheet, cell, null, { pass: true });
      }
      // « oui »: served, no time given (placed by the running times).
      if (grid && V.isServedMark(text)) {
        ledger.read(sheet, cell);
        return val(sheet, cell, null, { served: true });
      }
      // A band cell over trips without times: the trip serves that stop, its time is the band's (said, not placed).
      const b = grid ? V.bandHeadwayOf(text) : null;
      if (b) {
        if (!bands.has(cell.at)) {
          // The hours' rule holds for a band too: « 0h30 - 1h30 » written after the evening's trips is the same
          // service day's 24:30–25:30, never the small hours before its first departure; and the band's end is the
          // latest moment read so far (a time after it is read after the band).
          const shift = b.from < NIGHT_BEFORE && latest >= EVENING_AFTER ? 86400 : 0;
          bands.set(cell.at, { from: val(sheet, cell, V.hhmm(b.from + shift), { sec: b.from + shift }), to: val(sheet, cell, V.hhmm(b.to + shift), { sec: b.to + shift }), headway_min: val(sheet, cell, b.min) });
          latest = Math.max(latest, b.to + shift);
        }
        ledger.read(sheet, cell);
        return val(sheet, cell, null, { served: true, band: true });
      }
      ledger.skip(sheet, cell, t?.error || "not_a_time");
      return null;
    });
    const untimed = !times.some((x) => x && x.value != null);
    trips.push({ column: cc, ...(numbers.has(cc) ? { number: numbers.get(cc) } : {}), ...(perTrip.has(cc) ? { day_type: perTrip.get(cc) } : {}), ...(untimed ? { untimed: true } : {}), ...(notes.has(cc) ? { note: notes.get(cc) } : {}), times });
  }
  for (const cc of tripCols.slice(MAX_TRIPS)) for (const r of rows) ledger.skip(sheet, cellAt(sheet, r, cc), "too_many");
  // Marks in a column without any time: a trip the sheet gives no time for. (Written across, the trips are the rows
  // right under the header and nothing further: what lies below belongs to whatever stands there.)
  const inBlock = new Set(tripCols);
  for (const r of sheet.across ? [] : rows) {
    for (const cell of cellsOfRow(sheet, r)) {
      if (cell.c <= c || inBlock.has(cell.c)) continue;
      if (!cell.copy && (V.isPassMark(V.textOf(cell)) || (grid && V.isServedMark(V.textOf(cell))))) ledger.skip(sheet, cell, "no_time");
    }
  }
  // The block's cells, cited as the sheet writes them: written across, its header row over its stops' columns.
  const range = sheet.across ? `${colName(first)}${c + 1}:${colName(last)}${end + 1}` : `${colName(c)}${first + 1}:${colName(end)}${last + 1}`;
  return { sheet: sheet.name, row: ctxRow ?? first, ctx, stops, trips, grid: Boolean(grid), bands: [...bands.values()], range };
};

// ── The timetable written across (layout B, one trip per row) ───────────────

/**
 * The sheet read across its diagonal: each cell keeps its address (`at`), its row becomes its column. The finder and
 * the reader above, written for stops down a column, read on it a timetable written with its stops across a row and
 * one trip per row — what stands « above its stops » there is the column at their left: the trips' labels.
 */
const acrossOf = (sheet) => {
  const grid = new Map();
  for (const cell of sheet.grid.values()) grid.set(cellKey(cell.c, cell.r), { ...cell, r: cell.c, c: cell.r });
  return { name: sheet.name, grid, ...indexOf(grid), byAt: sheet.byAt, across: true };
};

// The head of a column of trips' labels (« Course », « Trajet », « N° de course »): the trips run down the rows.
const TRIP_HEADERS = new Set(["course", "courses", "trajet", "trajets", "service", "services", "voyage", "voyages", "navette", "navettes", "mission", "missions", "trip", "trips", "run", "runs", "n°", "no", "num", "numero", "n° course", "n° de course", "no de course", "numero de course", "course n°", "n° service", "n° de service", "n° de trajet"]);
// The words a row of stop names never holds: a table's own headers, not places.
const NOT_STOPS = new Set([...STOP_HEADERS, ...NOTE_LABELS, ...TRIP_HEADERS, "heure", "heures", "horaire", "horaires", "duree", "temps", "temps de parcours", "total", "jour", "jours", "commentaire", "commentaires"]);

/**
 * A header of a timetable written across: a stop's name — never a trip's label, a day type, a header word, a time
 * window, a date, nor a merged cell (one title over several cells, not a stop of its own).
 */
const stopLike = (cell) => {
  if (!isStopName(cell) || cell.copy || cell.merged || tripOrDay(cell)) return false;
  const text = V.textOf(cell);
  return !V.dayTypesOf(text).length && !headerRole(text) && !NOT_STOPS.has(V.fold(text).replace(/[:.]+$/, "")) && !V.bandOf(text) && !V.periodOf(text);
};

/**
 * Whether every trip of a block runs forward along its stops — two times at least, each no earlier than the one
 * before (past midnight as the reader reads it) — and every stop has a time on some trip: what a timetable read the
 * right way shows, and a list of other things (« Départ | Arrivée | Durée ») does not.
 */
const runsForward = (sheet, { rows, tripCols }) =>
  rows.every((r) => tripCols.some((cc) => isTimeCell(cellAt(sheet, r, cc)))) &&
  tripCols.every((cc) => {
    let prev = -Infinity;
    let n = 0;
    for (const r of rows) {
      const t = V.timeOf(cellAt(sheet, r, cc));
      if (!t || t.sec == null) continue;
      const sec = t.sec < NIGHT_BEFORE && prev >= EVENING_AFTER ? t.sec + 86400 : t.sec;
      if (sec < prev) return false;
      prev = sec;
      n += 1;
    }
    return n >= 2;
  });

/** The median of the forward steps of the times along each line of cells (seconds), or null (no step). */
const medianStep = (lines) => {
  const steps = [];
  for (const cells of lines) {
    let prev = null;
    for (const cell of cells) {
      const t = V.timeOf(cell);
      if (!t || t.sec == null) continue;
      if (prev != null && t.sec > prev) steps.push(t.sec - prev);
      prev = t.sec;
    }
  }
  steps.sort((a, b) => a - b);
  return steps.length ? steps[steps.length >> 1] : null;
};

/**
 * Which way a block's times step the least, as a timetable's do (a few minutes from stop to stop along a trip, the
 * headway from one trip to the next): "trips" (along its trips as the block reads them), "stops" (along its stops —
 * the trips run the other way round), or null (too few times, or as much either way). The median of the steps.
 */
const stepsAlong = (sheet, { rows, tripCols }) => {
  const trips = medianStep(tripCols.map((cc) => rows.map((r) => cellAt(sheet, r, cc))));
  const stops = medianStep(rows.map((r) => tripCols.map((cc) => cellAt(sheet, r, cc))));
  if (trips == null || stops == null || trips === stops) return null;
  return trips < stops ? "trips" : "stops";
};

/**
 * The step between a block's trips as it reads them (seconds, the median): what each hop from stop to stop would be,
 * were it read the other way round. An hour or more is no hop between two stops of a timetable: trips named in words
 * (« Matin », « Midi »), never stops. A frequent line timed every few stops (its trips 8 minutes apart, its timing
 * points 12) steps less along its rows than down its columns all the same, and is read down as it always was.
 */
const LONG_HOP = 3600;
const stepBetweenTrips = (sheet, { rows, tripCols }) => medianStep(rows.map((r) => tripCols.map((cc) => cellAt(sheet, r, cc))));

// The leading words of the loaded feed's stop keys (« gare », « gare sncf » of « gare sncf quai a »), built once per
// feed: a cell names a stop of the feed spelled longer or shorter when it, or its leading words, are among them.
const prefixesOf = new WeakMap();
const nearlyKnown = (stopNames, cell) => {
  const k = V.stopKey(V.textOf(cell));
  if (!k) return false;
  if (!prefixesOf.has(stopNames)) {
    const p = new Set();
    for (const s of stopNames) {
      const w = s.split(" ");
      for (let i = 1; i < w.length; i++) p.add(w.slice(0, i).join(" "));
    }
    prefixesOf.set(stopNames, p);
  }
  if (stopNames.has(k) || prefixesOf.get(stopNames).has(k)) return true;
  const w = k.split(" ");
  for (let i = 1; i < w.length; i++) if (stopNames.has(w.slice(0, i).join(" "))) return true;
  return false;
};

/** A cell's text as a header word: folded, its final « : » or « . » aside. */
const headWord = (cell) => (cell ? V.fold(V.textOf(cell)).replace(/[:.]+$/, "").trim() : "");

/**
 * Whether the trip of a block found on the view (its view column cc) has a trip's label at its left: among the cells
 * there, three at most, up to the first that is neither a label nor a day type (the table's edge).
 */
const labelledTrip = (view, t, cc) => {
  for (let k = 1; k <= 3; k++) {
    const x = cellAt(view, t.rows[0] - k, cc);
    if (!x) continue;
    if (!tripOrDay(x)) return false;
    if (V.tripLabelOf(x)) return true;
  }
  return false;
};

/**
 * The blocks found on the sheet read across, with what breaks them (in the view's coordinates; `taken` the cells of
 * other tables). A timetable written across is often broken by an empty row or a sub-heading between its trips
 * (« Après-midi »): the trips after the break join it — one timetable, as two blocks of the same stops down a column
 * are one — when the break names nothing (no day type, direction, line nor period: three rows at most) and each trip
 * after it is labelled. A break it cannot join (« Samedi » between them, trips without a label), or stops timed on its
 * trips' rows past its first or last stop (an empty column between them, a stop whose header is missing), marks the
 * block `cut`: never read as the whole timetable it is only part of — `tail`, the break and the trips after it, are
 * set aside with it.
 */
const joinAcross = (view, found, taken) => {
  const freeTime = (r, c) => !taken.has(`${r},${c}`) && isTimeCell(cellAt(view, r, c));
  // A view column's cells on rows `rows` (no merged copy): what a sheet's row writes under the block's stops.
  const under = (rows, cc) => rows.map((r) => cellAt(view, r, cc)).filter((x) => x && !x.copy);
  // A cell between two groups of trips that names nothing: « Après-midi », a sentence — never a title of the sheet.
  const nameless = (x) => x.copy || (x.t === "s" && !isTimeCell(x) && !titleFacts(V.textOf(x)) && !V.dayTypesOf(V.textOf(x)).length && !V.tripLabelOf(x));
  return found.map((found1) => {
    const t = { ...found1, rows: [...found1.rows], tripCols: [...found1.tripCols] };
    for (;;) {
      const last = t.tripCols[t.tripCols.length - 1];
      // The rows of the sheet after the last trip, three at most, holding nothing under the stops: the break.
      let s = last + 1;
      const gap = [];
      while (s <= last + 4 && !under(t.rows, s).length) gap.push(s++);
      if (s === last + 1 || s > last + 4 || !t.rows.some((r) => freeTime(r, s))) break;
      const tail = [];
      for (let cc = s; t.rows.some((r) => freeTime(r, cc)); cc++) tail.push(cc);
      const breakCells = gap.flatMap((g) => (view.cols.get(g) || []).map((r) => cellAt(view, r, g)));
      if (breakCells.every(nameless) && tail.every((cc) => labelledTrip(view, { rows: t.rows }, cc))) {
        t.tripCols.push(...tail);
        continue;
      }
      // Set aside with it: the break (a « Samedi » there is no title of the sheet) and the trips after it.
      t.cut = true;
      t.tail = [...gap, ...tail];
      break;
    }
    // Stops timed on its trips' rows beyond its first or last stop, across empty columns (or none: a header missing).
    const timedAt = (r) => t.tripCols.some((cc) => freeTime(r, cc));
    for (const step of [1, -1]) {
      let r = step > 0 ? t.rows[t.rows.length - 1] + 1 : t.rows[0] - 1;
      for (let k = 0; k < 3 && !under([r], t.c).length && !t.tripCols.some((cc) => cellAt(view, r, cc)); k++) r += step;
      if (timedAt(r)) t.cut = true;
    }
    return t;
  });
};

/**
 * How a timetable found on the sheet read across reads (`t` in the view's coordinates: its header row `c`, its stops'
 * columns `rows`, its trips' rows `tripCols`) — decided from its cells, never guessed. What says its trips run down
 * the rows: their labels at its left (« F1 », « 12 », « Course 3 »), a trip's word over them (« Course », « Trajet »),
 * the feed's stops in its header and none at its left (not even spelled otherwise), its times stepping less along the
 * rows than down the columns by an hour or more (a hop no two stops of a timetable are apart).
 *   "across"  read one trip per row: every trip labelled (among the cells at its left, three at most, up to the first
 *             that is neither a label nor a day type: the table's edge), every header a stop's name (stopLike, two
 *             names at least), timed (no « oui » marks), every trip running forward
 *             (runsForward), the times not stepping less down the columns, no « Arrêts » over the labels — and, when
 *             the feed's stop names are given, half the headers at least among them and no label
 *   "unsure"  something says so but the rest does not hold: nothing of it is read, the assistant reads it — never a
 *             timetable read inverted (« Matin », « Midi » read as stops, or « Départ », « Arrivée »)
 *   null      nothing says so, or — no trip labelled — something says the cells at its left are stops (the feed's
 *             names, « Arrêts » or « Destination » over them, a header naming one of them or a place twice: a row of
 *             destinations): a timetable down a column, seen across; a merged sub-heading seen across is none either
 */
const acrossReading = (view, t, stopNames) => {
  const headers = t.rows.map((r) => cellAt(view, r, t.c));
  // One cell merged across the stops (a sub-heading over the trips below it, « Après-midi »): no header of stops.
  if (headers.every((x) => x.merged || x.copy) && new Set(headers.map((x) => x.at)).size === 1) return null;
  const labelled = t.tripCols.filter((cc) => labelledTrip(view, t, cc));
  const known = stopNames && stopNames.size ? (cells) => cells.filter((x) => stopNames.has(V.stopKey(V.textOf(x)))).length : null;
  const firstBeside = t.tripCols.map((cc) => cellAt(view, t.rows[0] - 1, cc)).filter(Boolean);
  // The feed's word: the headers are its stops, the cells at the left none of them.
  const feedSays = known ? known(headers) * 2 >= headers.length && known(firstBeside) === 0 : null;
  const corner = cellAt(view, t.rows[0] - 1, t.c);
  const steps = stepsAlong(view, t);
  const keys = headers.map((x) => V.stopKey(V.textOf(x)));
  // A header of stops' names (two at least, each its own cell): what the steps of the times are read against.
  const named = headers.every(stopLike) && new Set(keys).size > 1;
  // Without a trip's label, what says the cells at the left are the stops (a timetable written down, seen across —
  // a row of destinations over its trips, however frequent): the feed knows them (spelled longer or shorter too:
  // « GARE SNCF (quai A) » is its « Gare SNCF »), « Arrêts », « Destination », « Sens » or « Origine » heads them,
  // the header names one of them (a trip's terminus is a stop of the line), or the header names a place twice (one
  // trip's stops never do, but for a loop's first stop met again at its end; trips' termini do) — never under a
  // trip's word (« Course »).
  const cornerWord = headWord(corner);
  const cornerRole = corner ? headerRole(V.textOf(corner))?.role : null;
  const inner = keys.length > 2 && keys[0] === keys[keys.length - 1] ? keys.slice(0, -1) : keys;
  const leftKeys = new Set(firstBeside.map((x) => V.stopKey(V.textOf(x))));
  const down =
    !TRIP_HEADERS.has(cornerWord) &&
    ((known && firstBeside.length > 0 && firstBeside.filter((x) => nearlyKnown(stopNames, x)).length * 2 >= firstBeside.length) ||
      STOP_HEADERS.has(cornerWord) ||
      cornerRole === "destination" ||
      cornerRole === "direction" ||
      ["origine", "origin", "provenance"].includes(cornerWord) ||
      keys.some((k) => k && leftKeys.has(k)) ||
      new Set(inner).size < inner.length);
  if (!labelled.length && down) return null;
  // Nothing else says so without a label — no trip's word over them, the feed silent: the steps alone say it only
  // when, read down, each hop from stop to stop would take an hour or more (« Matin », « Midi »); a frequent line
  // timed every few stops is read down, as it always was.
  const longHops = steps === "trips" && named && stepBetweenTrips(view, t) >= LONG_HOP;
  if (!labelled.length && feedSays !== true && !TRIP_HEADERS.has(cornerWord) && !longHops) return null;
  const sure =
    labelled.length === t.tripCols.length &&
    !t.grid &&
    named &&
    !STOP_HEADERS.has(headWord(corner)) &&
    runsForward(view, t) &&
    steps !== "stops" &&
    feedSays !== false;
  return sure ? "across" : "unsure";
};

/**
 * The timetables of a sheet written across (one trip per row), found before those written down a column, which
 * never take their cells: { view (the sheet read across), blocks: [the ones read the right way, in the view's
 * coordinates, `ctxRow` their header's row], unsure: [the ones left unread, likewise — a timetable read across but
 * broken where it cannot be joined (joinAcross: `cut`) is one of them, with the trips after its break] }.
 */
const acrossRegions = (sheet, taken, stopNames) => {
  const view = acrossOf(sheet);
  const swapped = new Set([...taken].map((k) => k.split(",").reverse().join(",")));
  const out = { view, blocks: [], unsure: [] };
  for (const t of joinAcross(view, timetableRegions(view, swapped, { contiguous: true }), swapped)) {
    const reading = acrossReading(view, t, stopNames);
    if (reading === "across" && !t.cut) out.blocks.push({ ...t, ctxRow: t.c });
    else if (reading) out.unsure.push({ ...t, tripCols: [...t.tripCols, ...(t.tail || [])] });
  }
  return out;
};

/**
 * The sheet's cells of a block found on the view, as "r,c" keys of the sheet: its header, its trips, the column next
 * to its stops (the trips' labels) and the labels or day types beyond it, up to the table's edge — never a cell of a
 * table beside it. The header row's cells at the left of its stops stay free: a title may stand there, as above the
 * stop column of a timetable written down.
 */
const acrossCells = (view, t) => {
  const out = [];
  for (const r of t.rows) for (const cc of [t.c, ...t.tripCols]) out.push(`${cc},${r}`);
  for (const cc of t.tripCols) {
    for (let k = 1; k <= 3; k++) {
      const x = cellAt(view, t.rows[0] - k, cc);
      if (k > 1 && x && !tripOrDay(x)) break;
      out.push(`${cc},${t.rows[0] - k}`);
    }
  }
  return out;
};

// ── The summary offer table (layout C) ──────────────────────────────────────

// The measure a row's label names (its words before a parenthesis or a colon): a frequency, a count, a span.
const MEASURES = [
  ["headway", /^(?:frequences?|intervalles?|cadences?|cadencement|headways?|frequency)$/],
  ["trips", /^(?:courses|nb courses|nombre de courses|nb de courses|nb departs|nombre de departs|departs|trips|number of trips|allers?-retours?)$/],
  ["span", /^(?:amplitudes?|amplitude horaire|amplitude de service|plage de service|horaires? de service|span|service span)$/],
];

/** The measure of a summary row's label: { kind, at_stop } | null (`at_stop`: « Amplitude (arrêt de cadencement) »). */
const measureOf = (text) => {
  const m = /^([^(:]+?)\s*(?:\((.*)\)?|:\s*(.*))?$/.exec(V.fold(text));
  if (!m) return null;
  const base = m[1].replace(/[*.]+$/, "").trim();
  const rest = m[2] || m[3] || "";
  for (const [kind, re] of MEASURES) if (re.test(base)) return { kind, at_stop: /\b(arrets?|cadencement|point de|terminus)\b/.test(rest) };
  return null;
};

const DIR_CELL = /^(?:dir\.?|direction|vers|destination|towards)\s*:?\s+(.+)$/i;

/** A summary row's direction cell: « Dir Gare » → { destination }, « Aller » → { direction }, « Sens 1 » → { sens }. */
const directionCellOf = (text) => {
  const t = String(text ?? "").trim();
  const m = DIR_CELL.exec(t);
  if (m) return V.directionOf(m[1]) ? { direction: V.directionOf(m[1]) } : { destination: m[1].trim() };
  if (/^sens\b/i.test(t)) return sensFacts(t.replace(/^sens\s*:?\s*/i, ""));
  return V.directionOf(t) && t.length > 1 ? { direction: V.directionOf(t) } : null;
};

/**
 * The summary tables of a sheet, found first (their range row would read as a header of bands): [{ row (the header
 * row), first (its first day-type column), cols: [{ c, cell, dayTypes }], rows: [{ r, measure }] }]. A header row:
 * day types from its first one on, the other cells there words (« renforts »: a column said, never read), never a
 * time or a number; below it, rows labelled by a measure at their left (or ranges only, under a labelled table).
 */
const summaryRegions = (sheet) => {
  const out = [];
  let after = -Infinity;
  for (const r of sheet.rows.keys()) {
    if (r < after) continue;
    const row = cellsOfRow(sheet, r).filter((x) => !x.copy);
    // Each cell naming a day type may be the first column of the table (a name at its left may read as one).
    for (const head of row.filter((x) => x.t === "s" && V.dayTypesOf(V.textOf(x)).length)) {
      const cols = row.filter((x) => x.c >= head.c).map((x) => ({ c: x.c, cell: x, dayTypes: x.t === "s" ? V.dayTypesOf(V.textOf(x)) : [] }));
      if (cols.some((k) => k.cell.t !== "s" || isTimeCell(k.cell) || V.textOf(k.cell).length > 40) || cols.filter((k) => k.dayTypes.length).length * 2 < cols.length) continue;
      const rows = [];
      let rr = r + 1;
      for (; sheet.rows.has(rr); rr++) {
        const measure = cellsOfRow(sheet, rr).filter((x) => x.c < head.c).map((x) => measureOf(V.textOf(x))).find(Boolean) || null;
        const values = cols.map((k) => cellAt(sheet, rr, k.c)).filter((x) => x && !x.copy);
        const ranges = values.length > 0 && values.every((x) => !isTimeCell(x) && V.bandOf(V.textOf(x)));
        if (!measure && !ranges) break;
        rows.push({ r: rr, measure });
      }
      if (!rows.some((x) => x.measure)) continue;
      out.push({ row: r, first: head.c, cols, rows });
      after = rr;
      break;
    }
  }
  return out;
};

/** A day type's key (its days and period): two headers naming the same one name the same column. */
const dayTypeKey = (d) => JSON.stringify([d.day, d.period, d.holidays]);

/** One value of a summary row read by its measure: { value: v } | { error }. */
const summaryValue = (sheet, cell, kind, measure) => {
  const text = V.textOf(cell);
  if (kind === "headway") {
    const hw = V.headwayOf(cell);
    if (!hw || hw.error) return { error: hw?.error || "invalid_headway" };
    return { value: val(sheet, cell, hw.none ? null : hw.min, hw.none ? { no_service: true } : {}) };
  }
  if (kind === "trips") {
    const n = cell.t === "n" ? cell.v : /^\d+$/.test(text) ? parseInt(text, 10) : null;
    return Number.isInteger(n) && n >= 0 && n < 2000 ? { value: val(sheet, cell, n) } : { error: "not_a_number" };
  }
  // The span: one range, first and last departure (a time alone, or words around the range, is not one).
  const b = V.bandOf(text);
  if (!b || isTimeCell(cell) || !/^\s*\d{1,2}\s*[h:]\s*\d{0,2}\s*(?:-|–|—|à|a|>|→|\/)\s*\d{1,2}\s*[h:]?\s*\d{0,2}\s*$/i.test(V.fold(text))) return { error: "invalid_time" };
  return { value: val(sheet, cell, { first: V.hhmm(b.from), last: V.hhmm(b.to) }, { first_sec: b.from, last_sec: b.to, ...(measure?.at_stop ? { at_stop: true } : {}) }) };
};

/**
 * The values of a summary table: [{ kind, value, day_type, destination?, direction?, sens?, ctx }] — one per value
 * cell and day type its column states. A header naming several day types gives its column to those no other
 * header names alone (« Semaine PS PVS » beside « Semaine PVS »: the school weeks); a header naming none
 * (« renforts ») is said, and its values with it (unknown_day_type).
 */
const readSummary = (sheet, ledger, facts, g) => {
  const out = [];
  const alone = new Set(g.cols.filter((k) => k.dayTypes.length === 1).map((k) => dayTypeKey(k.dayTypes[0])));
  for (const k of g.cols) {
    if (k.dayTypes.length) ledger.label(sheet, k.cell, "day_type");
    else ledger.skip(sheet, k.cell, "unknown_day_type");
    const own = k.dayTypes.length > 1 ? k.dayTypes.filter((d) => !alone.has(dayTypeKey(d))) : k.dayTypes;
    k.applies = (own.length ? own : k.dayTypes).map((d) => val(sheet, k.cell, d));
  }
  const ctx = contextFor(facts, g.row);
  for (const { r, measure } of g.rows) {
    const left = cellsOfRow(sheet, r).filter((x) => x.c < g.first);
    // The row's label (merged over the rows of its directions: cited where it is written) and its direction.
    const labelCell = left.find((x) => measureOf(V.textOf(x)));
    if (labelCell) ledger.label(sheet, labelCell, "measure");
    const ident = {};
    for (const x of left) {
      if (x === labelCell || unreadable(x)) continue;
      const d = directionCellOf(V.textOf(x));
      if (!d) continue;
      const [key, value] = Object.entries(d)[0];
      ident[key] = val(sheet, x, value);
      ledger.read(sheet, x);
      break;
    }
    const kind = measure ? measure.kind : "span";
    for (const k of g.cols) {
      const cell = cellAt(sheet, r, k.c);
      if (!cell || cell.copy) continue;
      const bad = unreadable(cell);
      if (bad) {
        ledger.skip(sheet, cell, bad);
        continue;
      }
      if (!k.dayTypes.length) {
        ledger.skip(sheet, cell, "unknown_day_type");
        continue;
      }
      const v = summaryValue(sheet, cell, kind, measure);
      if (v.error) {
        ledger.skip(sheet, cell, v.error);
        continue;
      }
      ledger.read(sheet, cell);
      for (const day of k.applies) out.push({ ...ident, kind, value: v.value, day_type: day, ctx });
    }
  }
  return out;
};

// The headers of the columns a summary sheet keeps beside the offer: dates, authors, comments (never offer values).
const COMMENT_HEADERS = new Set(["date", "dates", "qui", "auteur", "auteurs", "par", "redacteur", "redige par", "demandeur", "commentaire", "commentaires", "remarque", "remarques", "observation", "observations", "note", "notes", "historique"]);
const AUTHOR_HEADERS = new Set(["qui", "auteur", "auteurs", "par", "redacteur", "redige par", "demandeur"]);

const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

/** The comment columns of a sheet, headed at or above row `upTo`: Map(c → { from (the header's row), author }). */
const commentColumns = (sheet, upTo) => {
  const out = new Map();
  for (const cell of sheet.cells) {
    if (cell.r > upTo || cell.t !== "s") continue;
    const f = V.fold(V.textOf(cell)).replace(/[:.]+$/, "").trim();
    if (!COMMENT_HEADERS.has(f)) continue;
    // A header merged over several columns heads each of them.
    const m = /^[A-Z]+\d+:([A-Z]+)\d+$/.exec(cell.merged || "");
    for (let c = cell.c; c <= (m ? colIndex(m[1]) : cell.c); c++) if (!out.has(c)) out.set(c, { from: cell.r, author: AUTHOR_HEADERS.has(f) });
  }
  return out;
};

const colName = (c) => {
  let s = "";
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

// ── The model ───────────────────────────────────────────────────────────────

const pick = (rec, ctx, k) => rec[k] || ctx[k] || null;
const lineKey = (x) => JSON.stringify([x.line?.value ?? null, x.direction?.value ?? null, x.destination?.value ?? null, x.origin?.value ?? null, x.sens?.value ?? null]);
// Without a day type, the title as written tells the entries apart (« FHD » and « XYZ » are two unknown day types).
const dayKey = (d) => JSON.stringify([d.day_type?.value?.day ?? null, d.day_type?.value?.period ?? null, d.period?.value ?? null, d.day_type ? null : V.fold(d.day_title?.text || "")]);

/** A record's period: one cell (« du … au … », « Scolaire »), or « Du » and « Au » cells. */
const periodOfRecord = (rec, ctx) => {
  if (rec.period) return rec.period;
  if (rec.period_from || rec.period_to) {
    const a = rec.period_from;
    const b = rec.period_to;
    const base = a || b;
    return { value: { ...(a ? { from: a.value } : {}), ...(b ? { to: b.value } : {}) }, sheet: base.sheet, cell: base.cell, text: [a?.text, b?.text].filter(Boolean).join(" – "), cells: [a?.cell, b?.cell].filter(Boolean) };
  }
  return ctx.period || null;
};

/** The same value stated again in another cell: that cell is cited too (`cells`), the value is kept once. */
const cite = (kept, v) => {
  if (!kept || !v || !v.cell || kept.sheet !== v.sheet || kept.cell === v.cell) return;
  const cells = kept.cells || [kept.cell];
  for (const c of v.cells || [v.cell]) if (!cells.includes(c)) cells.push(c);
  kept.cells = cells;
};

const lineEntry = (lines, ident) => {
  const k = lineKey(ident);
  if (!lines.has(k)) {
    if (lines.size >= MAX_LINES) return null;
    lines.set(k, { line: ident.line || null, direction: ident.direction || null, destination: ident.destination || null, origin: ident.origin || null, ...(ident.sens ? { sens: ident.sens } : {}), day_types: [] });
  } else {
    const l = lines.get(k);
    for (const f of ["line", "direction", "destination", "origin", "sens"]) cite(l[f], ident[f]);
  }
  return lines.get(k);
};

const dayEntry = (line, ident) => {
  const k = dayKey(ident);
  let d = line.day_types.find((x) => dayKey(x) === k);
  if (!d) {
    d = { day_type: ident.day_type || null, ...(ident.period ? { period: ident.period } : {}), ...(ident.region ? { region: ident.region } : {}), ...(!ident.day_type && ident.day_title ? { day_title: ident.day_title } : {}), bands: [], first: null, last: null };
    line.day_types.push(d);
  } else {
    cite(d.day_type, ident.day_type);
    cite(d.period, ident.period);
  }
  return d;
};

/** A cell read, then kept out of the model: listed in `unread` with its reason instead. */
const unreadCell = (ledger, sheet, cell, reason) => {
  if (!sheet || !cell) return;
  if (ledger.state.get(`${sheet.name}!${cell.at}`) === "read") ledger.state.delete(`${sheet.name}!${cell.at}`);
  ledger.skip(sheet, cell, reason);
};

// The same value read twice: kept once; two values for one slot: the second cell is a conflict (unread).
const setOnce = (entry, k, v, ledger, sheetsByName) => {
  if (!v) return;
  if (!entry[k]) {
    entry[k] = v;
    return;
  }
  if (entry[k].cell === v.cell && entry[k].sheet === v.sheet) return;
  if (JSON.stringify(entry[k].value) === JSON.stringify(v.value)) return cite(entry[k], v);
  const sheet = sheetsByName.get(v.sheet);
  unreadCell(ledger, sheet, sheet && v.cell ? sheet.byAt.get(v.cell) : null, "conflicting_value");
};

const bandKey = (b) => `${b.from.value}|${b.to.value}`;

/**
 * A band of a day type: a new one is added; the same band stated again with the same headway is cited (its cells
 * too); the same band with ANOTHER headway is a conflict — the second headway cell is dropped (conflicting_value),
 * never the first one silently replaced nor the second one silently ignored.
 */
const addBand = (d, b, drop) => {
  const same = d.bands.find((x) => bandKey(x) === bandKey(b));
  if (!same) {
    d.bands.push(b);
    return;
  }
  // The range agrees (a band row's « 9h-12h » cell is cited); the headway is the same one, or a conflict.
  cite(same.from, b.from);
  cite(same.to, b.to);
  if (JSON.stringify(same.headway_min.value) !== JSON.stringify(b.headway_min.value)) drop(b.headway_min, "conflicting_value");
  else cite(same.headway_min, b.headway_min);
};

/**
 * Whether a block continues the timetable read before it for the same line, direction and day type (the day written
 * in two blocks, a morning and an afternoon): the same sheet, the same stops in the same order (their spelling's case
 * and accents aside), the same kind (a grid, or a timed timetable). Otherwise the block states another timetable of
 * that day, which never replaces the first: its cells are said.
 */
const continues = (tt, block) => Boolean(tt.grid) === Boolean(block.grid) && tt.stops.length === block.stops.length && tt.stops.every((s, j) => s.sheet === block.stops[j].sheet && V.fold(s.value) === V.fold(block.stops[j].value));

/** Whether a column of the group's trips stands under the band's cell (the trip's entry there: band: true, that cell). */
const bandUnder = (b, g) => g.trips.some((t) => t.times.some((x) => x && x.band && x.cell === b.headway_min.cell));

/** Every "sheet!A1" the lines cite (a value's cell, the cells of a value read from several). */
const citedOf = (lines) => {
  const out = new Set();
  const walk = (x) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) return x.forEach(walk);
    if (typeof x.sheet === "string" && typeof x.cell === "string") out.add(`${x.sheet}!${x.cell}`);
    if (typeof x.sheet === "string" && Array.isArray(x.cells)) x.cells.forEach((c) => out.add(`${x.sheet}!${c}`));
    Object.values(x).forEach(walk);
  };
  walk(lines);
  return out;
};

// The values a record of an offer table read (its own cells, and the ones it carries down from the row above).
const recordValues = (rec) => [rec.line, rec.direction, rec.destination, rec.sens, rec.origin, rec.day_type, rec.period, rec.period_from, rec.period_to, rec.first, rec.last, rec.trips, rec.no_service, rec.band_from, rec.band_to, rec.headway, ...rec.bands.map((b) => b.headway_min)];
const blockValues = (block) => [...block.stops, ...block.trips.flatMap((t) => [t.number, t.day_type, ...t.times]), ...block.bands.map((b) => b.headway_min)];

/**
 * The model (see the header): the offer tables' records, the timetable blocks and the summaries' values, each line
 * × direction × day type once. `wbLine`: the one line the workbook's titles name, for a summary whose sheet names
 * none.
 */
const buildModel = (records, blocks, ledger, sheetsByName, summaries = [], wbLine = null) => {
  const lines = new Map();
  // Values read but kept out of the model (a conflict, half a band, a line past MAX_LINES): each cell is listed in
  // `unread` with its reason once the model is built — unless another value of the model cites that same cell
  // (a merged cell, a value carried down from the row above).
  const dropped = [];
  // `unlessCited`: a conflict said only where no value of the model cites the cell (a block's first and last stop
  // name the line's direction, read, while the block's timetable is set aside).
  const drop = (v, reason, { unlessCited = false } = {}) => v && dropped.push({ v, reason, unlessCited });
  for (const rec of records) {
    const ctx = rec.ctx || {};
    const ident = { line: pick(rec, ctx, "line"), direction: pick(rec, ctx, "direction"), destination: pick(rec, ctx, "destination"), sens: pick(rec, ctx, "sens"), origin: rec.origin || null, day_type: pick(rec, ctx, "day_type"), period: periodOfRecord(rec, ctx), region: ctx.region || null };
    // A sheet whose name says the line (« Ligne 4 »).
    if (!ident.line && rec.sheetLine) ident.line = rec.sheetLine;
    const line = lineEntry(lines, ident);
    if (!line) {
      for (const v of recordValues(rec)) drop(v, "too_many");
      continue;
    }
    const d = dayEntry(line, ident);
    setOnce(d, "first", rec.first, ledger, sheetsByName);
    setOnce(d, "last", rec.last, ledger, sheetsByName);
    setOnce(d, "trips", rec.trips, ledger, sheetsByName);
    if (rec.no_service) {
      if (d.no_service) cite(d.no_service, rec.no_service);
      else d.no_service = rec.no_service;
    }
    for (const b of rec.bands) addBand(d, b, drop);
    // A band as a row: its range and its headway together, else what the row gives is half a band (said).
    if (rec.band_from && rec.band_to && rec.headway) addBand(d, { from: rec.band_from, to: rec.band_to, headway_min: rec.headway }, drop);
    else for (const v of [rec.band_from, rec.band_to, rec.headway]) drop(v, "band_incomplete");
  }
  // What the blocks of each day entry gave it last (its first and last departure, its count of trips): told apart
  // from a value an offer table's row gave, which stands when a later block of the day recomputes them.
  const ofBlocks = new Map();
  for (const block of blocks) {
    const ctx = block.ctx || {};
    // The trips' own day types, else the titles'.
    const groups = new Map();
    for (const t of block.trips) {
      const dt = t.day_type || ctx.day_type || null;
      const k = JSON.stringify([dt?.value?.day ?? null, dt?.value?.period ?? null]);
      if (!groups.has(k)) groups.set(k, { day_type: dt, trips: [] });
      groups.get(k).trips.push(t);
    }
    const lastStop = block.stops[block.stops.length - 1];
    const ident = { line: ctx.line || block.sheetLine || null, direction: ctx.direction || null, destination: ctx.destination || (ctx.direction ? null : lastStop), sens: ctx.sens || null, origin: block.stops[0], period: ctx.period || null, region: ctx.region || null };
    const line = lineEntry(lines, ident);
    if (!line) {
      for (const v of blockValues(block)) drop(v, "too_many");
      continue;
    }
    // Each group's entry (under a title that names no day type, the title as written tells the entries apart), and
    // whether its trips join that entry's timetable: a timetable read before, of other stops (or on another sheet,
    // or timed where this one is a grid), is never replaced — the later block's cells are said instead.
    const placed = [...groups.values()].map((g) => {
      const d = dayEntry(line, { ...ident, day_type: g.day_type, day_title: g.day_type ? null : ctx.day_title || null });
      return { g, d, kept: !d.timetable || continues(d.timetable, block) };
    });
    // A band cell a kept group's column stands under too is that group's: cited, never said with the other group.
    const sharedBand = (x) => Boolean(x && x.band && (block.bands || []).some((b) => b.headway_min.cell === x.cell && placed.some((p) => p.kept && bandUnder(b, p.g))));
    for (const { g, d, kept } of placed) {
      if (!kept) {
        for (const v of g.trips.flatMap((t) => [t.number, t.day_type, ...t.times])) if (!sharedBand(v)) drop(v, "conflicting_value");
        continue;
      }
      let trips = g.trips.map(({ column: _c, ...rest }) => rest); // eslint-disable-line no-unused-vars
      if (!d.timetable) d.timetable = { range: block.range, ...(block.grid ? { grid: true } : {}), stops: block.stops, trips };
      else {
        // The day continued in a second block (the same stops): its trips join the timetable, within the bound (the
        // trips past it said, too_many), and its stop cells are cited with the first block's.
        const room = Math.max(0, MAX_TRIPS - d.timetable.trips.length);
        for (const t of g.trips.slice(room)) for (const v of [t.number, t.day_type, ...t.times]) drop(v, "too_many");
        trips = trips.slice(0, room);
        d.timetable.range = `${d.timetable.range},${block.range}`;
        d.timetable.stops.forEach((s, j) => cite(s, block.stops[j]));
        d.timetable.trips.push(...trips);
      }
      // A grid's bands over trips without times (« 7h-9h : 15 min »): each one to the day types of the columns under
      // its cell, never to the block's other day types (a Saturday column beside it is no column of the band's).
      for (const b of block.bands || []) if (bandUnder(b, g)) addBand(d, b, drop);
      // The first and last departures: each trip's first time, the earliest and the latest of them — in a grid only
      // where every timed trip has its time at the first stop (times at a timing stop further on are no departures
      // from the origin: the clauses read them where they are). Recomputed over the whole timetable at each block,
      // like the count of its trips; a value an offer table's row gave stands. A trip marked by a note the reader
      // does not read (« (1) »: « ne circule pas pendant les vacances ») may not run every day: never the day's first
      // or last departure, and the count says how many trips are so marked (`noted`).
      const all = d.timetable.trips;
      const timed = all.filter((t) => !t.untimed);
      const atOrigin = !d.timetable.grid || (timed.length > 0 && timed.every((t) => t.times[0] && t.times[0].value != null));
      const starts = atOrigin ? all.filter((t) => !t.note).map((t) => t.times.find((x) => x && x.value != null)).filter(Boolean) : [];
      const firstDep = starts.reduce((a, b) => (!a || b.sec < a.sec ? b : a), null);
      const lastDep = starts.reduce((a, b) => (!a || b.sec > a.sec ? b : a), null);
      // How many trips the timetable states: its columns — unless some stand for trips it gives no time (a band's cell
      // over them, marks alone): their number is then the band's to say, never the count of the columns it spans.
      const noted = all.filter((t) => t.note).length;
      const count = all.some((t) => t.untimed) ? null : { value: all.length, sheet: block.sheet, cell: d.timetable.range, text: `${all.length}`, ...(noted ? { noted } : {}) };
      const own = ofBlocks.get(d) || { first: null, last: null, trips: null };
      if (!d.first || d.first === own.first) d.first = firstDep;
      if (!d.last || d.last === own.last) d.last = lastDep;
      if (!d.trips || d.trips === own.trips) {
        if (count) d.trips = count;
        else delete d.trips;
      }
      ofBlocks.set(d, { first: firstDep, last: lastDep, trips: count });
    }
    // The cells of the block no kept group cites: its stops when every group is said (its first and last stop, read as
    // the line's origin and destination, stay cited), a band no kept column stands under.
    if (!placed.some((x) => x.kept)) for (const v of block.stops) drop(v, "conflicting_value", { unlessCited: true });
    for (const b of block.bands || []) if (!placed.some((x) => x.kept && bandUnder(b, x.g))) drop(b.headway_min, "conflicting_value");
  }
  // The summaries: per direction and day type, the count of trips, the span, the frequency (never a timetable).
  for (const s of summaries) {
    const ctx = s.ctx || {};
    const ident = { line: ctx.line || s.sheetLine || wbLine || null, direction: s.direction || null, destination: s.destination || null, sens: s.sens || null, origin: null, day_type: s.day_type, period: ctx.period || null, region: ctx.region || null };
    const line = lineEntry(lines, ident);
    if (!line) {
      drop(s.value, "too_many");
      continue;
    }
    const d = dayEntry(line, ident);
    if (s.kind === "headway" && s.value.no_service) {
      if (d.no_service) cite(d.no_service, s.value);
      else d.no_service = s.value;
    } else setOnce(d, s.kind === "trips" ? "trips" : s.kind === "headway" ? "headway" : "span", s.value, ledger, sheetsByName);
  }
  // Bands in time order.
  for (const l of lines.values()) for (const d of l.day_types) d.bands.sort((a, b) => a.from.sec - b.from.sec || a.to.sec - b.to.sec);
  const cited = citedOf([...lines.values()]);
  for (const { v, reason, unlessCited } of dropped) {
    const sheet = sheetsByName.get(v.sheet);
    // A value set aside because another one contradicts it is always said — even where a grid's trip cites the
    // same cell as the band it stands under: the headway it states was not taken.
    for (const at of v.cells || [v.cell]) if (at && ((reason === "conflicting_value" && !unlessCited) || !cited.has(`${v.sheet}!${at}`))) unreadCell(ledger, sheet, sheet?.byAt.get(at), reason);
  }
  return [...lines.values()];
};

// ── Entry point ─────────────────────────────────────────────────────────────

const sheetLineOf = (sheet) => {
  const m = /^(?:ligne|line|l)\s*[-_ ]?\s*([A-Za-z0-9]+)\b/i.exec(sheet.name || "");
  return m ? { value: m[1], sheet: sheet.name, cell: null, text: sheet.name } : null;
};

/**
 * Parse an offer workbook (see the header). `name` gives the format by its extension; `stopNames`, the loaded feed's
 * stop names (any iterable, compared by V.stopKey), lets a timetable written across be read only where the feed
 * knows its stops. Throws the workbook's typed refusals (415, 400, 413).
 */
const parseWorkbook = (buffer, { name = "offre.xlsx", stopNames = null } = {}) => {
  const wb = readWorkbook(buffer, { name });
  const known = stopNames ? new Set([...stopNames].map((s) => V.stopKey(s)).filter(Boolean)) : null;
  const ledger = makeLedger();
  const sheetsByName = new Map(wb.sheets.map((s) => [s.name, s]));
  const records = [];
  const blocks = [];
  const summaries = [];
  const layouts = new Map();
  // Per sheet, the timetables whose orientation is not certain (written across, or a column of trips' labels with
  // times at its right): left unread, counted.
  const unsure = new Map();
  // The lines the workbook's titles name (a summary sheet names none: the workbook's one line is its).
  const wbLines = new Map();
  for (const sheet of wb.sheets) {
    // The cells of the tables (only the cells there are: a row's index, never every address of a span).
    const taken = new Set();
    const take = (r, cols) => {
      for (const cell of cellsOfRow(sheet, r)) if (!cols || cols.has(cell.c)) taken.add(`${r},${cell.c}`);
    };
    // Where the tables are, before anything is read: the titles are looked for outside them. The summaries first:
    // their range row would read as a header of bands.
    const sums = summaryRegions(sheet);
    const sumRows = new Set();
    for (const g of sums) {
      take(g.row, new Set(g.cols.map((k) => k.c)));
      for (const { r } of g.rows) {
        take(r);
        sumRows.add(r);
      }
      sumRows.add(g.row);
    }
    // Beside a summary, the columns headed « Date », « Qui », « Commentaires »: said as comments, never titles.
    const comments = sums.length ? commentColumns(sheet, Math.max(...sums.map((g) => g.row))) : new Map();
    const isComment = (cell) => comments.has(cell.c) && cell.r >= comments.get(cell.c).from;
    const regions = offerRegions(sheet, sumRows);
    for (const g of regions) {
      const span = new Set(g.span);
      for (const r of [g.top, g.row, ...g.rows]) take(r, span);
    }
    // The timetables written across (one trip per row) before those written down a column: read the right way when
    // that is certain, else set aside whole — either way their cells are never read the wrong way round below.
    const across = acrossRegions(sheet, taken, known);
    for (const t of [...across.blocks, ...across.unsure]) for (const k of acrossCells(across.view, t)) taken.add(k);
    // A column of trips' labels or day types with times at its right and no header of stops: no timetable either
    // way — its cells are said (never a « Sa » read as a title of the sheet), counted with the uncertain ones.
    const refused = [];
    const tts = timetableRegions(sheet, taken, { refused });
    for (const b of refused) for (const r of b.rows) take(r, new Set([b.c, ...b.tripCols]));
    if (across.unsure.length + refused.length) unsure.set(sheet.name, across.unsure.length + refused.length);
    // The notes under each timetable's trips (« Renvois »), before the rows above the next one are taken: each note
    // its own block's, read once — never a title (« Scolaire » naming a period), never the next block's mark or day
    // type. Its cells stay listed unread (what a note says is not read).
    const body = new Set();
    for (const b of tts) {
      const cols = new Set([b.c, ...b.tripCols]);
      for (const r of b.rows) for (const cell of cellsOfRow(sheet, r)) if (cols.has(cell.c)) body.add(`${r},${cell.c}`);
    }
    const belowOf = new Map();
    const noted = new Set();
    for (const [view, list] of [[sheet, tts], [across.view, across.blocks]]) {
      for (const b of list) {
        const n = notesBelow(view, b, (cell) => !taken.has(sheetKeyOf(view, cell)) && !body.has(sheetKeyOf(view, cell)));
        belowOf.set(b, n.marks);
        for (const cell of n.cells) noted.add(sheetKeyOf(view, cell));
      }
    }
    for (const k of noted) taken.add(k);
    const blockCells = new Set();
    for (const b of tts) {
      const trips = new Set(b.tripCols);
      for (const r of b.rows) {
        take(r, new Set([b.c, ...b.tripCols]));
        blockCells.add(`${r},${b.c}`);
      }
      // The rows of day types and trip numbers above the trips.
      for (let r = b.rows[0] - 1; r >= Math.max(sheet.bounds.s.r, b.rows[0] - 3); r--) take(r, trips);
    }
    const facts = [];
    for (const cell of sheet.cells) {
      const text = V.textOf(cell);
      if (cell.t === "n" || text.length > 200 || taken.has(`${cell.r},${cell.c}`) || isComment(cell)) continue;
      const f = titleFacts(text);
      if (f) facts.push({ r: cell.r, cell: cell.at, sheet: sheet.name, text, facts: f, raw: cell });
    }
    const recs = readOfferTables(sheet, ledger, facts, regions);
    const blks = [...tts.map((b) => readBlock(sheet, ledger, facts, b, b.grid ? sectionOf(sheet, b, blockCells) : null, { below: belowOf.get(b), noted })), ...across.blocks.map((b) => readBlock(across.view, ledger, facts, b, null, { below: belowOf.get(b), noted }))];
    const vals = sums.flatMap((g) => readSummary(sheet, ledger, facts, g));
    const sheetLine = sheetLineOf(sheet);
    for (const r of recs) records.push({ ...r, sheetLine });
    for (const b of blks) blocks.push({ ...b, sheetLine });
    for (const s of vals) summaries.push({ ...s, sheetLine });
    for (const f of facts) if (f.facts.line != null && !wbLines.has(String(f.facts.line))) wbLines.set(String(f.facts.line), { value: f.facts.line, sheet: sheet.name, cell: f.cell, text: f.text });
    if (sheetLine && !wbLines.has(String(sheetLine.value))) wbLines.set(String(sheetLine.value), sheetLine);
    // The titles that named something are read; the rest of the sheet is said.
    for (const f of facts) if (!ledger.isDone(sheet, f.raw)) ledger.label(sheet, f.raw, "title");
    for (const cell of sheet.cells) {
      if (ledger.isDone(sheet, cell)) continue;
      const bad = unreadable(cell);
      if (!bad && isComment(cell)) ledger.skip(sheet, cell, "comment", { redact: comments.get(cell.c).author && cell.r > comments.get(cell.c).from });
      else ledger.skip(sheet, cell, bad || "not_recognised");
    }
    const kinds = [recs.length && "offer", blks.length && "timetable", vals.length && "summary"].filter(Boolean);
    layouts.set(sheet.name, kinds.length > 1 ? "mixed" : kinds[0] || "none");
  }
  const lines = buildModel(records, blocks, ledger, sheetsByName, summaries, wbLines.size === 1 ? [...wbLines.values()][0] : null);
  const unread = ledger.unread.slice(0, MAX_UNREAD);
  const sheets = wb.sheets.map((s) => {
    const states = s.cells.map((c) => ledger.state.get(`${s.name}!${c.at}`));
    return { name: s.name, layout: layouts.get(s.name), cells: s.cells.length, read: states.filter((x) => x === "read").length, unread: states.filter((x) => x && x !== "read").length, ...(unsure.has(s.name) ? { unsure: unsure.get(s.name) } : {}) };
  });
  return { file: { name: String(name).slice(0, 200), format: wb.format }, lines, unread, labels: ledger.labels, sheets, ...(ledger.unread.length > MAX_UNREAD ? { unread_truncated: ledger.unread.length - MAX_UNREAD } : {}) };
};

/**
 * The aggregates of a parse (what eval/tools/spreadsheet-check prints): never a value, only counts —
 * `timetables_unsure` the timetables left unread because their orientation is not certain (when there are some).
 */
const aggregatesOf = (model) => {
  const reasons = {};
  for (const u of model.unread) reasons[u.reason] = (reasons[u.reason] || 0) + 1;
  const dayTypes = model.lines.reduce((n, l) => n + l.day_types.length, 0);
  const bands = model.lines.reduce((n, l) => n + l.day_types.reduce((m, d) => m + d.bands.length, 0), 0);
  const timetables = model.lines.reduce((n, l) => n + l.day_types.filter((d) => d.timetable).length, 0);
  const notSure = model.sheets.reduce((n, s) => n + (s.unsure || 0), 0);
  return { sheets: model.sheets.length, layouts: model.sheets.map((s) => s.layout), lines: model.lines.length, day_types: dayTypes, bands, timetables, ...(notSure ? { timetables_unsure: notSure } : {}), cells: model.sheets.reduce((n, s) => n + s.cells, 0), read: model.sheets.reduce((n, s) => n + s.read, 0), unread: model.unread.length + (model.unread_truncated || 0), unread_by_reason: reasons };
};

module.exports = { parseWorkbook, aggregatesOf, headerRole, titleFacts, MAX_LINES, MAX_TRIPS, _internals: { colName } };
