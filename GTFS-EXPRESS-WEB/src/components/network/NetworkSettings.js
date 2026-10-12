/**
 * NetworkSettings — what a network needs besides its lines: the operator
 * (name, website, timezone, language), the period the timetable covers, the
 * local week and public holidays, the running times by time of day (a
 * factor on the buses' speed at rush hours), and the operating caps and
 * costs of the brief (fleet, yearly budget, cost per km / hour / vehicle,
 * deadhead, reserve, contract volume). Without it a network built by hand
 * could only be finished in JSON: the operator's name, URL and timezone are
 * required by GTFS.
 *
 * `prefillFromTerritory(spec, territory)` fills the EMPTY fields from the
 * territory's dossier (timezone, language, local weekend, holidays within
 * the validity) and says which ones it filled; it never overwrites a value.
 *
 * Folded (target design §4 A3, §11; WP8, capture 19): no longer a wall of
 * fifteen fields whose only label was their placeholder, the settings sit
 * behind one button that says what is left — « Paramètres du réseau · 3
 * requis » — and open on groups whose every field has its label visible
 * above it, "requis" said in text for the three GTFS requires of the
 * operator (name, website, timezone) and its help tied to it; the dates are
 * typed in the interface's language (DateField, D47), never a browser's
 * mm/dd/yyyy. `openSignal`, a number the host sets (0: none), opens the
 * settings and puts the focus on the first required field left empty (the
 * host's "Paramètres" task or need leads here), then `onOpened` lets the
 * host clear it — a later mount (another tab, then back) never takes the
 * focus again. `open` / `onOpenChange` let the host keep the fold across
 * those mounts; without them the fold is the component's own.
 */

import React, { useEffect, useId, useRef, useState } from "react";
import { Box, ButtonBase, Chip, Collapse, MenuItem, Typography, useTheme } from "@mui/material";
import TuneOutlinedIcon from "@mui/icons-material/TuneOutlined";
import AddIcon from "@mui/icons-material/Add";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { useLanguage } from "../../contexts/LanguageContext";
import { QuietButton, soft } from "./StudioUI";
import { BandPill, LabeledField, SelectField, nextBand } from "./SpecEditors";
import { DateField } from "../transform/DateField";

// The operator's fields GTFS requires (agency_name, agency_url, agency_timezone).
export const REQUIRED_AGENCY = Object.freeze(["name", "url", "timezone"]);

const WEEKENDS = { "sat,sun": ["sat", "sun"], "fri,sat": ["fri", "sat"], "fri": ["fri"], "sun": ["sun"], "thu,fri": ["thu", "fri"] };
const PREFILL_LABEL = { timezone: "timezone_short", lang: "lang_short", weekend: "weekend", holidays: "holidays" };
const ymdToIso = (v) => (/^\d{8}$/.test(String(v || "")) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : "");
const isoToYmd = (v) => String(v || "").replace(/-/g, "");
/** The required operator fields still empty. */
export const missingAgency = (spec) => REQUIRED_AGENCY.filter((k) => !String(spec?.agency?.[k] || "").trim());
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

/** A group of settings: a small heading, then its fields. */
function Group({ title, hint = null, children, testid = undefined }) {
  const id = useId();
  return (
    <Box component="section" aria-labelledby={id} data-testid={testid} sx={{ display: "flex", flexDirection: "column", gap: 0.75, mt: 0.5 }}>
      <Typography id={id} component="h3" sx={{ fontSize: "0.74rem", fontWeight: 800, color: "text.primary" }}>
        {title}
      </Typography>
      {children}
      {hint && <Typography sx={{ fontSize: "0.66rem", color: "text.secondary", lineHeight: 1.4 }}>{hint}</Typography>}
    </Box>
  );
}

