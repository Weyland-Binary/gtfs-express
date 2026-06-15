import React, { useMemo, useState } from "react";
import {
  Box,
  Typography,
  ToggleButtonGroup,
  ToggleButton,
  Button,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Divider,
  CircularProgress,
  TextField,
  InputAdornment,
  Autocomplete,
} from "@mui/material";
import { useTheme, alpha } from "@mui/material/styles";
import AddIcon from "@mui/icons-material/Add";
import SearchIcon from "@mui/icons-material/Search";
import GestureIcon from "@mui/icons-material/Gesture";
import TimelineIcon from "@mui/icons-material/Timeline";
import AltRouteIcon from "@mui/icons-material/AltRoute";
import { useLanguage } from "../../contexts/LanguageContext";
import StudioShapeList from "./StudioShapeList";
import StudioStopList from "./StudioStopList";

function directionWord(directionId, t) {
  const d = directionId != null ? String(directionId) : "0";
  return d === "1" ? t("shapeStudio.label.inbound") : t("shapeStudio.label.outbound");
}

// Left rail: the persistent two-level selector (LINES → the selected line's
// tracés/arrêts) + the "Tracés | Arrêts" segment + the "Nouveau tracé" menu.
export default function StudioLineRail({
  routes = [],
  selectedRouteId,
  onSelectRoute,
  search = "",
  onSearchChange,
  agencies = [],
  selectedAgencyId,
  onAgencyChange,
  routeShapes = [],
  shapeLabels,
  selectedShapeId,
  onSelectShape,
  hoveredShapeId,
  onHoverShape,
  hoverSource,
  routeDetail,
  railMode,
  onRailModeChange,
  onNewShape,
  mapStops = [],
  selectedStopId,
  onSelectStop,
  onAddStop,
  loadingRoute,
}) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [newAnchor, setNewAnchor] = useState(null);

  const filteredRoutes = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return routes;
    return routes.filter((r) =>
      [r.route_short_name, r.route_long_name, r.route_id]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle)),
    );
  }, [routes, search]);

  const directions = routeDetail?.directions || [];

  const handleNewShape = (payload) => {
    setNewAnchor(null);
    onNewShape(payload);
  };

  return (
    <Box
      sx={(th) => ({
        width: 320,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        borderRight: `1px solid ${th.palette.divider}`,
        backgroundColor: th.palette.background.paper,
      })}
    >
      {/* ── Header: unified search (+ agency filter) ── */}
      <Box
        sx={(th) => ({
          p: 1,
          display: "flex",
          flexDirection: "column",
          gap: 1,
          borderBottom: `1px solid ${th.palette.divider}`,
          flexShrink: 0,
        })}
      >
        <TextField
          size="small"
          value={search}
          onChange={(e) => onSearchChange && onSearchChange(e.target.value)}
          placeholder={t("shapeStudio.search.placeholder")}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
        {agencies.length > 1 && (
          <Autocomplete
            size="small"
            options={agencies}
            value={
              agencies.find((a) => a.agency_id === selectedAgencyId) || null
            }
            onChange={(e, val) =>
              onAgencyChange && onAgencyChange(val ? val.agency_id : null)
            }
            getOptionLabel={(a) => a.agency_name || a.agency_id || ""}
            isOptionEqualToValue={(o, v) => o.agency_id === v.agency_id}
            renderInput={(params) => (
              <TextField {...params} label={t("shapeStudio.topbar.agency")} />
            )}
          />
        )}
      </Box>

      {/* ── LINES list ── */}
      <Typography
        variant="overline"
        sx={{ px: 1.5, pt: 1, color: "text.secondary", fontWeight: 700 }}
      >
        {t("shapeStudio.rail.linesHeading")}
      </Typography>
      <Box
        sx={{
          maxHeight: selectedRouteId ? "38%" : "100%",
          overflowY: "auto",
          px: 1,
          pb: 1,
          flexShrink: 0,
        }}
      >
        {filteredRoutes.length === 0 && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ p: 2, textAlign: "center" }}
          >
            {t("shapeStudio.empty.noLine")}
          </Typography>
        )}
        {filteredRoutes.map((r) => {
          const sel = r.route_id === selectedRouteId;
          return (
            <Box
              key={r.route_id}
              onClick={() => onSelectRoute(r.route_id)}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                cursor: "pointer",
                borderRadius: 1.5,
                px: 1,
                py: 0.75,
                backgroundColor: sel
                  ? alpha(theme.palette.primary.main, 0.14)
                  : "transparent",
                "&:hover": {
                  backgroundColor: alpha(theme.palette.primary.main, 0.08),
                },
              }}
            >
              <Box
                sx={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  flexShrink: 0,
                  backgroundColor: `#${r.route_color || "888888"}`,
                  border: `1px solid ${theme.palette.divider}`,
                }}
              />
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" fontWeight={600} noWrap>
                  {r.route_short_name || r.route_id}
                </Typography>
                {r.route_long_name && (
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block" }}>
                    {r.route_long_name}
                  </Typography>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* ── Selected line: Tracés | Arrêts ── */}
      {selectedRouteId && (
        <>
          <Divider />
          <Box sx={{ px: 1.5, py: 1, display: "flex", flexDirection: "column", gap: 1 }}>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={railMode}
              onChange={(e, val) => val && onRailModeChange(val)}
              fullWidth
            >
              <ToggleButton value="shapes">
                {t("shapeStudio.rail.tracesMode")}
              </ToggleButton>
              <ToggleButton value="stops">
                {t("shapeStudio.rail.arretsMode")}
              </ToggleButton>
            </ToggleButtonGroup>
          </Box>

          {loadingRoute ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <CircularProgress size={28} />
            </Box>
          ) : railMode === "shapes" ? (
            <Box sx={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
              {routeShapes.length === 0 ? (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ p: 2, textAlign: "center" }}
                >
                  {t("shapeStudio.empty.noShape")}
                </Typography>
              ) : (
                <StudioShapeList
                  shapes={routeShapes}
                  labels={shapeLabels}
                  selectedShapeId={selectedShapeId}
                  onSelect={onSelectShape}
                  hoveredShapeId={hoveredShapeId}
                  onHoverShape={onHoverShape}
                  hoverSource={hoverSource}
                />
              )}
              <Box sx={{ p: 1, mt: "auto" }}>
                <Button
                  fullWidth
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={(e) => setNewAnchor(e.currentTarget)}
                >
                  {t("shapeStudio.rail.newShape")}
                </Button>
                <Menu
                  anchorEl={newAnchor}
                  open={Boolean(newAnchor)}
                  onClose={() => setNewAnchor(null)}
                >
                  <MenuItem onClick={() => handleNewShape({ mode: "draw" })}>
                    <ListItemIcon>
                      <GestureIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText primary={t("shapeStudio.create.draw")} />
                  </MenuItem>
                  {directions.length > 0 && <Divider />}
                  {directions.map((d) => (
                    <MenuItem
                      key={`straight-${d.direction_id}`}
                      onClick={() =>
                        handleNewShape({ mode: "straight", direction: d })
                      }
                    >
                      <ListItemIcon>
                        <TimelineIcon fontSize="small" />
                      </ListItemIcon>
                      <ListItemText
                        primary={`${t("shapeStudio.create.straight")} — ${directionWord(d.direction_id, t)}`}
                      />
                    </MenuItem>
                  ))}
                  {directions.map((d) => (
                    <MenuItem
                      key={`auto-${d.direction_id}`}
                      onClick={() =>
                        handleNewShape({ mode: "auto", direction: d })
                      }
                    >
                      <ListItemIcon>
                        <AltRouteIcon fontSize="small" />
                      </ListItemIcon>
                      <ListItemText
                        primary={`${t("shapeStudio.create.autoGen")} — ${directionWord(d.direction_id, t)}`}
                      />
                    </MenuItem>
                  ))}
                </Menu>
              </Box>
            </Box>
          ) : (
            <StudioStopList
              stops={mapStops}
              selectedStopId={selectedStopId}
              onSelect={onSelectStop}
              onAddStop={onAddStop}
            />
          )}
        </>
      )}
    </Box>
  );
}
