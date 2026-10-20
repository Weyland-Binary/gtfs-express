/**
 * The reader's screenshots on the demo network (public/img/{fr,en}/, taken in the lab by e2e/tools/home-shots.mjs),
 * shown by home/ReaderViewer: its four screens — overview, timetable, map, the assistant answering —, in the reader's
 * language (French for French, English for every other language) and the theme's mode.
 */

/** The screenshots' address: French for a French reader, English for every other language. */
export const readerShot = (name, mode, language) => `/img/${language === "fr" ? "fr" : "en"}/${mode === "dark" ? "Dark" : "Light"}_${name}.webp`;

export const READER_SHOTS = [
  { key: "overview", file: "Overview" },
  { key: "schedules", file: "Schedules" },
  { key: "map", file: "Map" },
  { key: "assistant", file: "Assistant" },
];
