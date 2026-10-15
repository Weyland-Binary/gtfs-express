/**
 * aliases — renamed translation keys, old → new; `t()` resolves an old name
 * through this table. It stays empty (languageContext.test.js checks it): a
 * rename moves the code and the eight language blocks in one change, because
 * scripts/i18n-check.js does not read this file and reports a `t("old")`
 * whose key is not in translations.js as missing. A key a screen says in its
 * own words (« Appliquer… », « Concevoir avec l'assistant »…) is a key of its
 * own in translations.js, never an alias of a key that says something else.
 */

const ALIASES = Object.freeze({});

export default ALIASES;
