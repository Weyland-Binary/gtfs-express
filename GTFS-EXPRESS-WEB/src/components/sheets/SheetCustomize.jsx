/**
 * « Personnaliser »: what the sheets show, the network's look and the paper, out of the way of the one thing most
 * people do (choose a line, print). Three short views, each fitting the panel without a scroll; a column beside the
 * preview, so every change is seen at once on the sheet, and the look is shown again here as the header will print.
 * Nothing to confirm: the settings apply as they are set and are kept on this browser.
 */
import React, { useEffect, useRef, useState } from "react";
import { Box, Button, ButtonBase, Collapse, IconButton, InputAdornment, MenuItem, Switch, TextField, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import TimelapseOutlinedIcon from "@mui/icons-material/TimelapseOutlined";
import SchoolOutlinedIcon from "@mui/icons-material/SchoolOutlined";
import AltRouteOutlinedIcon from "@mui/icons-material/AltRouteOutlined";
import FormatSizeOutlinedIcon from "@mui/icons-material/FormatSizeOutlined";
import QrCode2OutlinedIcon from "@mui/icons-material/QrCode2Outlined";
import DateRangeOutlinedIcon from "@mui/icons-material/DateRangeOutlined";
import LinkRoundedIcon from "@mui/icons-material/LinkRounded";
import AddPhotoAlternateOutlinedIcon from "@mui/icons-material/AddPhotoAlternateOutlined";
import ColorizeOutlinedIcon from "@mui/icons-material/ColorizeOutlined";
import TranslateOutlinedIcon from "@mui/icons-material/TranslateOutlined";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import CropPortraitRoundedIcon from "@mui/icons-material/CropPortraitRounded";
import CropLandscapeRoundedIcon from "@mui/icons-material/CropLandscapeRounded";
import CloudDoneOutlinedIcon from "@mui/icons-material/CloudDoneOutlined";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import CalendarMonthOutlinedIcon from "@mui/icons-material/CalendarMonthOutlined";
import { Checkbox, CircularProgress, ToggleButton, ToggleButtonGroup } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import SegmentedSwitch from "../common/SegmentedSwitch";
import { DEFAULT_PREFS, LOGO_MAX_BYTES } from "./sheetPrefs";
import { FORMATS, routeColorsOf } from "./sheetLayout";

const ZONES = ["A", "B", "C"];
const QR_FIELDS = ["{stop_code}", "{stop_id}", "{stop_name}"];
const FOOTER_MAX = 160;
const FOOTER_COUNT_FROM = 120;
const SIZES = ["a4", "a3", "a5"];
const TABS = ["content", "brand", "paper", "calendar"];

function Heading({ children }) {
  return (
    <Typography component="h3" sx={{ fontSize: "0.72rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "text.secondary", mb: 0.75 }}>
      {children}
    </Typography>
  );
}

// One option: the whole row toggles it; off, its icon fades and its hint folds so the eye reads what is on.
function Option({ icon: Icon, label, hint, checked, onChange, testid }) {
  const theme = useTheme();
  return (
    <Box component="label" sx={{ display: "flex", alignItems: "center", gap: 1.25, mx: -1, px: 1, py: 0.6, borderRadius: "8px", cursor: "pointer", "&:hover": { backgroundColor: theme.palette.action.hover } }}>
      <Icon aria-hidden sx={{ fontSize: 20, color: checked ? "primary.main" : "text.disabled", transition: "color 150ms" }} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontSize: "0.9rem", fontWeight: 600, lineHeight: 1.3, color: checked ? "text.primary" : "text.secondary" }}>{label}</Typography>
        <Collapse in={checked && Boolean(hint)}>
          <Typography sx={{ fontSize: "0.78rem", color: "text.secondary", lineHeight: 1.35 }}>{hint}</Typography>
        </Collapse>
      </Box>
      <Switch size="small" checked={checked} onChange={(e) => onChange(e.target.checked)} inputProps={{ "data-testid": testid }} />
    </Box>
  );
}

// Nested settings of an option that is on, set off by a rule on their left.
function Nested({ open, children }) {
  const theme = useTheme();
  return (
    <Collapse in={open} unmountOnExit>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25, ml: 1.1, pl: 1.75, pt: 0.5, pb: 0.5, borderLeft: `2px solid ${alpha(theme.palette.primary.main, 0.3)}` }}>{children}</Box>
    </Collapse>
  );
}

