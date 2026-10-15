/* ------------------------------------------------------------------ */
/* Number / time formatters used by the toolbar, history list, and    */
/* result-count chips.                                                  */
/* ------------------------------------------------------------------ */

export const formatHumanCount = (n) => {
  if (n == null) return "—";
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
};

export const formatRowCount = (n) => {
  if (n == null) return "0";
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
};

export const formatRelative = (timestamp, t) => {
  const diff = Math.max(0, Date.now() - timestamp);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return t("sqlConsole.history.justNow");
  const min = Math.floor(sec / 60);
  if (min < 60) return t("sqlConsole.history.minutesAgo", { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("sqlConsole.history.hoursAgo", { count: hr });
  const day = Math.floor(hr / 24);
  return t("sqlConsole.history.daysAgo", { count: day });
};
