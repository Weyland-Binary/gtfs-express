/**
 * aliases — the keys renamed by the target design (§16.2), old → new: empty.
 *
 * The screens were rewritten lot by lot, each one moving its own keys while
 * both names worked (`t()` resolves an old name through this table). The
 * last lot (WP11) moved the last screens to the new keys, dropped the old
 * keys from the eight language blocks and emptied the table; a key a screen
 * still says in its own words (« Appliquer… », « Concevoir avec
 * l'assistant »…) is a key of its own in translations.js, never an alias of
 * a key that says something else. scripts/i18n-check.js does not read this
 * file: a `t("old")` whose key is not in translations.js is reported
 * missing, so a rename moves the code and the eight blocks in one change and
 * this table stays empty (languageContext.test.js checks it).
 */

const ALIASES = Object.freeze({});

export default ALIASES;
