/**
 * The attribution list of the demand inputs, merged by id so a source feeding
 * several layers is listed once with all of them.
 */

"use strict";

const addSource = (draft, source) => {
  if (!draft || !source || !source.id) return;
  const prev = draft.sources.get(source.id);
  const used = [...new Set([...(prev?.used_for || []), ...(source.used_for || [])])];
  draft.sources.set(source.id, { id: source.id, name: source.name, url: source.url || null, license: source.license || null, used_for: used });
};

/** A layer no longer built from these sources: drop the use, and the source once it has none. */
const dropUse = (draft, ids, layer) => {
  for (const id of ids) {
    const s = draft.sources.get(id);
    if (!s) continue;
    const used = (s.used_for || []).filter((u) => u !== layer);
    if (used.length) draft.sources.set(id, { ...s, used_for: used });
    else draft.sources.delete(id);
  }
};

module.exports = { addSource, dropUse };
