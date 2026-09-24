import React, { useMemo, useState } from "react";
import {
  Box,
  Typography,
  ToggleButtonGroup,
  ToggleButton,
  Button,
  Chip,
  Divider,
  CircularProgress,
  TextField,
  InputAdornment,
  Autocomplete,
  Tooltip,
  Collapse,
} from "@mui/material";
import { useTheme, alpha } from "@mui/material/styles";
import AddIcon from "@mui/icons-material/Add";
import SearchIcon from "@mui/icons-material/Search";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import { useLanguage } from "../../contexts/LanguageContext";
import StudioShapeList from "./StudioShapeList";
import StudioStopList from "./StudioStopList";

// Left rail: the persistent two-level selector (LINES → the selected line's
// shapes/stops) + the "Shapes | Stops" segment + the "New shape" button.
export default function StudioLineRail({
  routes = [],
  coverage = null, // { [route_id]: { trips, missing, shapes } }
  filterMissing = false,
  onFilterMissingChange,
  selectedRouteId,
  onSelectRoute,
  search = "",
  onSearchChange,
  agencies = [],
  selectedAgencyId,
  onAgencyChange,
  routeShapes = [],
  shapeLabels,
  fitByShape,
  selectedShapeId,
  onSelectShape,
  onEditShape,
  hoveredShapeId,
  onHoverShape,
  hoverSource,
  railMode,
  onRailModeChange,
  onNewShape,
  mapStops = [],
  selectedStopId,
  onSelectStop,
  onAddStop,
  loadingRoute,
  unusedShapes = [],
  unusedTruncated = false,
  selectedUnusedId,
  onSelectUnused,
}) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [unusedOpen, setUnusedOpen] = useState(true);

  const anyMissing = useMemo(
    () => Boolean(coverage) && routes.some((r) => coverage[r.route_id]?.missing > 0),
    [coverage, routes],
  );

  const filteredRoutes = useMemo(() => {
    const needle = search.trim().toLowerCase();
    let list = routes;
    if (needle) {
      list = list.filter((r) =>
        [r.route_short_name, r.route_long_name, r.route_id]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle)),
      );
    }
    if (filterMissing && coverage) {
      list = list.filter((r) => coverage[r.route_id]?.missing > 0);
    }
    return list;
  }, [routes, search, filterMissing, coverage]);

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
      {/* ── Header: line search (+ agency filter) ── */}
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
          inputProps={{ "data-testid": "studio-search" }}
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
      <Box
        sx={{
          px: 1.5,
          pt: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 1,
        }}
      >
        <Typography
          variant="overline"
          sx={{ color: "text.secondary", fontWeight: 700 }}
        >
          {t("shapeStudio.rail.linesHeading")}
        </Typography>
        {anyMissing && (
          <Chip
            size="small"
            color={filterMissing ? "error" : "default"}
            variant={filterMissing ? "filled" : "outlined"}
            label={t("shapeStudio.rail.filterMissing")}
            onClick={() => onFilterMissingChange && onFilterMissingChange(!filterMissing)}
            data-testid="studio-filter-missing"
            sx={{ height: 20, fontSize: 10 }}
          />
        )}
      </Box>
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
          const sel = r.route_id === selectedRouteId && !selectedUnusedId;
          const cov = coverage ? coverage[r.route_id] : null;
          return (
            <Box
              key={r.route_id}
              data-testid={`studio-line-${r.route_id}`}
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
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography variant="body2" fontWeight={600} noWrap>
                  {r.route_short_name || r.route_id}
                </Typography>
                {r.route_long_name && (
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block" }}>
                    {r.route_long_name}
                  </Typography>
                )}
              </Box>
              {cov && cov.missing > 0 ? (
                <Tooltip title={t("shapeStudio.rail.missingBadge", { count: cov.missing })} arrow>
                  <Chip
                    size="small"
                    color="error"
                    label={cov.missing}
                    data-testid="studio-line-missing"
                    sx={{ height: 18, fontSize: 10, fontWeight: 700, minWidth: 24 }}
                  />
                </Tooltip>
              ) : cov && cov.shapes > 0 ? (
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, flexShrink: 0 }}>
                  {cov.shapes === 1
                    ? t("shapeStudio.rail.shapeCountOne")
                    : t("shapeStudio.rail.shapeCount", { count: cov.shapes })}
                </Typography>
              ) : null}
            </Box>
          );
        })}

        {/* ── Unassigned shapes ── */}
        {unusedShapes.length > 0 && (
          <Box sx={{ mt: 1 }} data-testid="studio-unused-shapes">
            <Box
              onClick={() => setUnusedOpen((o) => !o)}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                px: 0.5,
                cursor: "pointer",
                color: "text.secondary",
              }}
            >
              <LinkOffIcon sx={{ fontSize: 14 }} />
              <Typography variant="overline" sx={{ fontWeight: 700, flex: 1 }}>
                {t("shapeStudio.rail.unusedHeading")} ({unusedShapes.length})
              </Typography>
              {unusedOpen ? (
                <ExpandLessIcon sx={{ fontSize: 16 }} />
              ) : (
                <ExpandMoreIcon sx={{ fontSize: 16 }} />
              )}
            </Box>
            <Collapse in={unusedOpen}>
              <Typography variant="caption" color="text.secondary" sx={{ px: 0.5, display: "block", mb: 0.5 }}>
                {t("shapeStudio.rail.unusedHint")}
              </Typography>
              {unusedShapes.map((u) => {
                const sel = u.shape_id === selectedUnusedId;
                return (
                  <Box
                    key={u.shape_id}
                    data-testid={`studio-unused-${u.shape_id}`}
                    onClick={() => onSelectUnused && onSelectUnused(u.shape_id)}
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                      cursor: "pointer",
                      borderRadius: 1.5,
                      px: 1,
                      py: 0.5,
                      backgroundColor: sel
                        ? alpha(theme.palette.primary.main, 0.14)
                        : "transparent",
                      "&:hover": {
                        backgroundColor: alpha(theme.palette.primary.main, 0.08),
                      },
                    }}
                  >
                    <Typography
                      variant="body2"
                      noWrap
                      sx={{ fontFamily: "monospace", fontSize: 12, flex: 1 }}
                    >
                      {u.shape_id}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                      {t("shapeStudio.status.points", { count: u.point_count })}
                    </Typography>
                  </Box>
                );
              })}
              {unusedTruncated && (
                <Typography variant="caption" color="text.secondary" sx={{ px: 1 }}>
                  {t("shapeStudio.rail.unusedTruncated", { count: unusedShapes.length })}
                </Typography>
              )}
            </Collapse>
          </Box>
        )}
      </Box>

      {/* ── Selected line: Shapes | Stops ── */}
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
              <ToggleButton value="shapes" data-testid="studio-mode-shapes">
                {t("shapeStudio.rail.tracesMode")}
              </ToggleButton>
              <ToggleButton value="stops" data-testid="studio-mode-stops">
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
                  fitByShape={fitByShape}
                  selectedShapeId={selectedUnusedId ? null : selectedShapeId}
                  onSelect={onSelectShape}
                  onEdit={onEditShape}
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
                  onClick={onNewShape}
                  data-testid="studio-new-shape"
                >
                  {t("shapeStudio.rail.newShape")}
                </Button>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: "block", textAlign: "center", mt: 0.5, fontSize: 10 }}
                >
                  {t("shapeStudio.action.editHint")}
                </Typography>
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
