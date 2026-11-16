/**
 * How a source file was written, beyond its rows and its header: what the import reads of it so that every exit can
 * write the file back as it was (services/feedOut). Kept by file in _source_files.form, a key only where the file
 * departs from the writer's own way:
 *   blank     the columns whose presence alone speaks to the validator (gtfsCsvColumns OMIT_WHILE_EMPTY) that the
 *             file carried without a value in any row
 *   grouped   true when the file wrote the rows of each group together and in sequence (GROUPS: a trip's calls, a
 *             shape's points), which is what the validator calls sorted
 *   quoted    { column: "all" | "filled" }: the columns the file wrote between quotes where nothing asked for it,
 *             every cell of them, or every cell holding a value
 *   bare      the columns whose values with a space at either end the file wrote without quotes
 *   decimals  { column: n }: the columns held as numbers (DECIMAL_COLUMNS) that the file wrote with at least n
 *             decimals, zeros added where the number has fewer (48.850000)
 *   written   { column: { number: text } }: the numbers of such a column that the file wrote another way than that
 *             count gives (zeros the others lack, none where the others have them, a sign, a leading zero), when
 *             they are few
 *   eol       the file's line end when it is not LF: "\r\n" or "\r"
 *   bom       true when the file opens on a UTF-8 byte order mark
 *   unclosed  true when the file's last line has no line end
 */

"use strict";

const fs = require("fs");

const { OMIT_WHILE_EMPTY } = require("../gtfsCsvColumns");
const { QUOTED } = require("../csvReader");

/** The tables whose rows go by groups: [the column naming the group, the column ordering its rows]. */
const GROUPS = Object.freeze({ stop_times: Object.freeze(["trip_id", "stop_sequence"]), shapes: Object.freeze(["shape_id", "shape_pt_sequence"]) });

/**
 * The columns a table holds as numbers with decimals: of such a value the copy keeps the number, not its text, so
 * the count of decimals its file wrote is kept by column, with the few numbers written another way.
 */
const DECIMAL_COLUMNS = Object.freeze({
  stops: Object.freeze(["stop_lat", "stop_lon"]),
  shapes: Object.freeze(["shape_pt_lat", "shape_pt_lon", "shape_dist_traveled"]),
  levels: Object.freeze(["level_index"]),
  pathways: Object.freeze(["length", "max_slope", "min_width"]),
});

const isBlank = (value) => value === undefined || value === null || String(value).trim() === "";

const decimalsOf = (text) => {
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
};

/** The decimals `written` holds when it is the number's own text with zeros added after it; 0 when it is written any other way. */
const paddedDecimals = (written, text) => {
  if (typeof written !== "string" || written.length <= text.length || !written.startsWith(text) || text.includes("e")) return 0;
  return (text.includes(".") ? /^0+$/ : /^\.0+$/).test(written.slice(text.length)) ? decimalsOf(written) : 0;
};

/** A number's own text with zeros added up to `decimals` decimals: the same number, written as its file wrote its column. */
const withDecimals = (text, decimals) => {
  if (text.includes("e")) return text;
  const dot = text.indexOf(".");
  if (dot === -1) return /^-?\d+$/.test(text) ? `${text}.${"0".repeat(decimals)}` : text;
  const have = text.length - dot - 1;
  return have >= decimals ? text : text + "0".repeat(decimals - have);
};

/**
 * The count of decimals that gives back the most values of a column as written, 0 when adding none does: `padded[n]`
 * values were written with zeros added up to n decimals, `plain[n]` as the number's own text of n decimals.
 */
const decimalsFor = ({ plain, padded }) => {
  const zeroed = padded.reduce((sum, count) => sum + count, 0);
  let best = 0;
  let fewest = zeroed;
  padded.forEach((count, n) => {
    let missed = zeroed - count;
    for (let d = 0; d < n; d++) missed += plain[d] || 0;
    if (missed < fewest) {
      best = n;
      fewest = missed;
    }
  });
  return best;
};

// The distinct numbers a column may list as written another way: more of them written one way are that column's way,
// which a count gives back or nothing does.
const FEW = 256;

