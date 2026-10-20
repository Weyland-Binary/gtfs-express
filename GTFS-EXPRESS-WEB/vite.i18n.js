// i18n-split — one chunk per language (2026-10-11, the owner's « interface performante »): src/i18n/translations.js
// stays the single source the tooling reads (scripts/i18n-check.js, i18n-apply.js, refresh-facts.sh: one file,
// one block per language), but the app no longer ships every language in its first chunk — 3.4 MB of the 9.5 MB rendered.
// `virtual:i18n/<code>` is that language's block alone; the LanguageContext imports French statically (the app opens
// in French) and the others on demand, each its own chunk.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "src/i18n/translations.js");
const PREFIX = "virtual:i18n/";
const RESOLVED = `\0${PREFIX}`;

export default function i18nSplit() {
  let cache = null; // { mtime, dict }
  const dictionary = () => {
    const stat = fs.statSync(FILE);
    if (cache && cache.mtime === stat.mtimeMs) return cache.dict;
    // The file is one object literal and its default export: evaluated as a CommonJS module, nothing else runs.
    const source = fs.readFileSync(FILE, "utf8").replace(/export\s+default\s+translations;?\s*$/, "module.exports = translations;");
    const module = { exports: {} };
    vm.runInNewContext(source, { module }, { filename: FILE });
    cache = { mtime: stat.mtimeMs, dict: module.exports };
    return cache.dict;
  };
  return {
    name: "i18n-split",
    resolveId(id) {
      return id.startsWith(PREFIX) ? `${RESOLVED}${id.slice(PREFIX.length)}` : null;
    },
    load(id) {
      if (!id.startsWith(RESOLVED)) return null;
      const code = id.slice(RESOLVED.length);
      const dict = dictionary();
      if (!dict[code]) throw new Error(`i18n-split: no language "${code}" in translations.js`);
      this.addWatchFile(FILE);
      return `export default ${JSON.stringify(dict[code])};`;
    },
  };
}
