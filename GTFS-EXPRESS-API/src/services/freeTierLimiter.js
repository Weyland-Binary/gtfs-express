/**
 * freeTierLimiter — anonymous free-trial quota for the AI chat companion.
 *
 * Product decision: every session gets a few AI messages WITHOUT a beta
 * code so the user tastes the repair companion on THEIR feed before the
 * paywall. Two in-memory sliding caps guard the giveaway:
 *
 *   • per session  — NL2SQL_FREE_MESSAGES_PER_SESSION (lifetime of the
 *     session; sessions expire after 1-2h TTL anyway)
 *   • per IP / day — NL2SQL_FREE_MESSAGES_PER_IP_DAY, defeats the obvious
 *     "open a new session" recycling. IPs are HMAC-hashed via the shared
 *     hashIp() before being used as keys (CLAUDE.md rule: never keep raw
 *     identifiers around).
 *
 * The global daily AI budget (aiCostLimiter) still applies on top — this
 * module only decides WHO gets the free taste, not how much the operator
 * is willing to spend overall. In-memory, single-process scope: acceptable
 * for the beta footprint, same trade-off as aiCostLimiter.
 */

const config = require("../config");
const { hashIp } = require("./eventLogger");

const DAY_MS = 24 * 60 * 60 * 1000;

// sessionId → count (monotonic; entries die with the process / are pruned)
const sessionCounts = new Map();
// hashed ip → [timestamps] within the last 24h
const ipWindows = new Map();

const MAX_TRACKED_KEYS = 10000;

const pruneIpWindow = (arr, now) => {
  while (arr.length > 0 && now - arr[0] > DAY_MS) arr.shift();
  return arr;
};

// Defensive cap on map growth: drop the oldest half when the tracker gets
// unreasonably large (only reachable under deliberate abuse).
const capMap = (map) => {
  if (map.size <= MAX_TRACKED_KEYS) return;
  const drop = Math.floor(map.size / 2);
  let i = 0;
  for (const key of map.keys()) {
    map.delete(key);
    if (++i >= drop) break;
  }
};

/**
 * Check whether an anonymous session may send one more free message.
 * Pure read — call `consume()` after the request is accepted.
 *
 * @returns {{ ok: boolean, code?: string, remaining: number }}
 */
const check = ({ sessionId, ip }) => {
  const perSession = config.NL2SQL_FREE_MESSAGES_PER_SESSION;
  if (!perSession || perSession <= 0) {
    return { ok: false, code: "FREE_TIER_DISABLED", remaining: 0 };
  }

  const used = sessionCounts.get(sessionId) || 0;
  if (used >= perSession) {
    return { ok: false, code: "FREE_QUOTA_EXHAUSTED", remaining: 0 };
  }

  const perIpDay = config.NL2SQL_FREE_MESSAGES_PER_IP_DAY;
  if (perIpDay > 0 && ip) {
    const key = hashIp(ip);
    const win = pruneIpWindow(ipWindows.get(key) || [], Date.now());
    ipWindows.set(key, win);
    if (win.length >= perIpDay) {
      return { ok: false, code: "FREE_QUOTA_EXHAUSTED", remaining: 0 };
    }
  }

  return { ok: true, remaining: perSession - used };
};

/** Record one consumed free message. Returns the remaining allowance. */
const consume = ({ sessionId, ip }) => {
  const used = (sessionCounts.get(sessionId) || 0) + 1;
  sessionCounts.set(sessionId, used);
  capMap(sessionCounts);
  if (ip) {
    const key = hashIp(ip);
    const win = pruneIpWindow(ipWindows.get(key) || [], Date.now());
    win.push(Date.now());
    ipWindows.set(key, win);
    capMap(ipWindows);
  }
  return Math.max(0, config.NL2SQL_FREE_MESSAGES_PER_SESSION - used);
};

/** Test hook — wipe all counters. */
const resetForTests = () => {
  sessionCounts.clear();
  ipWindows.clear();
};

module.exports = { check, consume, resetForTests };
