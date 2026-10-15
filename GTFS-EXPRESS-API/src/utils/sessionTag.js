/**
 * utils/sessionTag — a session id as the logs may name it.
 *
 * Why: a session id is a bearer credential — whoever holds it reads and
 * changes the network it names (the web's routes.js says it never travels in
 * a link). The logs (upload, edit mode entry, export refusal, purge…) are
 * kept LOG_RETENTION_DAYS and copied into the backups, so one line holding
 * the id in clear would be enough to open someone's feed. Here the id
 * becomes a keyed tag, the same HMAC as
 * the addresses and e-mails of the event log (eventLogger.keyedHash), cut to
 * twelve hex characters: the lines of one session still correlate with each
 * other, and the tag opens nothing.
 *
 *   sessionTag(sessionId) → "s:3f9a0c21b7d4" ("s:-" for none)
 */

"use strict";

const { keyedHash } = require("../services/eventLogger");

const sessionTag = (sessionId) => (sessionId ? `s:${keyedHash(String(sessionId)).slice(0, 12)}` : "s:-");

module.exports = { sessionTag };
