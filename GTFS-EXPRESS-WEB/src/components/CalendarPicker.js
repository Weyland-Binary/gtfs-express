import React, { useState, useMemo, useCallback } from "react";
import { Box, IconButton, Popover, Typography, Tooltip } from "@mui/material";
import { styled, useTheme } from "@mui/material/styles";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CalendarTodayIcon from "@mui/icons-material/CalendarToday";
import CircleIcon from "@mui/icons-material/Circle";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// Per-service-type colour schemes (bg/text/hover/dot) are resolved at
// runtime from `theme.palette.calendarSchemes[serviceType]` so light and
// dark variants live centrally in Theme.js.

// --- Utilities ---

function toGTFSDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseISODate(str) {
  if (!str) return null;
  const parts = str.split("-");
  if (parts.length !== 3) return null;
  return new Date(
    parseInt(parts[0]),
    parseInt(parts[1]) - 1,
    parseInt(parts[2]),
  );
}

function parseGTFSDate(str) {
  if (!str || str.length !== 8) return null;
  return new Date(
    parseInt(str.substring(0, 4)),
    parseInt(str.substring(4, 6)) - 1,
    parseInt(str.substring(6, 8)),
  );
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function getServiceType(date, calendar, calendarDates) {
  const dateStr = toGTFSDate(date);
  const dow = date.getDay();

  let hasRegularService = false;
  const activeServiceIds = [];

  for (const entry of calendar) {
    if (dateStr >= entry.start_date && dateStr <= entry.end_date) {
      if (String(entry[DAY_KEYS[dow]]) === "1") {
        hasRegularService = true;
        activeServiceIds.push(entry.service_id);
      }
    }
  }

  let hasAddedException = false;
  const removedServiceIds = new Set();

  for (const entry of calendarDates) {
    if (String(entry.date) === dateStr) {
      if (String(entry.exception_type) === "1") {
        hasAddedException = true;
      } else if (String(entry.exception_type) === "2") {
        removedServiceIds.add(entry.service_id);
      }
    }
  }

  if (hasRegularService) {
    const allRemoved = activeServiceIds.every((sid) =>
      removedServiceIds.has(sid),
    );
    if (allRemoved) hasRegularService = false;
  }

  const hasService = hasRegularService || hasAddedException;
  if (!hasService) return "no-service";
  if (hasAddedException && !hasRegularService) return "exception";
  if (dow === 0) return "sunday";
  if (dow === 6) return "saturday";
  return "weekday";
}

function getMonthGrid(year, month) {
  const firstDay = new Date(year, month, 1);
  let startDow = firstDay.getDay() - 1;
  if (startDow < 0) startDow = 6;

  const days = [];
  for (let i = startDow - 1; i >= 0; i--) {
    days.push({ date: new Date(year, month, -i), currentMonth: false });
  }
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let i = 1; i <= daysInMonth; i++) {
    days.push({ date: new Date(year, month, i), currentMonth: true });
  }
  const remaining = 42 - days.length;
  for (let i = 1; i <= remaining; i++) {
    days.push({ date: new Date(year, month + 1, i), currentMonth: false });
  }
  return days;
}

// --- Styled Components ---

const CalendarTrigger = styled("button")(({ theme }) => ({
  borderRadius: 10,
  backgroundColor: theme.palette.mode === "dark" ? "#2d2d2d" : "#ffffff",
  border: `1px solid ${theme.palette.mode === "dark" ? "rgba(255,255,255,0.23)" : "rgba(0,0,0,0.23)"}`,
  padding: "7px 14px",
  display: "flex",
  alignItems: "center",
  gap: 8,
  transition: "all 0.2s ease",
  width: "100%",
  textAlign: "left",
  minHeight: 40,
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: "0.875rem",
  color: theme.palette.text.primary,
  outline: "none",
  "&:hover": {
    backgroundColor: theme.palette.mode === "dark" ? "#3d3d3d" : "#f8fafc",
    borderColor:
      theme.palette.mode === "dark"
        ? "rgba(255,255,255,0.5)"
        : "rgba(0,0,0,0.87)",
  },
  "&:focus": {
    borderColor: theme.palette.primary.main,
    borderWidth: 2,
    padding: "6px 13px",
    boxShadow:
      theme.palette.mode === "dark"
        ? "0 0 0 3px rgba(144, 202, 249, 0.2)"
        : "0 0 0 3px rgba(25, 118, 210, 0.1)",
  },
}));