/** Notes `text` among the numbers written the way `key` names, until they are more than a few (the way is then null). */
const noteFew = (ways, key, text) => {
  const numbers = ways[key];
  if (numbers === undefined) ways[key] = new Set([text]);
  else if (numbers !== null && numbers.add(text).size > FEW) ways[key] = null;
};

/**
 * The numbers of a column the count `n` does not give back as its file wrote them, { number: text }: only a number
 * the file wrote one way, and none when they are more than a few.
 */
const writtenOtherwise = ({ few }, n) => {
  // By number, the text its file wrote it as: null once it wrote it two ways.
  const asFile = new Map();
  const note = (text, file) => asFile.set(text, asFile.has(text) && asFile.get(text) !== file ? null : file);
  few.plain.forEach((numbers) => {
    for (const text of numbers || []) note(text, text);
  });
  few.padded.forEach((numbers, decimals) => {
    for (const text of numbers || []) note(text, withDecimals(text, decimals));
  });
  for (const [text, file] of few.other || []) note(text, file);
  const listed = {};
  for (const [text, file] of asFile) if (file !== null && file !== (n > 0 ? withDecimals(text, n) : text)) listed[text] = file;
  const count = Object.keys(listed).length;
  return count > 0 && count <= FEW ? listed : null;
};