// A route colour comes from the feed and may be malformed: the swatch then falls back to the theme's text colour.
const contrastOf = (theme, color) => {
  try {
    return theme.palette.getContrastText(color);
  } catch {
    return theme.palette.text.primary;
  }
};

// A decorative swatch is only the look of the native colour input laid over it.
function Swatch({ color, selected, label, onClick, size = 26, decorative = false, children }) {
  const theme = useTheme();
  const sx = {
    position: "relative",
    width: size,
    height: size,
    borderRadius: "50%",
    display: "grid",
    placeItems: "center",
    backgroundColor: color,
    color: contrastOf(theme, color),
    boxShadow: selected ? `0 0 0 2px ${theme.palette.background.paper}, 0 0 0 4px ${color}` : `inset 0 0 0 1px ${alpha(theme.palette.common.black, 0.12)}`,
    transition: "box-shadow 120ms",
    "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 4 },
  };
  const inner = (
    <>
      {selected && <CheckRoundedIcon sx={{ fontSize: size * 0.6 }} />}
      {children}
    </>
  );
  if (decorative)
    return (
      <Box aria-hidden sx={sx}>
        {inner}
      </Box>
    );
  return (
    <Tooltip title={label}>
      <ButtonBase role="radio" aria-checked={selected} aria-label={label} onClick={onClick} sx={sx}>
        {inner}
      </ButtonBase>
    </Tooltip>
  );
}

/** The sheet's header as it will print, in small: the line, its direction, the band's colour, the logo, the network. */
function BrandPreview({ sample, prefs, network, t }) {
  const route = sample?.route || { short: "A", color: "1E88E5", text: "FFFFFF" };
  const colors = routeColorsOf(route);
  const accent = prefs.accent || colors["--gx-route-ink"];
  return (
    <Box aria-label={t("sheets.brand.preview")} data-testid="sheets-brand-preview" sx={{ borderRadius: "10px", overflow: "hidden", border: `1px solid ${alpha("#000", 0.12)}`, backgroundColor: "#fff", color: "#1a1a1a", fontFamily: '"Inter", "Roboto", sans-serif' }}>
      <Box sx={{ display: "flex", alignItems: "stretch", backgroundColor: `#${route.color}`, color: `#${route.text}` }}>
        <Box sx={{ px: 1.25, display: "flex", alignItems: "center", fontSize: "1.3rem", fontWeight: 800, borderRight: "1px solid currentColor", opacity: 0.95 }}>{route.short}</Box>
        <Box sx={{ px: 1.25, py: 0.6, display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 0 }}>
          <Typography sx={{ fontSize: "0.62rem", opacity: 0.9, lineHeight: 1.1 }}>{t("sheets.direction")}</Typography>
          <Typography noWrap sx={{ fontSize: "0.92rem", fontWeight: 800, textTransform: "uppercase", lineHeight: 1.1 }}>
            {sample?.headsign || t("sheets.brand.sampleHeadsign")}
          </Typography>
        </Box>
        {prefs.logo && (
          <Box sx={{ ml: "auto", px: 1, display: "flex", alignItems: "center", backgroundColor: "#fff" }}>
            <Box component="img" src={prefs.logo} alt="" sx={{ maxHeight: 26, maxWidth: 72, objectFit: "contain" }} />
          </Box>
        )}
      </Box>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", px: 1.25, py: 0.5, fontSize: "0.7rem" }}>
        <Box component="span" sx={{ fontWeight: 700, color: accent }}>
          {t("sheets.brand.sampleValid")}
        </Box>
        <Box component="span" sx={{ color: "#6b6b6b" }}>{network || "…"}</Box>
      </Box>
      {prefs.footer && (
        <Box data-testid="sheets-brand-footer" sx={{ mx: 1, mb: 1, px: 1, py: 0.45, borderRadius: "4px", textAlign: "center", fontSize: "0.74rem", fontWeight: 800, color: "#fff", backgroundColor: accent }}>
          {prefs.footer}
        </Box>
      )}
    </Box>
  );
}

