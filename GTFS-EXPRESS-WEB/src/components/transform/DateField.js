/**
 * DateField / DateListField — dates typed and shown in the app's language
 * (05/10/2026 in French, 10/05/2026 in English…) whatever the browser's,
 * kept as ISO dates (YYYY-MM-DD) in the plan. A calendar button opens the
 * browser's picker; the helper line spells the date out ("lundi 5 octobre
 * 2026") so the reader can check it.
 *
 * `required` adds « * » to the label; `ariaRequired` only sets aria-required
 * on the input, for a form that already says « (requis) » in the label's
 * text (the operation form, §11: required stated in words and to assistive
 * technologies alike).
 */

import React, { useEffect, useRef, useState } from "react";
import { Autocomplete, Chip, IconButton, InputAdornment, TextField, Tooltip } from "@mui/material";
import CalendarMonthOutlinedIcon from "@mui/icons-material/CalendarMonthOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { datePlaceholder, formatDate, parseDateInput, toIso } from "./localDates";

const placeholderOf = (t, language) => datePlaceholder(language, { day: t("transform.date.dd"), month: t("transform.date.mm"), year: t("transform.date.yyyy") });

export function DateField({ label, value, onChange, helperText = "", required = false, ariaRequired = false, testid = undefined, disabled = false }) {
  const { t, language } = useLanguage();
  const iso = toIso(value);
  const [text, setText] = useState(iso ? formatDate(iso, language) : value || "");
  const [bad, setBad] = useState(false);
  const pickerRef = useRef(null);
  useEffect(() => {
    const current = parseDateInput(text, language);
    if (current !== (iso || null)) setText(iso ? formatDate(iso, language) : value || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iso, language]);
  const commit = (raw) => {
    setText(raw);
    if (!String(raw).trim()) {
      setBad(false);
      onChange("");
      return;
    }
    const parsed = parseDateInput(raw, language);
    setBad(!parsed);
    if (parsed) onChange(parsed);
  };
  const openPicker = () => {
    const el = pickerRef.current;
    if (!el) return;
    try {
      if (typeof el.showPicker === "function") el.showPicker();
      else el.click();
    } catch {
      el.focus();
    }
  };
  const spelled = iso ? formatDate(iso, language, "full") : "";
  return (
    <>
      <TextField
        size="small"
        fullWidth
        label={`${label}${required ? " *" : ""}`}
        value={text}
        disabled={disabled}
        error={bad}
        placeholder={placeholderOf(t, language)}
        onChange={(e) => commit(e.target.value)}
        onBlur={() => iso && setText(formatDate(iso, language))}
        helperText={bad ? t("transform.date.invalid", { format: placeholderOf(t, language) }) : [spelled, helperText].filter(Boolean).join(" — ")}
        inputProps={{ "data-testid": testid, inputMode: "numeric", "aria-required": required || ariaRequired || undefined }}
        InputProps={{
          endAdornment: (
            <InputAdornment position="end">
              <Tooltip title={t("transform.date.pick")}>
                <span>
                  <IconButton size="small" edge="end" onClick={openPicker} disabled={disabled} aria-label={t("transform.date.pick")}>
                    <CalendarMonthOutlinedIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </span>
              </Tooltip>
            </InputAdornment>
          ),
        }}
      />
      <input
        ref={pickerRef}
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        value={iso || ""}
        onChange={(e) => {
          const v = toIso(e.target.value);
          setBad(false);
          setText(v ? formatDate(v, language) : "");
          onChange(v || "");
        }}
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none", border: 0, padding: 0 }}
      />
    </>
  );
}

/** Several dates: each typed date becomes a chip (shown in the reader's format). */
export function DateListField({ label, value, onChange, helperText = "", required = false, ariaRequired = false, testid = undefined }) {
  const { t, language } = useLanguage();
  const list = (Array.isArray(value) ? value : String(value || "").split(",")).map((x) => toIso(String(x).trim()) || String(x).trim()).filter(Boolean);
  const [input, setInput] = useState("");
  const [bad, setBad] = useState(false);
  const add = (raw) => {
    const parts = String(raw || "").split(/[;,\s]+/).filter(Boolean);
    if (!parts.length) return;
    const parsed = parts.map((p) => parseDateInput(p, language));
    if (parsed.some((x) => !x)) {
      setBad(true);
      return;
    }
    setBad(false);
    setInput("");
    onChange([...new Set([...list, ...parsed])].sort());
  };
  return (
    <Autocomplete
      multiple
      freeSolo
      options={[]}
      value={list}
      inputValue={input}
      onInputChange={(_, v, reason) => reason === "input" && setInput(v)}
      onChange={(_, next, reason) => {
        if (reason === "createOption") add(next[next.length - 1]);
        else onChange(next.filter((x) => toIso(x)));
      }}
      renderTags={(items, getTagProps) => items.map((d, i) => <Chip {...getTagProps({ index: i })} key={d} size="small" label={formatDate(d, language)} title={formatDate(d, language, "full")} />)}
      renderInput={(params) => (
        <TextField
          {...params}
          size="small"
          label={`${label}${required ? " *" : ""}`}
          placeholder={list.length ? "" : placeholderOf(t, language)}
          error={bad}
          helperText={bad ? t("transform.date.invalid", { format: placeholderOf(t, language) }) : helperText}
          onBlur={() => input.trim() && add(input)}
          inputProps={{ ...params.inputProps, "data-testid": testid, "aria-required": required || ariaRequired || undefined }}
        />
      )}
    />
  );
}
