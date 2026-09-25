/**
 * networkGrounding.test.js — designing anywhere from everything available:
 * the country context (currency, languages, weekend, price level), works
 * and projects, place statistics, local weekends in the Network Spec,
 * operating costs in the local currency, and the specification documents
 * (PDF, Word, OpenDocument, text) the planner reads natively.
 */

"use strict";

process.env.NL2SQL_CHAT_ENABLED = "true";
process.env.ANTHROPIC_API_KEY = "test-key-sdk-is-mocked";
process.env.ALLOW_ANTHROPIC_IN_TESTS = "true";
process.env.BETA_GATE_DISABLED = "true";

jest.mock("@anthropic-ai/sdk", () => {
  const script = [];
  const captured = [];
  const makeStream = (params) => {
    captured.push({ ...params, messages: JSON.parse(JSON.stringify(params.messages)) });
    const next = script.shift() || { text: "(no script)" };
    const content = [];
    if (next.text) content.push({ type: "text", text: next.text });
    for (const tu of next.toolUses || []) content.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
    return {
      async *[Symbol.asyncIterator]() {
        if (next.text) yield { type: "content_block_delta", delta: { type: "text_delta", text: next.text } };
        yield { type: "message_delta", usage: { output_tokens: 3 } };
      },
      async finalMessage() {
        return { content, stop_reason: next.toolUses && next.toolUses.length ? "tool_use" : "end_turn", usage: { input_tokens: 10, output_tokens: 3 } };
      },
    };
  };
  class Anthropic {
    constructor() {
      this.messages = { stream: makeStream, create: async () => ({ content: [] }) };
    }
  }
  return { Anthropic, __script: script, __captured: captured };
});

const { __script, __captured } = require("@anthropic-ai/sdk");
const archiver = require("archiver");
const request = require("supertest");
const app = require("../app");
const country = require("../services/network/countryService");
const territory = require("../services/network/territoryService");
const ops = require("../services/network/operationsService");
const docs = require("../services/network/briefDocumentService");
const planner = require("../services/network/networkPlannerService");
const { normalizeSpec } = require("../services/network/networkSpec");

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const wb = (value, date = "2024") => [{ page: 1 }, [{ value, date }]];

// Public country sources, keyed by URL.
const sparqlRows = (rows) => ok({ results: { bindings: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { value: v }]))) } });
const countryFetch = jest.fn(async (url) => {
  const u = decodeURIComponent(String(url));
  if (u.includes("wikidata") && u.includes('wdt:P297 "SA"')) return sparqlRows([{ countryLabel: "Saudi Arabia", currencyCode: "SAR", langCode: "ar", dsLabel: "right" }]);
  // Wikidata lists two current currencies for France (the CFP franc first here): the built-in table wins.
  if (u.includes("wikidata") && u.includes('wdt:P297 "FR"')) return sparqlRows([{ countryLabel: "France", currencyCode: "XPF", langCode: "fr", dsLabel: "right" }, { countryLabel: "France", currencyCode: "EUR", langCode: "fr", dsLabel: "right" }]);
  if (u.includes("wikidata") && u.includes('wdt:P297 "GB"')) return sparqlRows([{ countryLabel: "United Kingdom", currencyCode: "GBP", langCode: "en", dsLabel: "left" }, { countryLabel: "United Kingdom", currencyCode: "GBP", langCode: "cy", dsLabel: "left" }]);
  if (/\/country\/SA\?format=json/.test(u)) return ok([{ page: 1 }, [{ region: { value: "Middle East, North Africa, Afghanistan & Pakistan" }, incomeLevel: { value: "High income" } }]]);
  if (u.includes("/country/SA/indicator/NY.GDP.PCAP.CD")) return ok(wb(30448.1));
  if (u.includes("/country/SA/indicator/SP.URB.TOTL.IN.ZS")) return ok(wb(85.0));
  // Price level = PPP (LCU per international $) ÷ exchange rate (LCU per US$): SA 1.875/3.75 = 0.5, FR 0.72/0.9 = 0.8.
  if (u.includes("/country/SA/indicator/PA.NUS.PPP?")) return ok(wb(1.875));
  if (u.includes("/country/SA/indicator/PA.NUS.FCRF")) return ok(wb(3.75));
  if (u.includes("/country/FR/indicator/PA.NUS.PPP?")) return ok(wb(0.72));
  if (u.includes("/country/FR/indicator/PA.NUS.FCRF")) return ok(wb(0.9));
  if (u.includes("/country/")) return ok([{ page: 1 }, []]);
  if (u.includes("er-api") || u.includes("latest/EUR")) return ok({ rates: { SAR: 4.0, USD: 1.08, GBP: 0.85 } });
  return { ok: false, status: 404, json: async () => ({}) };
});

