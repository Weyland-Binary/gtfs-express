/**
 * A calendar date written YYYYMMDD, judged the same way by what reads a network and by what edits one. Apart from the
 * editors' field checks (utils/fieldValidators, of the hosted edition), so that reading a network needs none of them.
 */

"use strict";

const DATE_YYYYMMDD_RE = /^\d{8}$/;
// The years a service date can mean. A day written 99991231 or 00010101 is a slip of the hand, and a calendar that
// runs to it stretches every reading of the network's days; the web's date fields hold the same window.
const DATE_YEAR_MIN = 1900;
const DATE_YEAR_MAX = 2099;

/** A real calendar day written YYYYMMDD, of the years 1900 to 2099: 20260230 and 99991231 are refused. */
const isValidYYYYMMDDDate = (value) => {
  const s = String(value);
  if (!DATE_YYYYMMDD_RE.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  if (y < DATE_YEAR_MIN || y > DATE_YEAR_MAX) return false;
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
};

module.exports = { DATE_YYYYMMDD_RE, DATE_YEAR_MIN, DATE_YEAR_MAX, isValidYYYYMMDDDate };
