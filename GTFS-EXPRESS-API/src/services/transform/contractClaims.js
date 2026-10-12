/**
 * contractClaims — what a change planner's answer says it did to the CONTRACT, which no tool of the model can do
 * (the Albi end-to-end test of 2026-10-07: asked « voulez-vous les corriger ? » and told yes, the model answered
 * « j'ai reformulé les objectifs avec le sens modifié » — the contract never changed, and the same false failures were
 * signed at the delivery). The planner proposes corrections (propose_clause_corrections) and the person applies them
 * under their name; a sentence claiming the change was made is struck in the answer like the verdict's own
 * contradictions (prose.spans, reason "claims_contract_change"), never a retry of the model.
 *
 * Striking a true sentence would be a defect of its own (the review of 2026-10-07: « Pour tenir l'objectif c3,
 * l'horaire a été modifié » was struck), so a claim is read by its grammar, the clause word at its head, and then
 * against the record:
 *   - "active": the model in the first person (« j'ai », « nous avons », "I", "we"), a verb that rewrites or removes,
 *     then the clause word with nothing but
 *     determiners, the person's possessives or numbers between them (« j'ai reformulé les objectifs », « J'ai corrigé
 *     l'objectif c7 », "I updated your requirements") — never « j'ai modifié deux courses pour tenir l'objectif c5 »,
 *     « j'ai changé de stratégie pour l'objectif c3 », nor « mes objectifs » (the model's own clauses);
 *   - "passive": the clause word as the subject, at the start of a sentence or of a clause, with its ids or a short
 *     complement (« de la ligne F »), then « a / ont été <verbe> » agreeing in number, nothing else between
 *     (« Les objectifs de la ligne F ont été reformulés », "Objective c7 has been replaced") — never « Pour tenir
 *     l'objectif c3, l'horaire a été modifié », nor a passive with its agent (« … par vous »);
 *   - "colon": a heading naming clauses, then a participle (« Objectifs D et C : reformulés … »).
 * A sentence that proposes the change or leaves it to the person (« proposé », « une fois que vous les aurez
 * appliquées », "once you apply") claims nothing, nor does a repair verb beside a failure (« j'ai corrigé les
 * objectifs non tenus en ajoutant des courses »: the plan made to hold them).
 * Against the record (`contract`, `plan`, `written`): a contract without clauses holds nothing the model cannot change;
 * a claim naming only clauses of the model's own plan is true (it refines them with patch_plan), and so may be a
 * general one when the turn wrote clauses of its own and none of the contract's (none of them saying again, under
 * another id, what a clause of the contract says of the same line); a passive naming clauses the person
 * corrected or set aside, or a general one once the person changed some, may say the person's own act (corrections
 * applied) — none of them is struck. A claim in the first person is struck whatever the person did: the model never
 * changes a clause of the contract itself.
 *
 *   candidatesOf(text) → [{ start, end, text, form: "active" | "passive" | "colon", ids }]: the grammar alone
 *   contractClaimSpans(text, { contract, plan, written }) → [{ start, end, text, reason: "claims_contract_change" }]
 *     `written`: { own: Set, contract: Set } — the clause ids the turn's set_plan / patch_plan wrote, its own and the
 *     contract's (which the merge returned whole)
 *   withContractClaims(prose, text, context) → the verdict's reading (verdict.contradictionsOf) with them struck too:
 *     claims_contract_change and contradicts set, the spans merged in order (the first reason wins an overlap)
 * French and English, like the verdict's own detector (services/verdict). Every run of spaces the grammar reads is
 * bounded (S, S0): a text of long blank runs is read in linear time.
 */

"use strict";

// A word in either case at its first letter (it may open the sentence): "Objectifs", "objectifs".
const cap = (w) => `[${w[0].toUpperCase()}${w[0]}]${w.slice(1)}`;
const anyOf = (words) => words.map(cap).join("|");
const WEND = "(?![\\p{L}\\p{N}_])";
const S = "\\s{1,6}";
const S0 = "\\s{0,6}";