describe("country context", () => {
  test("currency, language, local weekend and the cost factor from the price level and the exchange rate", async () => {
    const c = await country.countryContext("sa", { fetchImpl: countryFetch, force: true });
    expect(c).toMatchObject({ code: "SA", name: "Saudi Arabia", region: "Middle East, North Africa, Afghanistan & Pakistan", income_level: "High income", currency: { code: "SAR" }, languages: ["ar"], driving_side: "right", weekend: ["fri", "sat"], gdp_per_capita_usd: 30448, urban_pct: 85, eur_rate: 4, price_level: 0.5 });
    // 0.5 / 0.8 (price level vs France) × 4 SAR per EUR.
    expect(c.cost_factor).toBe(2.5);
    expect(c.sources.map((s) => s.id)).toEqual(["wikidata", "worldbank", "exchangerate"]);
    // Several official languages, left-hand traffic.
    const gb = await country.countryContext("GB", { fetchImpl: countryFetch, force: true });
    expect(gb).toMatchObject({ currency: { code: "GBP", symbol: "£" }, languages: ["en", "cy"], driving_side: "left" });
    expect(country.summarizeCountry(c)).toMatch(/Usual weekend: fri\+sat — set spec\.weekend/);
    // Cached for a day.
    const calls = countryFetch.mock.calls.length;
    await country.countryContext("SA", { fetchImpl: countryFetch });
    expect(countryFetch.mock.calls.length).toBe(calls);
    const fr = await country.countryContext("FR", { fetchImpl: countryFetch, force: true });
    expect(fr).toMatchObject({ currency: { code: "EUR" }, weekend: ["sat", "sun"], eur_rate: 1, cost_factor: 1 });
    expect(await country.countryContext("??")).toBeNull();
  });

  test("every source down: built-in currency and weekend, warnings, never an error", async () => {
    const down = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const c = await country.countryContext("EG", { fetchImpl: down, force: true });
    expect(c).toMatchObject({ code: "EG", currency: { code: "EGP" }, weekend: ["fri", "sat"], cost_factor: null });
    expect(c.warnings.length).toBeGreaterThanOrEqual(4);
  });
});

describe("local weekends and local costs", () => {
  const SPEC = {
    agency: { name: "Riyadh Bus", url: "https://bus.example", timezone: "Asia/Riyadh" },
    feed: { start_date: "20260101", end_date: "20261231" },
    stops: [{ id: "a", name: "A", lat: 24.7, lon: 46.7 }, { id: "b", name: "B", lat: 24.72, lon: 46.72 }],
    lines: [{ id: "L1", short_name: "1", mode: "bus", directions: [{ stops: ["a", "b"] }], services: [{ calendar: "weekday", periods: [{ from: "06:00", to: "22:00", headway_min: 15 }] }, { calendar: "weekend", periods: [{ from: "08:00", to: "23:00", headway_min: 30 }] }] }],
    weekend: ["fri", "sat"],
  };

  test("'weekday' and 'weekend' follow spec.weekend", () => {
    const n = normalizeSpec(SPEC);
    expect(n.ok).toBe(true);
    expect(n.spec.weekend).toEqual(["fri", "sat"]);
    const byId = Object.fromEntries(n.spec.calendars.map((c) => [c.id, c.days]));
    expect(byId.WKD).toEqual(["mon", "tue", "wed", "thu", "sun"]);
    expect(byId.WKE).toEqual(["fri", "sat"]);
    // Default week unchanged, no weekend key in the spec.
    const d = normalizeSpec({ ...SPEC, weekend: undefined });
    expect(d.spec.weekend).toBeUndefined();
    expect(Object.fromEntries(d.spec.calendars.map((c) => [c.id, c.days])).WKD).toEqual(["mon", "tue", "wed", "thu", "fri"]);
  });

  test("costs in the local currency at the local price level, unless the brief gives figures", async () => {
    const c = await country.countryContext("SA", { fetchImpl: countryFetch });
    const spec = normalizeSpec(SPEC).spec;
    const o = ops.estimateOperations(spec, null, { country: c });
    expect(o.currency).toBe("SAR");
    expect(o.per_line[0].cost_per_km).toBe(10.5); // 4.2 EUR × 2.5
    expect(o.assumptions.cost_basis).toBe("country:SA");
    const own = normalizeSpec({ ...SPEC, operations: { currency: "USD", cost_per_km: 3 } }).spec;
    const o2 = ops.estimateOperations(own, null, { country: c });
    expect(o2.currency).toBe("USD");
    expect(o2.per_line[0].cost_per_km).toBe(3);
    expect(o2.assumptions.cost_basis).toBe("brief");
    // An operations block without a currency no longer forces EUR.
    expect(normalizeSpec({ ...SPEC, operations: { max_vehicles: 4 } }).spec.operations).toEqual({ max_vehicles: 4 });
  });
});

