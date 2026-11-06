/**
 * The network's days for the reader's strip: the server reads each date's class and the trips it runs (GET /days,
 * the network's or a line's); the browser keeps what it read for the session and words the classes in its language.
 */

import { useEffect, useState } from "react";
import API_BASE_URL from "../config";
import { requestJson } from "./apiRequest";
import { localeOf } from "./formatDate";

const MAX_KEPT = 64;
const kept = new Map();

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

/** The days read for `key` (the session and data version) and `routeId`, null until read or when the read failed. */
export const useNetworkDays = ({ key, routeId = null, enabled = true }) => {
  const id = `${key}|${routeId || ""}`;
  const [days, setDays] = useState(() => (enabled ? kept.get(id) || null : null));
  useEffect(() => {
    if (!enabled) return undefined;
    if (kept.has(id)) {
      setDays(kept.get(id));
      return undefined;
    }
    const controller = new AbortController();
    getNetworkDays({ routeId, signal: controller.signal })
      .then((data) => {
        const read = sound(data);
        if (!read) return;
        kept.set(id, read);
        while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value);
        if (!controller.signal.aborted) setDays(read);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [id, routeId, enabled]);
  return enabled ? days : null;
};

export const _forgetNetworkDays = () => kept.clear();

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
