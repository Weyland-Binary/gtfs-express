/**
 * NetworkSettings — what a network needs besides its lines: the operator
 * (name, website, timezone, language), the period the timetable covers, the
 * local week and public holidays, and the operating caps of the brief
 * (fleet, yearly budget, costs). Without it a network built by hand could
 * only be finished in JSON: the operator's name, URL and timezone are
 * required by GTFS.
 *
 * `prefillFromTerritory(spec, territory)` fills the EMPTY fields from the
 * territory's dossier (timezone, language, local weekend, holidays within
 * the validity) and says which ones it filled; it never overwrites a value.
 */

import React from "react";
import { Box, Chip, MenuItem, Typography, useTheme } from "@mui/material";
import TuneOutlinedIcon from "@mui/icons-material/TuneOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { SectionHeader, soft } from "./StudioUI";
import { Field, SelectField } from "./SpecEditors";

const WEEKENDS = { "sat,sun": ["sat", "sun"], "fri,sat": ["fri", "sat"], "fri": ["fri"], "sun": ["sun"], "thu,fri": ["thu", "fri"] };
const PREFILL_LABEL = { timezone: "timezone_short", lang: "lang_short", weekend: "weekend", holidays: "holidays" };
const ymdToIso = (v) => (/^\d{8}$/.test(String(v || "")) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : "");
const isoToYmd = (v) => String(v || "").replace(/-/g, "");
const todayYmd = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");
const plusYear = (ymd) => `${parseInt(ymd.slice(0, 4), 10) + 1}${ymd.slice(4)}`;
const num = (v) => {
  const n = parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
};

/** The spec with its empty settings filled from the territory; `filled` lists what changed. */
export const prefillFromTerritory = (spec, territory) => {
  if (!territory) return { spec, filled: [] };
  const filled = [];
  const agency = { ...(spec.agency || {}) };
  if (!agency.timezone && territory.timezone) {
    agency.timezone = territory.timezone;
    filled.push("timezone");
  }
  const lang = territory.country?.languages?.[0];
  if (!agency.lang && lang) {
    agency.lang = lang;
    filled.push("lang");
  }
  const next = { ...spec, agency };
  const weekend = territory.country?.weekend;
  if (!spec.weekend && Array.isArray(weekend) && weekend.length && weekend.join() !== "sat,sun") {
    next.weekend = weekend;
    filled.push("weekend");
  }
  if (!(spec.holidays || []).length && (territory.holidays || []).length) {
    const start = spec.feed?.start_date || todayYmd();
    const end = spec.feed?.end_date || plusYear(start);
    const dates = [...new Set(territory.holidays.map((h) => h.date).filter((d) => /^\d{8}$/.test(d) && d >= start && d <= end))].sort();
    if (dates.length) {
      next.holidays = dates;
      filled.push("holidays");
    }
  }
  return { spec: filled.length ? next : spec, filled };
};

