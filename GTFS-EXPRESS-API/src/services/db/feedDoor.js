/**
 * What the door says of a feed folder before anything of it is validated or imported: the files that cannot be read as
 * the tables they name, for a cause the person can act on (the file written in UTF-16, its columns separated by
 * semicolons or tabs, its column names in another case than the specification's, a column named twice). Without it
 * such a file reaches the import as a table with no key column and the feed is refused for a required field it does
 * hold, or as a table whose column holds the values of the second of two written under its name.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { refusal } = require("../refusal");
const { TABLE_MAP } = require("./feedImport");
const { KEY_COLUMNS } = require("../../utils/importPolicy");

// A header fits in it; the file is not read further.
const HEAD_BYTES = 8192;

const headOf = (file) => {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    return head.subarray(0, fs.readSync(fd, head, 0, HEAD_BYTES, 0));
  } finally {
    fs.closeSync(fd);
  }
};

/** "UTF-16" or "UTF-32" by the file's mark, or by the zero bytes no UTF-8 text holds; null otherwise. */
const wideEncodingOf = (head) => {
  const [a, b, c, d] = head;
  if (head.length >= 4 && ((a === 0xff && b === 0xfe && c === 0 && d === 0) || (a === 0 && b === 0 && c === 0xfe && d === 0xff))) return "UTF-32";
  if (head.length >= 2 && ((a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff))) return "UTF-16";
  return head.subarray(0, 256).includes(0) ? "UTF-16" : null;
};

const namesOf = (line, separator) => line.split(separator).map((name) => name.trim().replace(/^"(.*)"$/, "$1").trim());

/**
 * Why `file` cannot be read as `table`: { cause: "encoding", encoding }, { cause: "semicolon" | "tab" },
 * { cause: "case", columns } or { cause: "duplicate", columns }. Null when its header reads as it is, or when nothing
 * of this kind explains it.
 */
const reasonOf = (file, { table, columns }) => {
  const head = headOf(file);
  const encoding = wideEncodingOf(head);
  if (encoding) return { cause: "encoding", encoding };
  const [line] = head.toString("utf8").replace(/^﻿/, "").split(/\r\n|\r|\n/, 1);
  const known = new Set(columns);
  const names = namesOf(line, ",");
  const asWritten = names.filter((name) => known.has(name));
  // A name only another case of a column's, the column itself absent.
  const otherCase = names.filter((name) => !known.has(name) && known.has(name.toLowerCase()) && !names.includes(name.toLowerCase()));
  const keys = KEY_COLUMNS[table] || [];
  if (otherCase.length > 0 && (asWritten.length === 0 || otherCase.some((name) => keys.includes(name.toLowerCase())))) return { cause: "case", columns: otherCase };
  // A name written twice, the file's own columns included: a row holds one value under a name, so the values of one
  // of the two would be lost, and the validator refuses the header.
  const twice = [...new Set(names.filter((name, i) => name !== "" && names.indexOf(name) !== i))];
  if (asWritten.length > 0) return twice.length > 0 ? { cause: "duplicate", columns: twice } : null;
  for (const [separator, cause] of [[";", "semicolon"], ["\t", "tab"]]) {
    const cells = namesOf(line, separator);
    if (cells.length > 1 && cells.some((name) => known.has(name.toLowerCase()))) return { cause };
  }
  return null;
};

const REFUSALS = [
  ["encoding", "UTF16_FILE", (files, found) => [`${files.join(", ")}: written in ${found[0].encoding}; a GTFS file is written in UTF-8.`, { encoding: found[0].encoding }]],
  ["semicolon", "SEMICOLON_SEPARATED", (files) => [`${files.join(", ")}: the columns are separated by semicolons; a GTFS file separates them with commas.`, {}]],
  ["tab", "TAB_SEPARATED", (files) => [`${files.join(", ")}: the columns are separated by tabs; a GTFS file separates them with commas.`, {}]],
  ["case", "HEADER_CASE", (files, found) => {
    const columns = [...new Set(found.flatMap((f) => f.columns))].slice(0, 8);
    return [`${files.join(", ")}: column names written in another case (${columns.join(", ")}); GTFS column names are lower case.`, { columns }];
  }],
  ["duplicate", "DUPLICATE_COLUMNS", (files, found) => {
    const columns = [...new Set(found.flatMap((f) => f.columns))].slice(0, 8);
    return [`${files.join(", ")}: a column is named twice (${columns.join(", ")}); a GTFS file names each of its columns once.`, { columns }];
  }],
];

/**
 * The refusal of a feed folder one of whose files cannot be read as its table: the first cause among the encoding, the
 * separator, the names' case and a name written twice, with every file it holds in `files`. Null when every file reads.
 */
const unreadableFeed = (directory) => {
  const found = [];
  for (const entry of TABLE_MAP) {
    const file = path.join(directory, `${entry.table}.txt`);
    if (!fs.existsSync(file)) continue;
    const reason = reasonOf(file, entry);
    if (reason) found.push({ file: `${entry.table}.txt`, ...reason });
  }
  for (const [cause, code, describe] of REFUSALS) {
    const held = found.filter((f) => f.cause === cause);
    if (held.length === 0) continue;
    const files = held.map((f) => f.file);
    const [message, details] = describe(files, held);
    return refusal(422, code, message, { files, ...details });
  }
  return null;
};

module.exports = { unreadableFeed };
