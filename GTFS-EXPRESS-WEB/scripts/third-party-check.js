#!/usr/bin/env node

/**
 * third-party-check — the built site asks no font CDN for anything.
 *
 * Why: until this check the app loaded Inter from fonts.googleapis.com and
 * fonts.gstatic.com at every page load, which sent each visitor's address to
 * Google before any choice of theirs. The font is now part of the build
 * (src/assets/fonts/inter); this check keeps it so: run after `vite build`
 * (`npm run build` chains it), it fails the build when a page or a stylesheet
 * of dist/ names a font CDN, when a @font-face loads anything but a file of
 * the build itself, or when no Inter woff2 was emitted at all.
 *
 * What it reads: dist/**\/*.html (index.html and the public pages copied
 * there) and dist/**\/*.css. The browser's other third-party calls (the map
 * tiles, the routing service) are the owner's choice, listed with what they
 * send in DEPLOYMENT.md ("Third-party calls from the browser") — not refused
 * here.
 *
 * Usage: node scripts/third-party-check.js [distDir]   (default: ./dist)
 * The functions are exported for the unit test (src/__tests__/thirdPartyCheck.test.js).
 */

const fs = require("fs");
const path = require("path");

// A font CDN: the hosts the app used to call, and the usual others.
const FONT_CDN_RE = /\b(?:fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net|fast\.fonts\.net|cdn\.jsdelivr\.net\/npm\/@fontsource)\b/i;
// The sources of a @font-face block.
const FONT_FACE_RE = /@font-face\s*\{[^}]*\}/gi;
const URL_RE = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;

/** Every file under `dir` whose name matches `re`, recursively. */
const filesUnder = (dir, re) => {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, re));
    else if (re.test(entry.name)) out.push(full);
  }
  return out;
};

/** A file's path inside the build, with forward slashes on every system (as the site's own URLs). */
const relativeTo = (dir, file) => path.relative(dir, file).split(path.sep).join("/");

/** The problems of one text (an HTML page or a stylesheet): [{ file, problem }]. */
const problemsOf = (file, text) => {
  const problems = [];
  const cdn = FONT_CDN_RE.exec(text);
  if (cdn) problems.push({ file, problem: `names a font CDN (${cdn[0]})` });
  for (const face of text.match(FONT_FACE_RE) || []) {
    for (const m of face.matchAll(URL_RE)) {
      const src = m[2].trim();
      if (/^(?:https?:)?\/\//i.test(src)) problems.push({ file, problem: `a @font-face loads ${src} from another site` });
    }
  }
  return problems;
};

/** Check a built site: { ok, problems: [{ file, problem }], fonts: [woff2 files] }. */
const checkDist = (distDir) => {
  const problems = [];
  if (!fs.existsSync(path.join(distDir, "index.html"))) return { ok: false, problems: [{ file: distDir, problem: "no index.html: build the site first" }], fonts: [] };
  for (const file of [...filesUnder(distDir, /\.html$/i), ...filesUnder(distDir, /\.css$/i)]) problems.push(...problemsOf(relativeTo(distDir, file), fs.readFileSync(file, "utf8")));
  const fonts = filesUnder(distDir, /^inter-latin.*\.woff2$/i).map((f) => relativeTo(distDir, f));
  if (!fonts.length) problems.push({ file: distDir, problem: "no Inter woff2 in the build: the font would fall back to the system's" });
  return { ok: problems.length === 0, problems, fonts };
};

if (require.main === module) {
  const dist = path.resolve(process.argv[2] || path.join(__dirname, "..", "dist"));
  const { ok, problems, fonts } = checkDist(dist);
  if (!ok) {
    for (const p of problems) process.stderr.write(`✗ ${p.file}: ${p.problem}\n`);
    process.exit(1);
  }
  process.stdout.write(`✓ third-party check: no font CDN in the build, Inter served from it (${fonts.length} file(s))\n`);
}

module.exports = { FONT_CDN_RE, problemsOf, checkDist, filesUnder };
