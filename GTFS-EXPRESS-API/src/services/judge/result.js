/** One clause's verdict, in the shape every check returns. */

"use strict";

// located_by: the weakest authority a place of the clause rests on; baseline: what a relational
// clause compared with ("before" the plan, or "self", the measured feed itself).
const result = (clause, status, { expected = null, measured = null, lines = [], stops = [], note = null, located_by = null, places = null, measured_on = null, unsupported = false, grid = null, baseline = null } = {}) => ({
  id: clause.id,
  kind: clause.kind,
  level: clause.level,
  text: clause.text || null,
  params: clause.params,
  status,
  expected,
  measured,
  anchors: { lines, stops },
  ...(note ? { note } : {}),
  ...(located_by ? { located_by } : {}),
  ...(places ? { places } : {}),
  ...(measured_on && measured_on.length ? { measured_on } : {}),
  ...(grid ? { grid } : {}),
  ...(baseline ? { baseline } : {}),
  ...(unsupported ? { unsupported: true } : {}),
});

const missingLine = (c) => result(c, "fail", { expected: `line ${c.params.line}`, measured: "no such line" });

module.exports = { result, missingLine };