const DayCell = styled("button")(({
  theme,
  serviceType,
  isSelected,
  isToday,
  isCurrentMonth,
}) => {
  const mode = theme.palette.mode;
  const colors =
    theme.palette.calendarSchemes[serviceType] ||
    theme.palette.calendarSchemes["no-service"];
  const isActive = serviceType !== "no-service";

  return {
    width: 36,
    height: 36,
    border: "none",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: isCurrentMonth ? "pointer" : "default",
    fontFamily: "inherit",
    fontSize: 13,
    fontWeight: isToday ? 700 : isSelected ? 600 : 400,
    transition: "all 0.15s ease",
    position: "relative",
    outline: "none",
    opacity: isCurrentMonth ? 1 : 0.25,
    backgroundColor: isSelected
      ? mode === "dark"
        ? theme.palette.primary.main
        : theme.palette.primary.main
      : isCurrentMonth && isActive
        ? colors.bg
        : "transparent",
    color: isSelected
      ? mode === "dark"
        ? "#0a1929"
        : "#ffffff"
      : isCurrentMonth
        ? colors.text
        : mode === "dark"
          ? "#555"
          : "#ccc",
    boxShadow: isSelected
      ? mode === "dark"
        ? "0 2px 8px rgba(144, 202, 249, 0.4)"
        : "0 2px 8px rgba(25, 118, 210, 0.35)"
      : "none",
    ...(isToday &&
      !isSelected && {
        boxShadow:
          mode === "dark"
            ? `inset 0 0 0 2px ${theme.palette.primary.main}`
            : `inset 0 0 0 2px ${theme.palette.primary.main}`,
      }),
    "&:hover": isCurrentMonth
      ? {
          backgroundColor: isSelected
            ? mode === "dark"
              ? theme.palette.primary.dark
              : theme.palette.primary.dark
            : colors.hover,
          transform: "scale(1.1)",
        }
      : {},
  };
});

// --- Component ---

