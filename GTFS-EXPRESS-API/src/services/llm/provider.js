/**
 * llm/provider — where the model runs: the direct API (the default), Amazon
 * Bedrock or Google Vertex AI, chosen by LLM_PROVIDER.
 *
 * Why: the operators the product is sold to may need their briefs and feeds
 * processed inside the EU. On the direct API, inference_geo offers only "us"
 * or "global"; Bedrock in an EU region (eu-west-3 Paris, eu-central-1
 * Frankfurt) or Vertex AI in the "eu" multi-region keeps the processing in
 * the EU. The three clients expose the same messages.create / .stream
 * surface (prompt caching, tools, streaming, adaptive thinking, effort), so
 * a service only changes how it builds its client and names its model.
 *
 *   readProviderConfig(env) → { provider, known, configured, missing[], region?, projectId? }
 *                             (`env` is process.env or config.js, whose values carry the
 *                             variables' names; the direct API's key is kept on the result
 *                             as a non-enumerable `apiKey`, so logging the result never shows it)
 *   describeMissing(cfg)    → what the selected provider lacks, for a log line or a 503
 *   createClient(cfg)       → that provider's SDK client. Its package is required only when
 *                             selected, and constructing it sends nothing to the model.
 *   modelId(id, provider)   → the id the provider knows the model by (Bedrock: "anthropic.<id>")
 *   baseModelOf(id)         → the first-party id back (no "anthropic.", no "eu." / "us." /
 *                             "global." before it, no "@version")
 *   supportsEffort(model)   → whether the model takes output_config.effort (Haiku refuses it)
 *
 * Every client is built with the SDK's retries raised to three (DEFAULT_CLIENT_OPTIONS): a call refused
 * before its stream opens (a connection error, a 429, a 5xx) is sent again by the SDK; a stream cut in
 * the middle is a planner round's to retry (llm/streamRound). `options` override them (the tests pass
 * maxRetries: 0 and their own fetch).
 *
 * Every client createClient returns, whatever the provider, passes each request
 * body through llm/personalData.scrubRequest first: the names and e-mails of the
 * persons the current request knows (the account, the contract's deciders, the
 * journal's actors…) never reach the provider, whichever service built the
 * request (scrubPersons); and counts each call's cost for the account that
 * asked it (llm/aiMeter).
 *
 * Credentials: only the direct API's key is read here. Bedrock uses the AWS
 * default chain (environment, profile, instance role), resolved by its SDK at
 * the first request; Vertex the Google application default credentials,
 * which its SDK starts looking up when the client is built (without a key
 * file, that lookup may ask the cloud metadata server). Nothing here logs
 * them.
 */

"use strict";

const PROVIDERS = Object.freeze(["anthropic", "bedrock", "vertex"]);
const DEFAULT_VERTEX_REGION = "eu";

const clean = (v) => String(v ?? "").trim();

const result = (fields, missing) => ({ ...fields, known: true, configured: missing.length === 0, missing });

/** The selected provider and whether it has what it needs, from the environment (or config.js). */
const readProviderConfig = (env = process.env) => {
  const provider = clean(env.LLM_PROVIDER).toLowerCase() || "anthropic";
  if (provider === "bedrock") {
    const region = clean(env.LLM_AWS_REGION);
    return result({ provider, region: region || null }, region ? [] : ["LLM_AWS_REGION"]);
  }
  if (provider === "vertex") {
    const projectId = clean(env.LLM_VERTEX_PROJECT_ID);
    const region = clean(env.LLM_VERTEX_REGION) || DEFAULT_VERTEX_REGION;
    return result({ provider, projectId: projectId || null, region }, projectId ? [] : ["LLM_VERTEX_PROJECT_ID"]);
  }
  if (provider === "anthropic") {
    const apiKey = clean(env.ANTHROPIC_API_KEY);
    const cfg = result({ provider }, apiKey ? [] : ["ANTHROPIC_API_KEY"]);
    return Object.defineProperty(cfg, "apiKey", { value: apiKey || null, enumerable: false });
  }
  return { provider, known: false, configured: false, missing: ["LLM_PROVIDER"] };
};

/** "LLM_AWS_REGION is missing (LLM_PROVIDER=bedrock)", or "" when nothing is. */
const describeMissing = (cfg) => {
  if (!cfg.known) return `LLM_PROVIDER "${cfg.provider}" is not one of ${PROVIDERS.join(", ")}`;
  if (!cfg.missing.length) return "";
  return `${cfg.missing.join(", ")} ${cfg.missing.length > 1 ? "are" : "is"} missing (LLM_PROVIDER=${cfg.provider})`;
};