// Verbs that rewrite or remove a clause: French past participles (agreeing or not), English past forms.
const FR_PART = `(?:(?:reformul|remplac|modifi|rectifi|chang|supprim|retir|corrig|ajust|adapt|révis|actualis|écart|annul|enlev|remani|invers)é(?:e|s|es)?|réécrit(?:e|s|es)?|redéfini(?:e|s|es)?|mis(?:e|es)?${S}à${S}jour)`;
const EN_PART = "(?:reformulated|rewritten|rewrote|rephrased|replaced|modified|updated|changed|amended|removed|dropped|deleted|corrected|fixed|adjusted|adapted|revised|edited|redefined|discarded|dismissed|waived|inverted|reversed)";
// The verbs that also say a failing clause was made to hold by the plan (« corriger un objectif non tenu »).
const REPAIR = /^(?:corrig|rectifi|corrected|fixed)/i;

// Between the verb and the clause word, or before a subject: determiners, the person's possessives, numbers — never
// a preposition (« de stratégie pour », "trips to meet") nor the model's own (« mes », "my").
const FR_DET = `(?:(?:${anyOf(["les", "le", "la", "vos", "votre", "ces", "cet", "cette", "ce", "tous", "toutes", "chaque", "certains", "certaines", "plusieurs", "des", "autres", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze"])}|\\d{1,3})${S}|[Ll]['’](?:ensemble${S}des${S})?|[Dd]['’]autres${S})`;
const EN_DET = `(?:(?:${anyOf(["the", "your", "these", "those", "this", "that", "all", "both", "some", "several", "other", "each", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"])}|\\d{1,3})${S}|[Aa]ll${S}of${S}(?:the|your)${S})`;
const FR_SG = `(?:${anyOf(["objectif", "exigence", "clause", "contrat"])})`;
const FR_PL = `(?:${anyOf(["objectifs", "exigences", "clauses", "contrats"])})`;
const EN_SG = `(?:${anyOf(["objective", "requirement", "clause", "contract"])})`;
const EN_PL = `(?:${anyOf(["objectives", "requirements", "clauses", "contracts"])})`;

// The ids a claim names after its clause word: a clause id (c7, c2_v2, other_lines_unchanged), a line (F, S1, 12A).
const ID = `(?:[A-Z]{1,3}\\d{0,3}|[A-Za-z]{0,4}\\d[\\p{L}\\p{N}_-]{0,24}|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)${WEND}`;
const IDS = `${ID}(?:(?:${S0},${S0}|${S}(?:et|and|&)${S})${ID}){0,12}`;
// A short complement of the clause word: its line, direction or grid.
const FR_COMPL = `(?:de${S}la|du|des|pour${S}la|pour${S}les|sur${S}la)${S}(?:lignes?|sens|directions?|grilles?|périodes?|journées?)(?:${S}${IDS})?`;
const EN_COMPL = `(?:of|for|on)${S}(?:the${S})?(?:lines?|directions?|routes?|grids?)(?:${S}${IDS})?`;
const FR_TAIL = `${WEND}(?:${S}(?<ids>${IDS}))?(?:${S}${FR_COMPL})?`;
const EN_TAIL = `${WEND}(?:${S}(?<ids>${IDS}))?(?:${S}${EN_COMPL})?`;

// Where a subject starts: the text, a sentence, a clause (after a comma or a conjunction), a list item.
const CONJ = anyOf(["et", "mais", "puis", "donc", "enfin", "ensuite", "alors", "ainsi", "oui", "aussi", "également", "and", "but", "so", "then", "also", "yes"]);
const START = `(?<=(?:^|[.!?;:,()\\n•])${S0}|(?:^|\\n)${S0}[-–—]${S}|(?:^|[\\s(])(?:${CONJ})${S})`;
// The passive's auxiliaries, agreeing with the subject; never followed by its agent (« par vous », "by you").
const FR_AUX_SG = `${S}a${S}(?:(?:bien|donc|aussi|également|déjà|ainsi)${S})?été${S}(?:(?:bien|également|aussi|ainsi)${S})?`;
const FR_AUX_PL = `${S}ont${S}(?:(?:bien|donc|aussi|également|déjà|ainsi|tous|toutes)${S})?été${S}(?:(?:bien|également|aussi|ainsi|tous|toutes)${S})?`;
const EN_AUX_SG = `${S}(?:has${S}(?:(?:now|also|already|just)${S})?been|was)${S}(?:(?:also|now)${S})?`;
const EN_AUX_PL = `${S}(?:have${S}(?:(?:now|also|already|just|all)${S})?been|were)${S}(?:(?:also|now|all)${S})?`;
const NO_AGENT = `(?!${S}(?:par|by)${WEND})`;
const COLON = `${S0}:${S0}`;

