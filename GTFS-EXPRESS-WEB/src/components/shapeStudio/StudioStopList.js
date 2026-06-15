import React, { useMemo, useState } from "react";
import { Box, Button, TextField, InputAdornment, Typography } from "@mui/material";
import { useTheme, alpha } from "@mui/material/styles";
import AddLocationAltIcon from "@mui/icons-material/AddLocationAlt";
import SearchIcon from "@mui/icons-material/Search";
import RoomIcon from "@mui/icons-material/Room";
import { useLanguage } from "../../contexts/LanguageContext";

// The line's stops in the "Arrêts" rail mode, rendered as a clean, modern list
// (consistent with the shape cards). Selecting a row flies the map to the stop;
// "Add stop" arms map-placing mode. Coordinate editing = dragging the pin.
export default function StudioStopList({
  stops = [],
  selectedStopId,
  onSelect,
  onAddStop,
}) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return stops;
    return stops.filter(
      (s) =>
        (s.stop_name || "").toLowerCase().includes(needle) ||
        (s.stop_id || "").toLowerCase().includes(needle),
    );
  }, [stops, q]);

  return (
    <Box
      sx={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}
    >
      {/* Header: search + add */}
      <Box sx={{ p: 1, pb: 0.5 }}>
        <TextField
          size="small"
          fullWidth
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("shapeStudio.stops.search")}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            mt: 1,
          }}
        >
          <Typography variant="caption" color="text.secondary">
            {t("shapeStudio.stops.count", { count: filtered.length })}
          </Typography>
          <Button
            size="small"
            variant="outlined"
            startIcon={<AddLocationAltIcon />}
            onClick={onAddStop}
            sx={{ textTransform: "none" }}
          >
            {t("shapeStudio.stops.add")}
          </Button>
        </Box>
      </Box>

      {/* List */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 0.25,
          px: 1,
          pb: 1,
        }}
      >
        {filtered.map((s) => {
          const sel = s.stop_id === selectedStopId;
          return (
            <Box
              key={s.stop_id}
              onClick={() => onSelect(s.stop_id)}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                px: 1,
                py: 0.6,
                borderRadius: 1.5,
                cursor: "pointer",
                backgroundColor: sel
                  ? alpha(theme.palette.primary.main, 0.14)
                  : "transparent",
                outline: sel
                  ? `1px solid ${theme.palette.primary.main}`
                  : "1px solid transparent",
                transition: "background-color 0.12s ease",
                "&:hover": {
                  backgroundColor: alpha(theme.palette.primary.main, 0.08),
                },
              }}
            >
              <RoomIcon
                sx={{
                  fontSize: 18,
                  flexShrink: 0,
                  color: sel
                    ? theme.palette.primary.main
                    : theme.palette.text.disabled,
                }}
              />
              <Box sx={{ minWidth: 0 }}>
                <Typography
                  noWrap
                  sx={{ fontSize: "0.82rem", fontWeight: 500, lineHeight: 1.3 }}
                >
                  {s.stop_name || s.stop_id}
                </Typography>
                <Typography
                  noWrap
                  sx={{
                    fontFamily: "monospace",
                    fontSize: "0.66rem",
                    color: "text.secondary",
                    lineHeight: 1.2,
                  }}
                >
                  {Number(s.stop_lat).toFixed(5)}, {Number(s.stop_lon).toFixed(5)}
                </Typography>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
