/**
 * What the operator's console counts to steer the product: a feature's uses and a refusal's CODE per person and day,
 * the milestones an account reached, each draft's life and each turn of a brief, the licences day by day, the
 * searches that found nothing. Privacy: a person is an account or the funnel's visitor key of the day, never an
 * address; a search's words are kept without anyone; nothing here reaches a model provider. Best effort throughout: a
 * count that cannot be written never fails or slows a request.
 */

"use strict";

const config = require("../../config");
const features = require("./features");

const DAY_MS = 24 * 60 * 60 * 1000;
const MILESTONES = Object.freeze(["network", "draft", "brief", "applied", "export", "sheets", "invite"]);
const TIERS = Object.freeze(["visitor", "reader", "trial", "licence"]);
// The offer's own answers: counted on the way to the licence, not as friction.
const PAYWALL_CODES = Object.freeze(["NOT_SIGNED_IN", "SUBSCRIPTION_REQUIRED"]);
const MAX_PENDING = 20000;

const on = () => Boolean(config.ACCOUNTS_ENABLED);
const db = () => require("../accounts/store").getDb();
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const isoOf = (ms) => new Date(ms).toISOString();

const pendingFeatures = new Map();
const pendingRefusals = new Map();
const reached = new Map();
const liveDrafts = new Set();
const notDrafts = new Set();

/** visitor, reader (an account without the licence), trial or licence. */
const tierOf = (user) => {
  if (!user) return "visitor";
  const licence = user.licence;
  if (!licence || !licence.active) return "reader";
  return licence.source === "trial" ? "trial" : "licence";
};

const visitorOf = (req, day) => require("./funnel")._internals.visitorOf(req, day);
const whoOf = (userId, visitor) => (userId ? `u:${userId}` : visitor ? `v:${visitor}` : null);

/** One use of a feature by an account or a day's visitor. */
const useFeature = ({ feature, userId = null, visitor = null, tier = null, at = Date.now() } = {}) => {
  if (!on() || !features.KEYS.has(feature)) return;
  const who = whoOf(userId, visitor);
  if (!who || pendingFeatures.size >= MAX_PENDING) return;
  const day = dayOf(at);
  const key = `${day}|${feature}|${who}`;
  const row = pendingFeatures.get(key) || { day, feature, who, user_id: userId ? String(userId) : null, tier: TIERS.includes(tier) ? tier : null, uses: 0 };
  row.uses += 1;
  pendingFeatures.set(key, row);
};

/** One refusal answered with its CODE on a route template. */
const refuse = ({ code, route, userId = null, visitor = null, at = Date.now() } = {}) => {
  if (!on() || !code || !route) return;
  const who = whoOf(userId, visitor) || "v:unknown";
  if (pendingRefusals.size >= MAX_PENDING) return;
  const day = dayOf(at);
  const key = `${day}|${code}|${route}|${who}`;
  const row = pendingRefusals.get(key) || { day, code: String(code).slice(0, 60), route: String(route).slice(0, 200), who, user_id: userId ? String(userId) : null, count: 0 };
  row.count += 1;
  pendingRefusals.set(key, row);
};

/** A request at its end (perfLogger): the feature it used when it succeeded, the CODE it was refused with. */
const noteRequest = ({ req, method, template, matched, status, code, at = Date.now() }) => {
  if (!on() || !matched) return;
  const feature = status < 400 ? features.ofRoute(method, template) : null;
  const refused = status >= 400 && code ? code : null;
  if (!feature && !refused) return;
  const user = req && req.user ? req.user : null;
  const visitor = user ? null : visitorOf(req, dayOf(at));
  if (feature) useFeature({ feature, userId: user && user.id, visitor, tier: tierOf(user), at });
  if (refused) refuse({ code: refused, route: `${method} ${template}`, userId: user && user.id, visitor, at });
};

