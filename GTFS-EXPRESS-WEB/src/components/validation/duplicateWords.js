/**
 * A duplicate group in the person's words: what it is (« Course 12-A-0705 », « Arrêt 34F »), and what each copy
 * holds (a trip's first and last times and its calls, else the values that differ).
 */

const NOUNS = {
  stop_times: ["trip_id", "trip"],
  frequencies: ["trip_id", "trip"],
  trips: ["trip_id", "trip"],
  shapes: ["shape_id", "shape"],
  calendar: ["service_id", "service"],
  calendar_dates: ["service_id", "service"],
  stops: ["stop_id", "stop"],
  routes: ["route_id", "route"],
  route_networks: ["route_id", "route"],
};

export const groupLabelOf = (group, t) => {
  const noun = NOUNS[group?.table];
  if (noun && group.key?.[noun[0]] != null) return t(`duplicates.label.${noun[1]}`, { id: group.key[noun[0]] });
  return t("duplicates.label.other", { file: group?.file || "", key: Object.values(group?.key || {}).join(" · ") });
};

const clock = (v) => (/^\d{1,3}:\d{2}:\d{2}$/.test(String(v || "")) ? String(v).slice(0, -3) : v || "—");

/** One copy of a group, `side` "shown" (the network's) or "copy" (the duplicate aside). */
export const copyWordsOf = (group, side, t) => {
  const trip = group?.[side];
  if (trip && trip.calls != null) return t("duplicates.trip.calls", { first: clock(trip.first), last: clock(trip.last), count: trip.calls });
  const rows = group?.rows || [];
  const values = (rows[0]?.differing || []).slice(0, 2).map((d) => `${d.column} ${(side === "shown" ? d.shown : d.copy) || "—"}`);
  const more = rows.length > 1 ? ` ${t("duplicates.moreRows", { count: rows.length - 1 })}` : "";
  return `${values.join(" · ") || "—"}${more}`;
};

/** The key that names a row within its group (« stop_sequence 4 »), its group's own key left out. */
export const rowKeyOf = (group, row) =>
  Object.entries(row?.key || {})
    .filter(([c]) => !(c in (group?.key || {})))
    .map(([c, v]) => `${c} ${v}`)
    .join(" · ");
