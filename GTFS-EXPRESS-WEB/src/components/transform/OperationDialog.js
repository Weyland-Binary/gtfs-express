/**
 * OperationDialog — add or edit one operation of a change plan with a form
 * generated from the engine's catalogue, in the reader's words.
 *
 * The catalogue is listed by category with localized titles (searchable in
 * the reader's language and by the engine's names). The parameters come in
 * sections: what the operation needs first, then which trips (direction,
 * times, route variant), then the scope (days, dates, periods, school
 * zone) and the advanced options — the last three folded unless they hold
 * a value. Lines and stops are picked from the feed, dates typed in the
 * app's language, days/periods/directions chosen from their names.
 *
 * Without the assistant this form is how a change is written: opened
 * without an operation, it shows the catalogue itself — by family, each operation with
 * what it does, filtered by what is typed in the field — never an empty
 * field; every label is visible and a required one says « requis » in
 * text; « Enregistrer et simuler » stays disabled while a required field
 * is empty, and says which ones under it (`operation-missing`), rather than
 * saving a step the engine would only block with a question — the
 * parameters that stand in for each other are one group of the catalogue
 * (`requires_one_of`: `route` or `routes`, `end_date` or `start_date`,
 * `direction` or `pattern`, `days` or `dates`), asked as one (« Ligne ou
 * Lignes ») and said « requis » on the first member only while no other
 * has a value (missingRequired, saysRequired). A new
 * operation takes the framing's period as its default (`defaults`: the
 * dates of ②'s « Mise en service »), shown and changeable like any value.
 */

import React, { useEffect, useId, useMemo, useState } from "react";
import { Autocomplete, Box, Button, Collapse, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, TextField, Typography, useMediaQuery, useTheme } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import { SectionHeader } from "../network/StudioUI";
import { DateField, DateListField } from "./DateField";
import { DAY_CHOICES, DAY_VALUES, DIRECTION_CHOICES, PERIOD_CHOICES, boolLabel, categoryLabel, dayLabel, directionLabel, enumChoices, enumLabel, groupParams, missingLabel, missingRequired, opHelp, opTitle, paramHelp, paramLabel, periodLabel, saysRequired, sortCatalogue } from "./catalogueText";
import { OperationCatalog } from "./ManualSidebar";

const LIST_TYPES = ["times", "dates", "stops", "routes"];
const MULTILINE_TYPES = ["object", "list", "periods", "departures", "array", "text"];

