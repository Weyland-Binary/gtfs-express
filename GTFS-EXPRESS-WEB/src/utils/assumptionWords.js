/**
 * assumptionWords — what an assumption of a contract is, in the reader's words.
 *
 * The server's contract (services/contract/contractService.pendingAssumptionsOf) writes the items a named person
 * accepts at the build as English sentences: « Not measurable, to check by hand, not checked: « … » » for a
 * requirement nobody can measure, « Assumption of the contract, not confirmed: … », « Contract not decided by a
 * person: assumed by … ». Each carries what it is (`kind`, with its `quote` or `by`); an item that kept only its text
 * still says it in the sentence itself. common/AcknowledgementForm tells them in the reader's language, by what they
 * are, never by their English words.
 *
 *   assumptionSaid(a)       → { said: "wish", quote, why } | { said: "contract_assumption", words }
 *                             | { said: "contract_assumed", by } | { said: "text", text }
 */

// The server's sentences (contractService: WISH_PREFIX, the unconfirmed assumption, ASSUMED_PREFIX).
export const WISH_TEXT = /^Not measurable, to check by hand, not checked: « (.*) »$/s;
const CONTRACT_ASSUMPTION_TEXT = /^Assumption of the contract, not confirmed: (.*)$/s;
const CONTRACT_ASSUMED_TEXT = /^Contract not decided by a person: assumed by (.*) \(the clauses were not reviewed one by one\)\.$/s;

const filled = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** What an assumption of the plan is (see the header): its kind first, else what its sentence says it is. */
export const assumptionSaid = (a) => {
  const text = typeof a === "string" ? a : String(a?.text ?? "");
  const kind = a && typeof a === "object" ? a.kind : null;
  const quote = kind === "wish" && typeof a.quote === "string" ? a.quote : (WISH_TEXT.exec(text) || [])[1] ?? null;
  if (quote !== null) return { said: "wish", quote, why: filled(a?.why) };
  const words = kind === "contract_assumption" && typeof a.quote === "string" ? a.quote : (CONTRACT_ASSUMPTION_TEXT.exec(text) || [])[1] ?? null;
  if (words !== null) return { said: "contract_assumption", words };
  const by = kind === "contract_assumed" && filled(a.by) ? a.by.trim() : (CONTRACT_ASSUMED_TEXT.exec(text) || [])[1] ?? null;
  if (by !== null) return { said: "contract_assumed", by };
  return { said: "text", text };
};
