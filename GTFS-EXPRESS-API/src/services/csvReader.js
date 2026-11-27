/**
 * A CSV file's rows (a GTFS file's, or an attached table's with its own separator) read from its text as it streams,
 * line by line. RFC 4180 when the file is well formed; when it is not, a double quote never swallows what follows it:
 *  - a quote is special only when it opens a cell: anywhere else it is text;
 *  - in a quoted cell "" is one quote, a quote followed by a separator or a line end closes the cell, and a quote
 *    followed by anything else is text;
 *  - a quoted cell runs over several lines only when it is well formed: one that holds a quote of text and does not
 *    close on its line was no quoted cell, and is read as written from its opening quote;
 *  - a quoted cell still open at the end of the file, or longer than any cell is, refuses the file with the line it
 *    opens on.
 * The line end is the file's first one (LF, CRLF or CR). A row keeps, under QUOTED, the keys of its cells that were
 * written between quotes: what the import reads of a file's way of quoting. A column whose header cell is empty is a
 * column still: it is keyed by its place (namelessKey), so its values are read and two of them never share a key.
 */

"use strict";

const { refusal } = require("./refusal");
const { validatorTrim } = require("../utils/validatorTrim");

const QUOTE = 34;
const CR = 13;
const LF = 10;

// Past the text one quoted cell holds: the validator reads 4 096 characters a cell, so no feed it can read comes near.
const MAX_OPEN_CHARS = 1024 * 1024;

/** On a row (or, with `records`, on its cells): the keys (the indexes) of the cells written between quotes; absent when none was. */
const QUOTED = Symbol("quotedCells");

// A symbol the row does not list: a row compares, copies and serialises as its cells alone.
const noteQuoted = (cells) => {
  if (cells[QUOTED] === undefined) Object.defineProperty(cells, QUOTED, { value: [] });
  cells[QUOTED].push(cells.length);
};

// The key of a column whose header cell is empty: a space, then the cell's index. The names are read trimmed, so no
// name a file writes is such a key; it is not the key of a cell past the header ("_<index>"), and not a number, which
// an object lists before its other keys whatever the order they were set in.
const NAMELESS = /^ \d+$/;
const namelessKey = (index) => ` ${index}`;
const isNameless = (key) => typeof key === "string" && NAMELESS.test(key);
/** The index of the header cell a nameless key stands for. */
const namelessIndex = (key) => Number(key.slice(1));

// A column under one of these names would write to the row object's prototype: it is not kept.
const UNSAFE_NAMES = new Set(["__proto__", "constructor", "prototype"]);

const unclosedQuote = (file, line) =>
  refusal(422, "UNCLOSED_QUOTE", `${file || "The file"}: the double quote opened on line ${line} is never closed, so the rest of the file would be read as one value.`, {
    files: file ? [file] : [],
    line,
  });

/**
 * createCsvReader({ file, separator, records }) → { write(text), end(), header }. `write` and `end` answer the rows the
 * text completed, each an object keyed by the header's trimmed names (a column without a name by namelessKey): a short
 * row carries only the cells it has, a cell past the header is keyed "_<index>", a blank line is {}. `header` is null
 * until the first line is read, `headWritten` the names written otherwise than as they are read. `file` names
 * the file in a refusal; `separator` is one character, a comma unless given; with `records` every line is answered as
 * its cells, the first one too, and no header is read.
 */
