/**
 * transformGolden.test.js — level 0 of the change-planner evaluation
 * (eval/transform/cases.js), on the real Albi feed: each case's reference
 * plan previews unblocked with integrity intact and passes every check of
 * the oracle; each mutant fails at least one — the oracle can tell a right
 * plan from a plausible wrong one. A case whose right answer is a question
 * (expect: "ask") has an empty reference: the feed must stay as it is.
 * Cases whose operators are not in the catalogue yet are skipped. Calendar
 * lookups (public and school holidays) go to a frozen service.
 */

"use strict";

const path = require("path");
const { loadReal } = require("./_helpers/feedDb");
const fm = require("../services/transform/feedModel");
const S = require("../services/transform/scope");
const registry = require("../services/transform/operators");
const { previewPlan, commitPreview } = require("../services/transform/engine");
const { CASES, lib, holidayWeekdays, frozenFetch, FEED } = require(path.join(__dirname, "../../../eval/transform/cases.js"));

const L = lib(fm, S);

// A plan's placeholders filled from the feed (the holiday dates the Albi feed itself encodes).
const materialize = (plan, before) => JSON.parse(JSON.stringify(plan).replace('"__HOLIDAY_WEEKDAYS__"', JSON.stringify(holidayWeekdays(before, L))));

const run = async (plan) => {
  const db = loadReal(FEED);
  const before = fm.buildFeedModel(db);
  const p = await previewPlan(db, materialize(plan, before), { sessionId: "golden", country: "FR", fetchImpl: frozenFetch(before, S, fm) });
  if (p.id && !p.blocked) commitPreview("golden", db, p.id);
  return { p, before, after: fm.buildFeedModel(db) };
};

for (const c of CASES) {
  const ready = (c.requires || []).every((t) => registry.get(t));
  (ready ? describe : describe.skip)(`golden: ${c.id}`, () => {
    test("the reference plan meets every check", async () => {
      const { p, before, after } = await run(c.reference);
      expect(p.steps.map((s) => `${s.id}:${s.status}${s.ambiguities.length ? ` ${s.ambiguities.map((a) => a.code).join(",")}` : ""}${s.error ? ` ${s.error}` : ""}`)).toEqual(c.reference.operations.map((o) => `${o.id}:applied`));
      expect(p.integrity).toEqual([]);
      const results = c.checks(L).map((k) => ({ id: k.id, ...k.run(before, after) }));
      expect(results.filter((r) => !r.ok)).toEqual([]);
    });
    for (const m of c.mutants) {
      test(`mutant ${m.id} is rejected`, async () => {
        const { p, before, after } = await run(m.plan);
        const blocked = p.blocked;
        const failed = c.checks(L).map((k) => ({ id: k.id, ...k.run(before, after) })).filter((r) => !r.ok);
        expect(blocked || failed.length > 0).toBe(true);
      });
    }
  });
}