const PATTERNS = [
  { form: "active", re: `(?<![\\p{L}\\p{N}])(?:[Jj]['’]ai|[Nn]ous${S}avons)${S}(?:(?:bien|donc|également|aussi|déjà|ensuite|alors|enfin|finalement|d['’]abord)${S})?(?<verb>${FR_PART})${WEND}${S}(?:${FR_DET}){0,4}(?:${FR_PL}|${FR_SG})${FR_TAIL}` },
  { form: "active", re: `(?<![\\p{L}\\p{N}])(?:I|[Ww]e)(?:['’]ve|${S}have)?${S}(?:(?:also|now|already|then|just|therefore)${S})?(?<verb>${EN_PART})${WEND}${S}(?:${EN_DET}){0,4}(?:${EN_PL}|${EN_SG})${EN_TAIL}` },
  { form: "passive", re: `${START}(?:${FR_DET}){0,4}${FR_SG}${FR_TAIL}${FR_AUX_SG}(?<verb>${FR_PART})${WEND}${NO_AGENT}` },
  { form: "passive", re: `${START}(?:${FR_DET}){0,4}${FR_PL}${FR_TAIL}${FR_AUX_PL}(?<verb>${FR_PART})${WEND}${NO_AGENT}` },
  { form: "passive", re: `${START}(?:${EN_DET}){0,4}${EN_SG}${EN_TAIL}${EN_AUX_SG}(?<verb>${EN_PART})${WEND}${NO_AGENT}` },
  { form: "passive", re: `${START}(?:${EN_DET}){0,4}${EN_PL}${EN_TAIL}${EN_AUX_PL}(?<verb>${EN_PART})${WEND}${NO_AGENT}` },
  { form: "colon", re: `${START}(?:${FR_DET}){0,4}(?:${FR_PL}|${FR_SG})${FR_TAIL}${COLON}(?:(?:bien|tous|toutes)${S})?(?<verb>${FR_PART})${WEND}${NO_AGENT}` },
  { form: "colon", re: `${START}(?:${EN_DET}){0,4}(?:${EN_PL}|${EN_SG})${EN_TAIL}${COLON}(?:(?:all|now)${S})?(?<verb>${EN_PART})${WEND}${NO_AGENT}` },
].map((p) => ({ form: p.form, re: new RegExp(p.re, "gu") }));

// A sentence that proposes the change, or leaves it to the person, claims nothing.
const PROPOSES = /propos|(?<!\p{L})(?:si|quand|lorsque|dès que|dès lors que|après que|une fois que) vous|une fois (?:appliqu|accept|valid)|vous (?:les |l['’]|la |le )?(?:avez|aurez) (?:appliqu|accept|valid)|à (?:appliquer|accepter|valider)|en attente|(?<!\p{L})(?:if|once|when|after) you(?!\p{L})|(?<!\p{L})you(?: have|['’]ve)? (?:applied|accepted|approved)|pending|awaiting|to (?:apply|accept|approve)/iu;
// A failure beside a repair verb: the plan was made to hold the clause, the clause itself is the same.
const FAILURE = /non\s+tenu|pas\s+tenu|en\s+échec|échou|manqu|non\s+respect|not\s+met|unmet|failing|failed|fails/i;

// The sentence around [start, end): from the last end of sentence before it to the next one after it (600 characters
// at most on each side: a sentence is never longer than that in an answer).
const SENTENCE_REACH = 600;
const sentenceOf = (text, start, end) => {
  let a = start;
  while (a > 0 && start - a < SENTENCE_REACH && !/[.!?\n]/.test(text[a - 1])) a -= 1;
  let b = end;
  while (b < text.length && b - end < SENTENCE_REACH && !/[.!?\n]/.test(text[b])) b += 1;
  return text.slice(a, b);
};

