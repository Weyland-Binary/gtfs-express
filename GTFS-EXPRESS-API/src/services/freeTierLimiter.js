/**
 * The free AI messages without a licence, capped per session and per address a day (so a new session does not
 * reset them; addresses kept hashed only). In memory, one process; aiCostLimiter still bounds the spend on top.
 */

const config = require("../config");
const { hashIp } = require("./eventLogger");

const DAY_MS = 24 * 60 * 60 * 1000;

const sessionCounts = new Map();
// hashed address → timestamps within the last 24 h
const ipWindows = new Map();

const MAX_TRACKED_KEYS = 10000;

const pruneIpWindow = (arr, now) => {
  while (arr.length > 0 && now - arr[0] > DAY_MS) arr.shift();
  return arr;
};

// Only reachable under deliberate abuse: drop the oldest half.
const capMap = (map) => {
  if (map.size <= MAX_TRACKED_KEYS) return;
  const drop = Math.floor(map.size / 2);
  let i = 0;
  for (const key of map.keys()) {
    map.delete(key);
    if (++i >= drop) break;
  }
};

/** Pure read: `consume()` once the request is accepted. */
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

/** Returns the remaining allowance. */
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

const resetForTests = () => {
  sessionCounts.clear();
  ipWindows.clear();
};

module.exports = { check, consume, resetForTests };
