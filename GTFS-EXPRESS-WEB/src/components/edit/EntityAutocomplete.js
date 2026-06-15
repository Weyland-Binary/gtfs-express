import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Autocomplete,
  TextField,
  Box,
  Typography,
  CircularProgress,
  Chip,
} from "@mui/material";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";

/**
 * Generic autocomplete for foreign-key fields of GTFS entities.
 *
 * Supported entity shapes (derived from the existing /search endpoint
 * and read endpoints like /agencies). Pass one `entity` among:
 *
 *   "route"    → /search?q (routes)    id: route_id,    label: route_short_name / route_long_name
 *   "service"  → /search?q (calendar)  id: service_id,  label: "(days) start→end"
 *   "agency"   → /agencies             id: agency_id,   label: agency_name
 *   "shape"    → /shapes_for_route/:r  id: shape_id     (routeId prop required)
 *   "stop"     → /search?q (stops)     id: stop_id,     label: stop_name
 *
 * The field is designed to be a drop-in replacement for a plain TextField
 * targeting an id — passing an unknown id is allowed (freeSolo), so the
 * existing validation-on-save behavior remains intact.
 *
 * Props:
 *   value, onChange(newId)
 *   entity         — one of the keys above
 *   label, required, error, helperText, size, disabled, autoFocus
 *   routeId        — required when entity="shape"
 *   placeholder
 *   sx
 */
const CONFIG = {
  route: {
    searchKey: "routes",
    idField: "route_id",
    label: (r) =>
      r.route_short_name
        ? `${r.route_short_name}${r.route_long_name ? " · " + r.route_long_name : ""}`
        : r.route_long_name || r.route_id,
    sub: (r) => r.route_id,
  },
  service: {
    searchKey: "services",
    idField: "service_id",
    label: (s) => s.service_id,
    sub: (s) => {
      const days = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]
        .filter((d) => String(s[d]) === "1")
        .map((d) => d.substring(0, 2).toUpperCase())
        .join(" ");
      const range =
        s.start_date && s.end_date ? `${s.start_date}→${s.end_date}` : "";
      return [days, range].filter(Boolean).join(" · ");
    },
  },
  stop: {
    searchKey: "stops",
    idField: "stop_id",
    label: (s) => s.stop_name || s.stop_id,
    sub: (s) => s.stop_id,
  },
  trip: {
    searchKey: "trips",
    idField: "trip_id",
    label: (t) => t.trip_headsign || t.trip_id,
    sub: (t) => t.trip_id,
  },
  shape: {
    idField: "shape_id",
    label: (s) => s.shape_id,
    sub: (s) =>
      s.point_count ? `${s.point_count} pts` : "",
  },
  agency: {
    idField: "agency_id",
    label: (a) => a.agency_name || a.agency_id,
    sub: (a) => a.agency_id,
  },
};

