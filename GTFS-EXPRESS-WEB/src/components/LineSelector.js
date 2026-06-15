import React, { useMemo, useEffect, useCallback, useState } from "react";
import {
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Box,
  Paper,
  IconButton,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  CircularProgress,
  Chip,
  Popover,
  Typography,
} from "@mui/material";
import { styled, useTheme } from "@mui/material/styles";
import BusinessIcon from "@mui/icons-material/Business";
import RouteIcon from "@mui/icons-material/Route";
import SwapVertIcon from "@mui/icons-material/SwapVert";
import CloseIcon from "@mui/icons-material/Close";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditIcon from "@mui/icons-material/Edit";
import TramIcon from "@mui/icons-material/Tram";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import TrainIcon from "@mui/icons-material/Train";
import DirectionsSubwayIcon from "@mui/icons-material/DirectionsSubway";
import DirectionsBoatIcon from "@mui/icons-material/DirectionsBoat";
import DirectionsRailwayIcon from "@mui/icons-material/DirectionsRailway";
import CalendarMonthIcon from "@mui/icons-material/CalendarMonth";
import CalendarTodayIcon from "@mui/icons-material/CalendarToday";
import CalendarPicker from "./CalendarPicker";
import EditAgencyDialog from "./edit/EditAgencyDialog";
import { getActiveServiceIds } from "../utils/calendarUtils";
import { useLanguage } from "../contexts/LanguageContext";
import { useEditMode } from "../contexts/EditModeContext";
import { sortRoutesByPublisherOrder } from "../utils/routeSort";
import { fetchWithSession } from "../utils/sessionManager";
import API_BASE_URL from "../config";

const ROUTE_TYPE_ICON = {
  0: TramIcon, // Tram / Light rail
  1: DirectionsSubwayIcon, // Subway / Metro
  2: TrainIcon, // Rail
  3: DirectionsBusIcon, // Bus
  4: DirectionsBoatIcon, // Ferry
  5: DirectionsRailwayIcon, // Cable tram
  6: DirectionsRailwayIcon, // Aerial lift / Gondola
  7: DirectionsRailwayIcon, // Funicular
  11: DirectionsBusIcon, // Trolleybus
  12: TrainIcon, // Monorail
};

const SelectorContainer = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(1.5),
  marginBottom: 0,
  background: theme.palette.mode === "dark" ? "#1e1e1e" : "#ffffff",
  borderRadius: 0,
  boxShadow: "none",
  border:
    theme.palette.mode === "dark"
      ? "1px solid rgba(255,255,255,0.08)"
      : "1px solid rgba(0,0,0,0.06)",
  borderTop: "none",
  borderBottom: "none",
}));

const StyledFormControl = styled(FormControl)(({ theme }) => ({
  "& .MuiOutlinedInput-root": {
    borderRadius: 10,
    backgroundColor: theme.palette.mode === "dark" ? "#2d2d2d" : "#ffffff",
    transition: "all 0.2s ease",
    "&:hover": {
      backgroundColor: theme.palette.mode === "dark" ? "#3d3d3d" : "#f8fafc",
    },
    "&.Mui-focused": {
      backgroundColor: theme.palette.mode === "dark" ? "#2d2d2d" : "#ffffff",
      boxShadow:
        theme.palette.mode === "dark"
          ? "0 0 0 3px rgba(144, 202, 249, 0.2)"
          : "0 0 0 3px rgba(25, 118, 210, 0.1)",
    },
  },
  "& .MuiInputLabel-root": {
    fontWeight: 500,
    backgroundColor: theme.palette.mode === "dark" ? "#2d2d2d" : "#ffffff",
    paddingLeft: "4px",
    paddingRight: "4px",
  },
}));

