import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import {
  Box,
  TextField,
  InputAdornment,
  Paper,
  Typography,
  Chip,
  CircularProgress,
  ClickAwayListener,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import SearchIcon from "@mui/icons-material/Search";
import PlaceIcon from "@mui/icons-material/Place";
import RouteIcon from "@mui/icons-material/Route";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import TimelineIcon from "@mui/icons-material/Timeline";
import API_BASE_URL from "../config";
import { fetchWithSession } from "../utils/sessionManager";
import { useDetailPanel } from "../contexts/DetailPanelContext";
import { useLanguage } from "../contexts/LanguageContext";

// `color` is resolved at runtime from `theme.palette.entities[type]` —
// see Theme.js for the single source of truth.
const ENTITY_SECTION_DEFS = [
  {
    key: "stops",
    labelKey: "globalSearch.stops",
    icon: PlaceIcon,
    type: "stop",
    idField: "stop_id",
    nameField: "stop_name",
  },
  {
    key: "routes",
    labelKey: "globalSearch.routes",
    icon: RouteIcon,
    type: "route",
    idField: "route_id",
    nameField: "route_long_name",
  },
  {
    key: "trips",
    labelKey: "globalSearch.trips",
    icon: DirectionsBusIcon,
    type: "trip",
    idField: "trip_id",
    nameField: "trip_headsign",
  },
  {
    key: "shapes",
    labelKey: "globalSearch.shapes",
    icon: TimelineIcon,
    type: "shape",
    idField: "shape_id",
    nameField: "shape_id",
  },
];

function GlobalSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { openPanel } = useDetailPanel();
  const { t } = useLanguage();

  const ENTITY_SECTIONS = useMemo(
    () =>
      ENTITY_SECTION_DEFS.map((def) => ({
        ...def,
        label: t(def.labelKey),
        color: theme.palette.entities[def.type],
      })),
    [t, theme],
  );
  const debounceRef = useRef(null);
  const inputRef = useRef(null);

  const search = useCallback(async (q) => {
    if (q.length < 2) {
      setResults(null);
      setOpen(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/search?q=${encodeURIComponent(q)}`,
      );
      const data = await res.json();
      setResults(data);
      const hasResults =
        (data.stops?.length || 0) +
          (data.routes?.length || 0) +
          (data.trips?.length || 0) +
          (data.shapes?.length || 0) >
        0;
      setOpen(hasResults || q.length >= 2);
    } catch (e) {
      console.error("Search error:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleChange = (e) => {
    const val = e.target.value;
    setQuery(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 300);
  };

  const handleSelect = (type, id, item = null) => {
    // For shapes, pass route context so the map can auto-navigate
    const data = type === "shape" && item
      ? { routeId: item.route_id, agencyId: item.agency_id, directionId: item.direction_id }
      : null;
    openPanel(type, id, data);
    setQuery("");
    setResults(null);
    setOpen(false);
    inputRef.current?.blur();
  };

  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

  const totalResults = results
    ? (results.stops?.length || 0) +
      (results.routes?.length || 0) +
      (results.trips?.length || 0) +
      (results.shapes?.length || 0)
    : 0;

  return (
    <ClickAwayListener onClickAway={() => setOpen(false)}>
      <Box sx={{ position: "relative", width: 280 }}>
        <TextField
          inputRef={inputRef}
          value={query}
          onChange={handleChange}
          onFocus={() => results && totalResults > 0 && setOpen(true)}
          placeholder={t("globalSearch.placeholder")}
          size="small"
          fullWidth
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                {loading ? (
                  <CircularProgress size={16} />
                ) : (
                  <SearchIcon sx={{ fontSize: 18, color: "text.secondary" }} />
                )}
              </InputAdornment>
            ),
            sx: {
              borderRadius: 2,
              fontSize: "0.82rem",
              height: 36,
              backgroundColor: isDark
                ? "rgba(255,255,255,0.06)"
                : "rgba(0,0,0,0.03)",
              "&:hover": {
                backgroundColor: isDark
                  ? "rgba(255,255,255,0.09)"
                  : "rgba(0,0,0,0.05)",
              },
              "& .MuiOutlinedInput-notchedOutline": {
                borderColor: isDark
                  ? "rgba(255,255,255,0.12)"
                  : "rgba(0,0,0,0.1)",
              },
              "&:hover .MuiOutlinedInput-notchedOutline": {
                borderColor: isDark
                  ? "rgba(255,255,255,0.2)"
                  : "rgba(0,0,0,0.18)",
              },
            },
          }}
        />

        {open && results && (
          <Paper
            elevation={8}
            sx={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              right: 0,
              zIndex: 1300,
              maxHeight: 400,
              overflow: "auto",
              borderRadius: 2,
              border: isDark
                ? "1px solid rgba(255,255,255,0.1)"
                : "1px solid rgba(0,0,0,0.08)",
              background: isDark ? "#1e1e1e" : "#ffffff",
            }}
          >
            {totalResults === 0 ? (
              <Box p={2} textAlign="center">
                <Typography variant="body2" color="text.secondary">
                  {t("globalSearch.noResults", { query })}
                </Typography>
              </Box>
            ) : (
              ENTITY_SECTIONS.map((section) => {
                const items = results[section.key] || [];
                if (items.length === 0) return null;
                const Icon = section.icon;
                return (
                  <Box key={section.key}>
                    <Box
                      sx={{
                        px: 1.5,
                        py: 0.75,
                        display: "flex",
                        alignItems: "center",
                        gap: 0.75,
                        borderBottom: isDark
                          ? "1px solid rgba(255,255,255,0.06)"
                          : "1px solid rgba(0,0,0,0.04)",
                        background: isDark
                          ? "rgba(255,255,255,0.02)"
                          : "rgba(0,0,0,0.015)",
                      }}
                    >
                      <Icon sx={{ fontSize: 14, color: section.color }} />
                      <Typography
                        variant="caption"
                        fontWeight={700}
                        sx={{
                          color: section.color,
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                        }}
                      >
                        {section.label}
                      </Typography>
                      <Chip
                        label={items.length}
                        size="small"
                        sx={{
                          height: 18,
                          fontSize: 10,
                          fontWeight: 700,
                          background: `${section.color}18`,
                          color: section.color,
                        }}
                      />
                    </Box>
                    {items.map((item) => {
                      const id = item[section.idField];
                      const name = item[section.nameField] || id;
                      const subtitle =
                        section.key === "routes"
                          ? item.route_short_name
                          : section.key === "trips"
                            ? item.route_short_name || item.trip_id
                            : section.key === "shapes"
                              ? `${item.point_count || "?"} pts`
                              : item.stop_id;
                      return (
                        <Box
                          key={id}
                          onClick={() => handleSelect(section.type, id, item)}
                          sx={{
                            px: 1.5,
                            py: 0.75,
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            gap: 1,
                            "&:hover": {
                              background: isDark
                                ? "rgba(255,255,255,0.05)"
                                : "rgba(25,118,210,0.05)",
                            },
                            borderBottom: isDark
                              ? "1px solid rgba(255,255,255,0.03)"
                              : "1px solid rgba(0,0,0,0.02)",
                          }}
                        >
                          <Box
                            sx={{
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              background: section.color,
                              flexShrink: 0,
                            }}
                          />
                          <Box flex={1} minWidth={0}>
                            <Typography
                              variant="body2"
                              fontWeight={600}
                              noWrap
                              sx={{ fontSize: "0.8rem" }}
                            >
                              {name}
                            </Typography>
                            {subtitle !== name && (
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                noWrap
                                sx={{
                                  fontSize: "0.7rem",
                                  fontFamily: "monospace",
                                }}
                              >
                                {subtitle}
                              </Typography>
                            )}
                          </Box>
                        </Box>
                      );
                    })}
                  </Box>
                );
              })
            )}
          </Paper>
        )}
      </Box>
    </ClickAwayListener>
  );
}

export default GlobalSearch;