function EntityAutocomplete({
  value,
  onChange,
  entity,
  routeId,
  label,
  required,
  error,
  helperText,
  size = "small",
  disabled,
  autoFocus,
  placeholder,
  sx,
  getOptionDisabled,
}) {
  const { t } = useLanguage();
  const cfg = CONFIG[entity];
  if (!cfg)
    throw new Error(`Unknown entity "${entity}" for EntityAutocomplete`);

  const [inputValue, setInputValue] = useState(value || "");
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef(null);
  const abortRef = useRef(null);

  // Keep inputValue in sync when parent value changes externally
  useEffect(() => {
    setInputValue(value || "");
  }, [value]);

  // Load options: different strategies per entity
  const fetchOptions = (q) => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    let url;
    if (entity === "agency") {
      url = `${API_BASE_URL}/agencies`;
    } else if (entity === "shape") {
      if (!routeId) {
        setOptions([]);
        setLoading(false);
        return;
      }
      url = `${API_BASE_URL}/shapes_for_route/${encodeURIComponent(routeId)}`;
    } else {
      // route / service / stop / trip → /search
      if (!q || q.length < 1) {
        setOptions([]);
        setLoading(false);
        return;
      }
      url = `${API_BASE_URL}/search?q=${encodeURIComponent(q)}`;
    }

    fetchWithSession(url, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) {
          setOptions([]);
          return;
        }
        let rows;
        if (entity === "agency" || entity === "shape") {
          rows = Array.isArray(data) ? data : [];
        } else {
          rows = data[cfg.searchKey] || [];
        }
        setOptions(rows);
      })
      .catch((err) => {
        if (err.name !== "AbortError") setOptions([]);
      })
      .finally(() => setLoading(false));
  };

  // On open or input change, trigger search
  useEffect(() => {
    if (!open) return undefined;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    // agency + shape: cachable full list, load once when opened
    if (entity === "agency" || entity === "shape") {
      fetchOptions();
      return undefined;
    }

    debounceRef.current = setTimeout(() => fetchOptions(inputValue), 150);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [inputValue, open, entity, routeId]);

  // Build the option shown when a value exists but no option is loaded.
  // This avoids the "value not in options" warning and lets the user
  // keep the current id even if fetches return empty.
  const mergedOptions = useMemo(() => {
    if (!value) return options;
    const hasIt = options.some((o) => o[cfg.idField] === value);
    if (hasIt) return options;
    return [{ [cfg.idField]: value, __placeholder: true }, ...options];
  }, [value, options, cfg.idField]);

  return (
    <Autocomplete
      freeSolo
      size={size}
      disabled={disabled}
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      options={mergedOptions}
      loading={loading}
      value={value || ""}
      inputValue={inputValue}
      onInputChange={(_, v) => {
        setInputValue(v);
        // If user is freely typing, propagate so form stays in sync
        if (!options.some((o) => cfg.label(o) === v)) {
          onChange?.(v);
        }
      }}
      onChange={(_, newValue) => {
        if (typeof newValue === "string") {
          onChange?.(newValue.trim());
        } else if (newValue && newValue[cfg.idField]) {
          onChange?.(newValue[cfg.idField]);
          setInputValue(newValue[cfg.idField]);
        } else {
          onChange?.("");
        }
      }}
      getOptionLabel={(opt) => {
        if (typeof opt === "string") return opt;
        return opt?.[cfg.idField] || "";
      }}
      isOptionEqualToValue={(opt, v) => {
        const optId = typeof opt === "string" ? opt : opt?.[cfg.idField];
        const vId = typeof v === "string" ? v : v?.[cfg.idField];
        return optId === vId;
      }}
      getOptionDisabled={getOptionDisabled}
      renderOption={(props, opt) => {
        if (opt.__placeholder) {
          return (
            <li {...props} key={`ph-${opt[cfg.idField]}`}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Typography
                  variant="body2"
                  sx={{ fontFamily: "monospace", fontSize: 13 }}
                >
                  {opt[cfg.idField]}
                </Typography>
                <Chip
                  size="small"
                  label={t("autocomplete.currentValue")}
                  sx={{ height: 16, fontSize: 9 }}
                />
              </Box>
            </li>
          );
        }
        return (
          <li {...props} key={opt[cfg.idField]}>
            <Box sx={{ display: "flex", flexDirection: "column", minWidth: 0, width: "100%" }}>
              <Typography
                variant="body2"
                sx={{
                  fontSize: 13,
                  fontWeight: 600,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {cfg.label(opt)}
              </Typography>
              {cfg.sub(opt) && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    fontSize: 10,
                    fontFamily: "monospace",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {cfg.sub(opt)}
                </Typography>
              )}
            </Box>
          </li>
        );
      }}
      noOptionsText={
        entity === "shape" && !routeId
          ? t("autocomplete.noRouteSelected")
          : t("autocomplete.noResults")
      }
      loadingText={t("autocomplete.loading")}
      sx={sx}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          required={required}
          error={error}
          helperText={helperText}
          autoFocus={autoFocus}
          placeholder={placeholder}
          InputProps={{
            ...params.InputProps,
            endAdornment: (
              <>
                {loading ? <CircularProgress size={14} /> : null}
                {params.InputProps.endAdornment}
              </>
            ),
            sx: { fontFamily: value ? "monospace" : "inherit", fontSize: 13 },
          }}
        />
      )}
    />
  );
}

export default EntityAutocomplete;
