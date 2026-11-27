/**
 * Who a budget of the server counts: the signed-in account, else the caller's address hashed (aiCostLimiter
 * anonymousKey, an IPv6 address by its /64), never a session id or a header the caller chooses and can change at will.
 * `currentCaller` gives the request's caller to code far from `req` (the SQL sandbox's places).
 */

"use strict";

const { AsyncLocalStorage } = require("async_hooks");

const callerKey = (req) => (req?.user?.id != null ? `user:${req.user.id}` : require("../services/aiCostLimiter").anonymousKey(req));

const scope = new AsyncLocalStorage();

// Only what the key is made of, hashed on first use: a timer or a child armed during the request keeps this store as
// long as it lives, and must not keep the request and its body with it.
const callerContext = (req, _res, next) => scope.run({ userId: req.user?.id ?? null, ip: req.ip, key: null }, () => next());

/** The caller of the request this code runs for, or null outside one. */
const currentCaller = () => {
  const store = scope.getStore();
  if (!store) return null;
  if (store.key == null) store.key = callerKey({ user: store.userId == null ? null : { id: store.userId }, ip: store.ip });
  return store.key;
};

module.exports = { callerKey, callerContext, currentCaller };
