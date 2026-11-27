"use strict";

const fs = require("fs");
const path = require("path");

/**
 * A state file written whole or not at all: to a file beside it, then renamed over it. Written in place, a disk that
 * fills between the truncation and the write leaves an empty file, which the next read takes for no state.
 */
const writeJsonAtomic = (file, value) => {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
};

/** The file's value, or null when there is no file. A file that is there and cannot be read is an error, never « no state ». */
const readJsonIfThere = (file) => {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error(`${path.basename(file)} cannot be read: it is kept as it is.`), { code: "STATE_UNREADABLE", status: 500 });
  }
};

module.exports = { writeJsonAtomic, readJsonIfThere };
