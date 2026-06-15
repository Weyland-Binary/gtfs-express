import React, { useMemo } from "react";
import {
  Autocomplete,
  TextField,
  InputAdornment,
  Box,
  Typography,
} from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import { useLanguage } from "../contexts/LanguageContext";

// Google-Maps-style autocomplete search for the carto tab.
// Distinct from the hard-filter TextField used on ScheduleGrid:
// user types → sees matches → picks one → map pans/zooms to it.
//
// Controlled by parent via `selectedStopId` so the displayed value survives
// tab switches (the Autocomplete local state is lost on unmount, but the
// focus on the map is held by the parent — keeping them in sync here).
const StopSearchAutocomplete = ({
  stops = [],
  selectedStopId = null,
  onSelect,
  width = 240,
}) => {
  const { t } = useLanguage();

  const sortedStops = useMemo(
    () =>
      (stops || [])
        .slice()
        .sort((a, b) =>
          (a.stop_name || "").localeCompare(b.stop_name || "", undefined, {
            sensitivity: "base",
          }),
        ),
    [stops],
  );

  const selectedOption = useMemo(() => {
    if (!selectedStopId) return null;
    return stops.find((s) => s.stop_id === selectedStopId) || null;
  }, [stops, selectedStopId]);

  return (
    <Autocomplete
      size="small"
      options={sortedStops}
      value={selectedOption}
      getOptionLabel={(opt) => opt.stop_name || opt.stop_id || ""}
      filterOptions={(opts, state) => {
        const q = state.inputValue.toLowerCase().trim();
        if (!q) return opts.slice(0, 50);
        const matches = opts.filter(
          (o) =>
            (o.stop_name || "").toLowerCase().includes(q) ||
            (o.stop_id || "").toLowerCase().includes(q),
        );
        return matches.slice(0, 50);
      }}
      isOptionEqualToValue={(a, b) => a.stop_id === b.stop_id}
      onChange={(e, value) => {
        onSelect && onSelect(value ? value.stop_id : null);
      }}
      clearOnBlur
      handleHomeEndKeys
      blurOnSelect
      noOptionsText={t("app.stopSearchNoResults") || "No matching stops"}
      sx={{ width }}
      renderInput={(params) => (
        <TextField
          {...params}
          placeholder={t("app.stopSearch")}
          variant="outlined"
          InputProps={{
            ...params.InputProps,
            startAdornment: (
              <InputAdornment position="start" sx={{ ml: 0.5 }}>
                <SearchIcon sx={{ color: "#64748b", fontSize: 18 }} />
              </InputAdornment>
            ),
            sx: (theme) => ({
              borderRadius: 2,
              backgroundColor:
                theme.palette.mode === "dark" ? "#2d2d2d" : "#f8fafc",
              "&:hover": {
                backgroundColor:
                  theme.palette.mode === "dark" ? "#3d3d3d" : "#f1f5f9",
              },
              "& .MuiOutlinedInput-notchedOutline": {
                borderColor:
                  theme.palette.mode === "dark"
                    ? "rgba(255,255,255,0.15)"
                    : "#e2e8f0",
              },
              "&:hover .MuiOutlinedInput-notchedOutline": {
                borderColor:
                  theme.palette.mode === "dark"
                    ? "rgba(255,255,255,0.25)"
                    : "#cbd5e1",
              },
              "&.Mui-focused": {
                backgroundColor:
                  theme.palette.mode === "dark" ? "#2d2d2d" : "white",
              },
            }),
          }}
        />
      )}
      renderOption={(props, option) => (
        <Box
          component="li"
          {...props}
          sx={{
            display: "flex !important",
            flexDirection: "column",
            alignItems: "flex-start !important",
            gap: 0.1,
            py: 0.75,
          }}
        >
          <Typography
            sx={{
              fontSize: "0.85rem",
              fontWeight: 500,
              lineHeight: 1.2,
            }}
          >
            {option.stop_name}
          </Typography>
          <Typography
            sx={(theme) => ({
              fontSize: "0.7rem",
              color: theme.palette.text.secondary,
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            })}
          >
            {option.stop_id}
          </Typography>
        </Box>
      )}
      slotProps={{
        paper: {
          sx: {
            borderRadius: 2,
            mt: 0.5,
          },
        },
      }}
    />
  );
};

export default StopSearchAutocomplete;
