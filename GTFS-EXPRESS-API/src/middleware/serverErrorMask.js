/**
 * Many catch blocks answer res.status(500).json({ error: err.message }) past the central handler and would send a
 * SQLite message or a server path to the browser. In production a 500 keeps its CODE and loses its message, as does
 * any 5xx without a CODE; a typed refusal past 500 (502, 503: its message is written for the person) and the SQL
 * console's errors (the person's own SQL) stay as written. Each catch logs before it answers.
 */

"use strict";

const GENERIC = "An internal server error occurred.";
const CODE = /^[A-Z][A-Z0-9_]+$/;
// As Express routes it: case-insensitive, an optional trailing slash.
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
