"use strict";

const bodyParser = require("body-parser");
const { refusal } = require("../services/refusal");

const MB = 1024 * 1024;
// No object or list our bodies carry (a shape's point, a departure, an hour of a sheet) takes fewer bytes; a body of
// empty ones takes 3 bytes each and about 64 of heap once parsed, twenty times what it weighs.
const BYTES_PER_CONTAINER = 16;
const MAX_DEPTH = 64;
// JSON.parse gives each sequence of keys its hidden class, from a root per count of keys under 128 (more: a
// dictionary); a class followed by more keys than V8 keeps transitions for (1 536) has each later object build its own.
const MAX_SHAPES = 16384;
const MAX_NEXT_KEYS = 64;
const DICTIONARY_KEYS = 128;
// A key written as an array index is an element of its object, outside its class; one far from 0 makes the object's
// elements a dictionary, about 230 bytes an object. Our bodies carry none.
const MAX_INDEX_KEYS = 4096;

const tooLarge = (maxMb, message) => refusal(413, "BODY_TOO_LARGE", message, { max_mb: maxMb });

/** What a large body of `maxMb` may hold, before JSON.parse builds it. */
const limitsOf = (maxMb) => ({ containers: Math.floor((maxMb * MB) / BYTES_PER_CONTAINER), depth: MAX_DEPTH, shapes: MAX_SHAPES, nextKeys: MAX_NEXT_KEYS, indexKeys: MAX_INDEX_KEYS });

// A quote closes its text unless an odd run of backslashes escapes it.
const escaped = (buf, at) => {
  let backslashes = 0;
  while (buf[at - 1 - backslashes] === 0x5c) backslashes += 1;
  return backslashes % 2 === 1;
};

const SHORT_ESCAPES = new Map([
  [0x22, '"'],
  [0x5c, "\\"],
  [0x2f, "/"],
  [0x62, "\b"],
  [0x66, "\f"],
  [0x6e, "\n"],
  [0x72, "\r"],
  [0x74, "\t"],
]);
const hexDigit = (c) => (c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x61 && c <= 0x66 ? c - 0x57 : c >= 0x41 && c <= 0x46 ? c - 0x37 : -1);

/**
 * The text JSON.parse reads between two quotes, its escapes decoded as it decodes them (a lone surrogate stays itself,
 * where a UTF-8 encoder would put U+FFFD); null for an escape it refuses.
 */
const textOf = (buf, start, end) => {
  let text = "";
  let from = start;
  for (let j = start; j < end; ) {
    if (buf[j] !== 0x5c) {
      j += 1;
      continue;
    }
    if (j > from) text += buf.toString("utf8", from, j);
    const c = buf[j + 1];
    if (c === 0x75) {
      if (j + 6 > end) return null;
      let unit = 0;
      for (let k = j + 2; k < j + 6; k += 1) {
        const digit = hexDigit(buf[k]);
        if (digit < 0) return null;
        unit = unit * 16 + digit;
      }
      text += String.fromCharCode(unit);
      j += 6;
    } else {
      const short = SHORT_ESCAPES.get(c);
      if (short === undefined) return null;
      text += short;
      j += 2;
    }
    from = j;
  }
  if (from === start) return buf.toString("utf8", start, end);
  return from < end ? text + buf.toString("utf8", from, end) : text;
};

const isIndex = (text) => {
  const length = text.length;
  if (length < 1 || length > 10 || (length > 1 && text.charCodeAt(0) === 0x30)) return false;
  let value = 0;
  for (let j = 0; j < length; j += 1) {
    const digit = text.charCodeAt(j) - 0x30;
    if (digit < 0 || digit > 9) return false;
    value = value * 10 + digit;
  }
  return value < 4294967295;
};

const LIST = 0;
const OBJECT = 1;
const DICTIONARY = 2;

/**
 * Throws BODY_TOO_LARGE when a JSON text in UTF-8 opens more objects and lists than `limits.containers`, nests past
 * `limits.depth`, or would have JSON.parse build more hidden classes (and dictionary keys) than `limits.shapes`, one class
 * followed by more than `limits.nextKeys` keys, or more than `limits.indexKeys` elements. Keys are told apart by the
 * text JSON.parse reads of them (`"\u0039"` is 9, `"\ud800"` and `"\ud801"` two keys).
 */
