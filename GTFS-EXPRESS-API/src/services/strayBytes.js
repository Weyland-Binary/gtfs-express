/**
 * A UTF-8 text holding a few bytes that are not UTF-8 (a value pasted from a Windows tool, a character cut by a
 * column's width): the text stays UTF-8 and each such byte alone is read as its Windows-1252 character, so no byte is
 * lost and no accent around it is touched.
 */

"use strict";

const STRAYS_ENCODING = "utf-8-strays";

// Windows-1252 is Latin-1 but for the 32 bytes 0x80 to 0x9F, decoded here by its own table: some Node releases'
// TextDecoder("windows-1252") drop those characters (œ, €, ’, – lost on 24.11).
const CP1252_HIGH = "\u20AC\u0081\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u008D\u017D\u008F\u0090\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u009D\u017E\u0178";
// A thread is handed its bytes as a plain Uint8Array.
const bufferOf = (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
/** Bytes read as Windows-1252: every byte is one character, so a chunk decodes alone. */
const decodeWindows1252 = (bytes) => bufferOf(bytes).toString("latin1").replace(/[\x80-\x9F]/g, (c) => CP1252_HIGH[c.charCodeAt(0) - 0x80]);
const windows1252Char = (byte) => (byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80] : String.fromCharCode(byte));

/**
 * The length of the well-formed UTF-8 sequence that the byte at `i`, 0x80 or more, starts (2 to 4); 0 when it starts
 * none (overlong forms, surrogates and code points past U+10FFFF are none, as for the platform's decoder); -1 when
 * `end` comes inside a sequence well formed so far.
 */
const sequenceAt = (bytes, i, end) => {
  const lead = bytes[i];
  let length;
  let low = 0x80;
  let high = 0xbf;
  if (lead >= 0xc2 && lead <= 0xdf) length = 2;
  else if (lead >= 0xe0 && lead <= 0xef) {
    length = 3;
    if (lead === 0xe0) low = 0xa0;
    else if (lead === 0xed) high = 0x9f;
  } else if (lead >= 0xf0 && lead <= 0xf4) {
    length = 4;
    if (lead === 0xf0) low = 0x90;
    else if (lead === 0xf4) high = 0x8f;
  } else return 0;
  for (let k = 1; k < length; k++) {
    if (i + k >= end) return -1;
    const next = bytes[i + k];
    if (next < (k === 1 ? low : 0x80) || next > (k === 1 ? high : 0xbf)) return 0;
  }
  return length;
};

/**
 * A reader of such a text by chunks: `write(chunk)` and `end()` answer the text read, a sequence cut by a chunk's
 * edge waiting for its other bytes; `sequences` counts the characters of several bytes and `strays` the bytes that
 * belong to none. With `text: false` nothing is decoded: the two counts alone, which say what a file is.
 */
const strayDecoder = ({ text = true } = {}) => {
  let carry = null;
  const state = { sequences: 0, strays: 0 };
  const run = (bytes, last) => {
    let out = "";
    let from = 0;
    let i = 0;
    const end = bytes.length;
    while (i < end) {
      if (bytes[i] < 0x80) {
        i++;
        continue;
      }
      const length = sequenceAt(bytes, i, end);
      if (length > 0) {
        state.sequences++;
        i += length;
        continue;
      }
      if (length === -1 && !last) break;
      if (text) out += (i > from ? bytes.toString("utf8", from, i) : "") + windows1252Char(bytes[i]);
      state.strays++;
      i++;
      from = i;
    }
    if (text && i > from) out += bytes.toString("utf8", from, i);
    // Copied: the chunk it was cut from belongs to its stream.
    carry = i < end ? Buffer.from(bytes.subarray(i)) : null;
    return out;
  };
  state.write = (chunk) => run(carry ? Buffer.concat([carry, chunk]) : bufferOf(chunk), false);
  state.end = () => (carry ? run(carry, true) : "");
  return state;
};

/**
 * What a text that failed the strict UTF-8 decode is, from its two counts: UTF-8 holding stray bytes when its
 * characters of several bytes outnumber them, else a text of one byte a character (Windows-1252), where a pair of
 * accented letters may happen to look like one UTF-8 character.
 */
const isUtf8WithStrays = ({ sequences, strays }) => sequences > strays;

module.exports = { STRAYS_ENCODING, decodeWindows1252, strayDecoder, isUtf8WithStrays };