const createCsvReader = ({ file = null, separator = ",", records = false, maxOpenChars = MAX_OPEN_CHARS } = {}) => {
  const separatorCode = separator.charCodeAt(0);
  let eol = 0; // LF or CR once the file's first line end is read
  let pending = []; // the pieces of a line whose end is not read yet
  let pendingCr = false; // the text read so far ends on a CR, the first line end still undecided
  let lineNo = 0;
  let keys = null;
  // The header's names its file wrote otherwise than as they are read: { name: [text, quoted] }.
  let headWritten = null;
  let rows = [];
  // A quoted cell running past its line: the cells before it, its text so far, and the lines read since, to read them
  // again if it turns out to be no quoted cell.
  let open = null;
  // Lines to read again, the next one last.
  const again = [];

  const emit = (cells) => {
    if (records) {
      rows.push(cells);
      return;
    }
    if (keys === null) {
      keys = cells.map((name, c) => {
        const trimmed = name.trim();
        // The validator trims a name of U+0020 and below (Java's trim): a control character alone names no column either.
        return trimmed === "" || validatorTrim(name) === "" ? namelessKey(c) : UNSAFE_NAMES.has(trimmed) ? null : trimmed;
      });
      const quotedNames = new Set(cells[QUOTED]);
      keys.forEach((key, c) => {
        const quoted = quotedNames.has(c);
        if (key === null || (!quoted && cells[c] === key)) return;
        if (headWritten === null) headWritten = {};
        headWritten[key] = [cells[c], quoted ? 1 : 0];
      });
      return;
    }
    const row = {};
    const n = cells.length;
    const named = n < keys.length ? n : keys.length;
    for (let c = 0; c < named; c++) {
      const key = keys[c];
      if (key !== null) row[key] = cells[c];
    }
    for (let c = named; c < n; c++) row[`_${c}`] = cells[c];
    const quoted = cells[QUOTED];
    if (quoted !== undefined) Object.defineProperty(row, QUOTED, { value: quoted.map((c) => (c < keys.length ? keys[c] : `_${c}`)).filter((key) => key !== null) });
    rows.push(row);
  };

  const lineEndOf = (cr) => (eol === CR ? "\r" : cr ? "\r\n" : "\n");

  /**
   * The cells of `line` from `from`, added to `cells`; null when a quoted cell runs past the line (`open` then holds
   * it). The cell starting at `plainAt` is read as written, whatever it starts with.
   */
  const scan = (line, cr, from, cells, plainAt) => {
    const n = line.length;
    let i = from;
    // From the first quote of a run of quotes, a search for a closing quote goes on as every search that reached it.
    // Once one search has gone to the line's end without a close (from the quote at `walkedFrom`, its last quote of
    // text at `walkedLiteral`), a later one ends at the first such quote past it: else a line of cells each holding a
    // quote of text costs its cells times its length.
    let walkedFrom = -1;
    let walkedLiteral = -1;
    for (;;) {
      if (i < n && i !== plainAt && line.charCodeAt(i) === QUOTE) {
        let value = "";
        let segment = i + 1;
        let k = i + 1;
        let literal = false;
        let lastLiteral = -1;
        let end = -1;
        for (;;) {
          const q = line.indexOf('"', k);
          if (q === -1) {
            if (literal && walkedFrom === -1) {
              walkedFrom = i;
              walkedLiteral = lastLiteral;
            }
            break;
          }
          if (walkedFrom !== -1 && q > walkedFrom && line.charCodeAt(q - 1) !== QUOTE && (literal || walkedLiteral >= q)) {
            literal = true;
            break;
          }
          const next = q + 1 < n ? line.charCodeAt(q + 1) : -1;
          if (next === QUOTE) {
            value += line.substring(segment, q + 1);
            segment = k = q + 2;
          } else if (next === separatorCode || next === -1) {
            value += line.substring(segment, q);
            end = q + 1;
            break;
          } else {
            literal = true;
            lastLiteral = q;
            k = q + 1;
          }
        }
        if (end !== -1) {
          noteQuoted(cells);
          cells.push(value);
          if (end >= n) return cells;
          i = end + 1;
          continue;
        }
        if (!literal) {
          open = { cells, value: value + line.substring(segment) + lineEndOf(cr), line: lineNo, first: line, firstCr: cr, at: i, held: [], chars: n - i };
          return null;
        }
      }
      const cellEnd = line.indexOf(separator, i);
      if (cellEnd === -1) {
        cells.push(line.substring(i));
        return cells;
      }
      cells.push(line.substring(i, cellEnd));
      i = cellEnd + 1;
    }
  };

  /** A line read while a quoted cell is open: it closes the cell, carries it on, or shows it was no quoted cell. */
  const carryOn = (line, cr) => {
    const o = open;
    o.held.push({ line, cr });
    o.chars += line.length + 1;
    if (o.chars > maxOpenChars) throw unclosedQuote(file, o.line);
    const n = line.length;
    let segment = 0;
    let k = 0;
    for (;;) {
      const q = line.indexOf('"', k);
      if (q === -1) {
        o.value += line.substring(segment) + lineEndOf(cr);
        return;
      }
      const next = q + 1 < n ? line.charCodeAt(q + 1) : -1;
      if (next === QUOTE) {
        o.value += line.substring(segment, q + 1);
        segment = k = q + 2;
        continue;
      }
      open = null;
      if (next === separatorCode || next === -1) {
        noteQuoted(o.cells);
        o.cells.push(o.value + line.substring(segment, q));
        const cells = next === -1 ? o.cells : scan(line, cr, q + 2, o.cells, -1);
        if (cells) emit(cells);
        return;
      }
      // A quote of text in a cell that has run over a line: its lines are read again, its opening quote as text.
      for (let h = o.held.length - 1; h >= 0; h--) again.push(o.held[h]);
      lineNo = o.line;
      const cells = scan(o.first, o.firstCr, o.at, o.cells, o.at);
      if (cells) emit(cells);
      return;
    }
  };

  const read = (line, cr) => {
    lineNo++;
    if (open) return carryOn(line, cr);
    if (line.indexOf('"') === -1) return emit(line === "" ? [] : line.split(separator));
    const cells = scan(line, cr, 0, [], -1);
    if (cells) emit(cells);
    return undefined;
  };

  const take = (line, cr) => {
    read(line, cr);
    while (again.length > 0) {
      const held = again.pop();
      read(held.line, held.cr);
    }
  };

  /** A whole line, its end left out: in a file of LF line ends the CR before one goes with it. */
  const takeWhole = (text) => {
    if (eol === LF && text.length > 0 && text.charCodeAt(text.length - 1) === CR) take(text.substring(0, text.length - 1), true);
    else take(text, false);
  };

  const write = (text) => {
    rows = [];
    if (text.length === 0) return rows;
    let from = 0;
    if (eol === 0) {
      if (pendingCr) {
        // The line end the last text stopped in: CR LF over two texts, else a CR alone.
        pendingCr = false;
        eol = text.charCodeAt(0) === LF ? LF : CR;
        if (eol === CR) {
          const line = pending.join("");
          pending = [];
          take(line.substring(0, line.length - 1), false);
        }
      } else {
        const first = text.search(/[\r\n]/);
        if (first === -1) {
          if (text.length > 0) pending.push(text);
          return rows;
        }
        if (text.charCodeAt(first) === LF) eol = LF;
        else if (first + 1 < text.length) eol = text.charCodeAt(first + 1) === LF ? LF : CR;
        else {
          pending.push(text);
          pendingCr = true;
          return rows;
        }
      }
    }
    const mark = eol === CR ? "\r" : "\n";
    for (;;) {
      const at = text.indexOf(mark, from);
      if (at === -1) break;
      if (pending.length > 0) {
        pending.push(text.substring(from, at));
        const line = pending.join("");
        pending = [];
        takeWhole(line);
      } else if (eol === LF && at > from && text.charCodeAt(at - 1) === CR) take(text.substring(from, at - 1), true);
      else take(text.substring(from, at), false);
      from = at + 1;
    }
    if (from < text.length) pending.push(from === 0 ? text : text.substring(from));
    return rows;
  };

  const end = () => {
    rows = [];
    if (pending.length > 0) {
      const line = pending.join("");
      pending = [];
      pendingCr = false;
      // The last line may end on a CR alone, whatever the file's line end.
      if (eol !== CR && line.charCodeAt(line.length - 1) === CR) take(line.substring(0, line.length - 1), eol === LF);
      else take(line, false);
    }
    if (open) throw unclosedQuote(file, open.line);
    return rows;
  };

  return {
    write,
    end,
    get header() {
      return keys;
    },
    get headWritten() {
      return headWritten;
    },
  };
};

module.exports = { createCsvReader, MAX_OPEN_CHARS, QUOTED, namelessKey, isNameless, namelessIndex };
