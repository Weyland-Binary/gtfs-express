"use strict";

/**
 * A value as the MobilityData validator reads it: Java's String.trim, which drops the characters up to the space
 * (U+0000 to U+0020) at both ends and keeps every other space, so never String.prototype.trim. Two indices, not an
 * expression: one anchored at the end retries from every character of a run inside the value, minutes for a megabyte.
 */
const validatorTrim = (text) => {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 32) start += 1;
  while (end > start && text.charCodeAt(end - 1) <= 32) end -= 1;
  return start === 0 && end === text.length ? text : text.slice(start, end);
};

module.exports = { validatorTrim };
