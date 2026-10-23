/**
 * Where the model runs: the direct API (default), Amazon Bedrock or Google Vertex AI (LLM_PROVIDER). The direct
 * API's inference_geo offers only "us" or "global"; Bedrock in an EU region or Vertex in "eu" keeps the processing
 * in the EU. Every client createClient returns scrubs persons from each request (llm/personalData) and counts its
 * cost (llm/aiMeter). Only the direct API's key is read here, and it is never logged.
 */

"use strict";

const PROVIDERS = Object.freeze(["anthropic", "bedrock", "vertex"]);
const DEFAULT_VERTEX_REGION = "eu";

const clean = (v) => String(v ?? "").trim();

const result = (fields, missing) => ({ ...fields, known: true, configured: missing.length === 0, missing });

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
    // Non-enumerable, so logging the result never shows the key.
    return Object.defineProperty(cfg, "apiKey", { value: apiKey || null, enumerable: false });
  }
  return { provider, known: false, configured: false, missing: ["LLM_PROVIDER"] };
};

const describeMissing = (cfg) => {
  if (!cfg.known) return `LLM_PROVIDER "${cfg.provider}" is not one of ${PROVIDERS.join(", ")}`;
  if (!cfg.missing.length) return "";
  return `${cfg.missing.join(", ")} ${cfg.missing.length > 1 ? "are" : "is"} missing (LLM_PROVIDER=${cfg.provider})`;
};

// "anthropic.", optionally behind a cross-region inference prefix ("eu.", "us.", "global.", …).
const BEDROCK_PREFIX = /^(?:[a-z][a-z-]*\.)?anthropic\./;

/** Bedrock wants "anthropic.<id>"; an id already prefixed (or an ARN) is left as is. */
const modelId = (id, provider) => {
  if (provider !== "bedrock" || !id) return id;
  const s = String(id);
  return BEDROCK_PREFIX.test(s) || s.startsWith("arn:") ? s : `anthropic.${s}`;
};

const baseModelOf = (id) => String(id || "").replace(BEDROCK_PREFIX, "").replace(/@.*$/, "");

/** Haiku rejects output_config.effort. */
const supportsEffort = (model) => /^claude-(opus|sonnet|fable|mythos)-(4-[678]|5)/.test(baseModelOf(model));

const mapModelIds = (client, provider) => {
  const { messages } = client;
  for (const method of ["create", "stream"]) {
    const original = messages[method];
    messages[method] = (body, ...rest) => original.call(messages, body && body.model ? { ...body, model: modelId(body.model, provider) } : body, ...rest);
  }
  return client;
};

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

// The SDK retries only before a stream opens; a round cut in its stream is retried by llm/streamRound.
const DEFAULT_CLIENT_OPTIONS = Object.freeze({ maxRetries: 3 });
const meter = (client) => require("./aiMeter").meterUsage(client);
const clientOptions = (options) => ({ ...DEFAULT_CLIENT_OPTIONS, ...options });

const createClient = (cfg, options = {}) => {
  // Refused rather than left to the SDKs' environment fallbacks (AWS_REGION, a local profile), which would pick
  // a region or an account nobody chose.
  if (!cfg || !cfg.configured) {
    throw new Error(`The model provider is not configured: ${cfg ? describeMissing(cfg) : "no configuration"}.`);
  }
  if (cfg.provider === "bedrock") {
    const { AnthropicBedrockMantle } = require("@anthropic-ai/bedrock-sdk");
    return scrubPersons(meter(mapModelIds(new AnthropicBedrockMantle({ awsRegion: cfg.region, ...clientOptions(options) }), "bedrock")));
  }
  if (cfg.provider === "vertex") {
    const { AnthropicVertex } = require("@anthropic-ai/vertex-sdk");
    const client = new AnthropicVertex({ projectId: cfg.projectId, region: cfg.region, ...clientOptions(options) });
    // The SDK resolves credentials in its constructor; without them that promise can reject before any request
    // awaits it, an unhandled rejection that stops the process. The request that awaits it still gets the error.
    client._authClientPromise?.catch?.(() => {});
    return scrubPersons(meter(client));
  }
  const { Anthropic } = require("@anthropic-ai/sdk");
  return scrubPersons(meter(new Anthropic({ apiKey: cfg.apiKey, ...clientOptions(options) })));
};

module.exports = { PROVIDERS, DEFAULT_VERTEX_REGION, DEFAULT_CLIENT_OPTIONS, readProviderConfig, describeMissing, createClient, modelId, baseModelOf, supportsEffort, scrubPersons };