// What every writer puts between quotes whatever the file did: a quote, a separator or a line end in the value.
const MUST_QUOTE = /[",\r\n]/;

/** A space, or any character the validator's reader trims with it (Java's String.trim), at either end of a text that is not empty. */
const isPadded = (text) => text.charCodeAt(0) <= 32 || text.charCodeAt(text.length - 1) <= 32;

// A header fits in it many times over.
const HEAD_BYTES = 65536;
const LF = 0x0a;
const CR = 0x0d;

/**
 * How a file's text is laid out, read from its two ends: { eol, unclosed }, the line end its first line closes on (as
 * the reader decides it; null when no line end is in sight) and whether its last line is left without one.
 */
const layoutOfFile = (file) => {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    // One byte past the head tells a CR closing it from a CR LF cut in two.
    const head = Buffer.alloc(Math.min(size, HEAD_BYTES + 1));
    fs.readSync(fd, head, 0, head.length, 0);
    const first = [head.subarray(0, HEAD_BYTES).indexOf(LF), head.subarray(0, HEAD_BYTES).indexOf(CR)].filter((at) => at !== -1);
    const at = first.length > 0 ? Math.min(...first) : -1;
    const eol = at === -1 ? null : head[at] === LF ? "\n" : head[at + 1] === LF ? "\r\n" : "\r";
    const last = Buffer.alloc(1);
    const unclosed = size > 0 && fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== LF && last[0] !== CR;
    return { eol, unclosed };
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * Reads one file's form: `row(raw)` for each of its rows as read, loaded or not, `loaded(row, raw)` for each row its
 * table took (as loaded and as read), in the file's order, then `result(groupsOf)`, where `groupsOf(column)` counts
 * the groups the table holds. `layout` is what the file's bytes say, { bom, eol, unclosed }, when they were read.
 */
const formReader = (table, header, layout = null) => {
  let unfilled = (OMIT_WHILE_EMPTY[table] || []).filter((c) => header.includes(c));
  const group = GROUPS[table] && GROUPS[table].every((c) => header.includes(c)) ? GROUPS[table] : null;
  // The runs of rows naming one group, each in sequence: as many runs as groups when no group comes back later. Counted,
  // never listed: an id read from a file keeps the text it was cut from in memory.
  let inSequence = Boolean(group);
  let runs = 0;
  let current = null;
  let last = null;
  let rows = 0;
  // By column: the cells written between quotes (all, the empty ones, those nothing asked to quote), whether a cell
  // holding a value was written bare, and the padded values written bare, or between quotes for their spaces alone.
  const ways = header.map(() => ({ quoted: 0, quotedEmpty: 0, needless: 0, bareFilled: false, paddedBare: 0, paddedQuoted: 0 }));
  const wayOf = new Map(header.map((c, i) => [c, ways[i]]));
  // By column held as a number: the values written as the number's own text and with zeros added, counted by their
  // decimals, and the first few distinct numbers written each way.
  const numbers = (DECIMAL_COLUMNS[table] || []).filter((c) => header.includes(c)).map((column) => ({ column, plain: [], padded: [], few: { plain: [], padded: [], other: new Map() } }));
  return {
    row(raw) {
      rows++;
      if (unfilled.length > 0) unfilled = unfilled.filter((c) => isBlank(raw[c]));
      const quoted = raw[QUOTED];
      if (quoted !== undefined) {
        for (const c of quoted) {
          const way = wayOf.get(c);
          if (way === undefined) continue;
          const value = raw[c];
          way.quoted++;
          if (value === "") way.quotedEmpty++;
          else if (!MUST_QUOTE.test(value)) {
            if (isPadded(value)) way.paddedQuoted++;
            else way.needless++;
          }
        }
      }
      // A row's keys are its header's, in its order: the Map answers for the row that is not built so.
      let i = 0;
      for (const c in raw) {
        const way = c === header[i] ? ways[i] : wayOf.get(c);
        i++;
        const value = raw[c];
        if (way === undefined || typeof value !== "string" || value === "" || (quoted !== undefined && quoted.includes(c))) continue;
        if (!way.bareFilled) way.bareFilled = true;
        if (isPadded(value)) way.paddedBare++;
      }
    },
    loaded(row, raw) {
      for (const number of numbers) {
        const value = row[number.column];
        if (typeof value !== "number") continue;
        const text = String(value);
        const written = raw[number.column];
        if (written === text) {
          const n = decimalsOf(text);
          number.plain[n] = (number.plain[n] || 0) + 1;
          noteFew(number.few.plain, n, text);
          continue;
        }
        const n = paddedDecimals(written, text);
        if (n > 0) {
          number.padded[n] = (number.padded[n] || 0) + 1;
          noteFew(number.few.padded, n, text);
        } else if (number.few.other !== null && typeof written === "string") {
          // A text of its own, never a slice of the file's: a slice keeps the whole text it was cut from in memory.
          const had = number.few.other.get(text);
          number.few.other.set(text, had === undefined || had === written ? Buffer.from(written, "utf8").toString("utf8") : null);
          if (number.few.other.size > FEW) number.few.other = null;
        }
      }
      if (!inSequence) return;
      const id = row[group[0]];
      const sequence = row[group[1]];
      if (id !== current) {
        runs++;
        current = id;
      } else if (!(sequence > last)) inSequence = false;
      last = sequence;
    },
    result(groupsOf = null) {
      const grouped = inSequence && Boolean(groupsOf) && groupsOf(group[0]) === runs;
      const quoted = {};
      const bare = [];
      header.forEach((c, i) => {
        const way = ways[i];
        if (way.quoted === rows && way.quotedEmpty > 0) quoted[c] = "all";
        else if (!way.bareFilled && way.quotedEmpty === 0 && way.needless > 0) quoted[c] = "filled";
        else if (way.paddedBare > 0 && way.paddedQuoted === 0) bare.push(c);
      });
      const decimals = {};
      const written = {};
      for (const number of numbers) {
        const n = decimalsFor(number);
        if (n > 0) decimals[number.column] = n;
        const listed = writtenOtherwise(number, n);
        if (listed) written[number.column] = listed;
      }
      return {
        ...(unfilled.length > 0 ? { blank: unfilled } : {}),
        ...(grouped ? { grouped: true } : {}),
        ...(Object.keys(quoted).length > 0 ? { quoted } : {}),
        ...(bare.length > 0 ? { bare } : {}),
        ...(Object.keys(decimals).length > 0 ? { decimals } : {}),
        ...(Object.keys(written).length > 0 ? { written } : {}),
        ...(layout && layout.eol && layout.eol !== "\n" ? { eol: layout.eol } : {}),
        ...(layout && layout.bom ? { bom: true } : {}),
        ...(layout && layout.unclosed ? { unclosed: true } : {}),
      };
    },
  };
};

module.exports = { formReader, layoutOfFile, GROUPS, DECIMAL_COLUMNS, MUST_QUOTE, isPadded, withDecimals };
