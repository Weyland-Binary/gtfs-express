/**
 * ReaderBody — the reader's views: the overview (HomeDashboard), the timetables and the map of one line (the line
 * picker over them, the line's head with its frequency and accessibility chips, the stop filter or the stop search),
 * the shape studio (edit mode), the comparison, and the SQL console shown over the view, which stays mounted hidden
 * so it keeps its data. A lost working copy is said in place first, with the ways back. `feed` is the reader's data
 * and handlers (app/useFeedLoading); the rest comes from the app's state. Nothing here fetches.
 */
import React, { lazy } from "react";
import { Typography, Box, Alert, TextField, InputAdornment, IconButton, Chip, Button } from "@mui/material";
import CircularProgress from "@mui/material/CircularProgress";
import AccessibleIcon from "@mui/icons-material/Accessible";
import MapOutlinedIcon from "@mui/icons-material/MapOutlined";
import TableRowsOutlinedIcon from "@mui/icons-material/TableRowsOutlined";
import SegmentedSwitch from "../common/SegmentedSwitch";
import SearchIcon from "@mui/icons-material/Search";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import ClearIcon from "@mui/icons-material/Clear";
import LineSelector from "../LineSelector";
import StopSearchAutocomplete from "../StopSearchAutocomplete";
import Deferred from "./Deferred";
import { useLanguage } from "../../contexts/LanguageContext";
import { useNavigate, projectPath } from "../../utils/routes";
// The explorer's overview (its map, Leaflet) loads when a network opens: never in the app's first chunk.
const HomeDashboard = lazy(() => import("../HomeDashboard"));
const ScheduleGrid = lazy(() => import("../ScheduleGrid"));
const LineMap = lazy(() => import("../LineMap"));
const FeedDiffPage = lazy(() => import("../diff/FeedDiffPage"));
const SqlConsole = lazy(() => import("../SqlConsole/SqlConsole"));
const ShapeStudio = lazy(() => import("../shapeStudio/ShapeStudio"));

export default function ReaderBody({ feed, sessionLost, route, sqlConsoleVisible, selectedMainTab, setSelectedMainTab, setShowValidationReport, lensKey, validationReport, importAdjustments, networkReport, setNetworkReport, backgroundValidating, validatingSeconds, features, showSelectorGuide, setShowSelectorGuide, openPanel, markedRoutes, lensCompareShown }) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { loading, agencies, routes, setRoutes, directions, selectedAgency, selectedRoute, selectedDirection, selectedDate, stopsAndTimes, shapes, allRouteShapes, selectedSecondaryTab, setSelectedSecondaryTab, selectedRouteDetails, error, calendar, calendarDates, stopFilter, setStopFilter, focusedStopId, setFocusedStopId, handleAgencyChange, handleRouteChange, handleDirectionChange, handleDateChange, studioTarget } = feed;
  return (
    <>
      {/* The working copy is gone: said in place with the ways back — the project's « Reprendre »
          (its frozen version) inside a project, else Home (the file, the catalogue). */}
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
      {/* SQL Console — mounted only when active so it initialises
          lazily. Kept as a conditional render (not CSS-hidden) to
          avoid mounting a heavy editor that the user may never open. */}
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
      {/* Tab content — kept mounted even while the SQL console is
          visible (hidden via CSS only). This means HomeDashboard
          remains subscribed to dataVersion and re-fetches statistics
          in the background, so the Home tab shows fresh data the
          instant the SQL console is closed — no loading flash. */}
      <Box
        sx={
          sqlConsoleVisible
            ? { display: "none" }
            : { display: "contents" }
        }
      >
        {selectedMainTab === 0 ? (
          // Tab 0 — Home dashboard (post-upload at-a-glance)
          <Deferred>
          <HomeDashboard
            key={`lens-${lensKey}`}
            validationReport={validationReport}
            importAdjustments={importAdjustments}
            networkReport={networkReport}
            onDismissReport={() => setNetworkReport(null)}
            onRefineReport={route.name === "projectExplorer" ? () => {
              setNetworkReport(null);
              navigate(projectPath(route.params.id, 3));
            } : null}
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
              !selectedDate) && (
              <Box
                display="flex"
                justifyContent="center"
                alignItems="center"
                height="300px"
              >
                <Alert
                  severity="info"
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
                    {t("app.selectPrompt")}
                  </Typography>
                </Alert>
              </Box>
            )}
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
                          <div
                            style={{
                              width: 36,
                              height: 36,
                              minHeight: 36,
                              minWidth: 36,
                              backgroundColor: `#${selectedRouteDetails.route_color || "1976d2"}`,
                              color: `#${selectedRouteDetails.route_text_color || "FFFFFF"}`,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              borderRadius: 8,
                              fontSize: 16,
                              fontWeight: 700,
                              boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
                            }}
                          >
                            {selectedRouteDetails.route_short_name}
                          </div>
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
                          {/* The frequency-based service is said in the timetable's bar, beside its trips (ScheduleGrid). */}
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
                                // Reset first so picking the same stop
                                // twice still triggers the flyTo effect
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
                                    <ClearIcon
                                      sx={{
                                        color: "#64748b",
                                        fontSize: 18,
                                        cursor: "pointer",
                                        "&:hover": { color: "#334155" },
                                      }}
                                      onClick={() => setStopFilter("")}
                                    />
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
            <ShapeStudio agencies={agencies} target={studioTarget} />
          </Deferred>
        ) : selectedMainTab === 4 ? (
          <Deferred>
            <FeedDiffPage />
          </Deferred>
        ) : null}
      </Box>
    </>
  );
}
