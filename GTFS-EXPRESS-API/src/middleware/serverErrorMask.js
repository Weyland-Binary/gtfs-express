/**
 * serverErrorMask — a server error never shows its message in production.
 *
 * The central error handler (app.js) hides a 500's message in production, but
 * about a hundred catch blocks answer res.status(500).json({ error:
 * err.message }) themselves, past it: a SQLite message, a path of the server
 * (« ENOENT … /app/uploads/<session>/… »), a library's internals reached the
 * browser (the review of 2026-10-08). This guard wraps res.json once for every
 * route: in production a body sent with a 500 keeps its CODE (an `error`
 * written in UPPER_SNAKE) and loses its message for the central handler's
 * sentence; a body past 500 without a CODE does too. What stays as written:
 *   - a typed refusal past 500 (502, 503: capacity, the validator, the payment
 *     provider, a feature off), { error: CODE, message }: its message is ours,
 *     written for the person, and the web says it from its CODE;
 *   - the SQL console's routes (/sql…, /edit/sql…): the person reads the error
 *     of the SQL they wrote.
 * Each catch logs the error before it answers: nothing is lost for the logs.
 *
 *   serverErrorMask({ production }) → middleware
 *   maskedBody(status, body, path) → the body the browser receives
 */

"use strict";

const GENERIC = "An internal server error occurred.";
const CODE = /^[A-Z][A-Z0-9_]+$/;
// The SQL console, as Express routes it (case-insensitive, an optional trailing slash): the person's own SQL errors.
const SQL_CONSOLE = /^\/gtfs\/(edit\/)?sql(\/|$)/i;

const maskedBody = (status, body, path = "") => {
  if (!(status >= 500) || SQL_CONSOLE.test(path)) return body;
  const code = body && typeof body === "object" && typeof body.error === "string" && CODE.test(body.error) ? body.error : null;
  if (code && status !== 500) return body;
  return code ? { error: code, message: GENERIC } : { error: GENERIC };
};

const serverErrorMask =
  ({ production }) =>
  (req, res, next) => {
    if (!production) return next();
    const json = res.json.bind(res);
    res.json = (body) => json(maskedBody(res.statusCode, body, req.originalUrl.split("?")[0]));
    next();
  };

module.exports = { serverErrorMask, maskedBody, GENERIC };
