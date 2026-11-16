/** The reader's views. `feed` is the reader's data and handlers (app/useFeedLoading); nothing here fetches. */
import React, { lazy, useMemo, useRef } from "react";
import { Typography, Box, Alert, TextField, InputAdornment, IconButton, Chip, Button } from "@mui/material";
import CircularProgress from "@mui/material/CircularProgress";
import AccessibleIcon from "@mui/icons-material/Accessible";
import MapOutlinedIcon from "@mui/icons-material/MapOutlined";
import TableRowsOutlinedIcon from "@mui/icons-material/TableRowsOutlined";
import SegmentedSwitch from "../common/SegmentedSwitch";
import SearchIcon from "@mui/icons-material/Search";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import ClearIcon from "@mui/icons-material/Clear";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import LineSelector from "../LineSelector";
import LineBadge from "../common/LineBadge";
import StopSearchAutocomplete from "../StopSearchAutocomplete";
import Deferred from "./Deferred";
import TimeStrip from "./TimeStrip";
import { TAB_INDEX } from "./useAppRoutes";
import { STRIP_VIEWS } from "../../utils/timeStripPref";
import { useLanguage } from "../../contexts/LanguageContext";
import { getActiveServiceIds } from "../../utils/calendarUtils";
import { localeOf } from "../../utils/formatDate";
import { isIdleDay, servedDayNear } from "./useTimetable";
import { useNavigate, projectPath } from "../../utils/routes";
// The overview's map (Leaflet) is never in the app's first chunk.
const HomeDashboard = lazy(() => import("../HomeDashboard"));
const ScheduleGrid = lazy(() => import("../ScheduleGrid"));
const LineMap = lazy(() => import("../LineMap"));
const FeedDiffPage = lazy(() => import("../diff/FeedDiffPage"));
const SqlConsole = lazy(() => import("../SqlConsole/SqlConsole"));
const ShapeStudio = lazy(() => import("../shapeStudio/ShapeStudio"));
const StopSheets = lazy(() => import("../sheets/StopSheets"));
const OfferView = lazy(() => import("../offer/OfferView"));
const STRIP_TABS = new Set([...STRIP_VIEWS].map((view) => TAB_INDEX[view]));

