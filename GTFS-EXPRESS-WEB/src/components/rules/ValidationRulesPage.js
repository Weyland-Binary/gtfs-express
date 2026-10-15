/**
 * ValidationRulesPage — the validation rules at /regles: the legal line's « Règles de validation » stays in the app
 * rather than leaving for MobilityData's page in English, since the server holds its own catalogue of the rules it
 * checks (utils/rules.json, each matched to the canonical validator's notice) with their descriptions in French and
 * English.
 *
 * The page reads that catalogue in the reader's language (GET /edit/validate/catalogue?lang=, English for a
 * language the validator's messages do not have, said so) and lets one find a rule: by words (its code, its file,
 * its description), by severity, by GTFS file. Each rule says its code, its severity, its file and what it checks,
 * and links to its MobilityData sheet. An address /regles#<code> opens on that rule alone.
 *
 * Bare like the statement beside it: one heading, the filters, the rules grouped by file. Colours from the theme
 * (#19), the severities' own tones.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, InputAdornment, Link, MenuItem, TextField, ToggleButton, ToggleButtonGroup, Typography, alpha, useTheme } from "@mui/material";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { CANONICAL_RULES_BASE, getRuleDocUrl } from "../validation/ruleCatalog";

const SEVERITIES = ["error", "warning", "info"];
const RANK = { error: 0, warning: 1, info: 2 };
// The sections that are not one GTFS file have words of their own; the others are their file's name.
const NAMED_SECTIONS = new Set(["structure", "cross_file", "data_quality", "fare"]);

/** A section's words: « agency.txt », or its translated name. */
export const sectionLabel = (section, t) => (NAMED_SECTIONS.has(section) ? t(`rules.section.${section}`) : `${section}.txt`);

/** The rules as the page lists them, from the catalogue: { code, severity, section, description, md }. */
export const rulesOf = (catalogue) =>
  Object.entries(catalogue?.rules || {}).map(([code, rule]) => ({
    code,
    severity: SEVERITIES.includes(rule.default_severity) ? rule.default_severity : "info",
    section: rule.gtfs_section || "structure",
    description: rule.description || "",
    md: rule.mobilitydata_match || code,
  }));

