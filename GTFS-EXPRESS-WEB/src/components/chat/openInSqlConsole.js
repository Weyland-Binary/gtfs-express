/**
 * openInSqlConsole — Push a SQL string into the SQL Console and surface
 * the console panel.
 *
 * Mirrors the proven 4-step recipe from FixInSqlConsoleButton.js so the
 * behaviour is identical regardless of whether the source is the
 * Validation report (FixInSqlConsoleButton) or the chat assistant (here):
 *
 *   1. sessionStorage seed (CURRENT_QUERY_KEY) — survives unmount; the
 *      SqlConsole reads this in its useState initialiser, which is
 *      essential when the console is not yet mounted (we're navigating
 *      INTO it from elsewhere).
 *
 *   2. Dispatch "gtfs:close-validation-report" — the validation report and
 *      SQL Console are mutex-rendered in GTFSApp's view tree. Without this
 *      dismiss, calling `showSqlConsole()` while the validation report is
 *      open would be silently ignored (user sees nothing happen).
 *
 *   3. Dispatch SET_QUERY_EVENT — handles the case where the SQL Console
 *      IS already mounted. Idempotent with the sessionStorage seed.
 *
 *   4. Call `showSqlConsole()` — surfaces the panel (mutex flag).
 */

import {
  CURRENT_QUERY_KEY,
  SET_QUERY_EVENT,
} from "../SqlConsole/constants";

/**
 * @param {string}                sql              — query to load
 * @param {() => void}            showSqlConsole   — from useDetailPanel()
 * @param {{ autorun?: boolean }} [opts]           — `autorun` defaults to false
 *                                                    (the chat is read-only,
 *                                                    let the user inspect SQL
 *                                                    before re-running it)
 */
export const openInSqlConsole = (sql, showSqlConsole, opts = {}) => {
  if (!sql || typeof sql !== "string") return;
  const autorun = opts.autorun === true;

  try {
    sessionStorage.setItem(CURRENT_QUERY_KEY, sql);
  } catch {
    /* sessionStorage may be disabled — fall through */
  }

  try {
    window.dispatchEvent(new CustomEvent("gtfs:close-validation-report"));
  } catch {
    /* CustomEvent unsupported — fall through */
  }

  try {
    window.dispatchEvent(
      new CustomEvent(SET_QUERY_EVENT, { detail: { query: sql, autorun } }),
    );
  } catch {
    /* CustomEvent unsupported — sessionStorage seed will still work */
  }

  if (typeof showSqlConsole === "function") showSqlConsole();
};
