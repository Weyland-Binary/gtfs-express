/**
 * edit/actorContext.js — who makes an edit, carried from the request to the
 * edit log without threading it through every edit service (target design
 * §1 « Journal », §5.1, D20, WP10).
 *
 * The journal says who did what, when and why. An edit of the working copy
 * is written by one of sixty-odd `logEdit` calls in a dozen services, all of
 * them reached from an HTTP request; rather than adding a parameter to each
 * of them, this module keeps the request's actor in an AsyncLocalStorage the
 * middleware opens for the request, and the two writers of `_edit_log`
 * (edit/_editCore.logEdit and edit/shapeEditService.logEdit) read it:
 *
 *   actor        the account's id when the person is signed in (ACCOUNTS_ENABLED),
 *                else null — an anonymous edit has no account to name
 *   actor_name   the account's display name when signed in (the server knows it);
 *                otherwise the name this browser remembers for its acknowledgements
 *                (gtfs:ack-name), sent URI-encoded in X-Actor-Name — a declared
 *                name, kept as such: 2–120 characters with a letter (NAME_OK), or
 *                nothing
 *   reason       why: "manual" for a direct retouch (D20, the default), "plan" for a
 *                change plan applied (transform/engine passes it), "sql" for the SQL
 *                console — given by the writer, never by the request
 *
 * Outside a request (a script, a test calling a service directly) there is no
 * actor: the columns stay null and the reason is the writer's.
 */

"use strict";

const { AsyncLocalStorage } = require("async_hooks");

const storage = new AsyncLocalStorage();
const NAME_MAX = 120;

/** A declared name, as acknowledgements accept one (2–120 characters with a letter), or null. */
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

/** The actor of a request: { actor, actor_name }. */
const actorOf = (req) => {
  const user = req?.user || null;
  const signedName = cleanName(user?.display_name || "");
  return { actor: user?.id ? String(user.id) : null, actor_name: signedName || cleanName(req?.headers?.["x-actor-name"]) || null };
};

/** Express middleware: the rest of the request runs with its actor known. */
const actorContext = (req, _res, next) => storage.run(actorOf(req), () => next());

/** The current request's actor ({ actor, actor_name }), or nulls outside a request. */
const currentActor = () => storage.getStore() || { actor: null, actor_name: null };

/** Run `fn` as `actor` (tests, and a server task acting for a person). */
const runAs = (actor, fn) => storage.run({ actor: actor?.actor ?? null, actor_name: cleanName(actor?.actor_name || "") }, fn);

/**
 * The actor columns of an edit-log row: { actor, actor_name, reason }. `reason`
 * is the writer's ("manual" unless it says otherwise); `actorName` overrides the
 * request's name when the writer knows better (the name of a named
 * acknowledgement carried by a change plan).
 */
const editColumns = ({ reason = "manual", actorName = null } = {}) => {
  const { actor, actor_name } = currentActor();
  return { actor, actor_name: cleanName(actorName || "") || actor_name || null, reason: reason || "manual" };
};

module.exports = { actorContext, actorOf, currentActor, runAs, editColumns, cleanName };
