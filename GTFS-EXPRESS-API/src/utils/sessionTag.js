/**
 * A session id as the logs may name it. A session id is a bearer credential and
 * the logs are kept and backed up, so they carry a keyed hash (eventLogger.keyedHash)
 * cut to twelve hex characters: one session's lines still correlate, the tag opens nothing.
 */

"use strict";

const { keyedHash } = require("../services/eventLogger");

const sessionTag = (sessionId) => (sessionId ? `s:${keyedHash(String(sessionId)).slice(0, 12)}` : "s:-");

module.exports = { sessionTag };