const isoShort = (iso, language) => new Intl.DateTimeFormat(language, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
const SOURCE_KEY = { ai: "sheets.calendar.source.ai", official: "sheets.calendar.source.official" };

/** One period or holiday the network shows, with the name it carries and the person's confirmation. */
function CalendarRow({ title, entry, cls, name, onName, kind, onKind, confirmed, onConfirm, testid, t }) {
  const theme = useTheme();
  const key = entry ? SOURCE_KEY[entry.source] : cls?.name ? SOURCE_KEY.official : null;
  const ai = entry?.source === "ai";
  return (
    <Box data-testid={testid} sx={{ display: "flex", flexDirection: "column", gap: 0.75, p: 1.25, borderRadius: "10px", border: `1px solid ${theme.palette.divider}`, backgroundColor: confirmed ? alpha(theme.palette.success.main, 0.05) : "transparent" }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
        <Typography sx={{ fontSize: "0.82rem", fontWeight: 650 }}>{title}</Typography>
        {key && (
          <Typography component="span" sx={{ fontSize: "0.68rem", fontWeight: 700, px: 0.6, py: 0.1, borderRadius: 1, color: ai ? theme.palette.ai?.dark || "primary.dark" : "text.secondary", backgroundColor: alpha(ai ? theme.palette.ai?.main || theme.palette.primary.main : theme.palette.text.primary, 0.08), whiteSpace: "nowrap" }}>
            {t(key)}
          </Typography>
        )}
      </Box>
      {entry || !cls?.name ? (
        <>
          <TextField size="small" fullWidth label={t("sheets.calendar.name")} value={name} onChange={(e) => onName(e.target.value)} inputProps={{ maxLength: 80, "data-testid": `${testid}-name` }} />
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, flexWrap: "wrap" }}>
            {onKind && (
              <ToggleButtonGroup exclusive size="small" value={kind} onChange={(_, v) => v && onKind(v)} sx={{ "& .MuiToggleButton-root": { textTransform: "none", fontSize: "0.74rem", px: 1, py: 0.25 } }}>
                <ToggleButton value="school" data-testid={`${testid}-school`}>{t("sheets.calendar.kind.school")}</ToggleButton>
                <ToggleButton value="other">{t("sheets.calendar.kind.other")}</ToggleButton>
              </ToggleButtonGroup>
            )}
            <Box component="label" sx={{ display: "inline-flex", alignItems: "center", gap: 0.25, cursor: name ? "pointer" : "default", ml: "auto" }}>
              <Checkbox size="small" checked={confirmed} disabled={!name} onChange={(e) => onConfirm(e.target.checked)} inputProps={{ "data-testid": `${testid}-confirm` }} />
              <Typography sx={{ fontSize: "0.78rem", fontWeight: 600, color: confirmed ? "success.dark" : "text.secondary" }}>{t("sheets.calendar.confirmed")}</Typography>
            </Box>
          </Box>
        </>
      ) : (
        <Typography sx={{ fontSize: "0.84rem" }}>{cls.name.text || t("sheets.calendar.kind.school")}</Typography>
      )}
    </Box>
  );
}

/**
 * « Calendrier »: what the network shows over the period (the blocks run with another timetable, the weekdays run like
 * a Sunday), each with the name it carries: confirmed, proposed by the model, or from the official calendar; nothing
 * is printed before the person confirms it.
 */