/** The claims the grammar reads (see the header), in the order of the text, one per place (the first form wins). */
const candidatesOf = (raw) => {
  const original = String(raw || "");
  // Markdown emphasis and code marks read as spaces (the offsets stay those of the text): « **J'ai reformulé** les ».
  const text = original.replace(/[*`]/g, " ");
  const out = [];
  for (const { form, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (out.some((c) => start < c.end && c.start < end)) continue;
      const sentence = sentenceOf(text, start, end);
      if (PROPOSES.test(sentence)) continue;
      if (REPAIR.test(m.groups?.verb || "") && FAILURE.test(sentence)) continue;
      const ids = m.groups?.ids ? m.groups.ids.split(/\s*,\s*|\s+(?:et|and|&)\s+/).map((s) => s.trim()).filter(Boolean) : [];
      out.push({ start, end, text: original.slice(start, end), form, ids });
    }
  }
  return out.sort((a, b) => a.start - b.start);
};

/** The claims of a changed contract the record says are false (see the header). */
const contractClaimSpans = (text, { contract = null, plan = null, written = null } = {}) => {
  const own = (Array.isArray(contract?.clauses) ? contract.clauses : []).filter((c) => c && typeof c === "object" && c.id != null);
  if (!own.length) return [];
  const key = (id) => String(id).toLowerCase();
  const ofContract = new Map(own.map((c) => [key(c.id), c]));
  const ofPlan = new Set((plan?.requirements?.clauses || []).map((c) => (c && c.id != null ? key(c.id) : null)).filter((id) => id && !ofContract.has(id)));
  // What the person changed themself (set aside at ② or by applying a correction, corrected at ②): a passive may say it.
  const byPerson = (c) => c.status === "waived" || c.decision?.action === "waive" || c.decision?.action === "correct";
  const personChanged = own.some(byPerson);
  // The turn wrote clauses of its own and tried none of the contract's: « j'ai ajusté les exigences » may be true —
  // unless one of them says again what a clause of the contract says of the same line (a contract's objective
  // rewritten under another id: the person's own still stands as decided, the claim is about it).
  const lineOf = (c) => JSON.stringify(c?.params?.line ?? c?.params?.lines ?? null).toLowerCase();
  const ownWritten = (plan?.requirements?.clauses || []).filter((c) => c && c.id != null && written?.own?.has?.(c.id));
  const shadows = ownWritten.some((o) => own.some((c) => c.kind === o.kind && lineOf(c) === lineOf(o)));
  const wroteOwn = Boolean(written?.own?.size) && !written?.contract?.size && !shadows;
  return candidatesOf(text)
    .filter((k) => {
      const named = k.ids.map(key).filter((id) => ofContract.has(id));
      const mine = k.ids.map(key).filter((id) => ofPlan.has(id));
      if (named.length) return k.form === "active" || named.some((id) => !byPerson(ofContract.get(id)));
      if (mine.length || wroteOwn) return false;
      return k.form === "active" || !personChanged;
    })
    .map((k) => ({ start: k.start, end: k.end, text: k.text, reason: "claims_contract_change" }));
};

/** The verdict's reading of the answer (verdict.contradictionsOf) with its claims of a changed contract struck too. */
const withContractClaims = (prose, text, context = {}) => {
  const claims = contractClaimSpans(text, context);
  if (!claims.length) return prose;
  const t = String(text || "");
  // Sorted, an overlap merged into the span before it (the first reason wins), as the verdict's own spans are.
  const spans = [];
  for (const s of [...(prose?.spans || []), ...claims].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = spans[spans.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
      last.text = t.slice(last.start, last.end);
    } else spans.push({ ...s });
  }
  return { ...prose, claims_contract_change: true, contradicts: true, spans };
};

module.exports = { candidatesOf, contractClaimSpans, withContractClaims, _internals: { PATTERNS, PROPOSES, FAILURE, sentenceOf } };