describe("works, statistics and country in the territory dossier", () => {
  const dossierFetch = jest.fn(async (url, init = {}) => {
    const u = String(url);
    if (u.includes("nominatim")) return ok([{ lat: "24.7136", lon: "46.6753", boundingbox: ["24.6", "24.8", "46.6", "46.8"], display_name: "Riyadh, Saudi Arabia", name: "Riyadh", osm_type: "relation", osm_id: 1, type: "city", address: { country_code: "sa", country: "Saudi Arabia" }, extratags: { wikidata: "Q3692" } }]);
    if (u.includes("overpass")) {
      const body = decodeURIComponent(String(init.body || ""));
      if (body.includes('"landuse"="construction"')) {
        return ok({ elements: [
          { type: "way", id: 1, center: { lat: 24.71, lon: 46.68 }, tags: { highway: "construction", construction: "primary", name: "King Road" } },
          { type: "way", id: 2, center: { lat: 24.715, lon: 46.685 }, tags: { highway: "construction", construction: "primary", name: "King Road" } },
          { type: "way", id: 3, center: { lat: 24.75, lon: 46.7 }, tags: { landuse: "construction", construction: "residential", name: "New District", opening_date: "2027" } },
          { type: "way", id: 4, center: { lat: 24.72, lon: 46.69 }, tags: { railway: "construction", construction: "light_rail", name: "Line 7" } },
          { type: "node", id: 5, lat: 24.7, lon: 46.7, tags: { amenity: "school", name: "Not a work" } },
        ] });
      }
      if (body.includes("bus_stop")) return ok({ elements: [{ type: "node", id: 10, lat: 24.71, lon: 46.67, tags: { highway: "bus_stop", name: "Olaya" } }] });
      return ok({ elements: [] });
    }
    if (u.includes("wikidata") && !decodeURIComponent(u).includes("P297")) return ok({ results: { bindings: [{ pop: { value: "7009100" }, area: { value: "1913" }, unit: { value: "http://www.wikidata.org/entity/Q712226" } }] } });
    if (u.includes("open-meteo")) return ok({ timezone: "Asia/Riyadh", elevation: 612 });
    if (u.includes("nager") || u.includes("openholidays")) return ok([]);
    return countryFetch(url, init);
  });

  test("the dossier carries works (developments first), area and density, and the country context", async () => {
    country._internals._cache.clear();
    const d = await territory.buildTerritory("Riyadh", { fetchImpl: dossierFetch, force: true });
    expect(d.stats).toEqual({ area_km2: 1913, density_per_km2: 3664 });
    expect(d.population).toEqual({ value: 7009100, source: "wikidata" });
    expect(d.country).toMatchObject({ code: "SA", currency: { code: "SAR" }, weekend: ["fri", "sat"] });
    expect(d.works.counts).toEqual({ road: 1, development: 1, transit: 1 });
    expect(d.works.items.map((w) => w.kind)).toEqual(["development", "transit", "road"]);
    expect(d.works.items[0]).toMatchObject({ name: "New District", status: "construction", detail: "residential", opening_date: "2027" });
    expect(d.sources.map((s) => s.id)).toEqual(expect.arrayContaining(["wikidata", "worldbank", "exchangerate"]));
    const text = territory.summarizeForModel(d);
    expect(text).toMatch(/Area 1913 km², density 3664 inhabitants\/km²/);
    expect(text).toMatch(/Country: Saudi Arabia \(SA, Middle East, North Africa, Afghanistan & Pakistan, High income\)\. Currency SAR/);
    expect(text).toMatch(/Works and projects \(OpenStreetMap\): 1 road, 1 development, 1 transit/);
    expect(text).toMatch(/construction development "New District" \(residential\), opening 2027/);
    // Developments weigh in the demand hubs.
    const hubs = require("../services/network/networkDesignService").demandHubs(d);
    expect(hubs.some((h) => h.categories.development)).toBe(true);
  });
});

const zipOf = (files) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    const archive = archiver("zip");
    archive.on("data", (c) => chunks.push(c));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    for (const [name, text] of Object.entries(files)) archive.append(text, { name });
    archive.finalize();
  });

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n4 0 obj << /Type /Page /Parent 2 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1");