/** Written with the usage ledger's own counts, in its transaction. */
const flushInto = (database) => {
  if (!pendingFeatures.size && !pendingRefusals.size) return;
  const feats = [...pendingFeatures.values()];
  const refs = [...pendingRefusals.values()];
  pendingFeatures.clear();
  pendingRefusals.clear();
  const exists = database.prepare("SELECT 1 FROM users WHERE id = ?");
  // An account deleted since the count was taken keeps no row under its id.
  const alive = (row) => !row.user_id || Boolean(exists.get(row.user_id));
  const feat = database.prepare(
    `INSERT INTO feature_usage (day, feature, who, user_id, tier, uses) VALUES (@day, @feature, @who, @user_id, @tier, @uses)
     ON CONFLICT(day, feature, who) DO UPDATE SET uses = uses + excluded.uses, tier = COALESCE(excluded.tier, tier)`,
  );
  const ref = database.prepare(
    `INSERT INTO refusal_usage (day, code, route, who, user_id, count) VALUES (@day, @code, @route, @who, @user_id, @count)
     ON CONFLICT(day, code, route, who) DO UPDATE SET count = count + excluded.count`,
  );
  for (const row of feats) if (alive(row)) feat.run(row);
  for (const row of refs) if (alive(row)) ref.run(row);
};

/** The first time an account reaches a milestone; later ones change nothing. */
const milestone = (userId, name, at = Date.now()) => {
  if (!on() || !userId || !MILESTONES.includes(name)) return false;
  const id = String(userId);
  let known = reached.get(id);
  if (!known) {
    if (reached.size > 5000) reached.clear();
    known = new Set();
    reached.set(id, known);
  }
  if (known.has(name)) return false;
  known.add(name);
  try {
    return db().prepare("INSERT OR IGNORE INTO account_milestones (user_id, milestone, at) SELECT id, ?, ? FROM users WHERE id = ?").run(name, isoOf(at), id).changes > 0;
  } catch {
    return false;
  }
};

const safely = (fn) => {
  if (!on()) return null;
  try {
    return fn();
  } catch {
    return null;
  }
};

// ── A draft's life ─────────────────────────────────────────────────────────

const draftOpened = (id, userId = null, at = Date.now()) =>
  safely(() => {
    liveDrafts.add(String(id));
    notDrafts.delete(String(id));
    db().prepare("INSERT OR IGNORE INTO draft_ledger (id, user_id, opened_at) VALUES (?, ?, ?)").run(String(id), userId ? String(userId) : null, isoOf(at));
  });

// A working copy that is no draft is asked once, then remembered as none.
const isDraft = (id) => {
  const key = String(id || "");
  if (!key || notDrafts.has(key)) return false;
  if (liveDrafts.has(key)) return true;
  const found = Boolean(safely(() => db().prepare("SELECT 1 FROM draft_ledger WHERE id = ? AND closed_at IS NULL").get(key)));
  if (found) liveDrafts.add(key);
  else {
    if (notDrafts.size > 5000) notDrafts.clear();
    notDrafts.add(key);
  }
  return found;
};

/** Work written in a draft: a retouche by hand, or a turn of the brief (which makes it a brief's draft). */
const draftWorked = (id, { kind = "hand", retouches = 0, turns = 0, at = Date.now() } = {}) => {
  if (!isDraft(id)) return null;
  return safely(() =>
    db()
      .prepare(
        `UPDATE draft_ledger SET worked_at = COALESCE(worked_at, @at), retouches = retouches + @retouches, turns = turns + @turns,
           kind = CASE WHEN @kind = 'brief' OR kind = 'brief' THEN 'brief' ELSE 'hand' END WHERE id = @id`,
      )
      .run({ id: String(id), at: isoOf(at), retouches, turns, kind }),
  );
};

const draftDecided = (id, at = Date.now()) => (isDraft(id) ? safely(() => db().prepare("UPDATE draft_ledger SET decided_at = COALESCE(decided_at, ?) WHERE id = ?").run(isoOf(at), String(id))) : null);

/** `as`: applied or dropped. */
const draftClosed = (id, as, at = Date.now()) => {
  const key = String(id || "");
  if (!key) return null;
  liveDrafts.delete(key);
  return safely(() => db().prepare("UPDATE draft_ledger SET closed_at = ?, closed_as = ? WHERE id = ? AND closed_at IS NULL").run(isoOf(at), as === "applied" ? "applied" : "dropped", key));
};

