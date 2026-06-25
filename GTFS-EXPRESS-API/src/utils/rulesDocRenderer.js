/**
 * rulesDocRenderer.js — build the public HTML page documenting every
 * GTFS validation rule the GTFS Express validator implements.
 *
 * Pure function: no fs reads, no fs writes. Inputs are the parsed
 * rules.json and the EN / FR locale dictionaries. Output is a complete
 * <!doctype html> document as a string.
 *
 * Powers the GET /gtfs/edit/validate/rules endpoint via rulesDocService
 * (which adds mtime-based caching). Same source of truth as the React
 * ValidationRulesPage — both ultimately read rules.json — so the two
 * surfaces cannot drift.
 */

"use strict";

const renderRulesDoc = ({ rulesJson, enLocale, frLocale }) => {
const SECTIONS = rulesJson.$gtfs_sections || [];

// Friendly section labels for the sidebar / TOC. Falls back to the raw
// id (lowercased snake_case) when not listed here.
const SECTION_LABELS = {
  structure: "Structure & CSV",
  agency: "Agency",
  stops: "Stops",
  routes: "Routes",
  trips: "Trips",
  calendar: "Calendar",
  calendar_dates: "Calendar dates",
  stop_times: "Stop times",
  shapes: "Shapes",
  frequencies: "Frequencies",
  transfers: "Transfers",
  feed_info: "Feed info",
  pathways: "Pathways",
  levels: "Levels",
  translations: "Translations",
  attributions: "Attributions",
  fare: "Fares",
  timeframes: "Timeframes",
  cross_file: "Cross-file",
  data_quality: "Data quality",
};

const rules = Object.entries(rulesJson.rules).map(([code, meta]) => ({
  code,
  ...meta,
  has_en: Object.prototype.hasOwnProperty.call(enLocale, code),
  has_fr: Object.prototype.hasOwnProperty.call(frLocale, code),
}));

const grouped = {};
for (const section of SECTIONS) grouped[section] = [];
for (const r of rules) {
  if (!grouped[r.gtfs_section]) grouped[r.gtfs_section] = [];
  grouped[r.gtfs_section].push(r);
}
for (const section of Object.keys(grouped)) {
  grouped[section].sort((a, b) => a.code.localeCompare(b.code));
}

const total = rules.length;
const counts = rules.reduce(
  (acc, r) => {
    acc[r.default_severity] = (acc[r.default_severity] || 0) + 1;
    return acc;
  },
  { error: 0, warning: 0, info: 0 },
);
const aligned = rules.filter((r) => r.mobilitydata_match !== null).length;
const alignedPct = Math.round((aligned / total) * 100);

const escape = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const sectionLabel = (s) =>
  SECTION_LABELS[s] || s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const sectionsWithRules = SECTIONS.filter(
  (s) => grouped[s] && grouped[s].length > 0,
);

const sidebarHtml = sectionsWithRules
  .map(
    (s) => `
        <a class="side-link" href="#section-${s}" data-section="${s}">
          <span class="side-label">${escape(sectionLabel(s))}</span>
          <span class="side-count">${grouped[s].length}</span>
        </a>`,
  )
  .join("");

const ruleCard = (r) => {
  const md = r.mobilitydata_match
    ? `<a class="md-link" href="https://gtfs-validator.mobilitydata.org/rules.html#${r.mobilitydata_match.toUpperCase()}" target="_blank" rel="noopener" title="Open MobilityData reference">
         <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 11l6-6"/><path d="M11 11V5H5"/></svg>
         ${escape(r.mobilitydata_match)}
       </a>`
    : `<span class="md-tag custom">custom</span>`;
  const i18n = r.has_en && r.has_fr
    ? `<span class="i18n-tag" title="Translated EN + FR">i18n</span>`
    : `<span class="i18n-tag missing" title="Missing translations: ${r.has_en ? "" : "EN "}${r.has_fr ? "" : "FR"}">i18n</span>`;
  return `
        <article class="rule" id="rule-${escape(r.code)}"
                 data-severity="${escape(r.default_severity)}"
                 data-md="${r.mobilitydata_match ? "1" : "0"}"
                 data-search="${escape((r.code + " " + r.description).toLowerCase())}">
          <header class="rule-head">
            <button class="badge sev-${escape(r.default_severity)} sev-filter"
                    type="button" data-filter-sev="${escape(r.default_severity)}"
                    title="Show only ${escape(r.default_severity).toUpperCase()} rules (click again to reset)">
              ${escape(r.default_severity).toUpperCase()}
            </button>
            <button class="code-copy" type="button" data-copy="${escape(r.code)}" title="Copy rule code">
              <code>${escape(r.code)}</code>
            </button>
            ${md}
            ${i18n}
            <a class="anchor" href="#rule-${escape(r.code)}" aria-label="Permalink to this rule">#</a>
          </header>
          <p class="rule-desc">${escape(r.description)}</p>
        </article>`;
};

const sectionsHtml = sectionsWithRules
  .map((section) => {
    const list = grouped[section];
    return `
      <section class="section" id="section-${section}" data-section="${section}">
        <header class="section-head">
          <h2>${escape(sectionLabel(section))}</h2>
          <span class="section-count">${list.length} ${list.length === 1 ? "rule" : "rules"}</span>
        </header>
        <div class="rules">${list.map(ruleCard).join("")}</div>
      </section>`;
  })
  .join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>GTFS Express · Validation rules</title>
  <meta name="description" content="Catalogue of every validation rule emitted by the GTFS Express validator. ${total} rules, ${alignedPct}% aligned with the MobilityData Canonical Validator.">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#1565c0" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#0b1220" media="(prefers-color-scheme: dark)">
  <script>
    /* Pre-paint theme application: read the persisted preference and
       set [data-theme] on <html> BEFORE the stylesheet runs, so there
       is no flash of light theme on a dark-mode user reload. Wrapped
       in try-catch because some environments deny localStorage. */
    (function () {
      try {
        var saved = localStorage.getItem("gtfs-rules-theme");
        if (saved === "dark" || saved === "light") {
          document.documentElement.setAttribute("data-theme", saved);
        }
      } catch (_) {}
    })();
  </script>
  <style>
    /* ── Design tokens ────────────────────────────────────────────── */
    :root {
      --bg: #f6f7f9;
      --surface: #ffffff;
      --surface-2: #f9fafb;
      --border: #e5e7eb;
      --border-strong: #d1d5db;
      --text: #111827;
      --text-muted: #6b7280;
      --text-dim: #9ca3af;
      --primary: #1565c0;
      --primary-soft: #e3f2fd;
      --error: #c62828;
      --error-soft: #fdecec;
      --warning: #ef6c00;
      --warning-soft: #fff3e0;
      --info: #0277bd;
      --info-soft: #e1f5fe;
      --shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06);
      --shadow-lg: 0 8px 24px rgba(15, 23, 42, 0.08);
      --radius: 10px;
      --radius-sm: 6px;
    }
    /* Dark palette: applied either when the user has set the system to
       dark mode (and there is no explicit override on <html>), or when
       the user has clicked the theme toggle to dark. The selectors are
       written so an explicit data-theme="light" wins over the media
       query — that's how the toggle "force-overrides" the system. */
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --bg: #0b1220;
        --surface: #111a2c;
        --surface-2: #0f172a;
        --border: #1f2a44;
        --border-strong: #2a3a5e;
        --text: #e5e7eb;
        --text-muted: #94a3b8;
        --text-dim: #64748b;
        --primary: #60a5fa;
        --primary-soft: #1e293b;
        --error: #f87171;
        --error-soft: #2a1414;
        --warning: #fbbf24;
        --warning-soft: #2a1f0a;
        --info: #38bdf8;
        --info-soft: #0a1f2a;
        --shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
        --shadow-lg: 0 12px 28px rgba(0, 0, 0, 0.5);
      }
    }
    :root[data-theme="dark"] {
      --bg: #0b1220;
      --surface: #111a2c;
      --surface-2: #0f172a;
      --border: #1f2a44;
      --border-strong: #2a3a5e;
      --text: #e5e7eb;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --primary: #60a5fa;
      --primary-soft: #1e293b;
      --error: #f87171;
      --error-soft: #2a1414;
      --warning: #fbbf24;
      --warning-soft: #2a1f0a;
      --info: #38bdf8;
      --info-soft: #0a1f2a;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
      --shadow-lg: 0 12px 28px rgba(0, 0, 0, 0.5);
    }

    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; scroll-padding-top: 180px; }
    body {
      font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      margin: 0;
      color: var(--text);
      background: var(--bg);
    }
    a { color: var(--primary); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

    /* ── Hero ─────────────────────────────────────────────────────── */
    .hero {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 40px 24px 28px;
    }
    .hero-inner { max-width: 1180px; margin: 0 auto; }
    .eyebrow {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
      color: var(--primary); padding: 4px 10px; border-radius: 999px;
      background: var(--primary-soft); margin-bottom: 12px;
    }
    .eyebrow-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--primary); }
    h1 { font-size: 34px; font-weight: 700; margin: 0 0 8px; letter-spacing: -0.02em; }
    .lead { color: var(--text-muted); font-size: 16px; margin: 0 0 24px; max-width: 720px; }
    .lead a { color: var(--primary); font-weight: 500; }

    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; max-width: 760px; }
    .stat {
      background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius);
      padding: 14px 16px; transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .stat:hover { transform: translateY(-1px); box-shadow: var(--shadow); }
    .stat .num { font-size: 26px; font-weight: 700; line-height: 1; letter-spacing: -0.02em; }
    .stat .lbl { color: var(--text-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 6px; }

    /* ── Sticky filter bar ────────────────────────────────────────── */
    .filterbar {
      position: sticky; top: 0; z-index: 20;
      background: color-mix(in srgb, var(--bg) 88%, transparent);
      backdrop-filter: saturate(180%) blur(10px);
      -webkit-backdrop-filter: saturate(180%) blur(10px);
      border-bottom: 1px solid var(--border);
    }
    .filterbar-inner {
      max-width: 1180px; margin: 0 auto; padding: 12px 24px;
      display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
    }
    .search {
      position: relative; flex: 1 1 280px; min-width: 240px; max-width: 480px;
    }
    .search svg {
      position: absolute; left: 12px; top: 50%; transform: translateY(-50%);
      color: var(--text-muted); pointer-events: none;
    }
    .search input {
      width: 100%; height: 38px; padding: 0 14px 0 38px;
      border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
      background: var(--surface); color: var(--text);
      font: inherit; font-size: 14px;
      transition: border-color 0.12s, box-shadow 0.12s;
    }
    .search input:focus {
      outline: none; border-color: var(--primary);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 25%, transparent);
    }
    .filters { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .pill {
      display: inline-flex; align-items: center; gap: 6px;
      height: 30px; padding: 0 12px;
      border: 1px solid var(--border-strong); border-radius: 999px;
      background: var(--surface); color: var(--text);
      font: inherit; font-size: 12px; font-weight: 600;
      cursor: pointer; user-select: none;
      transition: all 0.12s ease;
    }
    .pill:hover { border-color: var(--primary); }
    .pill.off { opacity: 0.45; }
    .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
    .pill.sev-error { color: var(--error); }
    .pill.sev-warning { color: var(--warning); }
    .pill.sev-info { color: var(--info); }
    .pill.origin-md { color: var(--primary); }
    .pill.origin-custom { color: var(--text-muted); }
    .filter-sep {
      width: 1px; height: 22px; background: var(--border-strong); margin: 0 4px;
    }
    .meta-count {
      margin-left: auto; font-size: 12px; color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }

    /* Theme toggle: swaps sun / moon icons. The "active" icon is the
       one that the click *will switch to*, so a sun icon means "click
       to go light", a moon means "click to go dark". The two icons
       overlap and cross-fade so there is no layout shift. */
    .theme-toggle {
      width: 34px; height: 34px;
      display: inline-flex; align-items: center; justify-content: center;
      border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
      background: var(--surface); color: var(--text-muted);
      cursor: pointer; padding: 0; position: relative;
      transition: border-color 0.12s, color 0.12s, background 0.12s;
    }
    .theme-toggle:hover { border-color: var(--primary); color: var(--primary); }
    .theme-toggle:focus-visible {
      outline: none; border-color: var(--primary);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 25%, transparent);
    }
    .theme-toggle svg {
      position: absolute; transition: opacity 0.18s ease, transform 0.25s ease;
    }
    /* Sun = visible when current theme is dark (clicking goes light).
       Moon = visible when current theme is light (clicking goes dark).
       Default (no [data-theme]) follows prefers-color-scheme. */
    :root[data-theme="dark"] .theme-icon-sun { opacity: 1; transform: rotate(0); }
    :root[data-theme="dark"] .theme-icon-moon { opacity: 0; transform: rotate(-90deg); }
    :root[data-theme="light"] .theme-icon-sun { opacity: 0; transform: rotate(90deg); }
    :root[data-theme="light"] .theme-icon-moon { opacity: 1; transform: rotate(0); }
    :root:not([data-theme]) .theme-icon-sun { opacity: 0; transform: rotate(90deg); }
    :root:not([data-theme]) .theme-icon-moon { opacity: 1; transform: rotate(0); }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme]) .theme-icon-sun { opacity: 1; transform: rotate(0); }
      :root:not([data-theme]) .theme-icon-moon { opacity: 0; transform: rotate(-90deg); }
    }

    /* ── Layout ───────────────────────────────────────────────────── */
    .layout {
      max-width: 1180px; margin: 0 auto; padding: 24px;
      display: grid; grid-template-columns: 240px 1fr; gap: 32px;
    }
    @media (max-width: 880px) {
      .layout { grid-template-columns: 1fr; gap: 16px; padding: 16px; }
      .sidebar { display: none; }
    }

    /* ── Sidebar ──────────────────────────────────────────────────── */
    .sidebar {
      position: sticky; top: 88px; align-self: start;
      max-height: calc(100vh - 110px); overflow-y: auto;
      padding: 8px 0;
    }
    .sidebar-title {
      font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--text-muted); padding: 0 12px 8px;
    }
    .side-link {
      display: flex; align-items: center; justify-content: space-between;
      padding: 7px 12px; border-radius: var(--radius-sm);
      color: var(--text); text-decoration: none;
      font-size: 13px; font-weight: 500;
      transition: background 0.12s, color 0.12s;
    }
    .side-link:hover { background: var(--surface); text-decoration: none; }
    .side-link.active { background: var(--primary-soft); color: var(--primary); }
    .side-count {
      font-size: 11px; color: var(--text-dim); font-variant-numeric: tabular-nums;
      background: var(--surface-2); padding: 1px 7px; border-radius: 999px;
      border: 1px solid var(--border);
    }
    .side-link.active .side-count { background: var(--surface); color: var(--primary); border-color: var(--primary); }

    /* ── Main / sections ──────────────────────────────────────────── */
    .main { min-width: 0; }
    .section { margin-bottom: 36px; }
    .section.empty { display: none; }
    .section-head {
      display: flex; align-items: baseline; gap: 12px;
      margin: 8px 0 14px; padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }
    .section-head h2 {
      font-size: 20px; font-weight: 700; margin: 0;
      letter-spacing: -0.01em;
    }
    .section-count {
      font-size: 12px; color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }
    .rules { display: flex; flex-direction: column; gap: 10px; }

    /* ── Rule card ────────────────────────────────────────────────── */
    .rule {
      background: var(--surface);
      border: 1px solid var(--border); border-radius: var(--radius);
      padding: 14px 16px;
      transition: border-color 0.12s, box-shadow 0.12s;
    }
    .rule:hover { border-color: var(--border-strong); box-shadow: var(--shadow); }
    .rule.hidden { display: none; }
    .rule:target {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 18%, transparent);
    }
    .rule-head {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      margin-bottom: 6px;
    }
    .badge {
      display: inline-block; padding: 3px 8px; border-radius: 999px;
      font-size: 10px; font-weight: 700; letter-spacing: 0.06em;
      flex-shrink: 0;
    }
    .badge.sev-error { background: var(--error-soft); color: var(--error); }
    .badge.sev-warning { background: var(--warning-soft); color: var(--warning); }
    .badge.sev-info { background: var(--info-soft); color: var(--info); }

    /* Clickable severity badge (inside rule cards): inherits the colour
       from .sev-* but adopts the button reset + a subtle hover ring so
       it reads as actionable. Click handler in JS sets the severity
       filter to "only this severity"; clicking the same badge again
       resets to "all". */
    button.badge {
      border: 1px solid transparent; cursor: pointer; font: inherit;
      font-size: 10px; font-weight: 700; letter-spacing: 0.06em;
      padding: 3px 8px;
      transition: box-shadow 0.12s, border-color 0.12s, transform 0.12s;
    }
    button.badge:hover { border-color: currentColor; transform: translateY(-1px); }
    button.badge.sev-error:hover {
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--error) 18%, transparent);
    }
    button.badge.sev-warning:hover {
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--warning) 18%, transparent);
    }
    button.badge.sev-info:hover {
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--info) 18%, transparent);
    }

    .code-copy {
      background: none; border: none; padding: 0; cursor: pointer;
      font: inherit; color: inherit;
      transition: opacity 0.12s;
    }
    .code-copy code {
      background: var(--surface-2); border: 1px solid var(--border);
      padding: 2px 8px; border-radius: 5px; font-size: 13px; font-weight: 500;
      transition: background 0.12s, border-color 0.12s;
    }
    .code-copy:hover code { background: var(--primary-soft); border-color: var(--primary); }
    .code-copy.copied code {
      background: var(--info-soft); border-color: var(--info); color: var(--info);
    }

    .md-link {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 12px; color: var(--text-muted);
      padding: 2px 8px; border-radius: 999px;
      background: var(--surface-2); border: 1px solid var(--border);
      transition: all 0.12s;
    }
    .md-link:hover { color: var(--primary); border-color: var(--primary); text-decoration: none; }
    .md-tag {
      font-size: 11px; padding: 2px 8px; border-radius: 999px;
      background: var(--surface-2); border: 1px solid var(--border);
      color: var(--text-dim); font-weight: 500;
    }

    .i18n-tag {
      font-size: 10px; padding: 2px 7px; border-radius: 999px;
      background: var(--surface-2); border: 1px solid var(--border);
      color: var(--text-dim); font-weight: 600; letter-spacing: 0.04em;
    }
    .i18n-tag.missing { color: var(--warning); border-color: var(--warning); }

    .anchor {
      margin-left: auto; opacity: 0; transition: opacity 0.12s;
      color: var(--text-dim); font-weight: 600; padding: 2px 6px;
      font-size: 14px;
    }
    .rule:hover .anchor, .anchor:focus { opacity: 1; }
    .anchor:hover { color: var(--primary); text-decoration: none; }

    .rule-desc {
      margin: 0; color: var(--text-muted); font-size: 13.5px; line-height: 1.55;
    }

    /* ── Empty state ──────────────────────────────────────────────── */
    .empty-state {
      display: none;
      text-align: center; padding: 64px 24px;
      color: var(--text-muted);
    }
    .empty-state.visible { display: block; }
    .empty-state h3 { font-size: 18px; color: var(--text); margin: 0 0 6px; }

    /* ── Footer ───────────────────────────────────────────────────── */
    footer {
      max-width: 1180px; margin: 32px auto 24px;
      padding: 16px 24px;
      color: var(--text-muted); font-size: 12px;
      border-top: 1px solid var(--border);
    }
    footer code {
      background: var(--surface-2); border: 1px solid var(--border);
      padding: 1px 6px; border-radius: 4px;
    }
  </style>
