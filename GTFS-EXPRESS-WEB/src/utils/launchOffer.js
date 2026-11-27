/** The licence's launch price as the server states it (GET /config/plans, the « pro » plan's `launch`). */
export const launchOf = (pro) => {
  const offer = Boolean(pro && pro.launch && pro.launch.offer);
  return { offer, until: offer ? pro.launch.until || null : null };
};

/** « Tarif de lancement jusqu'au 31 mars 2027 »: a calendar day, read in UTC so that no zone moves it. */
export const launchUntilText = (t, until, language) => {
  let date = until;
  try {
    date = new Intl.DateTimeFormat(language || "fr", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${until}T00:00:00Z`));
  } catch {
    /* an unknown language: the day as the server gave it */
  }
  return t("licence.launchUntil", { date });
};

/** The note under the yearly price: the launch said (and its last day when announced), else per account. */
export const priceNoteOf = (t, launch, language) =>
  launch.until ? `${launchUntilText(t, launch.until, language)} · ${t("licence.priceNote.plain")}` : t(launch.offer ? "licence.priceNote.launch" : "licence.priceNote.plain");
