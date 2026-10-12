/**
 * refusal — a typed refusal: an Error that carries the HTTP status, a stable
 * code and the details a handler answers verbatim as { error: code, message,
 * ...details }. Shared by the change engine, the validator gate and the
 * acknowledgement record (moved out of transform/engine.js so those modules
 * need no require cycle to refuse the same way).
 *
 *   refusal(status, code, message, details = null) → Error & { status, code, details? }
 */

"use strict";

const refusal = (status, code, message, details = null) => Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

module.exports = { refusal };
