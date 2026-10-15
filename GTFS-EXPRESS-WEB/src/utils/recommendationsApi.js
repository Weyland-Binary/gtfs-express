/**
 * recommendationsApi — the measured diagnosis of the open network and the
 * recommendations it supports (the API's transform/recommendations, no
 * model): the modify job's ② when the person wants to improve the offer.
 *
 *   fetchRecommendations({ place, dataIds, lang, signal })
 *     POST /transform/recommendations → { diagnostic, recommendations, warnings, basis }
 *     rejects with the server's refusal (refusalToAction.readRefusal)
 *
 *   clausesOf(recommendation)        the contract clauses a recommendation adds, marked with its id
 *   isRetained(contract, id)         whether the contract holds a recommendation's clauses
 *   withRecommendation(contract, r, { name })    its clauses added, decided kept under the name
 *   withoutRecommendation(contract, id)          its clauses removed
 *   briefOf(recommendations, t)      the sentences ③'s planner starts from (the person reads and sends them)
 *
 * Every figure is the server's: the web adds nothing to a measure.
 */

import API_BASE_URL from "../config";
import { fetchWithSession } from "./sessionManager";
import { readRefusal } from "./refusalToAction";
import { addClause } from "./contract";

export const fetchRecommendations = async ({ place = null, dataIds = [], lang = "fr", signal } = {}) => {
  const res = await fetchWithSession(`${API_BASE_URL}/transform/recommendations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(place ? { place } : {}), ...(dataIds.length ? { dataIds } : {}), lang }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw await readRefusal(res);
  return res.json();
};

// A recommendation's clauses carry its id (`source`), so that retaining it again or setting it aside finds them.
const SOURCE = "recommendation";
const clauseId = (rid, cid, i) => `r_${String(rid).replace(/[^A-Za-z0-9_-]/g, "_")}_${cid || i + 1}`;

export const clausesOf = (r) => (Array.isArray(r?.clauses) ? r.clauses : []).map((c, i) => ({ ...c, id: clauseId(r.id, c.id, i), level: c.level || "must", source: { kind: SOURCE, id: r.id } }));

export const isRetained = (contract, id) => (contract?.clauses || []).some((c) => c?.source?.kind === SOURCE && c.source.id === id);

export const withoutRecommendation = (contract, id) => ({ ...contract, clauses: (contract?.clauses || []).filter((c) => !(c?.source?.kind === SOURCE && c.source.id === id)) });

export const withRecommendation = (contract, r, { name = null } = {}) => clausesOf(r).reduce((acc, clause) => addClause(acc, clause, { name }), withoutRecommendation(contract, r.id));

/** The ids of the recommendations the contract holds, in the contract's order. */
export const retainedIds = (contract) => [...new Set((contract?.clauses || []).filter((c) => c?.source?.kind === SOURCE).map((c) => c.source.id))];

/** ③'s first message: one line per retained recommendation, in the person's words (its title). */
export const briefOf = (retained, titleOf) => retained.map((r) => `- ${titleOf(r)}`).join("\n");
