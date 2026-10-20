/**
 * directActivity — what the agent and the reviewer do during a turn of the direct mode, as the person reads it: one
 * line per act in the product's own words (never the model's text: a purpose or an intent it wrote is not shown),
 * the same act repeated folded into one line with its count, and the counts of the turn (reads, writes, checks).
 *
 *   activityOf(prev, step) → { items: [{ id, key, icon, params, times }], counts: { reads, writes, checks } }
 *
 * `step` is a `step` event of POST /transform/direct: { kind, by, documents?, document?, tool?, feed?, findings? }.
 */

export const EMPTY_ACTIVITY = Object.freeze({ items: [], counts: { reads: 0, writes: 0, checks: 0 }, seq: 0 });
// The lines kept: the screen shows the last few, the rest is only counted.
const KEPT = 6;

/** The line an act reads as: its words' key, its icon, its words' parameters; null for a step that is no act. */
export const actOf = (step) => {
  const by = step?.by === "reviewer" ? "reviewer" : "agent";
  switch (step?.kind) {
    case "reading":
      if (step.document) return { key: "direct.activity.sheet", icon: "sheet", count: "reads" };
      return Array.isArray(step.documents) && step.documents.length ? { key: "direct.activity.documents", icon: "brief", params: { count: step.documents.length }, plural: true } : { key: "direct.activity.brief", icon: "brief" };
    case "querying":
      if (step.tool === "dates") return { key: "direct.activity.dates", icon: "dates", count: "reads" };
      if (by === "reviewer") return { key: step.feed === "before" ? "direct.activity.readBefore" : "direct.activity.readAfter", icon: "compare", count: "reads" };
      return { key: "direct.activity.query", icon: "query", count: "reads" };
    case "writing":
      return { key: "direct.activity.write", icon: "write", count: "writes" };
    case "measuring":
      return { key: by === "reviewer" ? "direct.activity.measure" : "direct.activity.selfCheck", icon: "check", count: "checks" };
    case "reviewing":
      return { key: "direct.activity.review", icon: "review" };
    case "correcting":
      return { key: "direct.activity.correct", icon: "write", params: { count: Math.max(1, Number(step.findings) || 1) }, plural: true };
    default:
      return null;
  }
};

/** The turn's activity after one more step. */
export const activityOf = (prev, step) => {
  const was = prev || EMPTY_ACTIVITY;
  const act = actOf(step);
  if (!act) return was;
  const counts = act.count ? { ...was.counts, [act.count]: was.counts[act.count] + 1 } : was.counts;
  const last = was.items[was.items.length - 1];
  // The same act again (a run of reads): one line, its count growing.
  if (last && last.key === act.key && JSON.stringify(last.params || null) === JSON.stringify(act.params || null)) {
    return { ...was, counts, items: [...was.items.slice(0, -1), { ...last, times: last.times + 1 }] };
  }
  const seq = was.seq + 1;
  return { seq, counts, items: [...was.items, { id: seq, key: act.key, icon: act.icon, params: act.params || null, plural: Boolean(act.plural), times: 1 }].slice(-KEPT) };
};