</head>
<body>
  <header class="hero">
    <div class="hero-inner">
      <span class="eyebrow"><span class="eyebrow-dot"></span> GTFS Express</span>
      <h1>Validation rules</h1>
      <p class="lead">Every check the GTFS Express validator runs on uploaded feeds. ${alignedPct}% of these rules align with the <a href="https://gtfs-validator.mobilitydata.org/rules.html" target="_blank" rel="noopener">MobilityData Canonical Validator</a> — the rest are spec-derived custom checks that surface at WARNING / INFO so a feed accepted by MobilityData is also accepted here.</p>
      <div class="stats">
        <div class="stat"><div class="num">${total}</div><div class="lbl">Total rules</div></div>
        <div class="stat"><div class="num" style="color:var(--error)">${counts.error}</div><div class="lbl">Errors</div></div>
        <div class="stat"><div class="num" style="color:var(--warning)">${counts.warning}</div><div class="lbl">Warnings</div></div>
        <div class="stat"><div class="num" style="color:var(--info)">${counts.info}</div><div class="lbl">Infos</div></div>
        <div class="stat"><div class="num">${alignedPct}<span style="font-size:18px">%</span></div><div class="lbl">MobilityData aligned</div></div>
      </div>
    </div>
  </header>

  <div class="filterbar">
    <div class="filterbar-inner">
      <label class="search">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="7" cy="7" r="5"/><path d="M14 14L10.5 10.5"/>
        </svg>
        <input id="q" type="search" placeholder="Search rule code or description…" autocomplete="off" spellcheck="false">
      </label>
      <div class="filters" role="group" aria-label="Severity filters">
        <button class="pill sev-error" data-sev="error" aria-pressed="true"><span class="dot"></span>Errors</button>
        <button class="pill sev-warning" data-sev="warning" aria-pressed="true"><span class="dot"></span>Warnings</button>
        <button class="pill sev-info" data-sev="info" aria-pressed="true"><span class="dot"></span>Infos</button>
      </div>
      <div class="filter-sep" aria-hidden="true"></div>
      <div class="filters" role="group" aria-label="Origin filters">
        <button class="pill origin-md" data-origin="1" aria-pressed="true"><span class="dot"></span>MobilityData</button>
        <button class="pill origin-custom" data-origin="0" aria-pressed="true"><span class="dot"></span>Custom</button>
      </div>
      <span class="meta-count" id="meta-count">${total} rules</span>
      <button class="theme-toggle" id="theme-toggle" type="button"
              title="Toggle light / dark theme (Shift+T)" aria-label="Toggle theme">
        <svg class="theme-icon-sun" width="16" height="16" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4"/>
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
        </svg>
        <svg class="theme-icon-moon" width="16" height="16" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
      </button>
    </div>
  </div>

  <main class="layout">
    <aside class="sidebar" aria-label="Sections">
      <div class="sidebar-title">Sections</div>
      <nav>${sidebarHtml}</nav>
    </aside>
    <div class="main">
      ${sectionsHtml}
      <div class="empty-state" id="empty-state">
        <h3>No rules match your filters</h3>
        <p>Try clearing the search box or re-enabling a severity / origin filter.</p>
      </div>
    </div>
  </main>

  <footer>
    Generated on the fly from <code>src/utils/rules.json</code>. Endpoint: <code>GET /gtfs/edit/validate/rules</code>.
    Schema version <code>${escape(rulesJson.$schema_version)}</code>.
  </footer>

  <script>
    (function () {
      const TOTAL = ${total};
      const params = new URLSearchParams(window.location.search);

      const state = {
        q: params.get("q") || "",
        sev: new Set((params.get("sev") || "error,warning,info").split(",").filter(Boolean)),
        origin: new Set((params.get("origin") || "1,0").split(",").filter(Boolean)),
      };

      const qInput = document.getElementById("q");
      qInput.value = state.q;

      const sevPills = document.querySelectorAll("[data-sev]");
      const originPills = document.querySelectorAll("[data-origin]");
      const metaCount = document.getElementById("meta-count");
      const emptyState = document.getElementById("empty-state");
      const rules = document.querySelectorAll(".rule");
      const sections = document.querySelectorAll(".section");
      const sideLinks = document.querySelectorAll(".side-link");

      const reflectPill = (btn, on) => {
        btn.classList.toggle("off", !on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      };
      sevPills.forEach((p) => reflectPill(p, state.sev.has(p.dataset.sev)));
      originPills.forEach((p) => reflectPill(p, state.origin.has(p.dataset.origin)));

      const persistUrl = () => {
        const next = new URLSearchParams();
        if (state.q) next.set("q", state.q);
        if (state.sev.size !== 3) next.set("sev", [...state.sev].join(","));
        if (state.origin.size !== 2) next.set("origin", [...state.origin].join(","));
        const qs = next.toString();
        history.replaceState(null, "", qs ? "?" + qs : window.location.pathname);
      };

      const apply = () => {
        const q = state.q.trim().toLowerCase();
        let visible = 0;
        const sectionVisible = {};
        rules.forEach((r) => {
          const sev = r.dataset.severity;
          const origin = r.dataset.md;
          const text = r.dataset.search;
          let show = state.sev.has(sev) && state.origin.has(origin);
          if (show && q) show = text.includes(q);
          r.classList.toggle("hidden", !show);
          if (show) {
            visible++;
            const sec = r.closest(".section");
            if (sec) sectionVisible[sec.id] = true;
          }
        });
        sections.forEach((sec) => {
          sec.classList.toggle("empty", !sectionVisible[sec.id]);
        });
        sideLinks.forEach((a) => {
          const sec = a.dataset.section;
          a.style.opacity = sectionVisible["section-" + sec] ? "1" : "0.4";
        });
        emptyState.classList.toggle("visible", visible === 0);
        metaCount.textContent =
          visible === TOTAL ? TOTAL + " rules" : visible + " of " + TOTAL + " rules";
        persistUrl();
      };

      qInput.addEventListener("input", (e) => {
        state.q = e.target.value;
        apply();
      });
      sevPills.forEach((p) =>
        p.addEventListener("click", () => {
          const k = p.dataset.sev;
          if (state.sev.has(k)) state.sev.delete(k);
          else state.sev.add(k);
          reflectPill(p, state.sev.has(k));
          apply();
        }),
      );
      originPills.forEach((p) =>
        p.addEventListener("click", () => {
          const k = p.dataset.origin;
          if (state.origin.has(k)) state.origin.delete(k);
          else state.origin.add(k);
          reflectPill(p, state.origin.has(k));
          apply();
        }),
      );

      document.querySelectorAll(".code-copy").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(btn.dataset.copy);
            btn.classList.add("copied");
            setTimeout(() => btn.classList.remove("copied"), 1100);
          } catch (_) {
            // Clipboard API can fail on insecure contexts — ignore silently.
          }
        });
      });

      // Click a severity badge inside a rule card → set the severity
      // filter to "only this one". Click the same badge again with that
      // exact filter active → reset to "all severities". This gives a
      // 1-click drill-down without forcing the user to scroll back to
      // the filter bar.
      document.querySelectorAll(".sev-filter").forEach((btn) => {
        btn.addEventListener("click", () => {
          const sev = btn.dataset.filterSev;
          const isSolo = state.sev.size === 1 && state.sev.has(sev);
          state.sev = new Set(isSolo ? ["error", "warning", "info"] : [sev]);
          sevPills.forEach((p) => reflectPill(p, state.sev.has(p.dataset.sev)));
          apply();
        });
      });

      // Theme toggle: explicit override that beats prefers-color-scheme.
      // Persisted to localStorage so the choice survives reloads. The
      // initial application is done in the head <script> below to avoid
      // a flash of wrong colours on slow networks.
      const themeBtn = document.getElementById("theme-toggle");
      const currentTheme = () =>
        document.documentElement.getAttribute("data-theme") ||
        (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      themeBtn.addEventListener("click", () => {
        const next = currentTheme() === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        try { localStorage.setItem("gtfs-rules-theme", next); } catch (_) {}
      });
      // Shift+T keyboard shortcut, mirroring docs.
      document.addEventListener("keydown", (e) => {
        if (e.shiftKey && (e.key === "T" || e.key === "t") &&
            e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") {
          themeBtn.click();
        }
      });

      if ("IntersectionObserver" in window && sections.length > 0) {
        const byId = new Map([...sideLinks].map((a) => [a.dataset.section, a]));
        const obs = new IntersectionObserver(
          (entries) => {
            entries.forEach((e) => {
              if (!e.isIntersecting) return;
              const id = e.target.dataset.section;
              sideLinks.forEach((a) => a.classList.remove("active"));
              const link = byId.get(id);
              if (link) link.classList.add("active");
            });
          },
          { rootMargin: "-30% 0px -60% 0px" },
        );
        sections.forEach((s) => obs.observe(s));
      }

      apply();
    })();
  </script>
</body>
</html>
`;

return html;
};

module.exports = { renderRulesDoc };
