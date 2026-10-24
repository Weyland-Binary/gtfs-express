/**
 * Loads a query into the SQL console, as FixInSqlConsoleButton does: the sessionStorage seed serves a console not
 * yet mounted, the event one already mounted, and the validation report is closed first because the two render
 * exclusively (showSqlConsole would otherwise do nothing).
 */

import {
  CURRENT_QUERY_KEY,
} from "../SqlConsole/constants";
import { CLOSE_VALIDATION_REPORT_EVENT, SET_QUERY_EVENT } from "../../utils/appEvents";

/** `autorun` defaults to false: the person reads the SQL before running it. */
export const openInSqlConsole = (sql, showSqlConsole, opts = {}) => {
  if (!sql || typeof sql !== "string") return;
  const autorun = opts.autorun === true;

  try {
    sessionStorage.setItem(CURRENT_QUERY_KEY, sql);
  } catch {
    /* sessionStorage disabled */
  }

  try {
    window.dispatchEvent(new CustomEvent(CLOSE_VALIDATION_REPORT_EVENT));
  } catch {
    /* CustomEvent unsupported */
  }

  try {
    window.dispatchEvent(
      new CustomEvent(SET_QUERY_EVENT, { detail: { query: sql, autorun } }),
    );
  } catch {
    /* CustomEvent unsupported: the sessionStorage seed still works */
  }

  if (typeof showSqlConsole === "function") showSqlConsole();
};
