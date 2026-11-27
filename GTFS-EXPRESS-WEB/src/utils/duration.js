/** A length of time in seconds as "1 h 30 min", "6 min 40 s" or "45 s"; "" when it is no number. */
export const durationLabel = (seconds) => {
  const total = Number(seconds);
  if (seconds == null || seconds === "" || !Number.isFinite(total) || total < 0) return "";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.round(total % 60);
  return [h ? `${h} h` : "", m ? `${m} min` : "", s || (!h && !m) ? `${s} s` : ""].filter(Boolean).join(" ");
};
