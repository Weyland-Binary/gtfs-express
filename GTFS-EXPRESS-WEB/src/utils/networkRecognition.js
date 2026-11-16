/**
 * A network opened again, known by its content fingerprint (the server's: the same files in any zip give the same
 * one): the projects of this browser it is the reference or a version of, and for a published feed what changed since
 * this browser last opened it. Fail-soft: storage disabled or corrupt says nothing.
 */

import { isEmptyWork } from "./workState";

export const OPENINGS_KEY = "gtfs:catalog:openings";
export const MAX_OPENINGS = 50;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;

export const isFingerprint = (value) => typeof value === "string" && FINGERPRINT_RE.test(value);

const browserStorage = () => {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
};

export const MAX_KNOWN_PROJECTS = 3;
// A project shared with the person is offered only when they change it.
const CHANGES = new Set(["owner", "approver", "contributor"]);

/**
 * The modify projects whose network is these files, the most recent first (the list's order), at most three:
 * [{ project, n }], n the version that holds them (the highest), 0 for the reference.
 */
export const projectsOfFiles = (projects = [], fingerprint = null) => {
  if (!isFingerprint(fingerprint)) return [];
  const out = [];
  for (const project of projects || []) {
    // A work holding nothing is nothing to resume: never offered.
    if (project?.job !== "modify" || (project.role && !CHANGES.has(project.role)) || isEmptyWork(project)) continue;
    const held = (project.versions || []).filter((v) => v?.zip?.fingerprint === fingerprint).reduce((best, v) => (!best || (v.n ?? 0) > (best.n ?? 0) ? v : best), null);
    if (held) out.push({ project, n: held.n ?? 0 });
    else if (project.network?.fingerprint === fingerprint) out.push({ project, n: 0 });
    if (out.length === MAX_KNOWN_PROJECTS) break;
  }
  return out;
};

const readOpenings = (storage) => {
  try {
    const all = JSON.parse(storage.getItem(OPENINGS_KEY) || "{}");
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
};

/**
 * Records a published feed opened from `url` and says how it compares with this browser's last opening of it:
 * { same: true, since } (since: when these files were first seen there), { same: false, since } (since: the last
 * opening), or null the first time.
 */
export const noteCatalogOpening = (url, fingerprint, { storage = browserStorage(), now = Date.now() } = {}) => {
  if (!url || !isFingerprint(fingerprint) || !storage) return null;
  const all = readOpenings(storage);
  const before = all[url] && isFingerprint(all[url].fingerprint) ? all[url] : null;
  const same = before?.fingerprint === fingerprint;
  const at = new Date(now).toISOString();
  const entries = Object.entries(all).filter(([key, v]) => key !== url && v && typeof v === "object");
  entries.push([url, { fingerprint, first: same ? before.first || before.last || at : at, last: at }]);
  entries.sort((a, b) => String(b[1].last || "").localeCompare(String(a[1].last || "")));
  try {
    storage.setItem(OPENINGS_KEY, JSON.stringify(Object.fromEntries(entries.slice(0, MAX_OPENINGS))));
  } catch {
    /* storage full or disabled: nothing remembered */
  }
  const since = !before ? null : same ? before.first || before.last : before.last || before.first;
  return since ? { same, since } : null;
};
