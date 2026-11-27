"use strict";

const SPACE = /\s/;

/**
 * The shape of an e-mail address, as the expression every check used before reads it (emailShape.test.js compares
 * them): one at after at least one character, no space (\s), and after the at a dot with a character on each side.
 * Indices, not that expression: it retries the part after the at from every dot, minutes for a megabyte.
 */
const isEmailShaped = (text) => {
  const at = text.indexOf("@");
  if (at < 1 || at !== text.lastIndexOf("@") || SPACE.test(text)) return false;
  const dot = text.indexOf(".", at + 2);
  return dot !== -1 && dot < text.length - 1;
};

module.exports = { isEmailShaped };
