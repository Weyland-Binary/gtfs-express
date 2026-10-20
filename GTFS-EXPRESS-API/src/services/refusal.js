/**
 * refusal — a typed refusal: an Error that carries the HTTP status, a stable
 * code and the details a handler answers verbatim as { error: code, message,
 * ...details }. Shared by the change engine, the validator gate and the
 * acknowledgement record (a module of its own, so that those modules refuse
 * the same way without a require cycle).
 *
 *   refusal(status, code, message, details = null) → Error & { status, code, details? }
 */

"use strict";

const refusal = (status, code, message, details = null) => Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

module.exports = { refusal };
