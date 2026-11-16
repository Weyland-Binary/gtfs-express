/**
 * An Error carrying an HTTP status, a stable code and details, answered as { error: code, message, ...details }.
 * A module of its own so every module refuses the same way without a require cycle.
 */

"use strict";

const refusal = (status, code, message, details = null) => Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

module.exports = { refusal };