const kindOfDraft = (id) => safely(() => (db().prepare("SELECT kind FROM draft_ledger WHERE id = ?").get(String(id || "")) || {}).kind) || null;

const count = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.round(Number(n)) : 0);

/** One turn of the brief's agent, as its event says it. */
const briefTurn = ({ draftId = null, userId = null, reason, demands, done, not_done, unproven, not_asked, corrections, agent_rounds, reviewer_rounds, durationMs, failed = null, at = Date.now() } = {}) =>
  safely(() =>
    db()
      .prepare(
        `INSERT INTO brief_turns (at, draft_id, user_id, reason, demands, done, not_done, unproven, not_asked, corrections, agent_rounds, reviewer_rounds, duration_ms, failed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(isoOf(at), draftId ? String(draftId) : null, userId ? String(userId) : null, String(reason || "error").slice(0, 20), count(demands), count(done), count(not_done), count(unproven), count(not_asked), count(corrections), count(agent_rounds), count(reviewer_rounds), count(durationMs), failed ? String(failed).slice(0, 60) : null),
  );

// ── Plain counts per day ───────────────────────────────────────────────────

const NAME = /^[a-z][a-z0-9_.|-]{0,79}$/;

/** A count of the day under a kind and a key, tied to no one (a table retouched, an answer rated). */
const tally = (kind, key, n = 1, at = Date.now()) =>
  safely(() =>
    db()
      .prepare("INSERT INTO product_counts (day, kind, key, count) VALUES (?, ?, ?, ?) ON CONFLICT(day, kind, key) DO UPDATE SET count = count + excluded.count")
      .run(dayOf(at), String(kind), String(key).slice(0, 80), count(n) || 1),
  );

// ── Searches that found nothing ────────────────────────────────────────────

const TERM = /^[\p{L}\p{N}][\p{L}\p{N} '’.-]{1,59}$/u;

/** The words as typed, lower-cased, without the visitor: a place's or a network's name, never an address or a number. */
const searchMiss = (kind, term, at = Date.now()) => {
  const words = String(term || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!TERM.test(words) || /@|\d{4,}/.test(words)) return null;
  return tally(`search.${String(kind).slice(0, 20)}`, words, 1, at);
};

// ── The licences, day by day ───────────────────────────────────────────────

const monthlyOf = (source, period) => {
  if (source === "subscription" && period === "month") return config.LICENCE_PRICE_EUR_MONTH;
  // A licence granted on a quote is counted at the list price: no amount is kept for it.
  return config.LICENCE_PRICE_EUR_YEAR / 12;
};

/** The paying licences of a moment: a subscription or a client's grant, on an account that can sign in. */
const payingNow = (now = Date.now()) => {
  const store = require("../accounts/store");
  const owners = new Set(config.ADMIN_EMAILS || []);
  return store.withAccountsIndex(
    () =>
      store
        .listUsers()
        .filter((u) => !u.disabled && !owners.has(String(u.email || "").toLowerCase()))
        .map((user) => {
          const sub = store.subscriptionOf(user.id);
          const licence = store.licenceOf(user, sub, now);
          if (!licence.active || !["subscription", "admin"].includes(licence.source)) return null;
          const period = licence.source === "subscription" ? (sub && sub.period) || "year" : null;
          return { user_id: user.id, source: licence.source, period, mrr_eur: Math.round(monthlyOf(licence.source, period) * 100) / 100 };
        })
        .filter(Boolean),
    now,
  );
};

/** Today's licences, written over the day's earlier snapshot. */
const snapshotLicences = (now = Date.now()) =>
  safely(() => {
    const day = dayOf(now);
    const rows = payingNow(now);
    const database = db();
    database.transaction(() => {
      database.prepare("DELETE FROM licence_days WHERE day = ?").run(day);
      const put = database.prepare("INSERT INTO licence_days (day, user_id, source, period, mrr_eur) VALUES (?, ?, ?, ?, ?)");
      for (const r of rows) put.run(day, r.user_id, r.source, r.period, r.mrr_eur);
    })();
    return rows;
  });

// ── What the server's own events say ───────────────────────────────────────

const reqLike = ({ userId, ip, userAgent }) => ({ ip: ip || "", headers: { "user-agent": userAgent || "" }, user: userId ? { id: userId } : null });

/** Called by the event logger for every event it records; reads the few that mark a milestone or a draft's life. */
const onEvent = (type, { userId = null, session = null, ip = null, userAgent = null, data = {} } = {}) => {
  if (!on()) return;
  try {
    // Some events carry their facts one level down (`data.data`).
    if (data && data.data && typeof data.data === "object") data = data.data;
    const who = (data && data.user_id) || userId || null;
    const funnel = () => require("./funnel");
    switch (type) {
      case "upload": {
        const door = data.is_sample ? "demo" : data.source === "catalog" ? "catalog" : "upload";
        if (!data.is_sample) milestone(who, "network");
        funnel().record(reqLike({ userId: who, ip, userAgent }), "network.opened", door, { userId: who });
        break;
      }
      case "draft.opened":
        milestone(who, "draft");
        if (data.draft) draftOpened(data.draft, who);
        break;
      case "mutation.applied": {
        if (session) draftWorked(session, { kind: "hand", retouches: 1 });
        const key = `${data.entity || "other"}|${data.action || "other"}|${data.kind === "sql_console" ? "sql" : "form"}`.toLowerCase();
        if (NAME.test(key)) tally("retouch", key, data.count);
        break;
      }
      case "chat.feedback":
        tally("rating", data.rating === "up" || data.rating === 1 || data.rating === "positive" ? "up" : "down");
        break;
      case "chat.turn":
        tally("assistant", data.reader ? "reader" : data.anon ? "visitor" : "licence");
        break;
      case "transform.direct":
        milestone(who, "brief");
        if (session) draftWorked(session, { kind: "brief", turns: 1 });
        briefTurn({ draftId: session && isDraft(session) ? session : null, userId: who, reason: data.reason, demands: data.demands, done: data.done, not_done: data.not_done, unproven: data.unproven, not_asked: data.not_asked, corrections: data.corrections, agent_rounds: data.agent_rounds, reviewer_rounds: data.reviewer_rounds, durationMs: data.durationMs, failed: data.error || data.agent_error || data.review_error || null });
        break;
      case "transform.commit":
        milestone(who, "applied");
        funnel().record(reqLike({ userId: who, ip, userAgent }), "version.applied", data.way === "brief" ? "brief" : data.way === "hand" ? "hand" : "other", { userId: who });
        break;
      case "export.completed":
      case "workspace.package":
      case "workspace.delivered":
        milestone(who, "export");
        break;
      case "workspace.member":
        milestone(who, "invite");
        break;
      default:
    }
  } catch {
    /* a count never stands in the way of the event */
  }
};

const purge = (cutoffIso) =>
  safely(() => {
    const day = cutoffIso.slice(0, 10);
    const out = {};
    for (const table of ["feature_usage", "refusal_usage", "product_counts"]) out[table] = db().prepare(`DELETE FROM ${table} WHERE day < ?`).run(day).changes;
    out.brief_turns = db().prepare("DELETE FROM brief_turns WHERE at < ?").run(cutoffIso).changes;
    out.draft_ledger = db().prepare("DELETE FROM draft_ledger WHERE opened_at < ? AND closed_at IS NOT NULL").run(cutoffIso).changes;
    return out;
  });

const reset = () => {
  pendingFeatures.clear();
  pendingRefusals.clear();
  reached.clear();
  liveDrafts.clear();
  notDrafts.clear();
};

module.exports = {
  MILESTONES,
  TIERS,
  PAYWALL_CODES,
  DAY_MS,
  tierOf,
  useFeature,
  refuse,
  noteRequest,
  flushInto,
  milestone,
  draftOpened,
  draftWorked,
  draftDecided,
  draftClosed,
  kindOfDraft,
  briefTurn,
  tally,
  searchMiss,
  payingNow,
  snapshotLicences,
  onEvent,
  purge,
  _internals: { reset, pending: () => ({ features: pendingFeatures, refusals: pendingRefusals }) },
};