function CalendarTab({ calendar, onChange, onSuggest, suggesting, aiLocked, language, t }) {
  const theme = useTheme();
  const data = calendar?.data || null;
  const [draft, setDraft] = useState(null);
  // What the server answered last stands: a save or the model's proposals replace the edits in hand.
  useEffect(() => setDraft(null), [data?.updatedAt]);
  const periods = draft?.periods || data?.periods || [];
  const holidays = draft?.holidays || data?.holidays || [];
  const commit = (next) => {
    setDraft(next);
    onChange(next);
  };
  const rows = (data?.classes || []).filter((c) => c.kind === "alt").flatMap((c) => c.ranges.map((r) => ({ cls: c, from: r.from, to: r.to })));
  const dates = (data?.classes || []).flatMap((c) => c.holidays || []);
  const entryOf = (r) => periods.find((p) => p.from === r.from && p.to === r.to) || null;
  const holidayOf = (d) => holidays.find((h) => h.date === d) || null;
  const setPeriod = (r, patch) => {
    const current = entryOf(r) || { from: r.from, to: r.to, name: "", kind: "school", source: "user", confirmed: false };
    const next = { ...current, ...patch, source: patch.name !== undefined && patch.name !== current.name ? "user" : current.source };
    commit({ periods: [...periods.filter((p) => !(p.from === r.from && p.to === r.to)), ...(next.name ? [next] : [])], holidays });
  };
  const setHoliday = (d, patch) => {
    const current = holidayOf(d) || { date: d, name: "", source: "user", confirmed: false };
    const next = { ...current, ...patch, source: patch.name !== undefined && patch.name !== current.name ? "user" : current.source };
    commit({ periods, holidays: [...holidays.filter((h) => h.date !== d), ...(next.name ? [next] : [])] });
  };
  if (!data && calendar?.loading) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, color: "text.secondary", fontSize: "0.85rem" }}>
        <CircularProgress size={16} /> {t("sheets.calendar.loading")}
      </Box>
    );
  }
  return (
    <>
      <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", lineHeight: 1.45 }}>{t("sheets.calendar.help")}</Typography>
      {!rows.length && !dates.length ? (
        <Typography data-testid="sheets-calendar-empty" sx={{ fontSize: "0.86rem", color: "text.secondary" }}>{t("sheets.calendar.empty")}</Typography>
      ) : (
        <>
          <Button variant="contained" disableElevation onClick={onSuggest} disabled={suggesting} startIcon={suggesting ? <CircularProgress size={14} color="inherit" /> : aiLocked ? <LockOutlinedIcon /> : <AutoAwesomeRoundedIcon />} data-testid="sheets-calendar-suggest" sx={{ alignSelf: "flex-start", textTransform: "none", fontWeight: 700, borderRadius: "9px", background: `linear-gradient(135deg, ${theme.palette.ai?.gradientStart || theme.palette.primary.main}, ${theme.palette.ai?.gradientEnd || theme.palette.primary.dark})` }}>
            {suggesting ? t("sheets.calendar.suggesting") : t("sheets.calendar.suggest")}
          </Button>
          <Typography sx={{ fontSize: "0.76rem", color: "text.secondary", mt: -1.5 }}>{t("sheets.calendar.suggestHint")}</Typography>
          {rows.length > 0 && (
            <Box>
              <Heading>{t("sheets.calendar.blocks")}</Heading>
              <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                {rows.map((r, i) => {
                  const entry = entryOf(r);
                  return <CalendarRow t={t} key={`${r.from}-${r.to}`} testid={`sheets-calendar-period-${i}`} title={`${isoShort(r.from, language)} → ${isoShort(r.to, language)}`} entry={entry} cls={r.cls} name={entry?.name || ""} onName={(v) => setPeriod(r, { name: v })} kind={entry?.kind || "school"} onKind={(v) => setPeriod(r, { kind: v })} confirmed={Boolean(entry?.confirmed)} onConfirm={(v) => setPeriod(r, { confirmed: v })} />;
                })}
              </Box>
            </Box>
          )}
          {dates.length > 0 && (
            <Box>
              <Heading>{t("sheets.calendar.holidays")}</Heading>
              <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                {dates.map((h, i) => {
                  const entry = holidayOf(h.date);
                  return <CalendarRow t={t} key={h.date} testid={`sheets-calendar-holiday-${i}`} title={isoShort(h.date, language)} entry={entry} cls={null} name={entry?.name || ""} onName={(v) => setHoliday(h.date, { name: v })} confirmed={Boolean(entry?.confirmed)} onConfirm={(v) => setHoliday(h.date, { confirmed: v })} />;
                })}
              </Box>
            </Box>
          )}
        </>
      )}
    </>
  );
}

/** The paper as a silhouette, in proportion, turning with the orientation. */
function PaperIcon({ paper }) {
  const theme = useTheme();
  const scale = 40 / Math.max(paper.w, paper.h);
  return (
    <Box aria-hidden sx={{ width: 48, height: 48, flexShrink: 0, display: "grid", placeItems: "center" }}>
      <Box sx={{ width: Math.round(paper.w * scale), height: Math.round(paper.h * scale), borderRadius: "3px", border: `1.5px solid ${theme.palette.primary.main}`, backgroundColor: theme.palette.background.paper, transition: "width 200ms, height 200ms", boxShadow: `2px 2px 0 ${alpha(theme.palette.primary.main, 0.15)}` }} />
    </Box>
  );
}

