// Screenshots of Home's showcase, taken in the lab by e2e/tools/showcase-shots.mjs (a change's on the screens bench).
// French for a French reader, English for every other language.
export const readerShot = (name, mode, language) => `/img/${language === "fr" ? "fr" : "en"}/${mode === "dark" ? "Dark" : "Light"}_${name}.webp`;

// Home's showcase, in its tabs' order of priority. A change is shown by a brief's decision, the way most changes go.
export const SHOWCASE = [
  { key: "reader", file: "Show_Reader" },
  { key: "shapes", file: "Show_Shapes" },
  { key: "modify", file: "Show_Brief" },
  { key: "sheets", file: "Show_Sheets" },
  { key: "sql", file: "Show_Sql" },
];
