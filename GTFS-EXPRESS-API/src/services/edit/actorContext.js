/**
 * Who makes an edit, kept in an AsyncLocalStorage for the request so the edit log's writers read it without a
 * parameter through every edit service. The signed-in account's name wins over the declared X-Actor-Name header;
 * the reason is always the writer's, never the request's. Outside a request the actor is null.
 */

"use strict";

const { AsyncLocalStorage } = require("async_hooks");

const storage = new AsyncLocalStorage();
const NAME_MAX = 120;

/** A declared name as acknowledgements accept one, or null. */
const cleanName = (raw) => {
  if (typeof raw !== "string") return null;
  let text = raw;
  try {
    text = decodeURIComponent(raw);
  } catch {
    /* not URI-encoded: read as sent */
  }
  text = text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (text.length < 2 || text.length > NAME_MAX || !/\p{L}/u.test(text)) return null;
  return text;
};

const actorOf = (req) => {
  const user = req?.user || null;
  const signedName = cleanName(user?.display_name || "");
  return { actor: user?.id ? String(user.id) : null, actor_name: signedName || cleanName(req?.headers?.["x-actor-name"]) || null };
};

const actorContext = (req, _res, next) => storage.run(actorOf(req), () => next());

const currentActor = () => storage.getStore() || { actor: null, actor_name: null };

const runAs = (actor, fn) => storage.run({ actor: actor?.actor ?? null, actor_name: cleanName(actor?.actor_name || "") }, fn);

/** `actorName` overrides the request's name when the writer knows better (a named acknowledgement). */
const editColumns = ({ reason = "manual", actorName = null } = {}) => {
  const { actor, actor_name } = currentActor();
  return { actor, actor_name: cleanName(actorName || "") || actor_name || null, reason: reason || "manual" };
};

module.exports = { actorContext, actorOf, currentActor, runAs, editColumns, cleanName };