export default function SheetCustomize({ open, onClose, setup, custom, setCustom, usingCustom, setUsingCustom, region, setRegion, prefs, setPref, sample = null, calendar = null, onCalendarChange = null, onCalendarSuggest = null, suggesting = false, aiLocked = false }) {
  const theme = useTheme();
  const { t, language, languages } = useLanguage();
  const fileRef = useRef(null);
  const qrRef = useRef(null);
  const [tab, setTab] = useState("content");
  const [logoError, setLogoError] = useState(false);
  const [dragging, setDragging] = useState(false);
  const school = setup.school;
  const zoneShown = school && !["not_france", "no_country"].includes(school.status);
  const zoneAuto = school?.region_source === "inferred" && school.region ? t("sheets.school.inferred", { zone: school.region }) : t("sheets.school.common");
  const presets = [...new Set([theme.palette.primary.main, theme.palette.info.main, theme.palette.success.main, theme.palette.warning.main, theme.palette.error.main, theme.palette.secondary.main].map((c) => c.toLowerCase()))];
  const accent = (prefs.accent || "").toLowerCase();
  const customAccent = accent && !presets.includes(accent) ? accent : "";
  const changed = Object.keys(DEFAULT_PREFS).some((k) => prefs[k] !== DEFAULT_PREFS[k]);
  const routeColor = sample?.route ? `#${sample.route.color}` : theme.palette.primary.main;
  const format = FORMATS[prefs.format] ? prefs.format : "a4p";
  const size = format.slice(0, 2);
  const orientation = format.slice(2);
  const setPaper = (s, o) => setPref("format", FORMATS[`${s}${o}`] ? `${s}${o}` : `${s}p`);

  const pickLogo = (file) => {
    if (!file || !file.type?.startsWith("image/")) return;
    if (file.size > LOGO_MAX_BYTES) {
      setLogoError(true);
      return;
    }
    setLogoError(false);
    const reader = new FileReader();
    reader.onload = () => setPref("logo", String(reader.result || ""));
    reader.readAsDataURL(file);
  };

  // A field clicked goes where the caret is, so the address can be written around it.
  const insertField = (field) => {
    const input = qrRef.current;
    const value = prefs.qrUrl || "";
    const at = input && typeof input.selectionStart === "number" ? input.selectionStart : value.length;
    const end = input && typeof input.selectionEnd === "number" ? input.selectionEnd : at;
    setPref("qrUrl", value.slice(0, at) + field + value.slice(end));
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(at + field.length, at + field.length);
    });
  };

  if (!open) return null;

  const reset = () => {
    for (const [k, v] of Object.entries(DEFAULT_PREFS)) setPref(k, v);
    setLogoError(false);
  };
  const tabLabel = { content: t("sheets.content.title"), brand: t("sheets.brand.title"), paper: t("sheets.tab.paper"), calendar: t("sheets.tab.calendar") };

  return (
    <Box component="aside" aria-labelledby="sheets-customize-title" data-testid="sheets-customize" data-tab={tab} onKeyDown={(e) => e.key === "Escape" && onClose()} sx={{ width: { xs: 400, xl: 460 }, flexShrink: 0, minHeight: 0, display: "flex", flexDirection: "column", borderLeft: `1px solid ${theme.palette.divider}`, bgcolor: "background.paper" }}>
      <Box sx={{ px: 2, pt: 1.5, pb: 1.25, flexShrink: 0, borderBottom: `1px solid ${theme.palette.divider}`, display: "flex", flexDirection: "column", gap: 1.25 }}>
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
          <Typography id="sheets-customize-title" component="h2" sx={{ fontSize: "1.15rem", fontWeight: 750, letterSpacing: "-0.01em" }}>
            {t("sheets.customize.title")}
          </Typography>
          <IconButton onClick={onClose} aria-label={t("sheets.customize.close")} data-testid="sheets-customize-close" sx={{ mr: -1 }}>
            <CloseIcon />
          </IconButton>
        </Box>
        <Box sx={{ display: "flex", "& [role=radiogroup]": { flex: 1 }, "& [role=radio]": { flex: 1 } }}>
          <SegmentedSwitch options={TABS.map((v) => ({ value: v, label: tabLabel[v], ...(v === "calendar" && calendar?.data?.classes?.some((c) => c.kind === "alt" || c.holidays?.length) ? { icon: <CalendarMonthOutlinedIcon /> } : {}) }))} value={tab} onChange={setTab} label={t("sheets.customize.title")} testid="sheets-customize-tab" />
        </Box>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 2, py: 2, display: "flex", flexDirection: "column", gap: 2.25 }}>
        {tab === "content" && (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
            <Option icon={TimelapseOutlinedIcon} label={t("sheets.content.freq")} hint={t("sheets.content.freqHint")} checked={prefs.freq} onChange={(v) => setPref("freq", v)} testid="sheets-freq" />
            <Option icon={SchoolOutlinedIcon} label={t("sheets.content.school")} hint={t("sheets.content.schoolHint")} checked={prefs.school} onChange={(v) => setPref("school", v)} testid="sheets-school" />
            <Option icon={AltRouteOutlinedIcon} label={t("sheets.content.links")} hint={t("sheets.content.linksHint")} checked={prefs.links} onChange={(v) => setPref("links", v)} testid="sheets-links" />
            <Option icon={FormatSizeOutlinedIcon} label={t("sheets.content.large")} hint={t("sheets.content.largeHint")} checked={prefs.large} onChange={(v) => setPref("large", v)} testid="sheets-large" />
            <Option icon={QrCode2OutlinedIcon} label={t("sheets.content.qr")} hint={t("sheets.content.qrHint")} checked={prefs.qr} onChange={(v) => setPref("qr", v)} testid="sheets-qr" />
            <Nested open={prefs.qr}>
              <Box>
                <TextField fullWidth size="small" label={t("sheets.content.qrUrl")} placeholder="https://…/{stop_code}" value={prefs.qrUrl} onChange={(e) => setPref("qrUrl", e.target.value)} inputRef={qrRef} InputProps={{ startAdornment: <InputAdornment position="start"><LinkRoundedIcon sx={{ fontSize: 18 }} /></InputAdornment> }} inputProps={{ "data-testid": "sheets-qr-url" }} />
                <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 0.75, mt: 1 }}>
                  <Typography sx={{ fontSize: "0.78rem", color: "text.secondary" }}>{t("sheets.content.qrFields")}</Typography>
                  {QR_FIELDS.map((f) => (
                    <ButtonBase key={f} onClick={() => insertField(f)} sx={{ px: 1, height: 24, borderRadius: "6px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.74rem", color: "primary.main", backgroundColor: alpha(theme.palette.primary.main, 0.08), "&:hover": { backgroundColor: alpha(theme.palette.primary.main, 0.16) }, "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}` } }}>
                      {f}
                    </ButtonBase>
                  ))}
                </Box>
              </Box>
              <TextField fullWidth size="small" label={t("sheets.content.qrCaption")} value={prefs.qrCaption} onChange={(e) => setPref("qrCaption", e.target.value)} />
            </Nested>
          </Box>
        )}

        {tab === "brand" && (
          <>
            <BrandPreview sample={sample} prefs={prefs} network={prefs.network || setup.agency?.name || ""} t={t} />
            <Box>
              <Heading>{t("sheets.brand.identity")}</Heading>
              <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
                <ButtonBase
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    pickLogo(e.dataTransfer.files?.[0]);
                  }}
                  data-testid="sheets-logo"
                  sx={{ width: "100%", display: "flex", alignItems: "center", gap: 1.25, p: 0.75, borderRadius: "10px", textAlign: "left", border: `1.5px dashed ${dragging ? theme.palette.primary.main : theme.palette.divider}`, backgroundColor: dragging ? alpha(theme.palette.primary.main, 0.06) : "transparent", transition: "border-color 120ms, background-color 120ms", "&:hover": { borderColor: theme.palette.primary.main }, "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 } }}
                >
                  <Box sx={{ width: 52, height: 36, flexShrink: 0, display: "grid", placeItems: "center", borderRadius: "8px", backgroundColor: prefs.logo ? theme.palette.common.white : alpha(theme.palette.primary.main, 0.08), border: prefs.logo ? `1px solid ${theme.palette.divider}` : "none" }}>
                    {prefs.logo ? <Box component="img" src={prefs.logo} alt="" sx={{ maxWidth: 46, maxHeight: 30, objectFit: "contain" }} /> : <AddPhotoAlternateOutlinedIcon sx={{ color: "primary.main" }} />}
                  </Box>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography sx={{ fontSize: "0.9rem", fontWeight: 600, color: "primary.main" }}>{prefs.logo ? t("sheets.brand.logoChange") : t("sheets.brand.logoAdd")}</Typography>
                    <Typography sx={{ fontSize: "0.76rem", color: logoError ? "error.main" : "text.secondary" }}>{logoError ? t("sheets.brand.logoTooBig") : t("sheets.brand.logoHint")}</Typography>
                  </Box>
                  {prefs.logo && (
                    <Button
                      component="span"
                      size="small"
                      color="inherit"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPref("logo", "");
                      }}
                      sx={{ textTransform: "none", color: "text.secondary", flexShrink: 0 }}
                    >
                      {t("sheets.brand.logoRemove")}
                    </Button>
                  )}
                </ButtonBase>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" hidden onChange={(e) => pickLogo(e.target.files?.[0])} />
                <TextField fullWidth size="small" label={t("sheets.brand.network")} value={prefs.network} placeholder={setup.agency?.name || ""} onChange={(e) => setPref("network", e.target.value)} inputProps={{ "data-testid": "sheets-network" }} />
              </Box>
            </Box>
            <Box>
              <Heading>{t("sheets.brand.accent")}</Heading>
              <Box role="radiogroup" aria-label={t("sheets.brand.accent")} sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1 }}>
                <ButtonBase role="radio" aria-checked={!accent} onClick={() => setPref("accent", "")} data-testid="sheets-accent-line" sx={{ display: "flex", alignItems: "center", gap: 1, pl: 0.5, pr: 1.25, py: 0.5, borderRadius: 999, border: `1.5px solid ${!accent ? theme.palette.primary.main : theme.palette.divider}`, backgroundColor: !accent ? alpha(theme.palette.primary.main, 0.06) : "transparent", "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 } }}>
                  <Swatch decorative color={routeColor} selected={!accent} size={22} />
                  <Typography sx={{ fontSize: "0.82rem", fontWeight: 600 }}>{t("sheets.brand.accentAuto")}</Typography>
                </ButtonBase>
                <Box aria-hidden sx={{ width: "1px", height: 22, backgroundColor: theme.palette.divider, mx: 0.25 }} />
                {presets.map((c) => (
                  <Swatch key={c} color={c} selected={accent === c} label={c} size={22} onClick={() => setPref("accent", c)} />
                ))}
                <Box title={t("sheets.brand.colorCustom")} sx={{ position: "relative", borderRadius: "50%", "&:has(input:focus-visible)": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 4 } }}>
                  <Swatch decorative color={customAccent || theme.palette.background.paper} selected={Boolean(customAccent)} size={22}>
                    {!customAccent && <ColorizeOutlinedIcon sx={{ fontSize: 14, color: "text.secondary" }} />}
                  </Swatch>
                  <Box component="input" type="color" value={customAccent || (/^#[0-9a-f]{6}$/i.test(routeColor) ? routeColor : theme.palette.primary.main)} onChange={(e) => setPref("accent", e.target.value)} aria-label={t("sheets.brand.colorCustom")} data-testid="sheets-accent-custom" sx={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer", border: 0, p: 0 }} />
                </Box>
              </Box>
            </Box>
            <Box>
              <Heading>{t("sheets.brand.footer")}</Heading>
              <TextField fullWidth size="small" multiline maxRows={3} value={prefs.footer} onChange={(e) => setPref("footer", e.target.value.replace(/\n/g, " "))} placeholder={t("sheets.brand.footerHint")} helperText={prefs.footer.length >= FOOTER_COUNT_FROM ? `${prefs.footer.length} / ${FOOTER_MAX}` : " "} FormHelperTextProps={{ sx: { textAlign: "right", mx: 0, minHeight: 0 } }} inputProps={{ maxLength: FOOTER_MAX, "data-testid": "sheets-footer", "aria-label": t("sheets.brand.footer") }} />
            </Box>
          </>
        )}

        {tab === "paper" && (
          <>
            <Box>
              <Heading>{t("sheets.format.title")}</Heading>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
                <PaperIcon paper={FORMATS[format]} />
                <Box sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 1 }}>
                  <TextField select size="small" value={size} onChange={(e) => setPaper(e.target.value, orientation)} inputProps={{ "data-testid": "sheets-size", "aria-label": t("sheets.format.title") }}>
                    {SIZES.map((s) => (
                      <MenuItem key={s} value={s}>
                        {s.toUpperCase()} · {FORMATS[`${s}p`].w} × {FORMATS[`${s}p`].h} mm
                      </MenuItem>
                    ))}
                  </TextField>
                  <SegmentedSwitch
                    options={[
                      { value: "p", label: t("sheets.format.portrait"), icon: <CropPortraitRoundedIcon /> },
                      { value: "l", label: t("sheets.format.landscape"), icon: <CropLandscapeRoundedIcon />, disabled: !FORMATS[`${size}l`] },
                    ]}
                    value={orientation}
                    onChange={(o) => setPaper(size, o)}
                    label={t("sheets.format.orientation")}
                    testid="sheets-orientation"
                  />
                </Box>
              </Box>
            </Box>
            <Box>
              <Heading>{t("sheets.brand.lang")}</Heading>
              <TextField select fullWidth size="small" value={prefs.lang || language} onChange={(e) => setPref("lang", e.target.value)} helperText={t("sheets.brand.langHint")} InputProps={{ startAdornment: <InputAdornment position="start"><TranslateOutlinedIcon sx={{ fontSize: 18 }} /></InputAdornment> }} inputProps={{ "data-testid": "sheets-lang", "aria-label": t("sheets.brand.lang") }}>
                {languages.map((l) => (
                  <MenuItem key={l.code} value={l.code}>
                    <Box component="span" sx={{ display: "inline-block", width: 28, fontFamily: "ui-monospace, Menlo, monospace", fontSize: "0.75rem", color: "text.secondary" }}>
                      {l.code.toUpperCase()}
                    </Box>
                    {l.label}
                  </MenuItem>
                ))}
              </TextField>
            </Box>
          </>
        )}

        {tab === "calendar" && (
          <>
            <CalendarTab calendar={calendar} onChange={(next) => onCalendarChange?.(next)} onSuggest={() => onCalendarSuggest?.()} suggesting={suggesting} aiLocked={aiLocked} language={language} t={t} />
            <Box>
              <Heading>{t("sheets.calendar.title")}</Heading>
              <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                {zoneShown && (
                  <TextField select fullWidth size="small" label={t("sheets.school.zone")} value={region || ""} onChange={(e) => setRegion(e.target.value || null)} inputProps={{ "data-testid": "sheets-zone" }}>
                    <MenuItem value="">{zoneAuto}</MenuItem>
                    {ZONES.map((z) => (
                      <MenuItem key={z} value={z}>
                        {t("sheets.school.zoneName", { zone: z })}
                      </MenuItem>
                    ))}
                  </TextField>
                )}
                <Option icon={DateRangeOutlinedIcon} label={t("sheets.period.customDates")} hint={t("sheets.period.customHint")} checked={usingCustom} onChange={setUsingCustom} testid="sheets-period-custom" />
                <Nested open={usingCustom}>
                  <Box sx={{ display: "flex", gap: 1 }}>
                    <TextField size="small" type="date" label={t("sheets.period.from")} value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} InputLabelProps={{ shrink: true }} inputProps={{ min: setup.range?.from, max: setup.range?.to, "data-testid": "sheets-from" }} sx={{ flex: 1 }} />
                    <TextField size="small" type="date" label={t("sheets.period.to")} value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} InputLabelProps={{ shrink: true }} inputProps={{ min: setup.range?.from, max: setup.range?.to, "data-testid": "sheets-to" }} sx={{ flex: 1 }} />
                  </Box>
                </Nested>
              </Box>
            </Box>
          </>
        )}
      </Box>

      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, px: 2, py: 1, flexShrink: 0, borderTop: `1px solid ${theme.palette.divider}` }}>
        <Button color="inherit" size="small" startIcon={<RestartAltRoundedIcon />} onClick={reset} disabled={!changed} data-testid="sheets-customize-reset" sx={{ textTransform: "none", color: "text.secondary" }}>
          {t("sheets.customize.reset")}
        </Button>
        <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontSize: "0.76rem", color: "text.secondary" }} data-testid="sheets-customize-saved">
          <CloudDoneOutlinedIcon sx={{ fontSize: 16, color: "success.main" }} />
          {t("sheets.customize.savedShort")}
        </Box>
      </Box>
    </Box>
  );
}
