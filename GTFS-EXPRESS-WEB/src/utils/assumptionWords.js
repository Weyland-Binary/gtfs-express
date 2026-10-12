/**
 * assumptionWords — the plan's assumptions in the reader's words.
 *
 * What a change plan carries as assumptions comes from three writers: the
 * planner (its own sentences, in the person's language), the engine (the
 * questions it settled by itself, in the person's language) and the server's
 * contract (services/contract/contractService.pendingAssumptionsOf), whose
 * sentences are English: « Not measurable, to check by hand, not checked:
 * « … » » for a requirement nobody can measure, « Assumption of the
 * contract, not confirmed: … », « Contract not decided by a person: assumed
 * by … ». Each of those carries what it is (`kind`, with its `quote` or
 * `by`); a plan that kept only their text still says it in the sentence
 * itself. A French note printed them as they were (2026-10-07: thirteen
 * English lines in the note of a delivered package): they are told here in
 * the reader's language, by what they are, never by their English words
 * (common/AcknowledgementForm reads the same sentences for the delivery's
 * acknowledgement).
 *
 * A question the engine settled by itself (`auto`, or kind "engine") is
 * said as its choice, as the acknowledgement says it.
 *
 *   assumptionSaid(a)       → { said: "wish", quote, why } | { said: "contract_assumption", words }
 *                             | { said: "contract_assumed", by } | { said: "engine", text } | { said: "text", text }
 *   assumptionWords(a, t)   → the sentence in the reader's language
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
  // The engine's own answer to a question it settled (written in the person's language): said as its choice.
  if (kind === "engine" || (a && typeof a === "object" && a.auto && typeof a.auto === "object")) return { said: "engine", text };
  return { said: "text", text };
};

/** The assumption as one sentence in the reader's language (the acknowledgement's words for the server's own). */
export const assumptionWords = (a, t) => {
  const s = assumptionSaid(a);
  if (s.said === "wish") return `${t("ack.wish", { quote: s.quote })}${s.why ? ` (${s.why})` : ""}`;
  if (s.said === "contract_assumption") return t("ack.contractAssumption", { text: s.words });
  if (s.said === "contract_assumed") return t("ack.contractAssumed", { name: s.by });
  if (s.said === "engine") return t("ack.engineChoice", { text: s.text });
  return s.text;
};
