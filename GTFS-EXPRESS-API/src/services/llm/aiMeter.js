/**
 * llm/aiMeter — what every model call costs, kept per account: the AI is bounded in money, not in calls, and the
 * operator knows what each customer costs.
 *
 * Why here: every client of the model is built by llm/provider.createClient, so wrapping its messages.create and
 * .stream counts every call, whichever service builds it — the planners' rounds, the chat, the SQL questions, the
 * suggestions — without any of them knowing. The account is the request's (an AsyncLocalStorage opened by the
 * middleware after userContext, as llm/personalData does), so a turn that runs on after its response still counts
 * for the person who asked.
 *
 * A call's tokens come from the provider's own `usage` (llm/prices turns them into USD): the message of a create,
 * the last snapshot of a stream — a stream cut by an abort or an error was billed too, up to where it went. Nothing
 * is written when accounts are off (no projects.db); a failure to write never fails the call.
 *
 * Each call also says the product function it served (FEATURES), read from the route the request came by
 * (featureOfPath) or named by the handler that knows better (setFeature: the reader's chat is the reading companion,
 * not the licensed assistant): the operator's console sums the cost per function.
 *
 *   aiMeterContext(req, res, next)   the middleware (the request's account and function, or none)
 *   run({ userId, feature }, fn)     fn under that account (a test, a script)
 *   currentUserId()                  the account the calls are counted for now, or null
 *   setFeature(name)                 the function the current request's calls serve, from now on
 *   featureOfPath(path)              the function a route serves, from its path
 *   meterUsage(client)               the client, its calls counted (createClient applies it)
 *   record(model, usage)             count one call's usage for the current account
 */

"use strict";

const { AsyncLocalStorage } = require("async_hooks");
const config = require("../../config");
const { usdOf } = require("./prices");

const storage = new AsyncLocalStorage();

// The product functions a model call serves, as the console names them.
const FEATURES = Object.freeze(["change_planner", "network_studio", "assistant", "reader_companion", "sql_question", "summary", "field_suggestion", "other"]);
const FEATURE_ROUTES = [
  [/^\/gtfs\/transform\/plan\/?$/i, "change_planner"],
  [/^\/gtfs\/network\/plan\/?$/i, "network_studio"],
  [/^\/gtfs\/sql\/nl2sql-chat\/?$/i, "assistant"],
  [/^\/gtfs\/sql\/nl2sql\/?$/i, "sql_question"],
  [/^\/gtfs\/ai\/summarize\/?$/i, "summary"],
  [/^\/gtfs\/ai\/suggest-field\/?$/i, "field_suggestion"],
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

/** Name the function the current request's calls serve (a handler that knows better than its route). */
const setFeature = (name) => {
  const scope = storage.getStore();
  if (scope && FEATURES.includes(name)) scope.feature = name;
};

let warned = false;

/** Count one call: its cost from the usage the provider reported, for the account of the current request. */
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
 * The client with its calls counted. create: the response's usage once it arrives (the promise handed back is the
 * SDK's own, untouched). stream: the last snapshot's usage when the stream ends, however it ends; listening adds
 * no "error" listener, which would change how the stream reports its errors.
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
