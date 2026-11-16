// Screenshots of Home's showcase, taken in the lab by e2e/tools/showcase-shots.mjs (a change's on the screens bench).
// Bundled under a content hash: a screenshot taken again reaches a browser that cached the one before.
// French for a French reader, English for every other language.
const SHOTS = import.meta.glob("../../assets/showcase/*/*.webp", { eager: true, query: "?url", import: "default" });

export const readerShot = (name, mode, language) => SHOTS[`../../assets/showcase/${language === "fr" ? "fr" : "en"}/${mode === "dark" ? "Dark" : "Light"}_${name}.webp`] || null;

// Home's showcase, in its tabs' order of priority. A change is shown by a brief's decision, the way most changes go.
export const SHOWCASE = [
  { key: "reader", file: "Show_Reader" },
  { key: "shapes", file: "Show_Shapes" },
  { key: "modify", file: "Show_Brief" },
  { key: "sheets", file: "Show_Sheets" },
  { key: "sql", file: "Show_Sql" },
  { key: "aggregate", file: "Show_Aggregate" },
];

// The screens Home's head slides through, in order; the aggregate's only where the server runs it.
export const SLIDES = ["reader", "modify", "aggregate", "sheets", "shapes"].map((key) => SHOWCASE.find((s) => s.key === key));
export const slidesOf = (features) => (features?.aggregate?.enabled ? SLIDES : SLIDES.filter((s) => s.key !== "aggregate"));
