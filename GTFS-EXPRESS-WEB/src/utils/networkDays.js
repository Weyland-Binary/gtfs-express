/**
 * The network's days for the reader's strip: the server reads each date's class and the trips it runs (GET /days,
 * the network's or a line's); the browser keeps what it read last for a session and a line, shows it while it is read
 * again, and words the classes in its language.
 */

import { useEffect, useState } from "react";
import API_BASE_URL from "../config";
import { requestJson } from "./apiRequest";
import { localeOf } from "./formatDate";

const MAX_KEPT = 64;
// A read that takes longer than SLOW_READ_MS is the server modelling a large network again: the next one waits until
// the data stood still for QUIET_MS, so a burst of edits costs it one read.
const SLOW_READ_MS = 300;
export const QUIET_MS = 1500;
// "session|line" → { version, days, ms }: the days last read for a session and a line, and how long the read took.
const kept = new Map();
// "session|line" → when the read still out was sent.
const out = new Map();

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export const getNetworkDays = ({ routeId = null, signal } = {}) => {
  const q = new URLSearchParams({ today: localToday() });
  if (routeId) q.set("route_id", routeId);
  return requestJson(`${API_BASE_URL}/days?${q}`, signal ? { signal } : {});
};

const sound = (data) => data && Array.isArray(data.days) && Array.isArray(data.classes) && data.window?.from ? data : null;

/**
 * The days of the session `session` and of `routeId` (the network's without one), null until read or when they
 * cannot be read. They are read again each time the session's data `version` moves; the days read before stay
 * meanwhile, never another line's nor another session's.
 */
export const useNetworkDays = ({ session, version, routeId = null, enabled = true }) => {
  const scope = `${session}|${routeId || ""}`;
  const [, landed] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const have = kept.get(scope);
    if (have && have.version === version) return undefined;
    const controller = new AbortController();
    const read = () => {
      const sent = Date.now();
      out.set(scope, sent);
      const settle = (entry) => {
        if (out.get(scope) === sent) out.delete(scope);
        if (controller.signal.aborted) return;
        kept.delete(scope);
        if (entry) kept.set(scope, entry);
        while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value);
        landed((n) => n + 1);
      };
      getNetworkDays({ routeId, signal: controller.signal })
        .then((data) => {
          const days = sound(data);
          settle(days ? { version, days, ms: Date.now() - sent } : null);
        })
        // Days that cannot be read again say nothing of the data as it now stands.
        .catch(() => settle(null));
    };
    const slow = (have && have.ms > SLOW_READ_MS) || (out.has(scope) && Date.now() - out.get(scope) > SLOW_READ_MS);
    const timer = have && slow ? setTimeout(read, QUIET_MS) : null;
    if (!timer) read();
    return () => {
      if (timer) clearTimeout(timer);
      controller.abort();
    };
  }, [scope, version, routeId, enabled]);
  return enabled ? kept.get(scope)?.days || null : null;
};

export const _forgetNetworkDays = () => {
  kept.clear();
  out.clear();
};

const DOWS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
// A Monday, for the weekday names: 2024-01-01.
const dowName = (dow, language, width = "long") => {
  const name = new Intl.DateTimeFormat(localeOf(language), { weekday: width }).format(new Date(2024, 0, 1 + DOWS.indexOf(dow)));
  return name.charAt(0).toUpperCase() + name.slice(1);
};

/** Consecutive days of the week as { from, to }, else null. */
const dowRun = (dows) => {
  const set = new Set(dows);
  if (set.size === 7) return { from: "mon", to: "sun" };
  if (!set.size) return null;
  for (let start = 0; start < 7; start++) {
    if (!set.has(DOWS[start]) || set.has(DOWS[(start + 6) % 7])) continue;
    let n = 0;
    while (n < 7 && set.has(DOWS[(start + n) % 7])) n += 1;
    return n === set.size ? { from: DOWS[start], to: DOWS[(start + n - 1) % 7] } : null;
  }
  return null;
};

const dateOf = (iso) => new Date(`${iso}T12:00:00`);

/** "19 oct. – 1 nov." in the interface's language. */
export const formatDateRange = (from, to, language) => {
  const fmt = new Intl.DateTimeFormat(localeOf(language), { day: "numeric", month: "short" });
  if (from === to) return fmt.format(dateOf(from));
  return typeof fmt.formatRange === "function" ? fmt.formatRange(dateOf(from), dateOf(to)) : `${fmt.format(dateOf(from))} – ${fmt.format(dateOf(to))}`;
};

const dowsLabel = (dows, language, t) => {
  const run = dowRun(dows);
  if (run && run.from !== run.to) return t("days.range", { from: dowName(run.from, language), to: dowName(run.to, language) });
  return dows.map((d) => dowName(d, language)).join(", ");
};

/** A class's label: its days of the week, "and public holidays" when it holds them, a block's name or its dates. */
export const classLabelOf = (cls, language, t) => {
  if (!cls) return "";
  if (cls.kind === "alt") {
    if (cls.name) return cls.name;
    return t("days.class.block", { dates: (cls.ranges || []).map(([a, b]) => formatDateRange(a, b, language)).join(", ") });
  }
  const days = dowsLabel(cls.dows || [], language, t);
  return cls.kind === "rest" && cls.holidays?.length ? t("days.class.holidays", { days }) : days;
};