export default function ReaderBody({ feed, sessionLost, route, sqlConsoleVisible, selectedMainTab, setSelectedMainTab, setShowValidationReport, lensKey, validationReport, importAdjustments, backgroundValidating, validatingSeconds, features, showSelectorGuide, setShowSelectorGuide, openPanel, markedRoutes, lensCompareShown }) {
  const { t, language } = useLanguage();
  const navigate = useNavigate();
  const { loading, agencies, routes, setRoutes, directions, selectedAgency, selectedRoute, selectedDirection, selectedDate, stopsAndTimes, shapes, allRouteShapes, selectedSecondaryTab, setSelectedSecondaryTab, selectedRouteDetails, error, calendar, calendarDates, stopFilter, setStopFilter, focusedStopId, setFocusedStopId, handleAgencyChange, handleRouteChange, handleDirectionChange, handleDateChange, studioTarget } = feed;
  const idleDay = !loading && isIdleDay(stopsAndTimes, selectedRoute, selectedDate);
  // The calendars may still be those of the line left for an instant: no day is offered until they agree with the
  // timetable that this one is idle.
  const stopFilterInput = useRef(null);
  const idleDays = useMemo(() => {
    if (!idleDay || getActiveServiceIds(selectedDate, calendar, calendarDates).length > 0) return [];
    return [
      { id: "previous", day: servedDayNear(selectedDate, -1, calendar, calendarDates) },
      { id: "next", day: servedDayNear(selectedDate, 1, calendar, calendarDates) },
    ].filter((near) => near.day);
  }, [idleDay, selectedDate, calendar, calendarDates]);
  const dayLabel = (iso) => new Intl.DateTimeFormat(localeOf(language), { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${iso}T12:00:00`));
  return (
    <>
      {sessionLost && (
        <Alert
          severity="warning"
          data-testid="session-expired"
          sx={{ m: 1 }}
          action={
            route.name === "projectExplorer" ? (
              <Button color="inherit" size="small" onClick={() => navigate(projectPath(route.params.id))} sx={{ textTransform: "none", fontWeight: 800 }}>
                {t("recovery.resume")}
              </Button>
            ) : (
              <Button color="inherit" size="small" onClick={() => navigate("/")} sx={{ textTransform: "none", fontWeight: 800 }}>
                {t("home.projects")}
              </Button>
            )
          }
        >
          <strong>{t("recovery.title")}</strong> — {t(route.name === "projectExplorer" ? "recovery.body" : "recovery.notFound")}
        </Alert>
      )}
      {/* Mounted only when active: a heavy editor the person may never open. */}
      {sqlConsoleVisible && (
        <Box
          sx={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <Deferred>
            <SqlConsole />
          </Deferred>
        </Box>
      )}
      {/* Kept mounted (hidden by CSS) under the SQL console, so the overview stays subscribed to dataVersion and shows
         fresh data the instant the console closes, without a loading flash. */}
      <Box
        sx={
          sqlConsoleVisible
            ? { display: "none" }
            : { display: "contents" }
        }
      >
        {selectedMainTab === 0 ? (
          <Deferred>
          <HomeDashboard
            key={`lens-${lensKey}`}
            validationReport={validationReport}
            importAdjustments={importAdjustments}
            onNavigateToValidation={() => {
              setShowValidationReport(true);
            }}
            onNavigateToSchedule={() => setSelectedMainTab(1)}
            agencies={agencies}
            validation={{ running: backgroundValidating, seconds: validatingSeconds, unavailable: features?.access?.validator === "unavailable" }}
          />
          </Deferred>
        ) : selectedMainTab === 1 ? (
          <>
            <LineSelector
              agencies={agencies}
              routes={routes}
              directions={directions}
              selectedAgency={selectedAgency}
              selectedRoute={selectedRoute}
              selectedDirection={selectedDirection}
              selectedDate={selectedDate}
              onAgencyChange={handleAgencyChange}
              onRouteChange={handleRouteChange}
              onDirectionChange={handleDirectionChange}
              onDateChange={handleDateChange}
              onRoutesChanged={(deletedRouteId) =>
                setRoutes((prev) =>
                  prev.filter((r) => r.route_id !== deletedRouteId),
                )
              }
              calendar={calendar}
              calendarDates={calendarDates}
              showGuide={showSelectorGuide}
              onGuideDone={() => setShowSelectorGuide(false)}
              openPanel={openPanel}
              markedRouteIds={markedRoutes}
            />
            {(!selectedAgency ||
              !selectedRoute ||
              !selectedDirection ||
              !selectedDate) &&
              // A timetable that could not be read has no direction to show its error under; the error is its line's, and
              // is not said once no line is chosen.
              (error && !loading && selectedRoute ? (
                <Alert severity="error" data-testid="timetable-error" style={{ margin: "24px", textAlign: "center" }}>
                  {error}
                </Alert>
              ) : (
                <Box
                  display="flex"
                  justifyContent="center"
                  alignItems="center"
                  height="300px"
                >
                  <Alert
                    severity="info"
                    data-testid={idleDay ? "timetable-idle-day" : undefined}
                    sx={{
                      borderRadius: 3,
                      boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                      border: "1px solid rgba(25, 118, 210, 0.2)",
                      "& .MuiAlert-icon": {
                        fontSize: 28,
                      },
                    }}
                  >
                    <Typography variant="body1" fontWeight={500}>
                      {idleDay ? t("app.idleDay") : t("app.selectPrompt")}
                    </Typography>
                    {idleDays.length > 0 && (
                      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, mt: 1.25 }}>
                        {idleDays.map(({ id, day }) => (
                          <Button
                            key={id}
                            size="small"
                            variant="outlined"
                            color="inherit"
                            data-testid={`idle-day-${id}`}
                            startIcon={id === "previous" ? <ChevronLeftIcon /> : null}
                            endIcon={id === "next" ? <ChevronRightIcon /> : null}
                            onClick={() => handleDateChange({ target: { value: day } })}
                            sx={{ textTransform: "none", fontWeight: 600 }}
                          >
                            {id === "previous" ? t("app.idleDay.previous", { date: dayLabel(day) }) : t("app.idleDay.next", { date: dayLabel(day) })}
                          </Button>
                        ))}
                      </Box>
                    )}
                  </Alert>
                </Box>
              ))}
            {loading ? (
              <Box
                display="flex"
                justifyContent="center"
                alignItems="center"
                height="200px"
                flexDirection="column"
                gap={2}
              >
                <CircularProgress size={48} thickness={4} />
                <Typography variant="body2" color="text.secondary">
                  {t("app.loadingRoute")}
                </Typography>
              </Box>
            ) : (
              <>
                {selectedRoute &&
                  selectedRouteDetails &&
                  selectedAgency &&
                  selectedDirection &&
                  selectedDate && (
                    <>
                      <Box
                        display="flex"
                        alignItems="center"
                        justifyContent="space-between"
                        marginBottom={0}
                        marginTop={-1.5}
                        sx={(theme) => ({
                          backgroundColor:
                            theme.palette.mode === "dark"
                              ? "#1e1e1e"
                              : "#ffffff",
                          padding: 1.5,
                          borderRadius: 0,
                          boxShadow: "none",
                          border:
                            theme.palette.mode === "dark"
                              ? "1px solid rgba(255,255,255,0.08)"
                              : "1px solid rgba(0,0,0,0.06)",
                          borderTop: "none",
                          borderBottom: "none",
                        })}
                      >
                        <Box
                          display="flex"
                          alignItems="center"
                          gap={1.5}
                        >
                          <LineBadge route={selectedRouteDetails} size="lg" />
                          <Typography
                            variant="h6"
                            sx={(theme) => ({
                              fontWeight: 600,
                              color:
                                theme.palette.mode === "dark"
                                  ? "#e2e8f0"
                                  : "#1e293b",
                              fontSize: "1rem",
                            })}
                          >
                            {selectedRouteDetails.route_long_name}
                          </Typography>
                          <IconButton
                            size="small"
                            aria-label={t("selector.routeDetails")}
                            onClick={() =>
                              openPanel("route", selectedRoute)
                            }
                            sx={(theme) => ({
                              color:
                                theme.palette.mode === "dark"
                                  ? "rgba(255,255,255,0.5)"
                                  : "rgba(0,0,0,0.4)",
                              "&:hover": {
                                color: theme.palette.primary.main,
                                backgroundColor:
                                  theme.palette.mode === "dark"
                                    ? "rgba(144,202,249,0.1)"
                                    : "rgba(25,118,210,0.08)",
                              },
                            })}
                          >
                            <InfoOutlinedIcon sx={{ fontSize: 18 }} />
                          </IconButton>
                        </Box>
                        <Box
                          sx={{
                            flex: 1,
                            display: "flex",
                            alignItems: "center",
                            gap: 0.75,
                            flexWrap: "wrap",
                            justifyContent: "center",
                            px: 2,
                            minWidth: 0,
                          }}
                        >
                          {stopsAndTimes.total_trips > 0 &&
                            stopsAndTimes.wheelchair_accessible_trips >
                              0 && (
                              <Chip
                                icon={
                                  <AccessibleIcon
                                    sx={{ fontSize: 14 }}
                                  />
                                }
                                label={
                                  stopsAndTimes.wheelchair_accessible_trips ===
                                  stopsAndTimes.total_trips
                                    ? t("schedule.wheelchairAll")
                                    : t("schedule.wheelchairPartial", {
                                        accessible:
                                          stopsAndTimes.wheelchair_accessible_trips,
                                        total:
                                          stopsAndTimes.total_trips,
                                      })
                                }
                                size="small"
                                sx={(theme) => ({
                                  height: 22,
                                  fontSize: "0.72rem",
                                  fontWeight: 500,
                                  backgroundColor:
                                    theme.palette.mode === "dark"
                                      ? "#1a2e1a"
                                      : "#f0fdf4",
                                  color:
                                    theme.palette.mode === "dark"
                                      ? "#86efac"
                                      : "#166534",
                                  "& .MuiChip-icon": {
                                    color:
                                      theme.palette.mode === "dark"
                                        ? "#4ade80"
                                        : "#16a34a",
                                  },
                                })}
                              />
                            )}
                        </Box>
                        <Box
                          display="flex"
                          alignItems="center"
                          gap={1.5}
                        >
                          {selectedSecondaryTab === 1 && (
                            <StopSearchAutocomplete
                              stops={stopsAndTimes.stops || []}
                              selectedStopId={focusedStopId}
                              onSelect={(stopId) => {
                                if (!stopId) {
                                  setFocusedStopId(null);
                                  return;
                                }
                                // Reset first so picking the same stop twice still triggers the flyTo effect.
                                setFocusedStopId(null);
                                setTimeout(
                                  () => setFocusedStopId(stopId),
                                  0,
                                );
                              }}
                              width={240}
                            />
                          )}
                          {selectedSecondaryTab === 0 && (
                            <TextField
                              placeholder={t("app.stopSearch")}
                              inputProps={{ "aria-label": t("app.stopSearch") }}
                              inputRef={stopFilterInput}
                              value={stopFilter}
                              onChange={(e) =>
                                setStopFilter(e.target.value)
                              }
                              variant="outlined"
                              size="small"
                              sx={() => ({
                                width: 240,
                                "& .MuiOutlinedInput-root": {
                                  borderRadius: 2,
                                },
                              })}
                              InputProps={{
                                startAdornment: (
                                  <InputAdornment position="start">
                                    <SearchIcon
                                      sx={{
                                        color: "#64748b",
                                        fontSize: 18,
                                      }}
                                    />
                                  </InputAdornment>
                                ),
                                endAdornment: stopFilter && (
                                  <InputAdornment position="end">
                                    {/* The button leaves with the text it clears: the focus goes back to the field. */}
                                    <IconButton
                                      size="small"
                                      aria-label={t("app.clear")}
                                      onClick={() => {
                                        setStopFilter("");
                                        stopFilterInput.current?.focus();
                                      }}
                                      sx={{ p: 0.25, m: -0.25, color: "#64748b", "&:hover": { color: "#334155" } }}
                                    >
                                      <ClearIcon sx={{ fontSize: 18 }} />
                                    </IconButton>
                                  </InputAdornment>
                                ),
                                sx: (theme) => ({
                                  borderRadius: 2,
                                  backgroundColor:
                                    theme.palette.mode === "dark"
                                      ? "#2d2d2d"
                                      : "#f8fafc",
                                  "&:hover": {
                                    backgroundColor:
                                      theme.palette.mode === "dark"
                                        ? "#3d3d3d"
                                        : "#f1f5f9",
                                  },
                                  "& .MuiOutlinedInput-notchedOutline":
                                    {
                                      borderColor:
                                        theme.palette.mode === "dark"
                                          ? "rgba(255,255,255,0.15)"
                                          : "#e2e8f0",
                                    },
                                  "&:hover .MuiOutlinedInput-notchedOutline":
                                    {
                                      borderColor:
                                        theme.palette.mode === "dark"
                                          ? "rgba(255,255,255,0.25)"
                                          : "#cbd5e1",
                                    },
                                  "&.Mui-focused": {
                                    backgroundColor:
                                      theme.palette.mode === "dark"
                                        ? "#2d2d2d"
                                        : "white",
                                  },
                                }),
                              }}
                            />
                          )}
                          {/* Two ways of showing the same line, not a navigation: a view switch. */}
                          <SegmentedSwitch
                            options={[
                              { value: "grid", label: t("app.viewGrid"), icon: <TableRowsOutlinedIcon /> },
                              { value: "map", label: t("app.tabMap"), icon: <MapOutlinedIcon /> },
                            ]}
                            value={selectedSecondaryTab === 1 ? "map" : "grid"}
                            onChange={(view) => setSelectedSecondaryTab(view === "map" ? 1 : 0)}
                            label={t("app.viewLabel")}
                            testid="reader-view"
                            size="large"
                          />
                        </Box>
                      </Box>
                      {selectedAgency &&
                        selectedRoute &&
                        selectedDirection &&
                        selectedDate && (
                          <Box
                            style={{
                              flex: 1,
                              overflowY: "auto",
                              height: "calc(100vh - 400px)",
                            }}
                          >
                            {error && (
                              <Alert
                                severity="error"
                                style={{
                                  margin: "24px",
                                  textAlign: "center",
                                }}
                              >
                                {error}
                              </Alert>
                            )}
                            {!error &&
                              selectedSecondaryTab === 0 &&
                              selectedRoute &&
                              selectedDirection &&
                              selectedDate && (
                                <Deferred>
                                <ScheduleGrid
                                  stops={stopsAndTimes.stops}
                                  stopTimes={stopsAndTimes.stop_times}
                                  selectedRouteDetails={
                                    selectedRouteDetails
                                  }
                                  frequencyInfo={
                                    stopsAndTimes.frequency_info
                                  }
                                  hasFrequencies={
                                    stopsAndTimes.has_frequencies
                                  }
                                  hasNormalTimes={
                                    stopsAndTimes.has_normal_times
                                  }
                                  stopFilter={stopFilter}
                                  datasetKey={`${selectedRoute}|${selectedDirection}|${selectedDate}`}
                                  wheelchairAccessibleTrips={
                                    stopsAndTimes.wheelchair_accessible_trips
                                  }
                                  totalTrips={stopsAndTimes.total_trips}
                                  highlightTripIds={lensCompareShown ? lensCompareShown.added : null}
                                />
                                </Deferred>
                              )}
                            {!error &&
                              selectedSecondaryTab === 1 &&
                              Object.keys(shapes).length === 0 &&
                              Object.keys(allRouteShapes).length ===
                                0 && (
                                <Alert
                                  severity="info"
                                  sx={{ mx: 2, mt: 1 }}
                                >
                                  {t("map.noShapes")}
                                </Alert>
                              )}
                            {!error && selectedSecondaryTab === 1 && (
                              <Deferred>
                              <LineMap
                                chrome="readonly"
                                shapesById={shapes}
                                allRouteShapes={allRouteShapes}
                                stops={stopsAndTimes.stops}
                                focusedStopId={focusedStopId}
                              />
                              </Deferred>
                            )}
                          </Box>
                        )}
                    </>
                  )}
              </>
            )}
          </>
        ) : selectedMainTab === 3 ? (
          <Deferred>
            <ShapeStudio agencies={agencies} target={studioTarget} projectId={route?.name === "projectExplorer" ? route.params?.id || null : null} />
          </Deferred>
        ) : selectedMainTab === 4 ? (
          <Deferred>
            <FeedDiffPage />
          </Deferred>
        ) : selectedMainTab === 5 ? (
          <Deferred>
            <StopSheets />
          </Deferred>
        ) : selectedMainTab === 6 ? (
          <Deferred>
            <OfferView />
          </Deferred>
        ) : null}
      </Box>
      {/* The days under the screens that read the day chosen: the lines and the offer. */}
      {agencies.length > 0 && !sqlConsoleVisible && STRIP_TABS.has(selectedMainTab) && (
        <TimeStrip selectedDate={selectedDate} onDateChange={(iso) => handleDateChange({ target: { value: iso } })} routeId={selectedRoute || null} routeLabel={routes.find((r) => r.route_id === selectedRoute)?.route_short_name || ""} />
      )}
    </>
  );
}