const checkStructure = (buf, limits, maxMb) => {
  let containers = 0;
  let shapes = 0;
  let indexKeys = 0;
  const roots = new Map();
  const next = [];
  const dictionaryKeys = new Set();
  // By depth: the open container's kind, an object's keys as read (kept until it closes and their count is known), and
  // those of the last object closed there, which the next one most often repeats.
  const kinds = [];
  const keys = [];
  const starts = [];
  const ends = [];
  const counts = [];
  const lastKeys = [];
  const lastStarts = [];
  const lastEnds = [];
  const lastCounts = [];
  const same = [];
  let depth = 0;
  const shape = () => {
    shapes += 1;
    if (shapes > limits.shapes) throw tooLarge(maxMb, `The body's objects take more than ${limits.shapes} shapes.`);
  };
  const looseKey = (key) => {
    if (dictionaryKeys.has(key)) return;
    dictionaryKeys.add(key);
    shape();
  };
  const built = (objectKeys, count) => {
    let at = roots.get(count);
    if (at === undefined) {
      at = next.push(null) - 1;
      roots.set(count, at);
    }
    for (let k = 0; k < count; k += 1) {
      let after = next[at];
      if (after === null) {
        after = new Map();
        next[at] = after;
      }
      let to = after.get(objectKeys[k]);
      if (to === undefined) {
        if (after.size >= limits.nextKeys) throw tooLarge(maxMb, `The body's objects follow one shape with more than ${limits.nextKeys} keys.`);
        shape();
        to = next.push(null) - 1;
        after.set(objectKeys[k], to);
      }
      at = to;
    }
  };
  // The last object's key at this place when this one is written with the same bytes: its text, decoded once.
  const repeatedKey = (d, start, end) => {
    const at = counts[d];
    if (at >= lastCounts[d]) return undefined;
    const from = lastStarts[d][at];
    const length = end - start;
    if (lastEnds[d][at] - from !== length) return undefined;
    for (let j = 0; j < length; j += 1) if (buf[from + j] !== buf[start + j]) return undefined;
    return lastKeys[d][at];
  };
  const open = (kind) => {
    containers += 1;
    if (containers > limits.containers) throw tooLarge(maxMb, `The body holds more than ${limits.containers} objects and lists.`);
    if (depth >= limits.depth) throw tooLarge(maxMb, `The body nests more than ${limits.depth} levels deep.`);
    kinds[depth] = kind;
    if (kind === OBJECT) {
      if (keys[depth] === undefined) {
        keys[depth] = [];
        starts[depth] = [];
        ends[depth] = [];
        lastKeys[depth] = [];
        lastStarts[depth] = [];
        lastEnds[depth] = [];
        lastCounts[depth] = 0;
      }
      counts[depth] = 0;
      same[depth] = true;
    }
    depth += 1;
  };
  const closeObject = (d) => {
    const own = keys[d];
    const count = counts[d];
    if (!same[d] || count !== lastCounts[d]) built(own, count);
    keys[d] = lastKeys[d];
    lastKeys[d] = own;
    const from = starts[d];
    starts[d] = lastStarts[d];
    lastStarts[d] = from;
    const to = ends[d];
    ends[d] = lastEnds[d];
    lastEnds[d] = to;
    lastCounts[d] = count;
  };
  // No byte of a UTF-8 multibyte character equals a quote, a backslash, a bracket or a colon.
  for (let i = 0; i < buf.length; i += 1) {
    const c = buf[i];
    if (c === 0x22) {
      let end = buf.indexOf(0x22, i + 1);
      while (end > 0 && escaped(buf, end)) end = buf.indexOf(0x22, end + 1);
      // A text never closed: JSON.parse refuses the body, building nothing that is still open.
      if (end < 0) return;
      const kind = depth > 0 ? kinds[depth - 1] : LIST;
      if (kind !== LIST) {
        let j = end + 1;
        while (buf[j] === 0x20 || buf[j] === 0x0a || buf[j] === 0x0d || buf[j] === 0x09) j += 1;
        if (buf[j] === 0x3a) {
          const d = depth - 1;
          const repeated = kind === OBJECT ? repeatedKey(d, i + 1, end) : undefined;
          const text = repeated === undefined ? textOf(buf, i + 1, end) : repeated;
          // An escape JSON.parse cannot read: it refuses the body, building nothing that is still open.
          if (text === null) return;
          if (repeated === undefined && isIndex(text)) {
            indexKeys += 1;
            if (indexKeys > limits.indexKeys) throw tooLarge(maxMb, `The body's objects hold more than ${limits.indexKeys} keys written as numbers.`);
          } else if (kind === DICTIONARY) looseKey(text);
          else {
            const at = counts[d];
            if (at >= lastCounts[d] || lastKeys[d][at] !== text) same[d] = false;
            keys[d][at] = text;
            starts[d][at] = i + 1;
            ends[d][at] = end;
            counts[d] = at + 1;
            if (at + 1 >= DICTIONARY_KEYS) {
              for (let k = 0; k <= at; k += 1) looseKey(keys[d][k]);
              kinds[d] = DICTIONARY;
            }
          }
        }
      }
      i = end;
    } else if (c === 0x7b) open(OBJECT);
    else if (c === 0x5b) open(LIST);
    else if (c === 0x7d || c === 0x5d) {
      if (depth === 0) continue;
      depth -= 1;
      if (c === 0x7d && kinds[depth] === OBJECT) closeObject(depth);
    }
  }
};

/**
 * The JSON parser of a route that reads more than the 1 MB default: its bytes as sent (a compressed body is refused,
 * never inflated), in UTF-8, what JSON.parse would build of it counted first.
 */
const largeJson = (maxMb) => {
  const limits = limitsOf(maxMb);
  return bodyParser.json({
    limit: maxMb * MB,
    inflate: false,
    verify: (req, res, buf, encoding) => {
      if (encoding !== "utf-8") throw Object.assign(new Error(`unsupported charset "${String(encoding).toUpperCase()}"`), { status: 415, type: "charset.unsupported" });
      checkStructure(buf, limits, maxMb);
    },
  });
};

/** A body parser's own refusal of a body over its limit, typed as ours with that limit. */
const bodyRefusalOf = (err) => (err && err.type === "entity.too.large" && Number.isFinite(err.limit) ? tooLarge(Math.round(err.limit / MB), `The body is over this route's ${Math.round(err.limit / MB)} MB.`) : err);

module.exports = { largeJson, bodyRefusalOf, _internals: { checkStructure, limitsOf, BYTES_PER_CONTAINER, MAX_DEPTH, MAX_SHAPES, MAX_NEXT_KEYS, MAX_INDEX_KEYS } };
