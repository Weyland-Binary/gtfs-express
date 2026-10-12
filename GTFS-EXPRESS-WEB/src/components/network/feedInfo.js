/**
 * feedInfo — how a published GTFS feed reads in a list, the same way in
 * the studio's "Existing network", the landing's "find my network" dialog
 * and the planner's hand-off card: its title (the network on the National
 * Access Point, the provider on the Mobility Database), a detail line
 * (resource, coverage, size), its validity (an expired feed is flagged)
 * and whether it runs trains.
 */

export const RAIL = new Set(["rail", "train", "tram", "subway", "metro", "funicular"]);

/** YYYYMMDD (or YYYY-MM-DD) → a date in the reader's language. */
export const fmtDate = (d, language) => {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(String(d || ""));
  if (!m) return "";
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString(language || undefined, { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
};

const ymd = (d) => String(d || "").replace(/-/g, "").slice(0, 8);
const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};

/** How current a feed is: a phrase, a colour, and whether it expired (from its dates when the catalogue gave no status). */
export const validityOf = (f, t, language) => {
  if (!f) return null;
  const start = ymd(f.validity?.start);
  const end = ymd(f.validity?.end);
  const status = f.status || (end && end < todayYmd() ? "expired" : start && start > todayYmd() ? "future" : end ? "current" : null);
  if (status === "expired" && end) return { text: t("feeds.expired", { date: fmtDate(end, language) }), color: "warning.main", expired: true };
  if (status === "future" && start) return { text: t("feeds.startsOn", { date: fmtDate(start, language) }), color: "info.main", expired: false };
  if (status === "current" && end) return { text: t("feeds.validUntil", { date: fmtDate(end, language) }), color: "text.secondary", expired: false };
  if (f.source === "mdb" && f.snapshot) return { text: t("feeds.snapshot", { date: fmtDate(f.snapshot, language) }), color: "text.secondary", expired: false };
  return null;
};

/** The access point names a network (its operator aside); the Mobility Database, a provider. */
export const feedTitle = (f) => (f?.source === "pan" ? f.name || f.provider : f?.provider || f?.name) || "";

/** Resource, coverage and size on one line. */
export const feedDetail = (f, t, language) => {
  const title = feedTitle(f);
  const size = f?.stats?.routes != null && f?.stats?.trips != null ? t("feeds.size", { routes: f.stats.routes.toLocaleString(language), trips: f.stats.trips.toLocaleString(language) }) : null;
  const subtitle = f?.source === "pan" ? (f.resource_title && f.resource_title !== title ? f.resource_title : null) : f?.name && f.name !== title ? f.name : null;
  return [subtitle, f?.coverage || f?.municipality || f?.region, size].filter(Boolean).join(" · ");
};

export const isRailFeed = (f) => (f?.modes || []).some((m) => RAIL.has(String(m).toLowerCase()));
