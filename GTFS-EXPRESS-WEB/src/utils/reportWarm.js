/**
 * The report made ready before it is opened. A network whose validator found something will have its report read: as
 * soon as the browser is idle, the server is asked to compute the corrections ahead (a job nobody waits for, which
 * gives way to any work a person does), the page's code is loaded, and what the page opens on is kept where it looks
 * for it (utils/reportStore). A server that plans no correction answers nothing, and nothing more is asked.
 */

import { useEffect } from "react";
import API_BASE_URL from "../config";
import { fetchWithSession, validatedSession } from "./sessionManager";
import { KEPT, dropKept, readKept, useKeptValue, writeKept } from "./reportStore";

// How often the server is asked where it is, and for how long: five minutes, a large network's reading several times.
const POLL_MS = 2500;
const MAX_POLLS = 120;
// Where the browser has no idle callback.
const IDLE_MS = 800;
const IDLE_AT_MOST_MS = 3000;
// A network being edited: asked once the edits have stopped, never after each of them.
const SETTLED_MS = 10000;

/** The report's page, loaded ahead of the click that opens it. */
export const preloadReportPage = () =>
  import("../components/ValidationErrorsPage").then(
    () => true,
    () => false,
  );

const bodyOf = async (res) => (res && res.ok ? res.json().catch(() => null) : null);

/** Asks the server to compute the report ahead: "ready", "running" or "started"; null where it plans none. */
export const warmReport = async () => {
  try {
    const body = await bodyOf(await fetchWithSession(`${API_BASE_URL}/edit/repair/warm`, { method: "POST" }));
    return body && typeof body.state === "string" ? body.state : null;
  } catch {
    return null;
  }
};

// Read once the server holds them: both are answered from what it kept.
const keepOpening = async (dataVersion, still) => {
  try {
    const [plan, announced] = await Promise.all([fetchWithSession(`${API_BASE_URL}/edit/repair/plan`).then(bodyOf), fetchWithSession(`${API_BASE_URL}/edit/repair/bundle`).then(bodyOf)]);
    if (!still()) return;
    if (plan && plan.mark != null && plan.safe && typeof plan.safe === "object") writeKept(KEPT.plan, plan, dataVersion);
    if (announced && Array.isArray(announced.steps)) writeKept(KEPT.announced([], [], {}, false), announced, dataVersion);
  } catch {
    /* the page reads them itself when it opens */
  }
};

/**
 * Makes the open network's report ready while the person reads something else: only where its validator's report
 * counts an error or a warning, once for a network and a version of its data. `editing` says the data is being
 * changed: the report is then made ready once the changes have stopped.
 */
export function useReportWarm(report, dataVersion, { enabled = true, editing = false } = {}) {
  const found = report && !report.structural ? (Number(report.counts?.errors) || 0) + (Number(report.counts?.warnings) || 0) : 0;
  const worth = Boolean(enabled) && found > 0;
  const network = worth ? validatedSession() : null;
  useEffect(() => {
    if (!worth) return undefined;
    let alive = true;
    let timer = null;
    let polls = 0;
    const still = () => alive && validatedSession() === network;
    const ask = async () => {
      if (!still() || readKept(KEPT.plan, dataVersion)) return;
      const state = await warmReport();
      if (!still()) return;
      // No answer, or a job that ran out of memory on this network: nothing is being prepared, and asking again
      // would not change it.
      if (!state || state === "failed") {
        dropKept(KEPT.warming, dataVersion);
        return;
      }
      if (state === "ready") {
        await keepOpening(dataVersion, still);
        if (still()) dropKept(KEPT.warming, dataVersion);
        return;
      }
      writeKept(KEPT.warming, true, dataVersion);
      polls += 1;
      if (polls < MAX_POLLS) timer = setTimeout(ask, POLL_MS);
      else dropKept(KEPT.warming, dataVersion);
    };
    const start = () => {
      preloadReportPage();
      ask();
    };
    const idle = !editing && typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(start, { timeout: IDLE_AT_MOST_MS }) : null;
    const later = idle === null ? setTimeout(start, editing ? SETTLED_MS : IDLE_MS) : null;
    return () => {
      alive = false;
      if (validatedSession() === network) dropKept(KEPT.warming, dataVersion);
      clearTimeout(timer);
      clearTimeout(later);
      if (idle !== null && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idle);
    };
  }, [worth, dataVersion, network, editing]);
}

const sumOf = (c) => (Number(c?.error) || 0) + (Number(c?.warning) || 0) + (Number(c?.info) || 0);

/**
 * Where the open network's corrections stand, for a screen that leads to the report: { state, settled }. "ready" once
 * the one act was announced, with the findings it settles less those it brings out; "preparing" while it is being
 * computed ahead; null when nothing says (a clean network, a server that plans none).
 */
export function useReportReadiness(dataVersion) {
  const announced = useKeptValue(KEPT.announced([], [], {}, false), dataVersion);
  const warming = useKeptValue(KEPT.warming, dataVersion);
  if (announced && Array.isArray(announced.steps)) return { state: "ready", settled: Math.max(0, sumOf(announced.settles) - sumOf(announced.reveals)) };
  return { state: warming ? "preparing" : null, settled: 0 };
}
