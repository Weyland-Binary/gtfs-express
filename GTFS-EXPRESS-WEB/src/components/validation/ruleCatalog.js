/**
 * What a rule's code says by itself: its page on the validator's site, and a name to show until the catalogue (the
 * server's titles, validation/ruleTexts) has answered or for a code it does not hold.
 */

export const CANONICAL_RULES_BASE =
  "https://gtfs-validator.mobilitydata.org/rules.html";

const NOTICE_CODE = /^[a-z][a-z0-9_]*$/;

/** "my_rule_code" → "My Rule Code". */
export function humanizeRuleCode(code) {
  if (!code || code === "__ungrouped__") return "Uncategorized findings";
  return code
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function getRuleTitle(ruleCode) {
  return humanizeRuleCode(ruleCode);
}

// The validator's HTML report links each notice to rules.html#<code>-rule: the same anchor here.
export function getRuleDocUrl(ruleCode) {
  if (!ruleCode || !NOTICE_CODE.test(ruleCode)) return CANONICAL_RULES_BASE;
  return `${CANONICAL_RULES_BASE}#${ruleCode}-rule`;
}
