/**
 * The sheets' settings a person keeps from one visit to the next on this browser (the format, the content, the
 * network's look). A convenience: storage may be refused or empty, and the defaults then apply.
 */

const KEY = "gtfs:sheets:prefs:v2";
export const LOGO_MAX_BYTES = 500 * 1024;

export const DEFAULT_PREFS = Object.freeze({
  format: "a4p",
  freq: true,
  school: true,
  links: false,
  large: false,
  qr: false,
  qrUrl: "",
  qrCaption: "",
  network: "",
  logo: "",
  accent: "",
  footer: "",
  lang: "",
});

export const readPrefs = () => {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) || "{}");
    const out = { ...DEFAULT_PREFS };
    for (const k of Object.keys(DEFAULT_PREFS)) if (raw && typeof raw[k] === typeof DEFAULT_PREFS[k]) out[k] = raw[k];
    return out;
  } catch {
    return { ...DEFAULT_PREFS };
  }
};

export const writePrefs = (prefs) => {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage refused or full (a large logo): the settings hold for this visit */
  }
};

// The stop a « print » button elsewhere in the reader asks the sheets to open on.
let pendingStop = null;
const listeners = new Set();
export const askSheetFor = (stopId) => {
  pendingStop = stopId;
  listeners.forEach((fn) => fn(stopId));
};
export const takeAskedStop = () => {
  const id = pendingStop;
  pendingStop = null;
  return id;
};
export const onSheetAsked = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