// "anthropic.", optionally behind a cross-region inference prefix ("eu.", "us.", "global.", …).
const BEDROCK_PREFIX = /^(?:[a-z][a-z-]*\.)?anthropic\./;

/** The model id as the provider names it: Bedrock wants "anthropic.<id>"; an id already prefixed (or an ARN) is left as is. */
const modelId = (id, provider) => {
  if (provider !== "bedrock" || !id) return id;
  const s = String(id);
  return BEDROCK_PREFIX.test(s) || s.startsWith("arn:") ? s : `anthropic.${s}`;
};

/** The first-party id behind a provider's id: claude-opus-5-5 for "eu.anthropic.claude-opus-5-5" or "claude-opus-5-5@20260101". */
const baseModelOf = (id) => String(id || "").replace(BEDROCK_PREFIX, "").replace(/@.*$/, "");

/** Effort is a knob of the current models only (Haiku rejects it), whatever provider prefix the id carries. */
const supportsEffort = (model) => /^claude-(opus|sonnet|fable|mythos)-(4-[678]|5)/.test(baseModelOf(model));

/**
 * Every request's model goes through modelId(), whoever builds the request:
 * a call site that hands a first-party id to the Bedrock client still names
 * the model the way Bedrock knows it (modelId is idempotent).
 */
const mapModelIds = (client, provider) => {
  const { messages } = client;
  for (const method of ["create", "stream"]) {
    const original = messages[method];
    messages[method] = (body, ...rest) => original.call(messages, body && body.model ? { ...body, model: modelId(body.model, provider) } : body, ...rest);
  }
  return client;
};

/**
 * The persons' safety net (llm/personalData): every request body, whoever builds
 * it, goes out with the current request's persons replaced by their pseudonyms.
 * A request with nobody to hide is passed as it is (the same object).
 */
const scrubPersons = (client) => {
  const personalData = require("./personalData");
  const { messages } = client;
  for (const method of ["create", "stream"]) {
    const original = messages[method];
    if (typeof original !== "function") continue;
    messages[method] = (body, ...rest) => original.call(messages, personalData.scrubRequest(body, personalData.current()), ...rest);
  }
  return client;
};

/**
 * The SDK client of the selected provider. `options` go to the SDK
 * constructor unchanged (tests pass a fake fetch or fake credentials there;
 * the services pass none). An unconfigured provider is refused here rather
 * than left to the SDKs' own environment fallbacks (AWS_REGION,
 * CLOUD_ML_REGION, a local profile), which would pick a region or an
 * account nobody chose.
 */
// The SDK's own retries before a stream opens: three instead of its two. A round cut in its stream is retried
// by llm/streamRound instead. Tests pass their own (maxRetries: 0).
const DEFAULT_CLIENT_OPTIONS = Object.freeze({ maxRetries: 3 });
// Every call counted for the account that asked it (llm/aiMeter: the AI's envelopes in money).
const meter = (client) => require("./aiMeter").meterUsage(client);
const clientOptions = (options) => ({ ...DEFAULT_CLIENT_OPTIONS, ...options });

const createClient = (cfg, options = {}) => {
  if (!cfg || !cfg.configured) {
    // An internal invariant (every service checks config.LLM_CONFIGURED first and answers its own 503).
    throw new Error(`The model provider is not configured: ${cfg ? describeMissing(cfg) : "no configuration"}.`);
  }
  if (cfg.provider === "bedrock") {
    const { AnthropicBedrockMantle } = require("@anthropic-ai/bedrock-sdk");
    return scrubPersons(meter(mapModelIds(new AnthropicBedrockMantle({ awsRegion: cfg.region, ...clientOptions(options) }), "bedrock")));
  }
  if (cfg.provider === "vertex") {
    const { AnthropicVertex } = require("@anthropic-ai/vertex-sdk");
    const client = new AnthropicVertex({ projectId: cfg.projectId, region: cfg.region, ...clientOptions(options) });
    // The SDK starts resolving the Google credentials in its constructor and
    // awaits them at the first request. Without credentials that promise can
    // reject before any request awaits it (a planner previews its plan first):
    // an unhandled rejection, which stops the process. Marked handled here;
    // the request that awaits it still gets the error.
    client._authClientPromise?.catch?.(() => {});
    return scrubPersons(meter(client));
  }
  const { Anthropic } = require("@anthropic-ai/sdk");
  return scrubPersons(meter(new Anthropic({ apiKey: cfg.apiKey, ...clientOptions(options) })));
};

module.exports = { PROVIDERS, DEFAULT_VERTEX_REGION, DEFAULT_CLIENT_OPTIONS, readProviderConfig, describeMissing, createClient, modelId, baseModelOf, supportsEffort, scrubPersons };