export default function NetworkSettings({ spec, onChange, territory = null, prefilled = [] }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const agency = spec.agency || {};
  const feed = spec.feed || {};
  const ops = spec.operations || {};
  const setAgency = (patch) => onChange({ ...spec, agency: { ...agency, ...patch } });
  const setFeed = (patch) => onChange({ ...spec, feed: { ...feed, ...patch } });
  const setOps = (patch) => {
    const next = { ...ops, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === "") delete next[k];
    onChange({ ...spec, operations: Object.keys(next).length ? next : undefined });
  };
  const weekendKey = (spec.weekend || ["sat", "sun"]).join();
  const missing = ["name", "url", "timezone"].filter((k) => !String(agency[k] || "").trim());
  const territoryHolidays = (territory?.holidays || []).length;
  return (
    <Box data-testid="network-settings" sx={{ display: "flex", flexDirection: "column", gap: 1, p: 1.5, borderRadius: "12px", background: soft(theme) }}>
      <SectionHeader label={t("network.settings.title")} right={missing.length ? <Chip size="small" color="warning" label={t("network.settings.missing", { count: missing.length })} data-testid="settings-missing" sx={{ height: 20, fontSize: "0.66rem", fontWeight: 700 }} /> : null} />
      {prefilled.length > 0 && (
        <Typography sx={{ fontSize: "0.7rem", color: "text.secondary", display: "flex", alignItems: "center", gap: 0.5 }} data-testid="settings-prefilled">
          <TuneOutlinedIcon sx={{ fontSize: 14 }} />
          {t("network.settings.prefilled", { fields: prefilled.map((f) => t(`network.settings.field.${PREFILL_LABEL[f] || f}`)).join(", ") })}
        </Typography>
      )}
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 0.75 }}>
        <Field value={agency.name || ""} onChange={(e) => setAgency({ name: e.target.value })} label={t("network.settings.field.name")} testid="settings-agency-name" />
        <Field value={agency.url || ""} onChange={(e) => setAgency({ url: e.target.value.trim() })} label={t("network.settings.field.url")} testid="settings-agency-url" />
        <Field value={agency.timezone || ""} onChange={(e) => setAgency({ timezone: e.target.value.trim() })} label={t("network.settings.field.timezone")} testid="settings-agency-timezone" />
        <Field value={agency.lang || ""} onChange={(e) => setAgency({ lang: e.target.value.trim().toLowerCase() })} label={t("network.settings.field.lang")} testid="settings-agency-lang" />
      </Box>
      <Typography sx={{ fontSize: "0.7rem", fontWeight: 700, color: "text.secondary", mt: 0.5 }}>{t("network.settings.validity")}</Typography>
      <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap", alignItems: "center" }}>
        <Field type="date" value={ymdToIso(feed.start_date)} onChange={(e) => setFeed({ start_date: isoToYmd(e.target.value) || undefined })} label={t("network.settings.field.start")} testid="settings-start" width={170} />
        <Field type="date" value={ymdToIso(feed.end_date)} onChange={(e) => setFeed({ end_date: isoToYmd(e.target.value) || undefined })} label={t("network.settings.field.end")} testid="settings-end" width={170} />
        <SelectField value={WEEKENDS[weekendKey] ? weekendKey : "sat,sun"} onChange={(e) => onChange({ ...spec, weekend: e.target.value === "sat,sun" ? undefined : WEEKENDS[e.target.value] })} label={t("network.settings.field.weekend")} minWidth={170} testid="settings-weekend">
          {Object.keys(WEEKENDS).map((k) => (
            <MenuItem key={k} value={k}>
              {t(`network.settings.weekend.${k.replace(",", "_")}`)}
            </MenuItem>
          ))}
        </SelectField>
      </Box>
      <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap", alignItems: "center" }}>
        <Typography sx={{ fontSize: "0.76rem" }} data-testid="settings-holidays">{t("network.settings.holidays", { count: (spec.holidays || []).length })}</Typography>
        {territoryHolidays > 0 && (
          <Chip size="small" label={t("network.settings.useTerritoryHolidays", { count: territoryHolidays })} onClick={() => onChange(prefillFromTerritory({ ...spec, holidays: [] }, { holidays: territory.holidays }).spec)} data-testid="settings-territory-holidays" sx={{ height: 22, fontSize: "0.68rem" }} />
        )}
        <SelectField value={spec.holiday_service || "sunday"} onChange={(e) => onChange({ ...spec, holiday_service: e.target.value })} label={t("network.settings.field.holidayService")} minWidth={200} testid="settings-holiday-service">
          {["sunday", "saturday", "none"].map((k) => (
            <MenuItem key={k} value={k}>
              {t(`network.settings.holidayService.${k}`)}
            </MenuItem>
          ))}
        </SelectField>
      </Box>
      <Typography sx={{ fontSize: "0.7rem", fontWeight: 700, color: "text.secondary", mt: 0.5 }}>{t("network.settings.caps")}</Typography>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr 1fr", sm: "repeat(4, 1fr)" }, gap: 0.75 }}>
        <Field type="number" value={ops.max_vehicles ?? ""} onChange={(e) => setOps({ max_vehicles: num(e.target.value) })} label={t("network.settings.field.maxVehicles")} testid="settings-max-vehicles" mono />
        <Field type="number" value={ops.max_cost_year ?? ""} onChange={(e) => setOps({ max_cost_year: num(e.target.value) })} label={t("network.settings.field.maxCost")} testid="settings-max-cost" mono />
        <Field type="number" value={typeof ops.cost_per_km === "number" ? ops.cost_per_km : ""} onChange={(e) => setOps({ cost_per_km: num(e.target.value) })} label={t("network.settings.field.costPerKm")} testid="settings-cost-km" mono />
        <Field value={ops.currency || ""} onChange={(e) => setOps({ currency: e.target.value.trim().toUpperCase().slice(0, 3) || undefined })} label={t("network.settings.field.currency")} testid="settings-currency" />
      </Box>
      <Typography sx={{ fontSize: "0.66rem", color: "text.disabled" }}>{t("network.settings.capsHint")}</Typography>
    </Box>
  );
}