function LineSelector({
  agencies,
  routes,
  directions,
  selectedAgency,
  selectedRoute,
  selectedDirection,
  selectedDate,
  onAgencyChange,
  onRouteChange,
  onDirectionChange,
  onDateChange,
  onRoutesChanged,
  calendar,
  calendarDates,
  showGuide = false,
  onGuideDone,
  openPanel,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { t } = useLanguage();
  const { editing, recordEdit, showToast } = useEditMode();

  // Delete-route confirmation state
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // Service-id chips overflow popover anchor
  const [servicePopoverAnchor, setServicePopoverAnchor] = useState(null);

  // Cap how many active service_id chips render inline before collapsing into a +N pill
  const MAX_VISIBLE_CHIPS = 3;

  const handleDeleteClick = useCallback((e, route) => {
    e.stopPropagation();
    e.preventDefault();
    setDeleteTarget(route);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/routes/${encodeURIComponent(deleteTarget.route_id)}`,
        { method: "DELETE" },
      );
      const body = await res.json();
      if (!res.ok) {
        showToast(body.error || "Delete failed", "error");
        setDeleting(false);
        return; // Keep dialog open on error so user can retry
      }
      recordEdit(
        t("edit.route.deletedToast").replace(
          "{name}",
          deleteTarget.route_short_name || deleteTarget.route_id,
        ),
        body.validation,
        { entity: "route", entityId: deleteTarget.route_id },
      );
      // If the deleted route was selected, reset selection
      if (selectedRoute === deleteTarget.route_id) {
        onRouteChange({ target: { value: "" } });
      }
      // Signal parent to remove the route from the list
      onRoutesChanged?.(deleteTarget.route_id);
      setDeleting(false);
      setDeleteTarget(null);
    } catch (err) {
      showToast(err.message || "Network error", "error");
      setDeleting(false);
      // Keep dialog open on error
    }
  }, [
    deleteTarget,
    selectedRoute,
    onRouteChange,
    onRoutesChanged,
    recordEdit,
    showToast,
    t,
  ]);

  // Determine which selector to highlight
  const guideTarget = useMemo(() => {
    if (!showGuide) return null;
    if (!selectedRoute) return "route";
    if (!selectedDate) return "date";
    if (!selectedDirection) return "direction";
    return null;
  }, [showGuide, selectedRoute, selectedDate, selectedDirection]);

  // Turn off guide when all selectors are filled
  useEffect(() => {
    if (showGuide && selectedRoute && selectedDate && selectedDirection) {
      onGuideDone?.();
    }
  }, [showGuide, selectedRoute, selectedDate, selectedDirection, onGuideDone]);

  // Service IDs active on the selected date — drives the clickable chips
  const activeServiceIds = useMemo(
    () =>
      getActiveServiceIds(selectedDate, calendar || [], calendarDates || []),
    [selectedDate, calendar, calendarDates],
  );

  const pulseSelectSx = useCallback(
    (target) =>
      guideTarget === target
        ? {
            "@keyframes borderPulse": {
              "0%, 100%": { borderColor: "rgba(25, 118, 210, 0.7)" },
              "50%": { borderColor: "rgba(25, 118, 210, 0.2)" },
            },
            "& .MuiOutlinedInput-root .MuiOutlinedInput-notchedOutline": {
              borderColor: "rgba(25, 118, 210, 0.7)",
              borderWidth: 2,
              animation: "borderPulse 1.8s ease-in-out infinite",
            },
          }
        : {},
    [guideTarget],
  );

  // Compute the maximum route name length
  const maxRouteNameLength = useMemo(() => {
    if (!routes || routes.length === 0) return 0;
    return Math.min(
      Math.max(...routes.map((route) => (route.route_long_name || "").length)),
      100,
    );
  }, [routes]);

  // Single source of truth — see utils/routeSort.js. Honors the publisher's
  // route_sort_order with numeric-aware fallbacks; identical ordering is used
  // by the auto-pick on first load so the user sees the same "first route"
  // here and in the Schedule grid.
  const sortedRoutes = useMemo(
    () => (routes ? sortRoutesByPublisherOrder(routes) : []),
    [routes],
  );

  // Convert length to pixels (approx. 10px per character)
  const selectWidth = `${maxRouteNameLength * 10}px`;

  const [editAgencyTarget, setEditAgencyTarget] = useState(null);
  // Local overrides for edited agencies (agency_id → updated data)
  const [agencyOverrides, setAgencyOverrides] = useState({});

  // Use useEffect to pre-select the agency if there is only one
  useEffect(() => {
    if (agencies && agencies.length === 1 && !selectedAgency) {
      const agency = agencies[0];
      const agencyId = agency.agency_id || "default_agency_id";
      onAgencyChange({ target: { value: agencyId } });
    }
  }, [agencies, selectedAgency, onAgencyChange]);

  return (
    <SelectorContainer elevation={0}>
      <Box display="flex" gap={1.5}>
        {/* Agency selector */}
        <StyledFormControl variant="outlined" size="small" style={{ flex: 1 }}>
          <InputLabel id="agency-label">
            <Box display="flex" alignItems="center" gap={0.5}>
              <BusinessIcon sx={{ fontSize: 16 }} />
              {t("selector.agency")}
            </Box>
          </InputLabel>
          <Select
            labelId="agency-label"
            fullWidth
            value={selectedAgency || ""}
            onChange={(e) => {
              const agencyId = e.target.value;
              onAgencyChange(e);
            }}
            label={t("selector.agency")}
          >
            <MenuItem value="" disabled>
              {t("selector.agencyPlaceholder")}
            </MenuItem>
            {agencies &&
              agencies.map((agency, index) => {
                const display = agencyOverrides[agency.agency_id] ?? agency;
                return (
                  <MenuItem
                    key={agency.agency_id || `agency-${index}`}
                    value={agency.agency_id || "default_agency_id"}
                  >
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        width: "100%",
                        gap: 1,
                      }}
                    >
                      <span>{display.agency_name}</span>
                      {editing && (
                        <Tooltip title={t("app.edit")}>
                          <IconButton
                            size="small"
                            onClick={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                              setEditAgencyTarget(display);
                            }}
                            aria-label={t("app.edit")}
                            sx={{
                              p: 0.25,
                              flexShrink: 0,
                              color: "text.secondary",
                              "&:hover": { color: "primary.main" },
                            }}
                          >
                            <EditIcon sx={{ fontSize: 15 }} />
                          </IconButton>
                        </Tooltip>
                      )}
                    </Box>
                  </MenuItem>
                );
              })}
          </Select>
        </StyledFormControl>

        {/* Route selector */}
        <StyledFormControl
          variant="outlined"
          size="small"
          style={{ flex: 1, minWidth: selectWidth }}
          sx={pulseSelectSx("route")}
        >
          <InputLabel id="route-label">
            <Box display="flex" alignItems="center" gap={0.5}>
              <RouteIcon sx={{ fontSize: 16 }} />
              {t("selector.route")}
            </Box>
          </InputLabel>
          <Select
            labelId="route-label"
            fullWidth
            value={selectedRoute || ""}
            onChange={onRouteChange}
            label={t("selector.route")}
            renderValue={(value) => {
              const route = sortedRoutes.find((r) => r.route_id === value);
              if (!route) return null;
              const TypeIcon = ROUTE_TYPE_ICON[Number(route.route_type)];
              return (
                <Box
                  display="flex"
                  alignItems="center"
                  sx={{ overflow: "hidden", minWidth: 0 }}
                >
                  {TypeIcon && (
                    <TypeIcon
                      sx={{
                        fontSize: 15,
                        color: isDark
                          ? "rgba(255,255,255,0.45)"
                          : "rgba(0,0,0,0.35)",
                        mr: 0.5,
                        ml: -0.25,
                        flexShrink: 0,
                      }}
                    />
                  )}
                  <div
                    style={{
                      width: 24,
                      height: 24,
                      minHeight: 24,
                      minWidth: 24,
                      backgroundColor: `#${route.route_color || "2781BB"}`,
                      color: `#${route.route_text_color || "FFFFFF"}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      marginRight: 10,
                      borderRadius: 5,
                      fontWeight: 600,
                      boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
                    }}
                  >
                    <div style={{ fontSize: 12 }}>{route.route_short_name}</div>
                  </div>
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {route.route_long_name}
                  </span>
                </Box>
              );
            }}
          >
            <MenuItem value="" disabled>
              {t("selector.routePlaceholder")}
            </MenuItem>
            {sortedRoutes.map((route, index) => (
              <MenuItem
                key={`${route.route_id}-${index}`}
                value={route.route_id}
              >
                <Box
                  display="flex"
                  alignItems="center"
                  sx={{ overflow: "hidden", flex: 1 }}
                >
                  {(() => {
                    const TypeIcon = ROUTE_TYPE_ICON[Number(route.route_type)];
                    return TypeIcon ? (
                      <TypeIcon
                        sx={{
                          fontSize: 15,
                          color: isDark
                            ? "rgba(255,255,255,0.45)"
                            : "rgba(0,0,0,0.35)",
                          mr: 0.5,
                          ml: -0.25,
                          flexShrink: 0,
                        }}
                      />
                    ) : null;
                  })()}
                  <div
                    style={{
                      width: 24,
                      height: 24,
                      minHeight: 24,
                      minWidth: 24,
                      backgroundColor: `#${route.route_color || "2781BB"}`,
                      color: `#${route.route_text_color || "FFFFFF"}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      marginRight: 10,
                      borderRadius: 5,
                      fontWeight: 600,
                      boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
                    }}
                  >
                    <div style={{ fontSize: 12 }}>{route.route_short_name}</div>
                  </div>
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {route.route_long_name}
                  </span>
                </Box>
                {editing && selectedRoute !== route.route_id && (
                  <IconButton
                    size="small"
                    onClick={(e) => handleDeleteClick(e, route)}
                    sx={{
                      ml: 0.25,
                      p: 0.25,
                      flexShrink: 0,
                      color: isDark
                        ? "rgba(255,255,255,0.35)"
                        : "rgba(0,0,0,0.25)",
                      "&:hover": {
                        color: "#d32f2f",
                        backgroundColor: isDark
                          ? "rgba(211,47,47,0.12)"
                          : "rgba(211,47,47,0.08)",
                      },
                    }}
                  >
                    <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                )}
              </MenuItem>
            ))}
          </Select>
        </StyledFormControl>

        {/* Date selector */}
        <Box sx={{ flex: 1 }}>
          <CalendarPicker
            selectedDate={selectedDate}
            onDateChange={onDateChange}
            calendar={calendar}
            calendarDates={calendarDates}
            highlight={guideTarget === "date"}
          />
        </Box>

        {/* service_id chips active on the selected date */}
        {selectedDate && activeServiceIds.length > 0 && (() => {
          const visibleIds = activeServiceIds.slice(0, MAX_VISIBLE_CHIPS);
          const hiddenIds = activeServiceIds.slice(MAX_VISIBLE_CHIPS);
          const hiddenCount = hiddenIds.length;

          // Shared chip styling — used for both inline visible chips and chips inside the popover
          const chipSx = {
            fontSize: 11,
            fontWeight: 600,
            height: 22,
            maxWidth: 160,
            cursor: openPanel ? "pointer" : "default",
            bgcolor: isDark
              ? "rgba(25, 118, 210, 0.18)"
              : "rgba(25, 118, 210, 0.1)",
            color: isDark ? "#90caf9" : "#1565c0",
            border: `1px solid ${isDark ? "rgba(144,202,249,0.3)" : "rgba(21,101,192,0.25)"}`,
            "& .MuiChip-label": {
              px: 0.75,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            },
            "& .MuiChip-icon": { ml: 0.5 },
            "&:hover": openPanel
              ? {
                  bgcolor: isDark
                    ? "rgba(25, 118, 210, 0.32)"
                    : "rgba(25, 118, 210, 0.2)",
                }
              : {},
          };

          // Slightly stronger background for the +N overflow pill so it reads as an action
          const overflowChipSx = {
            ...chipSx,
            cursor: "pointer",
            bgcolor: isDark
              ? "rgba(25, 118, 210, 0.25)"
              : "rgba(25, 118, 210, 0.15)",
            "&:hover": {
              bgcolor: isDark
                ? "rgba(25, 118, 210, 0.4)"
                : "rgba(25, 118, 210, 0.25)",
            },
          };

          return (
            <>
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.5,
                  flexShrink: 0,
                  flexWrap: "nowrap",
                  overflow: "visible",
                }}
              >
                {visibleIds.map((sid) => (
                  <Tooltip key={sid} title={t("selector.activeServices")} arrow>
                    <Chip
                      icon={
                        <CalendarTodayIcon
                          sx={{ fontSize: "11px !important" }}
                        />
                      }
                      label={sid}
                      size="small"
                      onClick={
                        openPanel
                          ? () => openPanel("calendar", sid)
                          : undefined
                      }
                      clickable={Boolean(openPanel)}
                      sx={chipSx}
                    />
                  </Tooltip>
                ))}
                {hiddenCount > 0 && (
                  <Tooltip title={t("selector.activeServices")} arrow>
                    <Chip
                      label={`+${hiddenCount}`}
                      size="small"
                      onClick={(e) =>
                        setServicePopoverAnchor(e.currentTarget)
                      }
                      clickable
                      sx={overflowChipSx}
                    />
                  </Tooltip>
                )}
              </Box>
              <Popover
                open={Boolean(servicePopoverAnchor)}
                anchorEl={servicePopoverAnchor}
                onClose={() => setServicePopoverAnchor(null)}
                anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
                transformOrigin={{ vertical: "top", horizontal: "left" }}
              >
                <Box
                  sx={{
                    p: 1.25,
                    maxHeight: 320,
                    maxWidth: 320,
                    overflowY: "auto",
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{
                      display: "block",
                      mb: 0.75,
                      fontWeight: 600,
                      color: "text.secondary",
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                    }}
                  >
                    {t("selector.activeServices")}
                  </Typography>
                  <Box
                    sx={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 0.5,
                    }}
                  >
                    {activeServiceIds.map((sid) => (
                      <Chip
                        key={sid}
                        icon={
                          <CalendarTodayIcon
                            sx={{ fontSize: "11px !important" }}
                          />
                        }
                        label={sid}
                        size="small"
                        onClick={
                          openPanel
                            ? () => {
                                openPanel("calendar", sid);
                                setServicePopoverAnchor(null);
                              }
                            : undefined
                        }
                        clickable={Boolean(openPanel)}
                        sx={chipSx}
                      />
                    ))}
                  </Box>
                </Box>
              </Popover>
            </>
          );
        })()}

        {/* Direction selector */}
        <StyledFormControl
          variant="outlined"
          size="small"
          style={{ flex: 1 }}
          sx={pulseSelectSx("direction")}
        >
          <InputLabel id="direction-label">
            <Box display="flex" alignItems="center" gap={0.5}>
              <SwapVertIcon sx={{ fontSize: 16 }} />
              {t("selector.direction")}
            </Box>
          </InputLabel>
          <Select
            labelId="direction-label"
            fullWidth
            value={selectedDirection || ""}
            onChange={onDirectionChange}
            label={t("selector.direction")}
          >
            <MenuItem value="" disabled>
              {t("selector.directionPlaceholder")}
            </MenuItem>
            {directions && directions.length > 0 ? (
              directions.map((dir) => (
                <MenuItem
                  key={
                    dir.direction_id !== null
                      ? String(dir.direction_id)
                      : "null"
                  }
                  value={
                    dir.direction_id !== null
                      ? String(dir.direction_id)
                      : "null"
                  }
                >
                  {dir.label}
                </MenuItem>
              ))
            ) : (
              <MenuItem value="" disabled>
                {t("selector.directionSelectFirst")}
              </MenuItem>
            )}
          </Select>
        </StyledFormControl>
      </Box>

      {/* Delete route confirmation dialog */}
      <Dialog
        open={Boolean(deleteTarget)}
        onClose={() => !deleting && setDeleteTarget(null)}
      >
        <DialogTitle>{t("edit.route.deleteTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t("edit.route.deleteConfirm").replace(
              "{name}",
              deleteTarget
                ? deleteTarget.route_short_name || deleteTarget.route_id
                : "",
            )}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)} disabled={deleting}>
            {t("edit.route.deleteCancel")}
          </Button>
          <Button
            onClick={handleDeleteConfirm}
            color="error"
            variant="contained"
            disabled={deleting}
            startIcon={deleting ? <CircularProgress size={16} /> : null}
          >
            {t("edit.route.deleteButton")}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit agency dialog */}
      {editAgencyTarget && (
        <EditAgencyDialog
          open={Boolean(editAgencyTarget)}
          agency={editAgencyTarget}
          onClose={() => setEditAgencyTarget(null)}
          onSaved={(updated) => {
            setAgencyOverrides((prev) => ({
              ...prev,
              [updated.agency_id]: updated,
            }));
            setEditAgencyTarget(null);
          }}
        />
      )}
    </SelectorContainer>
  );
}

export default LineSelector;
