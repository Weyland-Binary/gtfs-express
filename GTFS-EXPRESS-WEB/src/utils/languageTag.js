/**
 * A language tag as the server takes it and as the validator reads it (Java's Locale.Builder.setLanguageTag): a
 * well-formed BCP 47 tag, whatever its case, or one of the irregular tags registered before that grammar. The same
 * rule as the API's fieldValidators.isValidLanguageCode, held to the same verdicts (fixtures/languageTags.json).
 */
const IRREGULAR = new Set([
  "en-gb-oed", "i-ami", "i-bnn", "i-default", "i-enochian", "i-hak", "i-klingon", "i-lux", "i-mingo", "i-navajo",
  "i-pwn", "i-tao", "i-tay", "i-tsu", "sgn-be-fr", "sgn-be-nl", "sgn-ch-de",
]);
const ALPHA_RE = /^[A-Za-z]+$/;
const ALPHANUM_RE = /^[A-Za-z0-9]+$/;
const DIGITS_RE = /^[0-9]+$/;
// eslint-disable-next-line no-control-regex
const TRIM_RE = /^[\x00-\x20]+|[\x00-\x20]+$/g;

const isWellFormed = (tag) => {
  if (IRREGULAR.has(tag.toLowerCase())) return true;
  const parts = tag.split("-");
  let i = 0;
  const is = (re, min, max) => i < parts.length && parts[i].length >= min && parts[i].length <= max && re.test(parts[i]);
  if (is(ALPHA_RE, 2, 8)) {
    i += 1;
    for (let extlangs = 0; extlangs < 3 && is(ALPHA_RE, 3, 3); extlangs += 1) i += 1;
    if (is(ALPHA_RE, 4, 4)) i += 1;
    if (is(ALPHA_RE, 2, 2) || is(DIGITS_RE, 3, 3)) i += 1;
    while (is(ALPHANUM_RE, 5, 8) || (is(ALPHANUM_RE, 4, 4) && DIGITS_RE.test(parts[i][0]))) i += 1;
    while (is(ALPHA_RE, 1, 1) && parts[i].toLowerCase() !== "x") {
      i += 1;
      if (!is(ALPHANUM_RE, 2, 8)) return false;
      while (is(ALPHANUM_RE, 2, 8)) i += 1;
    }
  }
  if (i < parts.length && parts[i].toLowerCase() === "x") {
    i += 1;
    if (!is(ALPHANUM_RE, 1, 8)) return false;
    while (is(ALPHANUM_RE, 1, 8)) i += 1;
  }
  return i === parts.length;
};

export const isLanguageTag = (value) => {
  if (typeof value !== "string") return false;
  const read = value.replace(TRIM_RE, "");
  return read !== "" && isWellFormed(read);
};
