/**
 * The printed sheet's stylesheet, shared by the preview and the print. A sheet is paper: its colours are the ink's,
 * the network's and the day types' (the same on every sheet so a passenger learns them), the same in the light and
 * dark themes, never the app's palette. Sizes are in em of the page's text size (--gx-base × --gx-scale): fitting a
 * page to its paper scales everything at once.
 */

const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const FAINT = "#a3a3a3";
const RULE = "#d9d9d9";
const CELL = "#ececec";

/** The band of each day type, the same on every sheet. */
export const DAY_TYPE_COLORS = Object.freeze({
  weekday: { bg: "#3D7CC9", fg: "#FFFFFF" },
  school_weekday: { bg: "#3D7CC9", fg: "#FFFFFF" },
  holiday_weekday: { bg: "#D0342C", fg: "#FFFFFF" },
  saturday: { bg: "#3E9B3E", fg: "#FFFFFF" },
  sunday_holiday: { bg: "#F2C200", fg: "#1a1a1a" },
});

export const SHEET_CSS = `
.gx-page { position: relative; box-sizing: border-box; overflow: hidden; background: #ffffff; color: ${INK};
  font-family: "Inter", "Roboto", "Segoe UI", "Helvetica Neue", Arial, sans-serif; font-size: calc(var(--gx-base) * var(--gx-scale));
  font-variant-numeric: tabular-nums; line-height: 1.2; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.gx-page *, .gx-page *::before, .gx-page *::after { box-sizing: border-box; }
.gx-sheet { position: absolute; inset: 0; padding: 7mm 7mm 6mm 5mm; display: flex; gap: 1.1em; }

/* The line's path, top to bottom of the page. */
.gx-path { flex: none; width: 31%; display: flex; flex-direction: column; overflow: hidden; }
.gx-stop { flex: 1 1 0; min-height: 1.25em; display: grid; grid-template-columns: 1fr 1.5em 2.6em; align-items: center; }
.gx-stop-name { text-align: right; font-size: 0.86em; font-weight: 600; line-height: 1.05; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; padding-right: 0.25em; }
.gx-stop.gx-past .gx-stop-name { color: ${FAINT}; font-weight: 500; }
.gx-stop.gx-here .gx-stop-name span { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; background: var(--gx-route-soft); padding: 0.2em 0.45em; border-radius: 0.25em; font-weight: 800; color: ${INK}; }
.gx-rail { position: relative; align-self: stretch; display: flex; align-items: center; justify-content: center; }
.gx-rail::before { content: ""; position: absolute; left: 50%; top: 0; bottom: 0; width: 0.28em; margin-left: -0.14em; background: var(--gx-route); }
.gx-stop:first-child .gx-rail::before { top: 50%; }
.gx-stop:last-child .gx-rail::before { bottom: 50%; }
.gx-stop.gx-past .gx-rail::before { background: var(--gx-route-pale); }
.gx-stop.gx-here .gx-rail::before { background: linear-gradient(var(--gx-route-pale) 0 50%, var(--gx-route) 50% 100%); }
.gx-stop:first-child.gx-here .gx-rail::before { background: var(--gx-route); }
.gx-dot { position: relative; width: 0.72em; height: 0.72em; border-radius: 50%; background: #ffffff; border: 0.17em solid var(--gx-route); }
.gx-stop.gx-past .gx-dot { border-color: var(--gx-route-pale); }
.gx-stop.gx-here .gx-dot { width: 1.15em; height: 1.15em; border-width: 0.32em; border-color: ${INK}; background: #ffffff; box-shadow: 0 0 0 0.12em #ffffff; }
.gx-stop.gx-end .gx-dot { width: 0.95em; height: 0.95em; box-shadow: inset 0 0 0 0.16em #ffffff; background: var(--gx-route); }
.gx-stop-min { font-size: 0.72em; font-weight: 700; color: ${MUTED}; padding-left: 0.2em; white-space: nowrap; }
.gx-stop.gx-fold { flex: 0 0 auto; min-height: 1.6em; }
.gx-stop.gx-fold .gx-stop-name { color: ${MUTED}; font-weight: 500; font-style: italic; }
.gx-stop.gx-fold .gx-rail::before { background: repeating-linear-gradient(var(--gx-route-pale) 0 0.25em, transparent 0.25em 0.5em); }
.gx-stop.gx-fold .gx-dot { display: none; }
.gx-links { display: inline-flex; gap: 0.15em; margin-right: 0.3em; vertical-align: middle; }
.gx-link { font-size: 0.66em; font-weight: 800; padding: 0.05em 0.3em; border-radius: 0.2em; line-height: 1.25; }

/* The sheet itself. */
.gx-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.75em; overflow: hidden; }
.gx-code { align-self: flex-end; font-size: 0.72em; font-weight: 600; letter-spacing: 0.06em; color: ${MUTED}; margin-bottom: -0.45em; min-height: 1em; }
.gx-card { border: 0.16em solid var(--gx-route); border-radius: 0.35em; overflow: hidden; }
.gx-card-top { display: flex; align-items: stretch; background: var(--gx-route); color: var(--gx-route-text); }
.gx-badge { flex: none; display: flex; align-items: center; justify-content: center; min-width: 3.4em; padding: 0.3em 0.55em; font-size: 2.15em; font-weight: 800; letter-spacing: -0.03em; line-height: 1; border-right: 0.08em solid currentColor; }
.gx-direction { flex: 1; min-width: 0; padding: 0.55em 0.8em; display: flex; flex-direction: column; justify-content: center; }
.gx-direction small { font-size: 0.95em; font-weight: 500; opacity: 0.92; }
.gx-direction strong { font-size: 1.75em; font-weight: 800; line-height: 1.05; text-transform: uppercase; letter-spacing: 0.01em; overflow-wrap: anywhere; }
.gx-card-facts { display: flex; align-items: stretch; color: var(--gx-route-ink); }
.gx-fact { flex: 1; padding: 0.5em 0.8em; display: flex; flex-direction: column; justify-content: center; font-size: 0.92em; font-weight: 600; line-height: 1.25; }
.gx-fact + .gx-fact { border-left: 0.1em solid var(--gx-route); }
.gx-fact b { font-size: 1.35em; font-weight: 800; }
.gx-fact.gx-logo { flex: 0 1 36%; align-items: center; }
.gx-fact.gx-logo img { max-width: 100%; max-height: 3.4em; object-fit: contain; }
.gx-valid { align-self: flex-end; font-size: 0.95em; font-weight: 700; color: var(--gx-accent); }
.gx-stopname { font-size: 1.35em; font-weight: 500; margin-top: 0.3em; }
.gx-stopname b { font-size: 1.45em; font-weight: 800; letter-spacing: -0.01em; }

.gx-day { display: flex; flex-direction: column; }
.gx-day-title { display: flex; align-items: baseline; gap: 0.8em; padding: 0.32em 0.55em; font-weight: 600; font-size: 1em; }
.gx-day-title em { font-style: normal; font-weight: 500; font-size: 0.82em; opacity: 0.92; margin-left: auto; text-align: right; }
.gx-grid { display: grid; grid-template-columns: repeat(var(--gx-hours), minmax(0, 1fr)); }
.gx-hour { background: #111111; color: #ffffff; text-align: center; font-weight: 800; font-size: 0.78em; padding: 0.22em 0; border-right: 0.06em solid #3a3a3a; }
.gx-hour small { font-size: 0.7em; font-weight: 600; margin-left: 0.05em; }
.gx-cell { display: flex; flex-direction: column; align-items: center; gap: 0.12em; padding: 0.28em 0 0.4em; background: #ffffff; font-size: 0.9em; font-weight: 600; min-height: 1.6em; }
.gx-cell.gx-alt { background: ${CELL}; }
.gx-cell.gx-cell-band { background: transparent; padding: 0.2em 0.15em; justify-content: center; }
.gx-cell-band .gx-band { width: 100%; margin: 0; }
.gx-cell sup { font-size: 0.66em; font-weight: 800; margin-left: 0.05em; }
.gx-band { display: flex; align-items: center; justify-content: center; margin: 0.35em 0.2em; padding: 0.4em; border: 0.1em solid ${RULE}; border-radius: 0.2em; background: #ffffff; font-weight: 600; font-size: 0.95em; text-align: center; box-shadow: 0 0.06em 0.18em rgba(0,0,0,0.12); }
.gx-absent { font-size: 0.85em; font-weight: 600; color: ${MUTED}; }

/* A stop's poster: every line of the stop, one block each, no path. */
.gx-poster { padding: 7mm; }
.gx-poster .gx-main { gap: 0.6em; }
.gx-poster-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 1em; padding-bottom: 0.4em; border-bottom: 0.16em solid var(--gx-accent); }
.gx-poster-head .gx-stopname { margin: 0; font-size: 1.5em; }
.gx-poster-head .gx-valid { align-self: flex-end; }
.gx-poster-block { display: flex; flex-direction: column; gap: 0.35em; margin-top: 0.35em; }
.gx-poster-line { display: flex; align-items: center; gap: 0.6em; padding: 0.25em 0.5em; background: var(--gx-route); color: var(--gx-route-text); border-radius: 0.3em; }
.gx-poster-line .gx-badge { font-size: 1.35em; padding: 0.1em 0.35em; min-width: 2.2em; border-right: 0; }
.gx-poster-line .gx-direction { padding: 0; flex-direction: row; align-items: baseline; gap: 0.4em; }
.gx-poster-line .gx-direction strong { font-size: 1.15em; }
.gx-poster-line .gx-poster-facts { margin-left: auto; font-size: 0.78em; font-weight: 600; opacity: 0.95; text-align: right; white-space: nowrap; }
.gx-poster .gx-day-title { font-size: 0.9em; padding: 0.22em 0.5em; }
.gx-poster .gx-cell { font-size: 0.85em; padding: 0.22em 0 0.3em; min-height: 1.4em; }
.gx-poster-notes { font-size: 0.74em; color: ${INK}; line-height: 1.35; }
.gx-poster-notes b { font-weight: 800; margin-right: 0.3em; }
.gx-poster-notes span + span { margin-left: 0.8em; }

.gx-spacer { flex: 1; min-height: 0; }
.gx-boxes { display: flex; gap: 0.7em; align-items: stretch; }
.gx-box { flex: 1; min-width: 0; border: 0.1em solid ${INK}; border-radius: 0.25em; overflow: hidden; display: flex; flex-direction: column; }
.gx-box-head { padding: 0.35em 0.5em; font-weight: 800; font-size: 0.85em; text-align: center; }
.gx-box-body { padding: 0.45em 0.55em; font-size: 0.78em; line-height: 1.35; flex: 1; }
.gx-box-body b { font-weight: 800; }
.gx-box.gx-school .gx-box-head { background: #EBDB2B; color: #1a1a1a; }
.gx-box.gx-notes .gx-box-head { background: var(--gx-route); color: var(--gx-route-text); }
.gx-box.gx-notes .gx-note { display: grid; grid-template-columns: 1.2em 1fr; }
.gx-box.gx-qr { flex: none; width: 8.6em; }
.gx-box.gx-qr .gx-box-head { background: #111111; color: #ffffff; }
.gx-box.gx-qr .gx-box-body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.2em; padding: 0.4em; }
.gx-box.gx-qr svg { width: 100%; height: auto; display: block; }
.gx-box.gx-qr span { font-size: 0.85em; text-align: center; }
.gx-footer { background: var(--gx-accent); color: #ffffff; text-align: center; font-weight: 800; font-size: 1.05em; padding: 0.45em 0.6em; border-radius: 0.15em; }
.gx-edition { font-size: 0.62em; color: ${FAINT}; text-align: right; margin-top: -0.35em; }

.gx-watermark { position: absolute; inset: 0; overflow: hidden; pointer-events: none; mix-blend-mode: multiply; }
.gx-watermark-tiles { position: absolute; left: -30%; top: -30%; width: 160%; height: 160%; transform: rotate(-26deg); display: flex; flex-wrap: wrap; align-content: space-around; justify-content: space-around; column-gap: 3.5em; row-gap: 4.2em; }
.gx-watermark-tiles span { font-size: 1.1em; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; white-space: nowrap; color: rgba(29, 78, 216, 0.13); }
.gx-watermark-trial .gx-watermark-tiles span { color: rgba(194, 65, 12, 0.14); }
`;

/** What the print adds: one sheet a page, nothing of the app. */
export const PRINT_CSS = (paper) => `
@media screen { #gx-print-root { position: fixed; left: -100000px; top: 0; } }
@media print {
  @page { size: ${paper.w}mm ${paper.h}mm; margin: 0; }
  html, body { margin: 0 !important; padding: 0 !important; background: #ffffff !important; height: auto !important; overflow: visible !important; }
  body > *:not(#gx-print-root) { display: none !important; }
  #gx-print-root { position: static; }
  #gx-print-root .gx-page { break-after: page; page-break-after: always; }
  #gx-print-root .gx-page:last-child { break-after: auto; page-break-after: auto; }
}
`;