function CalendarPicker({
  selectedDate,
  onDateChange,
  calendar = [],
  calendarDates = [],
  highlight = false,
}) {
  const theme = useTheme();
  const mode = theme.palette.mode;
  const [anchorEl, setAnchorEl] = useState(null);

  const selectedParsed = useMemo(
    () => parseISODate(selectedDate),
    [selectedDate],
  );
  const today = useMemo(() => new Date(), []);

  // Compute valid date range from calendar data
  const { minDate, maxDate } = useMemo(() => {
    let min = null;
    let max = null;
    for (const entry of calendar) {
      const start = parseGTFSDate(entry.start_date);
      const end = parseGTFSDate(entry.end_date);
      if (start && (!min || start < min)) min = start;
      if (end && (!max || end > max)) max = end;
    }
    for (const entry of calendarDates) {
      const d = parseGTFSDate(String(entry.date));
      if (d) {
        if (!min || d < min) min = d;
        if (!max || d > max) max = d;
      }
    }
    return { minDate: min, maxDate: max };
  }, [calendar, calendarDates]);

  // Initial view month: selected date > first valid month > today
  const initialMonth = useMemo(() => {
    if (selectedParsed)
      return {
        year: selectedParsed.getFullYear(),
        month: selectedParsed.getMonth(),
      };
    if (minDate)
      return { year: minDate.getFullYear(), month: minDate.getMonth() };
    return { year: today.getFullYear(), month: today.getMonth() };
  }, [selectedParsed, minDate, today]);

  const [viewYear, setViewYear] = useState(initialMonth.year);
  const [viewMonth, setViewMonth] = useState(initialMonth.month);

  // When selectedDate changes externally, sync view
  const prevSelectedRef = React.useRef(selectedDate);
  React.useEffect(() => {
    if (selectedDate !== prevSelectedRef.current) {
      prevSelectedRef.current = selectedDate;
      const parsed = parseISODate(selectedDate);
      if (parsed) {
        setViewYear(parsed.getFullYear());
        setViewMonth(parsed.getMonth());
      }
    }
  }, [selectedDate]);

  const days = useMemo(
    () => getMonthGrid(viewYear, viewMonth),
    [viewYear, viewMonth],
  );

  // Pre-compute service types for all visible days
  const serviceMap = useMemo(() => {
    if (calendar.length === 0 && calendarDates.length === 0) return null;
    const map = new Map();
    for (const day of days) {
      map.set(
        toISODate(day.date),
        getServiceType(day.date, calendar, calendarDates),
      );
    }
    return map;
  }, [days, calendar, calendarDates]);

  const canGoPrev = useMemo(() => {
    if (!minDate) return true;
    return (
      viewYear > minDate.getFullYear() ||
      (viewYear === minDate.getFullYear() && viewMonth > minDate.getMonth())
    );
  }, [viewYear, viewMonth, minDate]);

  const canGoNext = useMemo(() => {
    if (!maxDate) return true;
    return (
      viewYear < maxDate.getFullYear() ||
      (viewYear === maxDate.getFullYear() && viewMonth < maxDate.getMonth())
    );
  }, [viewYear, viewMonth, maxDate]);

  const handleOpen = useCallback((e) => {
    setAnchorEl(e.currentTarget);
  }, []);

  const handleClose = useCallback(() => {
    setAnchorEl(null);
  }, []);

  const handlePrevMonth = useCallback(() => {
    setViewMonth((m) => {
      if (m === 0) {
        setViewYear((y) => y - 1);
        return 11;
      }
      return m - 1;
    });
  }, []);

  const handleNextMonth = useCallback(() => {
    setViewMonth((m) => {
      if (m === 11) {
        setViewYear((y) => y + 1);
        return 0;
      }
      return m + 1;
    });
  }, []);

  const handleDayClick = useCallback(
    (day) => {
      if (!day.currentMonth) return;
      const iso = toISODate(day.date);
      onDateChange({ target: { value: iso } });
      setAnchorEl(null);
    },
    [onDateChange],
  );

  const handleToday = useCallback(() => {
    setViewYear(today.getFullYear());
    setViewMonth(today.getMonth());
  }, [today]);

  const open = Boolean(anchorEl);

  const displayDate = selectedParsed
    ? selectedParsed.toLocaleDateString("en-US", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";

  const hasCalendarData = calendar.length > 0 || calendarDates.length > 0;

  // Legend items to show
  const legendItems = [
    { type: "weekday", label: "Weekday" },
    { type: "saturday", label: "Saturday" },
    { type: "sunday", label: "Sunday" },
    { type: "exception", label: "Special" },
  ];

  return (
    <Box style={{ flex: 1, position: "relative" }}>
      {highlight && (
        <style>{`
          @keyframes calendarBorderPulse {
            0%, 100% { border-color: rgba(25, 118, 210, 0.7); }
            50% { border-color: rgba(25, 118, 210, 0.2); }
          }
        `}</style>
      )}
      {/* Floating label */}
      <Typography
        component="label"
        sx={{
          position: "absolute",
          top: -8,
          left: 12,
          px: 0.5,
          fontSize: "0.75rem",
          fontWeight: 500,
          color: open ? "primary.main" : "text.secondary",
          backgroundColor: mode === "dark" ? "#2d2d2d" : "#ffffff",
          zIndex: 1,
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          pointerEvents: "none",
          transition: "color 0.2s ease",
        }}
      >
        <CalendarTodayIcon sx={{ fontSize: 14 }} />
        Date
      </Typography>

      <CalendarTrigger
        onClick={handleOpen}
        aria-label="Open date picker"
        style={
          highlight
            ? {
                borderWidth: 2,
                borderColor: "rgba(25, 118, 210, 0.7)",
                padding: "6px 13px",
                animation: "calendarBorderPulse 1.8s ease-in-out infinite",
              }
            : undefined
        }
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            width: "100%",
            minHeight: 24,
          }}
        >
          <Typography
            variant="body2"
            sx={{
              color: displayDate ? "text.primary" : "text.secondary",
              whiteSpace: "nowrap",
            }}
          >
            {displayDate || "Select a date"}
          </Typography>
        </Box>
      </CalendarTrigger>

      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        slotProps={{
          paper: {
            sx: {
              mt: 0.5,
              borderRadius: 3,
              overflow: "hidden",
              boxShadow:
                mode === "dark"
                  ? "0 8px 32px rgba(0,0,0,0.6)"
                  : "0 8px 32px rgba(0,0,0,0.12)",
              border:
                mode === "dark"
                  ? "1px solid rgba(255,255,255,0.1)"
                  : "1px solid rgba(0,0,0,0.06)",
              backgroundColor: mode === "dark" ? "#1e1e1e" : "#ffffff",
            },
          },
        }}
      >
        <Box sx={{ width: 308, p: 2 }}>
          {/* Header */}
          <Box
            display="flex"
            alignItems="center"
            justifyContent="space-between"
            mb={1.5}
          >
            <IconButton
              size="small"
              onClick={handlePrevMonth}
              disabled={!canGoPrev}
              sx={{
                color: "text.primary",
                "&:hover": {
                  backgroundColor:
                    mode === "dark"
                      ? "rgba(255,255,255,0.08)"
                      : "rgba(0,0,0,0.04)",
                },
              }}
            >
              <ChevronLeftIcon fontSize="small" />
            </IconButton>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                cursor: "pointer",
              }}
              onClick={handleToday}
            >
              <Typography
                variant="subtitle2"
                fontWeight={600}
                sx={{ userSelect: "none" }}
              >
                {MONTH_NAMES[viewMonth]} {viewYear}
              </Typography>
            </Box>
            <IconButton
              size="small"
              onClick={handleNextMonth}
              disabled={!canGoNext}
              sx={{
                color: "text.primary",
                "&:hover": {
                  backgroundColor:
                    mode === "dark"
                      ? "rgba(255,255,255,0.08)"
                      : "rgba(0,0,0,0.04)",
                },
              }}
            >
              <ChevronRightIcon fontSize="small" />
            </IconButton>
          </Box>

          {/* Day-of-week headers */}
          <Box
            display="grid"
            gridTemplateColumns="repeat(7, 1fr)"
            sx={{ mb: 0.5 }}
          >
            {DAY_LABELS.map((label) => (
              <Box
                key={label}
                sx={{
                  textAlign: "center",
                  py: 0.5,
                }}
              >
                <Typography
                  variant="caption"
                  sx={{
                    fontWeight: 600,
                    color: "text.secondary",
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                  }}
                >
                  {label}
                </Typography>
              </Box>
            ))}
          </Box>

          {/* Day grid */}
          <Box display="grid" gridTemplateColumns="repeat(7, 1fr)" gap={0.25}>
            {days.map((day, idx) => {
              const iso = toISODate(day.date);
              const serviceType =
                serviceMap && day.currentMonth
                  ? serviceMap.get(iso) || "no-service"
                  : "no-service";
              const isSelected =
                selectedParsed && isSameDay(day.date, selectedParsed);
              const isToday = isSameDay(day.date, today);

              return (
                <Box
                  key={idx}
                  sx={{
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    py: 0.15,
                  }}
                >
                  <Tooltip
                    title={
                      day.currentMonth && hasCalendarData
                        ? serviceType === "weekday"
                          ? "Weekday service"
                          : serviceType === "saturday"
                            ? "Saturday service"
                            : serviceType === "sunday"
                              ? "Sunday service"
                              : serviceType === "exception"
                                ? "Special service"
                                : "No service"
                        : ""
                    }
                    arrow
                    enterDelay={400}
                    placement="top"
                  >
                    <DayCell
                      serviceType={serviceType}
                      isSelected={isSelected}
                      isToday={isToday}
                      isCurrentMonth={day.currentMonth}
                      onClick={() => handleDayClick(day)}
                      tabIndex={day.currentMonth ? 0 : -1}
                    >
                      {day.date.getDate()}
                    </DayCell>
                  </Tooltip>
                </Box>
              );
            })}
          </Box>

          {/* Legend */}
          {hasCalendarData && (
            <Box
              display="flex"
              justifyContent="center"
              gap={1.5}
              mt={1.5}
              pt={1.5}
              sx={{
                borderTop:
                  mode === "dark"
                    ? "1px solid rgba(255,255,255,0.08)"
                    : "1px solid rgba(0,0,0,0.06)",
              }}
            >
              {legendItems.map((item) => (
                <Box
                  key={item.type}
                  display="flex"
                  alignItems="center"
                  gap={0.4}
                >
                  <CircleIcon
                    sx={{
                      fontSize: 8,
                      color: theme.palette.calendarSchemes[item.type].dot,
                    }}
                  />
                  <Typography
                    variant="caption"
                    sx={{
                      fontSize: 10,
                      color: "text.secondary",
                      lineHeight: 1,
                    }}
                  >
                    {item.label}
                  </Typography>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      </Popover>
    </Box>
  );
}

export default CalendarPicker;
