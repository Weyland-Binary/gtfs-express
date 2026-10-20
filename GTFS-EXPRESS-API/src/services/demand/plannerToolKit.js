/**
 * plannerToolKit — the frame of the Network Studio's demand tools
 * (network/plannerDemandTools: a spec on a territory — estimate_demand,
 * optimize_service, generate_scenarios, adopt_scenario): the compute gate and
 * the figures' form.
 *
 *   fmt(v)                        a figure for the model: "n/a", else rounded
 *                                 with en grouping
 *   inputsSummary(inputs)         the inputs block of a "demand" event
 *   gatedToolSet(computing, plain) { definitions, byName } of a planner's
 *                                 tool set, the computing tools run behind
 *                                 withGate: they share the server's demand
 *                                 slots with the HTTP endpoints (a BUSY error
 *                                 tells the model to try later)
 */

"use strict";

const { withGate } = require("./computeGate");

const fmt = (v) => (v == null ? "n/a" : Math.round(v).toLocaleString("en"));

const inputsSummary = (inputs) => ({ totals: inputs.totals, quality: inputs.quality, sources: inputs.sources, warnings: inputs.warnings });

const gated = (tool) => ({ ...tool, run: (input) => withGate(() => tool.run(input)) });

const gatedToolSet = (computing, plain = []) => {
  const tools = [...computing.map(gated), ...plain];
  return { definitions: tools.map((t) => t.definition), byName: Object.fromEntries(tools.map((t) => [t.definition.name, t])) };
};

module.exports = { fmt, inputsSummary, gatedToolSet };
