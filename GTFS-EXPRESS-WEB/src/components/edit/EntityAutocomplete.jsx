import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 * Autocomplete for the foreign-key fields of GTFS entities: `entity` is route, service or stop (GET /search),
 * agency (GET /agencies) or shape (GET /shapes_for_route/:routeId, `routeId` required). An unknown id is allowed
 * (freeSolo), so it replaces a plain id TextField without changing the validation on save.
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

  useEffect(() => {
    setInputValue(value || "");
  }, [value]);

  // Stable until the entity or the line changes, so the search effect below re-fires on those alone.
  const fetchOptions = useCallback((q) => {
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
  }, [entity, routeId, cfg.searchKey]);

  useEffect(() => {
    if (!open) return undefined;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    // agency and shape: the full list, loaded once when opened.
    if (entity === "agency" || entity === "shape") {
      fetchOptions();
      return undefined;
    }

    debounceRef.current = setTimeout(() => fetchOptions(inputValue), 150);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [inputValue, open, entity, routeId, fetchOptions]);

  // A value with no loaded option gets a placeholder option: no "value not in options" warning, and the current id
  // is kept even when the fetch returns nothing.
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
        // Free typing is propagated so the form stays in sync.
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
