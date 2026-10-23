/**
 * What every model call costs, kept per account and per product function: the AI is bounded in money, not in calls.
 * createClient wraps every client with meterUsage, so every call counts without its service knowing; the account
 * lives in an AsyncLocalStorage, so a turn that runs on after its response still counts for the person who asked.
 */

"use strict";

const { AsyncLocalStorage } = require("async_hooks");
const config = require("../../config");
const { usdOf } = require("./prices");

const storage = new AsyncLocalStorage();

// Older ai_usage rows keep the name they were recorded under; the console names them as they are.
const FEATURES = Object.freeze(["direct", "assistant", "reader_companion", "sql_question", "summary", "field_suggestion", "sheets", "other"]);
const FEATURE_ROUTES = [
  [/^\/gtfs\/transform\/direct(\/review)?\/?$/i, "direct"],
  [/^\/gtfs\/sql\/nl2sql-chat\/?$/i, "assistant"],
  [/^\/gtfs\/sql\/nl2sql\/?$/i, "sql_question"],
  [/^\/gtfs\/ai\/summarize\/?$/i, "summary"],
  [/^\/gtfs\/ai\/suggest-field\/?$/i, "field_suggestion"],
  [/^\/gtfs\/documents\/sheets\/calendar\/suggest\/?$/i, "sheets"],
];
const featureOfPath = (p) => {
  const pathOnly = String(p || "").split("?")[0];
  const hit = FEATURE_ROUTES.find(([re]) => re.test(pathOnly));
  return hit ? hit[1] : "other";
};

const aiMeterContext = (req, res, next) =>
  storage.run({ userId: req.user && req.user.id ? req.user.id : null, feature: featureOfPath(req.originalUrl || req.url) }, next);

const run = (scope, fn) => storage.run({ userId: (scope && scope.userId) || null, feature: (scope && scope.feature) || null }, fn);

const currentUserId = () => {
  const scope = storage.getStore();
  return scope ? scope.userId : null;
};

const currentFeature = () => {
  const scope = storage.getStore();
  return scope ? scope.feature || null : null;
};

/** For a handler that knows better than its route (the reader's chat is the reading companion, not the assistant). */
const setFeature = (name) => {
  const scope = storage.getStore();
  if (scope && FEATURES.includes(name)) scope.feature = name;
};

let warned = false;

/** Nothing is written when accounts are off; a failure to write never fails the call. */
const record = (model, usage, userId = currentUserId(), feature = currentFeature()) => {
  if (!usage || typeof usage !== "object" || !config.ACCOUNTS_ENABLED) return;
  try {
    require("../accounts/store").recordAiUsage({ userId, model, usage, usd: usdOf(model, usage), feature });
  } catch (err) {
    if (!warned) console.warn(`[ai meter] a call's cost was not recorded: ${err.message}`);
    warned = true;
  }
};

/**
 * create hands back the SDK's own promise, untouched. A stream counts its last snapshot however it ends (an aborted
 * stream was billed up to where it went); no "error" listener is added, which would change how it reports errors.
 */
const meterUsage = (client) => {
  const { messages } = client;
  if (!messages) return client;
  const create = messages.create;
  if (typeof create === "function") {
    messages.create = (body, ...rest) => {
      const userId = currentUserId();
      const feature = currentFeature();
      const out = create.call(messages, body, ...rest);
      if (out && typeof out.then === "function") out.then((m) => m && m.usage && record(m.model || body?.model, m.usage, userId, feature), () => {});
      return out;
    };
  }
  const stream = messages.stream;
  if (typeof stream === "function") {
    messages.stream = (body, ...rest) => {
      const userId = currentUserId();
      const feature = currentFeature();
      const s = stream.call(messages, body, ...rest);
      if (s && typeof s.on === "function") {
        let last = null;
        let done = false;
        const finish = (message) => {
          if (done) return;
          const m = message || last;
          if (!m || !m.usage) return;
          done = true;
          record(m.model || body?.model, m.usage, userId, feature);
        };
        s.on("streamEvent", (_event, snapshot) => {
          if (snapshot) last = snapshot;
        });
        s.on("finalMessage", (m) => finish(m));
        s.on("end", () => finish(null));
      }
      return s;
    };
  }
  return client;
};

module.exports = { aiMeterContext, run, currentUserId, currentFeature, setFeature, featureOfPath, FEATURES, meterUsage, record };