export default function NetworkSettings({ spec, onChange, territory = null, prefilled = [], defaultOpen = false, open: openProp = undefined, onOpenChange = null, openSignal = 0, onOpened = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const bodyId = useId();
  const [ownOpen, setOwnOpen] = useState(Boolean(defaultOpen));
  const open = openProp === undefined ? ownOpen : Boolean(openProp);
  const setOpen = (next) => {
    const value = typeof next === "function" ? next(open) : next;
    if (openProp === undefined) setOwnOpen(value);
    onOpenChange?.(value);
  };
  // The required fields, focused by ref when the host asks for the settings.
  const nameRef = useRef(null);
  const urlRef = useRef(null);
  const timezoneRef = useRef(null);
  const requiredRefs = { name: nameRef, url: urlRef, timezone: timezoneRef };
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
  const bands = spec.running_time_profile || [];
  const setBands = (next) => onChange({ ...spec, running_time_profile: next.length ? next : undefined });
  const weekendKey = (spec.weekend || ["sat", "sun"]).join();
  const missing = missingAgency(spec);
  const territoryHolidays = (territory?.holidays || []).length;
  // The host asks for the settings (a task, a need): open, and the focus on the first required field left empty.
  const firstMissing = useRef(null);
  firstMissing.current = missing[0] || "name";
  useEffect(() => {
    if (!openSignal) return undefined;
    setOpen(true);
    const timer = setTimeout(() => {
      requiredRefs[firstMissing.current]?.current?.focus?.();
      onOpened?.();
    }, 0);
    return () => clearTimeout(timer);
    // Only a new signal opens: the refs are stable, the host's callbacks read when it fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal]);
  const required = (k) => REQUIRED_AGENCY.includes(k);
  return (
    <Box data-testid="network-settings" data-open={open ? "true" : "false"} sx={{ display: "flex", flexDirection: "column", gap: 0.5, p: 1.25, borderRadius: "12px", background: soft(theme) }}>
      <ButtonBase
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
        data-testid="settings-toggle"
        sx={{ justifyContent: "flex-start", gap: 0.75, borderRadius: "8px", px: 0.5, py: 0.5, textAlign: "left", "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 1 } }}
      >
        <TuneOutlinedIcon aria-hidden sx={{ fontSize: 18, color: "text.secondary" }} />
        <Typography component="span" sx={{ fontSize: "0.82rem", fontWeight: 800 }}>
          {t("network.settings.title")}
        </Typography>
        {missing.length ? (
          <Chip component="span" size="small" color="warning" label={t("network.settings.missing", { count: missing.length })} data-testid="settings-missing" sx={{ height: 20, fontSize: "0.66rem", fontWeight: 700 }} />
        ) : (
          <Typography component="span" data-testid="settings-complete" sx={{ fontSize: "0.7rem", fontWeight: 700, color: "success.main" }}>
            {t("network.settings.complete")}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        <Typography component="span" sx={{ fontSize: "0.7rem", color: "text.secondary" }}>
          {t(open ? "network.settings.fold" : "network.settings.unfold")}
        </Typography>
        <ExpandMoreIcon aria-hidden sx={{ fontSize: 18, color: "text.secondary", transform: open ? "none" : "rotate(-90deg)", transition: "transform 150ms" }} />
      </ButtonBase>
      <Collapse in={open}>
        <Box id={bodyId} sx={{ display: "flex", flexDirection: "column", gap: 0.75, px: 0.5, pb: 0.5 }}>
          {prefilled.length > 0 && (
            <Typography sx={{ fontSize: "0.7rem", color: "text.secondary", display: "flex", alignItems: "center", gap: 0.5 }} data-testid="settings-prefilled">
              <TuneOutlinedIcon aria-hidden sx={{ fontSize: 14 }} />
              {t("network.settings.prefilled", { fields: prefilled.map((f) => t(`network.settings.field.${PREFILL_LABEL[f] || f}`)).join(", ") })}
            </Typography>
          )}
          <Group title={t("network.settings.operator")} hint={t("network.settings.operatorHint")} testid="settings-operator">
            <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 0.75 }}>
              <LabeledField value={agency.name || ""} onChange={(e) => setAgency({ name: e.target.value })} label={t("network.settings.label.name")} required={required("name")} testid="settings-agency-name" inputRef={nameRef} />
              <LabeledField value={agency.url || ""} onChange={(e) => setAgency({ url: e.target.value.trim() })} label={t("network.settings.label.url")} example="https://…" hint={t("network.settings.hint.url")} required={required("url")} testid="settings-agency-url" type="url" inputRef={urlRef} />
              <LabeledField value={agency.timezone || ""} onChange={(e) => setAgency({ timezone: e.target.value.trim() })} label={t("network.settings.label.timezone")} example="Europe/Paris" hint={t("network.settings.hint.timezone")} required={required("timezone")} testid="settings-agency-timezone" inputRef={timezoneRef} />
              <LabeledField value={agency.lang || ""} onChange={(e) => setAgency({ lang: e.target.value.trim().toLowerCase() })} label={t("network.settings.label.lang")} example="fr" hint={t("network.settings.hint.lang")} testid="settings-agency-lang" />
            </Box>
          </Group>
          <Group title={t("network.settings.validity")} testid="settings-validity">
            <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(3, minmax(0, 1fr))" }, gap: 0.75, alignItems: "start" }}>
              <DateField label={t("network.settings.label.start")} value={ymdToIso(feed.start_date)} onChange={(v) => setFeed({ start_date: isoToYmd(v) || undefined })} testid="settings-start" />
              <DateField label={t("network.settings.label.end")} value={ymdToIso(feed.end_date)} onChange={(v) => setFeed({ end_date: isoToYmd(v) || undefined })} testid="settings-end" />
              <Box>
                <Typography component="span" sx={{ display: "block", fontSize: "0.72rem", fontWeight: 700, mb: 0.25 }}>
                  {t("network.settings.field.weekend")}
                </Typography>
                <SelectField value={WEEKENDS[weekendKey] ? weekendKey : "sat,sun"} onChange={(e) => onChange({ ...spec, weekend: e.target.value === "sat,sun" ? undefined : WEEKENDS[e.target.value] })} label={t("network.settings.field.weekend")} minWidth={170} testid="settings-weekend">
                  {Object.keys(WEEKENDS).map((k) => (
                    <MenuItem key={k} value={k}>
                      {t(`network.settings.weekend.${k.replace(",", "_")}`)}
                    </MenuItem>
                  ))}
                </SelectField>
              </Box>
            </Box>
            <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap", alignItems: "center" }}>
              <Typography sx={{ fontSize: "0.76rem" }} data-testid="settings-holidays">
                {t("network.settings.holidays", { count: (spec.holidays || []).length })}
              </Typography>
              {territoryHolidays > 0 && <Chip size="small" label={t("network.settings.useTerritoryHolidays", { count: territoryHolidays })} onClick={() => onChange(prefillFromTerritory({ ...spec, holidays: [] }, { holidays: territory.holidays }).spec)} data-testid="settings-territory-holidays" sx={{ height: 22, fontSize: "0.68rem" }} />}
              <Typography component="span" sx={{ fontSize: "0.72rem", fontWeight: 700 }}>
                {t("network.settings.field.holidayService")}
              </Typography>
              <SelectField value={spec.holiday_service || "sunday"} onChange={(e) => onChange({ ...spec, holiday_service: e.target.value })} label={t("network.settings.field.holidayService")} minWidth={200} testid="settings-holiday-service">
                {["sunday", "saturday", "none"].map((k) => (
                  <MenuItem key={k} value={k}>
                    {t(`network.settings.holidayService.${k}`)}
                  </MenuItem>
                ))}
              </SelectField>
            </Box>
          </Group>
          <Group title={t("network.settings.runningTime")} hint={t("network.settings.runningTimeHint")}>
            <Box data-testid="settings-running-time" sx={{ display: "flex", gap: 0.75, flexWrap: "wrap", alignItems: "center" }}>
              {bands.map((b, i) => (
                <BandPill key={i} band={b} valueKey="factor" label={t("network.settings.field.factor")} prefix={t("network.settings.speedTimes")} testid="settings-rtp-band" onChange={(patch) => setBands(bands.map((x, k) => (k === i ? { ...x, ...patch } : x)))} onRemove={() => setBands(bands.filter((_, k) => k !== i))} />
              ))}
              <QuietButton startIcon={<AddIcon sx={{ fontSize: "16px !important" }} />} onClick={() => setBands([...bands, nextBand(bands, { factor: 0.85 })])} data-testid="settings-rtp-add">
                {t("network.speed.add")}
              </QuietButton>
            </Box>
          </Group>
          <Group title={t("network.settings.caps")} hint={t("network.settings.capsHint")}>
            <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr 1fr", sm: "repeat(4, 1fr)" }, gap: 0.75 }}>
              <LabeledField type="number" value={ops.max_vehicles ?? ""} onChange={(e) => setOps({ max_vehicles: num(e.target.value) })} label={t("network.settings.field.maxVehicles")} testid="settings-max-vehicles" mono />
              <LabeledField type="number" value={ops.max_cost_year ?? ""} onChange={(e) => setOps({ max_cost_year: num(e.target.value) })} label={t("network.settings.field.maxCost")} testid="settings-max-cost" mono />
              <LabeledField type="number" value={typeof ops.cost_per_km === "number" ? ops.cost_per_km : ""} onChange={(e) => setOps({ cost_per_km: num(e.target.value) })} label={t("network.settings.field.costPerKm")} testid="settings-cost-km" mono />
              <LabeledField value={ops.currency || ""} onChange={(e) => setOps({ currency: e.target.value.trim().toUpperCase().slice(0, 3) || undefined })} label={t("network.settings.label.currency")} example="EUR" testid="settings-currency" />
            </Box>
          </Group>
          <Group title={t("network.settings.costs")} hint={t("network.settings.costsHint")}>
            <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr 1fr", sm: "repeat(3, 1fr)" }, gap: 0.75 }}>
              <LabeledField type="number" value={ops.cost_per_hour ?? ""} onChange={(e) => setOps({ cost_per_hour: num(e.target.value) })} label={t("network.settings.field.costPerHour")} testid="settings-cost-hour" mono />
              <LabeledField type="number" value={ops.cost_per_vehicle_year ?? ""} onChange={(e) => setOps({ cost_per_vehicle_year: num(e.target.value) })} label={t("network.settings.field.costPerVehicle")} testid="settings-cost-vehicle" mono />
              <LabeledField type="number" value={ops.commercial_km_contract ?? ""} onChange={(e) => setOps({ commercial_km_contract: num(e.target.value) })} label={t("network.settings.field.contractKm")} testid="settings-contract-km" mono />
              <LabeledField type="number" value={ops.deadhead_pct ?? ""} onChange={(e) => setOps({ deadhead_pct: num(e.target.value) })} label={t("network.settings.field.deadhead")} testid="settings-deadhead" mono inputProps={{ min: 0, max: 100 }} />
              <LabeledField type="number" value={ops.reserve_pct ?? ""} onChange={(e) => setOps({ reserve_pct: num(e.target.value) })} label={t("network.settings.field.reserve")} testid="settings-reserve" mono inputProps={{ min: 0, max: 100 }} />
            </Box>
          </Group>
        </Box>
      </Collapse>
    </Box>
  );
}