export const parseInput = (type, raw) => {
  if (raw === "" || raw == null) return undefined;
  if (type === "number") {
    const n = Number(String(raw).replace(",", "."));
    return Number.isFinite(n) ? n : raw;
  }
  if (Array.isArray(raw)) {
    if (!raw.length) return undefined;
    return type === "days" && raw.length === 1 ? raw[0] : raw;
  }
  const s = String(raw).trim();
  if (type === "money") {
    const n = Number(s.replace(",", "."));
    return Number.isFinite(n) ? n : s;
  }
  if (type === "boolean") return s === "true" ? true : s === "false" ? false : s;
  if (type === "color") return s.replace(/^#/, "").toUpperCase();
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  if (LIST_TYPES.includes(type) && s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);
  return s;
};

export const toInput = (v, type) => {
  if (v == null) return "";
  if (["routes", "stops", "days", "dates"].includes(type) && Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
  if (type === "days" && typeof v === "string" && v.includes(",")) return v.split(",").map((x) => x.trim()).filter(Boolean);
  if (type === "days" && typeof v === "string") return [v];
  if (typeof v === "boolean") return String(v);
  return typeof v === "object" ? JSON.stringify(v) : String(v);
};

const hasValue = (v) => (Array.isArray(v) ? v.length > 0 : String(v ?? "").trim() !== "");
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const asList = (v) => (Array.isArray(v) ? v : v ? String(v).split(",").map((x) => x.trim()).filter(Boolean) : []);

/** The choice whose words a person typed (« les deux » → both, « semaine » → weekday), else null. */
export const choiceTyped = (text, choices, labelOf) => {
  const q = norm(text).trim();
  if (!q) return null;
  if (choices.includes(text.trim())) return text.trim();
  const words = (s) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);
  // The exact words, else the label that starts with them, else one of its words that does (« semaine » → « En semaine »).
  return choices.find((c) => norm(labelOf(c)) === q) || choices.find((c) => norm(labelOf(c)).startsWith(q)) || choices.find((c) => words(labelOf(c)).some((w) => w.startsWith(q))) || null;
};

/**
 * A select of named choices that still accepts a free value (a destination, a named period…). Its arrow says it
 * is a list; words that name a choice are that choice (typing « les deux » is « both », never a destination).
 */
function ChoiceField({ label, helperText, value, choices, labelOf, onChange, testid, required = false }) {
  return (
    <Autocomplete
      freeSolo
      forcePopupIcon
      options={choices}
      value={value || ""}
      getOptionLabel={(o) => (choices.includes(o) ? labelOf(o) : String(o || ""))}
      onChange={(_, v) => onChange(v || "")}
      onInputChange={(_, v, reason) => {
        if (reason !== "input") return;
        // Only the exact words of a choice: a destination's name may contain « aller » or « retour ».
        const exact = choices.find((c) => norm(labelOf(c)) === norm(v).trim());
        onChange(exact || v);
      }}
      renderInput={(params) => <TextField {...params} size="small" label={label} helperText={helperText} inputProps={{ ...params.inputProps, "data-testid": testid, "aria-required": required || undefined }} />}
    />
  );
}

/**
 * The days: chips from a list (its arrow shows it is one). What is typed counts even without « Entrée »: on leaving
 * the field it becomes a chip, the day it names when it names one (« semaine » → En semaine): a person who types
 * « semaine » as the help suggests is never told « Champs requis manquants : Jours ».
 */
function DaysField({ label, helperText, value, onChange, testid, required = false }) {
  const { t } = useLanguage();
  const [input, setInput] = useState("");
  const list = asList(value);
  const labelOf = (o) => (DAY_VALUES.includes(o) ? dayLabel(t, o) : String(o));
  const toDay = (s) => (DAY_VALUES.includes(s) ? s : choiceTyped(String(s), DAY_CHOICES, labelOf) || String(s).trim());
  const set = (next) => onChange([...new Set(next.map(toDay).filter(Boolean))]);
  const commit = () => {
    if (!input.trim()) return;
    set([...list, input]);
    setInput("");
  };
  return (
    <Autocomplete
      multiple
      freeSolo
      forcePopupIcon
      options={DAY_CHOICES}
      value={list}
      inputValue={input}
      onInputChange={(_, v, reason) => reason !== "reset" && setInput(v)}
      getOptionLabel={labelOf}
      onChange={(_, next) => {
        set(next);
        setInput("");
      }}
      onBlur={commit}
      renderInput={(params) => <TextField {...params} size="small" label={label} helperText={helperText} inputProps={{ ...params.inputProps, "data-testid": testid, "aria-required": required || undefined }} />}
    />
  );
}

function ParamField({ opType, p, value, onChange, routes, stopNames, example }) {
  const { t } = useLanguage();
  // "requis" said in text, never an asterisk alone (RGAA 11.10); aria-required for assistive technologies.
  const label = `${paramLabel(t, opType, p)}${p.required ? ` (${t("form.required")})` : ""}`;
  const helperText = paramHelp(t, opType, p);
  const testid = `change-param-${p.name}`;
  const common = { size: "small", fullWidth: true, label, helperText, value: value ?? "", onChange: (e) => onChange(e.target.value), inputProps: { "data-testid": testid, "aria-required": p.required || undefined } };
  const routeLabel = (r) => `${r.short_name || r.id}${r.long_name ? ` — ${r.long_name}` : ""}`;
  switch (p.type) {
    case "route":
      if (routes?.length) {
        return (
          <TextField {...common} select>
            <MenuItem value="">—</MenuItem>
            {routes.map((r) => (
              <MenuItem key={r.id} value={r.short_name || r.id}>
                {routeLabel(r)}
              </MenuItem>
            ))}
          </TextField>
        );
      }
      return <TextField {...common} />;
    case "routes": {
      const options = ["all", ...(routes || []).map((r) => r.short_name || r.id)];
      const byName = new Map((routes || []).map((r) => [r.short_name || r.id, r]));
      return (
        <Autocomplete
          multiple
          freeSolo
          options={options}
          value={value === "all" ? ["all"] : asList(value)}
          getOptionLabel={(o) => (o === "all" ? t("transform.form.allLines") : byName.has(o) ? routeLabel(byName.get(o)) : String(o))}
          onChange={(_, list) => onChange(list.includes("all") ? "all" : list)}
          renderInput={(params) => <TextField {...params} size="small" label={label} helperText={helperText} inputProps={{ ...params.inputProps, "data-testid": testid, "aria-required": p.required || undefined }} />}
        />
      );
    }
    case "stop":
      return (
        <Autocomplete
          freeSolo
          options={stopNames}
          value={value || ""}
          filterOptions={(opts, state) => {
            const q = norm(state.inputValue);
            return (q ? opts.filter((o) => norm(o).includes(q)) : opts).slice(0, 50);
          }}
          onChange={(_, v) => onChange(v || "")}
          onInputChange={(_, v, reason) => reason === "input" && onChange(v)}
          renderInput={(params) => <TextField {...params} size="small" label={label} helperText={helperText} inputProps={{ ...params.inputProps, "data-testid": testid, "aria-required": p.required || undefined }} />}
        />
      );
    case "stops":
      if (typeof value === "string" && value.trim().startsWith("[{")) return <TextField {...common} multiline />;
      return (
        <Autocomplete
          multiple
          freeSolo
          options={stopNames}
          value={asList(value)}
          filterOptions={(opts, state) => {
            const q = norm(state.inputValue);
            return (q ? opts.filter((o) => norm(o).includes(q)) : opts).slice(0, 50);
          }}
          onChange={(_, list) => onChange(list)}
          renderInput={(params) => <TextField {...params} size="small" label={label} helperText={helperText} inputProps={{ ...params.inputProps, "data-testid": testid, "aria-required": p.required || undefined }} />}
        />
      );
    case "enum":
      if (Array.isArray(p.enum)) {
        return (
          <TextField {...common} select>
            <MenuItem value="">—</MenuItem>
            {enumChoices(p).map((v) => (
              <MenuItem key={v} value={v}>
                {enumLabel(t, p.name, v)}
              </MenuItem>
            ))}
          </TextField>
        );
      }
      return <TextField {...common} />;
    case "days":
      return <DaysField label={label} helperText={helperText} value={value} onChange={onChange} testid={testid} required={p.required} />;
    case "period":
      return <ChoiceField label={label} helperText={helperText} value={value} choices={PERIOD_CHOICES} labelOf={(v) => periodLabel(t, v)} onChange={onChange} testid={testid} required={p.required} />;
    case "direction":
      return <ChoiceField label={label} helperText={helperText} value={value} choices={DIRECTION_CHOICES} labelOf={(v) => directionLabel(t, v)} onChange={onChange} testid={testid} required={p.required} />;
    case "boolean":
      return (
        <TextField {...common} select>
          <MenuItem value="">—</MenuItem>
          <MenuItem value="true">{boolLabel(t, true)}</MenuItem>
          <MenuItem value="false">{boolLabel(t, false)}</MenuItem>
        </TextField>
      );
    case "color": {
      const hex = String(value || "").replace(/^#/, "");
      return <TextField {...common} placeholder="6E6E6E" InputProps={{ startAdornment: /^[0-9a-fA-F]{6}$/.test(hex) ? <Box sx={{ width: 16, height: 16, borderRadius: "4px", mr: 1, flexShrink: 0, background: `#${hex}`, boxShadow: "0 0 0 1px rgba(0,0,0,0.2)" }} /> : null }} />;
    }
    case "date":
      return <DateField label={label} ariaRequired={p.required} helperText={helperText} value={value} onChange={onChange} testid={testid} />;
    case "dates":
      return <DateListField label={label} ariaRequired={p.required} helperText={helperText} value={value} onChange={onChange} testid={testid} />;
    case "time":
      return <TextField {...common} placeholder="07:30" />;
    case "times":
      return <TextField {...common} placeholder="07:15, 07:45, 08:15" />;
    case "number":
      return <TextField {...common} type="number" />;
    case "money":
      return <TextField {...common} placeholder="2,10" />;
    default: {
      // Lists and objects: the catalogue's example shows the expected shape.
      const ex = example !== undefined ? toInput(example) : LIST_TYPES.includes(p.type) ? "a, b, c" : "";
      return <TextField {...common} placeholder={Array.isArray(ex) ? ex.join(", ") : ex} multiline={MULTILINE_TYPES.includes(p.type)} />;
    }
  }
}

/** The defaults a new operation takes for the parameters it has and that hold no value yet. */
export const withDefaults = (values, def, defaults) => {
  const next = { ...values };
  for (const p of def?.params || []) if (defaults && defaults[p.name] !== undefined && !hasValue(next[p.name])) next[p.name] = toInput(defaults[p.name], p.type);
  return next;
};

export function OperationDialog({ open, catalogue, routes, stops = null, onNeedStops = null, initial, defaults = null, onClose, onSave }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const missingId = useId();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const [type, setType] = useState(initial?.type || null);
  const [values, setValues] = useState({});
  const [quote, setQuote] = useState("");
  const [folds, setFolds] = useState({ selection: false, scope: false, advanced: false });
  // What is typed in the operation's field: it also filters the catalogue shown under it.
  const [search, setSearch] = useState("");
  const sorted = useMemo(() => sortCatalogue(t, catalogue, language), [t, catalogue, language]);
  const def = useMemo(() => (catalogue || []).find((o) => o.type === type) || null, [catalogue, type]);
  const groups = useMemo(() => groupParams(def), [def]);
  const stopNames = useMemo(() => [...new Set((stops || []).map((s) => s.stop_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, language)), [stops, language]);

  useEffect(() => {
    if (!open) return;
    const t0 = initial?.type || null;
    setType(t0);
    const d0 = (catalogue || []).find((o) => o.type === t0);
    const types = Object.fromEntries((d0?.params || []).map((p) => [p.name, p.type]));
    const given = Object.fromEntries(Object.entries(initial?.params || {}).map(([k, v]) => [k, toInput(v, types[k])]));
    // A new operation (from the catalogue, or typed) takes the framing's defaults; an existing one keeps its values.
    const v0 = initial?.id ? given : withDefaults(given, d0, defaults);
    setValues(v0);
    setSearch("");
    setQuote(initial?.source?.quote || "");
    const g = groupParams(d0);
    setFolds({ selection: g.selection.some((p) => hasValue(v0[p.name])), scope: g.scope.some((p) => hasValue(v0[p.name])), advanced: g.advanced.some((p) => hasValue(v0[p.name])) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial]);
  // Stops are listed only when a form needs them (big feeds).
  useEffect(() => {
    if (open && def && !stops && onNeedStops && (def.params || []).some((p) => p.type === "stop" || p.type === "stops")) onNeedStops();
  }, [open, def, stops, onNeedStops]);

  // Required and still empty, or a one-of group none of whose members has a value (the catalogue's
  // requires_one_of: `route` or `routes`…), said by its first member (catalogueText missingRequired).
  const missing = missingRequired(def, values, hasValue).map((m) => missingLabel(t, def.type, m));
  // Choosing an operation (the field or the catalogue): the sections holding a value open, the defaults fill in.
  const choose = (v) => {
    setType(v?.type || null);
    const g = groupParams(v);
    const next = initial?.id ? values : withDefaults(values, v, defaults);
    setValues(next);
    setFolds((f) => ({ selection: f.selection || g.selection.some((p) => hasValue(next[p.name])), scope: f.scope || g.scope.some((p) => hasValue(next[p.name])), advanced: f.advanced }));
  };
  const save = () => {
    const params = {};
    for (const p of def.params || []) {
      const v = parseInput(p.type, values[p.name]);
      if (v !== undefined) params[p.name] = v;
    }
    // Parameters the catalogue does not list (kept from the planner) stay as they were.
    for (const [k, v] of Object.entries(initial?.params || {})) if (!(def.params || []).some((p) => p.name === k) && !(k in params)) params[k] = v;
    onSave({ ...(initial || {}), type, params, source: quote.trim() ? { ...(initial?.source || {}), quote: quote.trim() } : initial?.source });
  };
  const field = (p) => <ParamField key={p.name} opType={def.type} p={{ ...p, required: saysRequired(def, p, values, hasValue) }} value={values[p.name]} onChange={(v) => setValues((s) => ({ ...s, [p.name]: v }))} routes={routes} stopNames={stopNames} example={def?.example ? def.example[p.name] : undefined} />;
  const section = (key, label, list) =>
    list.length > 0 && (
      <Box key={key} data-testid={`change-param-section-${key}`}>
        <SectionHeader label={label} open={folds[key]} onToggle={() => setFolds((f) => ({ ...f, [key]: !f[key] }))} />
        <Collapse in={folds[key]}>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, pt: 1 }}>{list.map(field)}</Box>
        </Collapse>
      </Box>
    );
  const help = def ? opHelp(t, def.type, def) : "";
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth fullScreen={fullScreen} data-testid="change-operation-dialog">
      <DialogTitle sx={{ fontWeight: 800 }}>{initial?.id ? t("transform.editOperation") : t("transform.addOperation")}</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 1.5, pt: "8px !important" }}>
        <Autocomplete
          options={sorted}
          value={def}
          onChange={(_, v) => choose(v)}
          onInputChange={(_, v, reason) => setSearch(reason === "input" ? v : "")}
          getOptionLabel={(o) => opTitle(t, o.type, o)}
          groupBy={(o) => categoryLabel(t, o.category)}
          isOptionEqualToValue={(a, b) => a.type === b.type}
          filterOptions={(opts, state) => {
            const q = norm(state.inputValue);
            if (!q) return opts;
            return opts.filter((o) => [opTitle(t, o.type, o), o.title, o.type, categoryLabel(t, o.category)].some((s) => norm(s).includes(q)));
          }}
          renderOption={(props, o) => {
            const { key, ...rest } = props;
            const h = opHelp(t, o.type, o);
            return (
              <Box component="li" key={key} {...rest} sx={{ display: "block !important" }}>
                <Typography sx={{ fontSize: "0.84rem", fontWeight: 600 }}>{opTitle(t, o.type, o)}</Typography>
                {h && (
                  <Typography sx={{ fontSize: "0.7rem", color: "text.secondary", lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                    {h}
                  </Typography>
                )}
              </Box>
            );
          }}
          disabled={Boolean(initial?.id)}
          renderInput={(p) => <TextField {...p} size="small" label={t("transform.operationType")} placeholder={t("transform.form.searchOperation")} inputProps={{ ...p.inputProps, "data-testid": "change-type" }} />}
        />
        {help && <Typography sx={{ fontSize: "0.76rem", color: "text.secondary", lineHeight: 1.5 }}>{help}</Typography>}
        {/* No operation chosen yet: the catalogue itself, filtered by the field, never an empty form. */}
        {!def && !initial?.id && <OperationCatalog catalogue={catalogue || []} onPick={(type) => choose((catalogue || []).find((o) => o.type === type) || null)} query={search} maxHeight="46vh" testid="change-operation-catalog" />}
        {def && groups.main.map(field)}
        {def && section("selection", t("transform.form.selection"), groups.selection)}
        {def && section("scope", t("transform.form.scope"), groups.scope)}
        {def && section("advanced", t("transform.form.advanced"), groups.advanced)}
        {def && <TextField size="small" label={t("transform.sourceQuote")} helperText={t("transform.sourceQuoteHint")} value={quote} onChange={(e) => setQuote(e.target.value)} multiline minRows={1} />}
      </DialogContent>
      <DialogActions sx={{ flexWrap: "wrap", gap: 0.5 }}>
        {/* What is left before saving, said in text next to the button it keeps disabled (never a tooltip on a disabled button). */}
        {def && missing.length > 0 && (
          <Typography id={missingId} data-testid="operation-missing" sx={{ flex: "1 1 220px", fontSize: "0.74rem", color: "warning.dark", px: 1 }}>
            {t("operation.missingRequired", { fields: missing.join(", ") })}
          </Typography>
        )}
        <Button onClick={onClose} sx={{ textTransform: "none" }}>
          {t("app.cancel")}
        </Button>
        <Button variant="contained" disableElevation disabled={!def || missing.length > 0} onClick={save} aria-describedby={def && missing.length ? missingId : undefined} data-testid="change-operation-save" sx={{ textTransform: "none", fontWeight: 700 }}>
          {t("transform.saveOperation")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default OperationDialog;