/** The rules a query, a severity and a section keep (words: every one must appear, in any order). */
export const filterRules = (rules, { query = "", severity = "all", section = "all" } = {}) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return rules.filter((r) => {
    if (severity !== "all" && r.severity !== severity) return false;
    if (section !== "all" && r.section !== section) return false;
    if (!words.length) return true;
    const text = `${r.code} ${r.md} ${r.section}.txt ${r.description}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
};

const CODE_RE = /^[a-z0-9_]{3,80}$/;

export default function ValidationRulesPage() {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const tones = theme.palette.severities || {};
  const [catalogue, setCatalogue] = useState(null);
  const [failed, setFailed] = useState(false);
  // /regles#<code>: the page opens on that rule alone.
  const [query, setQuery] = useState(() => {
    const hash = typeof window !== "undefined" ? decodeURIComponent(window.location.hash.slice(1)) : "";
    return CODE_RE.test(hash) ? hash : "";
  });
  const [severity, setSeverity] = useState("all");
  const [section, setSection] = useState("all");

  const load = useCallback(() => {
    setFailed(false);
    const lang = language === "fr" ? "fr" : "en";
    let alive = true;
    fetchWithSession(`${API_BASE_URL}/edit/validate/catalogue?lang=${lang}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`catalogue ${res.status}`))))
      .then((body) => alive && setCatalogue(body))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [language]);
  useEffect(() => load(), [load]);

  const rules = useMemo(() => rulesOf(catalogue), [catalogue]);
  const sections = useMemo(() => {
    const order = Array.isArray(catalogue?.$gtfs_sections) ? catalogue.$gtfs_sections : [];
    const present = new Set(rules.map((r) => r.section));
    return [...order.filter((s) => present.has(s)), ...[...present].filter((s) => !order.includes(s))];
  }, [catalogue, rules]);
  const counts = useMemo(() => Object.fromEntries(SEVERITIES.map((s) => [s, rules.filter((r) => r.severity === s).length])), [rules]);
  const shown = useMemo(() => filterRules(rules, { query, severity, section }), [rules, query, severity, section]);
  const groups = useMemo(
    () =>
      sections
        .map((s) => ({ section: s, rules: shown.filter((r) => r.section === s).sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.code.localeCompare(b.code)) }))
        .filter((g) => g.rules.length),
    [sections, shown],
  );
  const englishOnly = catalogue && catalogue.language && catalogue.language !== language && language !== "en";

  return (
    <Box data-testid="rules-page" sx={{ width: "100%", maxWidth: 980, mx: "auto", px: { xs: 2, md: 3 }, py: { xs: 2, md: 3 }, display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
        <Typography component="h1" tabIndex={-1} sx={{ fontSize: { xs: "1.45rem", md: "1.75rem" }, fontWeight: 800, lineHeight: 1.2, outline: "none" }}>
          {t("rules.title")}
        </Typography>
        <Typography sx={{ fontSize: "0.92rem", lineHeight: 1.65, color: "text.secondary", maxWidth: 760 }}>{t("rules.intro", { count: rules.length || "…" })}</Typography>
        <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap", alignItems: "center" }}>
          <Link href={CANONICAL_RULES_BASE} target="_blank" rel="noopener noreferrer" data-testid="rules-mobilitydata" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontSize: "0.85rem", fontWeight: 600 }}>
            {t("rules.mobilitydataAll")}
            <OpenInNewRoundedIcon sx={{ fontSize: 15 }} />
          </Link>
          {englishOnly && (
            <Typography data-testid="rules-english" sx={{ fontSize: "0.8rem", color: "text.secondary" }}>
              {t("rules.englishOnly")}
            </Typography>
          )}
        </Box>
      </Box>

      <Box sx={{ display: "flex", gap: 1.25, flexWrap: "wrap", alignItems: "center" }}>
        <TextField
          size="small"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("rules.search")}
          inputProps={{ "aria-label": t("rules.search"), "data-testid": "rules-search" }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchRoundedIcon sx={{ fontSize: 20, color: "text.secondary" }} /></InputAdornment> }}
          sx={{ flex: "1 1 260px", minWidth: 220 }}
        />
        <ToggleButtonGroup size="small" exclusive value={severity} onChange={(_, v) => v && setSeverity(v)} aria-label={t("rules.severity.label")} data-testid="rules-severity" sx={{ flexWrap: "wrap", "& .MuiToggleButton-root": { textTransform: "none", fontWeight: 600, px: 1.25 } }}>
          <ToggleButton value="all">{t("rules.severity.all")}</ToggleButton>
          {SEVERITIES.map((s) => (
            <ToggleButton key={s} value={s} data-testid={`rules-severity-${s}`}>
              <Box component="span" aria-hidden sx={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: tones[s]?.main, mr: 0.75 }} />
              {t(`rules.severity.${s}`)} · {counts[s] || 0}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <TextField select size="small" value={section} onChange={(e) => setSection(e.target.value)} label={t("rules.file")} inputProps={{ "data-testid": "rules-section" }} sx={{ minWidth: 190 }}>
          <MenuItem value="all">{t("rules.section.all")}</MenuItem>
          {sections.map((s) => (
            <MenuItem key={s} value={s}>
              {sectionLabel(s, t)}
            </MenuItem>
          ))}
        </TextField>
      </Box>

      <Typography role="status" data-testid="rules-count" sx={{ fontSize: "0.8rem", color: "text.secondary" }}>
        {catalogue ? t("rules.count", { shown: shown.length, total: rules.length }) : failed ? "" : t("rules.loading")}
      </Typography>

      {failed && (
        <Box data-testid="rules-failed" sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
          <Typography sx={{ fontSize: "0.9rem" }}>{t("rules.failed")}</Typography>
          <Button size="small" variant="outlined" onClick={load}>
            {t("rules.retry")}
          </Button>
        </Box>
      )}
      {catalogue && !shown.length && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
          <Typography data-testid="rules-empty" sx={{ fontSize: "0.9rem" }}>
            {t("rules.empty")}
          </Typography>
          <Button
            size="small"
            onClick={() => {
              setQuery("");
              setSeverity("all");
              setSection("all");
            }}
          >
            {t("rules.reset")}
          </Button>
        </Box>
      )}

      <Box sx={{ display: "flex", flexDirection: "column", gap: 2.5 }}>
        {groups.map((g) => (
          <Box key={g.section} component="section" aria-labelledby={`rules-${g.section}`} data-testid={`rules-group-${g.section}`} sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
            <Typography component="h2" id={`rules-${g.section}`} sx={{ fontSize: "0.95rem", fontWeight: 800, display: "flex", alignItems: "baseline", gap: 1 }}>
              {sectionLabel(g.section, t)}
              <Box component="span" sx={{ fontSize: "0.78rem", fontWeight: 600, color: "text.secondary" }}>
                {g.rules.length}
              </Box>
            </Typography>
            <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, border: `1px solid ${theme.palette.divider}`, borderRadius: 2, overflow: "hidden" }}>
              {g.rules.map((r, i) => {
                const tone = tones[r.severity]?.main || theme.palette.text.secondary;
                return (
                  <Box
                    component="li"
                    key={r.code}
                    id={r.code}
                    data-testid={`rule-${r.code}`}
                    data-severity={r.severity}
                    sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "minmax(0, 1fr) auto" }, gap: { xs: 0.5, sm: 2 }, alignItems: "start", px: 1.75, py: 1.25, borderTop: i ? `1px solid ${theme.palette.divider}` : "none", borderLeft: `3px solid ${tone}` }}
                  >
                    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.4, minWidth: 0 }}>
                      <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                        {/* The tone's own tint stays faint under it: at a tenth the error's red reads 4.47:1 (RGAA 3.2 wants 4.5). */}
                        <Box component="span" sx={{ fontSize: "0.7rem", fontWeight: 800, letterSpacing: "0.03em", textTransform: "uppercase", color: tone, backgroundColor: alpha(tone, 0.06), borderRadius: 1, px: 0.75, py: 0.1 }}>
                          {t(`rules.severity.one.${r.severity}`)}
                        </Box>
                        <Box component="code" sx={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "0.82rem", fontWeight: 600, overflowWrap: "anywhere" }}>
                          {r.code}
                        </Box>
                      </Box>
                      <Typography sx={{ fontSize: "0.88rem", lineHeight: 1.55 }}>{r.description}</Typography>
                    </Box>
                    <Link href={getRuleDocUrl(r.md)} target="_blank" rel="noopener noreferrer" aria-label={t("rules.sheetOf", { code: r.code })} sx={{ display: "inline-flex", alignItems: "center", gap: 0.4, fontSize: "0.78rem", fontWeight: 600, whiteSpace: "nowrap" }}>
                      {t("rules.sheet")}
                      <OpenInNewRoundedIcon sx={{ fontSize: 14 }} />
                    </Link>
                  </Box>
                );
              })}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