describe("specification documents", () => {
  test("PDF kept for the model, Word and OpenDocument reduced to text, text decoded; refusals", async () => {
    const pdf = await docs.ingestDocument({ name: "cahier-des-charges.pdf", buffer: PDF });
    expect(pdf).toMatchObject({ kind: "pdf", pages: 2, name: "cahier-des-charges.pdf" });
    const docx = await zipOf({ "word/document.xml": '<w:document><w:body><w:p><w:r><w:t>Ligne 1 :</w:t></w:r><w:r><w:tab/><w:t>Gare &amp; Hôpital</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Période</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Fréquence</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Pointe</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>10 min</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>' });
    const w = await docs.ingestDocument({ name: "cdc.docx", buffer: docx });
    expect(w.kind).toBe("text");
    expect(w.data).toMatch(/Ligne 1 :\tGare & Hôpital/);
    expect(w.data).toMatch(/Période\s*\n?\s*\|\s*\n?\s*Fréquence|Période \| Fréquence/);
    expect(w.data).toMatch(/10 min/);
    const odt = await zipOf({ "content.xml": '<office:document-content><office:body><office:text><text:h>Offre</text:h><text:p>Du lundi<text:s text:c="2"/>au vendredi</text:p></office:text></office:body></office:document-content>' });
    const o = await docs.ingestDocument({ name: "cdc.odt", buffer: odt });
    expect(o.data).toBe("Offre\nDu lundi  au vendredi");
    const txt = await docs.ingestDocument({ name: "brief.md", buffer: Buffer.from("# Réseau\nTrois lignes.", "utf8") });
    expect(txt).toMatchObject({ kind: "text", data: "# Réseau\nTrois lignes." });
    await expect(docs.ingestDocument({ name: "virus.exe", buffer: Buffer.from("MZ...") })).rejects.toMatchObject({ status: 415 });
    const many = Buffer.from(`%PDF-1.4\n${"<< /Type /Page >>\n".repeat(101)}`, "latin1");
    await expect(docs.ingestDocument({ name: "big.pdf", buffer: many })).rejects.toMatchObject({ status: 413, code: "DOCUMENT_TOO_LONG" });
    await expect(docs.ingestDocument({ name: "empty.docx", buffer: await zipOf({ "other.xml": "<x/>" }) })).rejects.toMatchObject({ status: 400 });
  });

  test("HTTP upload, then the planner reads the documents as document blocks (the last one cached)", async () => {
    const up = await request(app).post("/gtfs/network/documents").attach("file", PDF, "cahier.pdf");
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ name: "cahier.pdf", kind: "pdf", pages: 2 });
    expect(up.body.id).toMatch(/^[a-f0-9]{24}$/);
    const up2 = await request(app).post("/gtfs/network/documents").attach("file", Buffer.from("Budget : 12 bus maximum.", "utf8"), "notes.txt");
    expect(up2.status).toBe(201);
    const bad = await request(app).post("/gtfs/network/documents").attach("file", Buffer.from("x"), "photo.png");
    expect(bad.status).toBe(415);

    __script.push({ text: "Lu." });
    const events = [];
    await planner.planNetwork({ brief: "Conçois le réseau du cahier des charges.", documentIds: [up.body.id, up2.body.id, "000000000000000000000000"], language: "fr", rateKey: "t-docs", signal: new AbortController().signal, emit: (event, data) => events.push({ event, data }) });
    const step = events.find((e) => e.event === "step" && e.data.kind === "documents").data;
    expect(step).toMatchObject({ count: 2, names: ["cahier.pdf", "notes.txt"], missing: ["000000000000000000000000"] });
    const content = __captured[__captured.length - 1].messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toMatchObject({ type: "document", title: "cahier.pdf", source: { type: "base64", media_type: "application/pdf" } });
    expect(content[0].cache_control).toBeUndefined();
    expect(content[1]).toMatchObject({ type: "document", title: "notes.txt", source: { type: "text", media_type: "text/plain", data: "Budget : 12 bus maximum." }, cache_control: { type: "ephemeral" } });
    expect(content[2].type).toBe("text");
    expect(content[2].text).toMatch(/\[Attached documents\] "cahier\.pdf" \(2 pages\), "notes\.txt" — the specification/);
    expect(content[2].text).toMatch(/Conçois le réseau du cahier des charges\.$/);
    // The system prompt tells the model the documents are the specification.
    expect(__captured[__captured.length - 1].system[0].text).toMatch(/Attached documents \(PDF, Word, text/);
    const del = await request(app).delete(`/gtfs/network/documents/${up.body.id}`);
    expect(del.status).toBe(204);
    expect(docs.getDocuments([up.body.id]).missing).toEqual([up.body.id]);
  });
});
