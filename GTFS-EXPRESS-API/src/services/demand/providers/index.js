/**
 * providers — the public data that upgrades the demand inputs, in stages
 * (see inputs.js: a stage runs after the previous one, its providers side
 * by side). Each provider is { id, label, stage, countries, fallback,
 * run(draft, ctx) }; it commits its layer in one synchronous step at the
 * end and throws when its service is down (the builder turns that into a
 * warning, the layer keeping its previous source).
 *
 *   stage 0  communes    official communes of the box (FR)           → ctx.communes
 *            worldwide   elsewhere: says which layers stay estimates
 *   stage 1  population  INSEE 200 m grid, else commune populations (FR)
 *            sirene      jobs from SIRENE establishments (FR)
 *            education   schools and enrolments (FR)
 *            mobpro      commuting flows from the INSEE files (FR)
 *
 * Outside France the dossier's layers stand. The hook for a worldwide
 * population grid (GHSL, WorldPop) is the `worldwide` entry: a provider
 * implementing it would take its place with countries: null.
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
