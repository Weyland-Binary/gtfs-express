/**
 * The public data that upgrades the demand inputs, in stages: a stage runs
 * after the previous one, its providers side by side. A provider commits its
 * layer in one synchronous step at the end and throws when its service is
 * down; the builder turns that into a warning and the layer keeps its source.
 */

"use strict";

const { communesProvider } = require("./communes");
const { populationProvider } = require("./population");
const { sireneProvider } = require("./sirene");
const { educationProvider } = require("./education");
const { mobproProvider } = require("./mobpro");

const worldwideProvider = {
  id: "worldwide",
  label: "worldwide data",
  stage: 0,
  countries: null,
  run: async (draft, ctx) => {
    if (ctx.countryCode === "FR") return;
    draft.warnings.push(`official data: population by commune, jobs, schools and commuting flows are wired for France only${ctx.countryCode ? ` (this territory: ${ctx.countryCode})` : ""} — here the inputs are OpenStreetMap-based estimates plus your own data; a worldwide population grid (GHSL, WorldPop) is not implemented yet`);
  },
};

const PROVIDERS = [communesProvider, worldwideProvider, populationProvider, sireneProvider, educationProvider, mobproProvider];

module.exports = { PROVIDERS };
