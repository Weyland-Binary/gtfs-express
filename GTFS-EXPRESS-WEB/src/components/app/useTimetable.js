/**
 * The timetable of the line chosen in the reader: its calendar, a default date, the directions on that date, its
 * trips and shapes, and their silent re-read after an edit. A change of line or date loads the grid and the map once.
 * A day the line does not run is told by the timetable's state (`idle`, read by isIdleDay), never by an empty grid.
 */
import { useEffect, useRef, useState } from "react";
import { fetchWithSession } from "../../utils/sessionManager";
import { latestRequest } from "../../utils/latestRequest";
import { classifyFetchError } from "../../utils/scheduleErrors";
import { humanError } from "../../utils/humanError";
import { getActiveServiceIds } from "../../utils/calendarUtils";
import { isRealDay } from "../../utils/readerSelection";

const MAX_DAYS_SCANNED = 400;
const localIsoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const dayOf = (iso) => new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

/**
 * The line's day of service nearest to `iso`, after it (`step` 1) or before it (-1), read day by day inside its
 * calendars (the days and exceptions, not the ranges alone); null without one.
 */
export const servedDayNear = (iso, step, calendar, calendarDates) => {
  // The span the days are read in: the weekly services that run some day, and the dates added one by one.
  const weekly = calendar.filter((c) => WEEKDAYS.some((d) => String(c[d]) === "1"));
  const bounds = [...weekly.flatMap((c) => [String(c.start_date || ""), String(c.end_date || "")]), ...calendarDates.filter((cd) => String(cd.exception_type) === "1").map((cd) => String(cd.date || ""))].filter((d) => /^\d{8}$/.test(d)).sort();
  if (!bounds.length || !isRealDay(iso)) return null;
  const isoOf = (ymd) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  const first = isoOf(bounds[0]);
  const last = isoOf(bounds[bounds.length - 1]);
  const day = dayOf(iso);
  day.setDate(day.getDate() + step);
  let at = localIsoDate(day);
  if (step > 0 && at < first) at = first;
  if (step < 0 && at > last) at = last;
  const cursor = dayOf(at);
  for (let i = 0; i < MAX_DAYS_SCANNED && at >= first && at <= last; i++) {
    if (getActiveServiceIds(at, calendar, calendarDates).length > 0) return at;
    cursor.setDate(cursor.getDate() + step);
    at = localIsoDate(cursor);
  }
  return null;
};

/** The day a line opens on: today when it runs, else its next day of service, else its last. */
export const defaultServiceDay = (calendar, calendarDates, todayIso) =>
  getActiveServiceIds(todayIso, calendar, calendarDates).length > 0 ? todayIso : servedDayNear(todayIso, 1, calendar, calendarDates) || servedDayNear(todayIso, -1, calendar, calendarDates);

const emptyTimetable = (over = {}) => ({ stops: [], stop_times: [], has_frequencies: false, has_normal_times: true, frequency_info: [], ...over });

/** Whether the timetable held says that `route` does not run on `date`. */
export const isIdleDay = (timetable, route, date) => Boolean(route && date) && timetable?.idle === `${route}|${date}`;

// Why the timetable could not be read, in the interface's language: a rate limit says how long to wait.
const failureText = (error, t) => (classifyFetchError(error) === "rate-limit" ? humanError(error, t).message : t("app.errorSchedule"));

export default function useTimetable({ baseUrl, t, dataVersion, lensKey, selectedRoute, selectedDate, setSelectedDate, selectedDirection, setSelectedDirection, selectedDirectionRef, directionsLoadedKeyRef, setDirections, scheduleRefetchToken, setScheduleRefetchToken, setStopsAndTimes, setShapes, setAllRouteShapes, calendar, setCalendar, calendarDates, setCalendarDates, setLoading, setError }) {
  // The line whose calendars are held: those of the line left stay for an instant after another is chosen.
  const [calendarRoute, setCalendarRoute] = useState(null);
  useEffect(() => {
    if (!selectedRoute) {
      setCalendar([]);
      setCalendarDates([]);
      setCalendarRoute(null);
      return;
    }
    const controller = new AbortController();
    const fetchCalendarData = async () => {
      try {
        const [calRes, cdRes] = await Promise.all([
          fetchWithSession(
            `${baseUrl}/calendar/${encodeURIComponent(selectedRoute)}`,
            { signal: controller.signal, cache: "no-store" },
          ),
          fetchWithSession(
            `${baseUrl}/calendar_dates/${encodeURIComponent(selectedRoute)}`,
            { signal: controller.signal, cache: "no-store" },
          ),
        ]);
        if (calRes.ok) {
          setCalendar(await calRes.json());
        }
        if (cdRes.ok) {
          setCalendarDates(await cdRes.json());
        }
        if (calRes.ok && cdRes.ok) setCalendarRoute(selectedRoute);
      } catch (err) {
        if (err.name !== "AbortError") {
          console.error("Error fetching calendar data:", err);
        }
      }
    };
    fetchCalendarData();
    return () => controller.abort();
  }, [selectedRoute, baseUrl, dataVersion, lensKey, setCalendar, setCalendarDates]);

  // Every direction's shapes, so the map can fly to any shape clicked in RouteDetail.
  useEffect(() => {
    if (!selectedRoute) {
      setAllRouteShapes({});
      return;
    }
    const controller = new AbortController();
    fetchWithSession(
      `${baseUrl}/shapes_for_route/${encodeURIComponent(selectedRoute)}`,
      { signal: controller.signal },
    )
      .then((r) => (r.ok ? r.json() : []))
      .then((items) => {
        const byId = {};
        for (const item of items) {
          byId[item.shape_id] = item.points;
        }
        setAllRouteShapes(byId);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          console.warn("Failed to fetch all route shapes:", err);
        }
      });
    return () => controller.abort();
  }, [selectedRoute, baseUrl, dataVersion, lensKey, setAllRouteShapes]);

  // A date that names no day, whatever asked for it, is dropped: the default day takes its place.
  useEffect(() => {
    if (selectedDate && !isRealDay(selectedDate)) setSelectedDate("");
  }, [selectedDate, setSelectedDate]);

  // Default date, never once a date is picked. Without a line the calendars held are the line's left: no default.
  useEffect(() => {
    if (selectedDate || !selectedRoute) return;
    if (calendar.length === 0 && calendarDates.length === 0) return;
    const day = defaultServiceDay(calendar, calendarDates, localIsoDate(new Date()));
    if (day) setSelectedDate(day);
  }, [calendar, calendarDates, selectedDate, selectedRoute, setSelectedDate]);

  const handleDirectionChange = (e) => {
    setSelectedDirection(e.target.value);
    selectedDirectionRef.current = e.target.value;
    setError("");
  };

  const handleDateChange = (e) => {
    setSelectedDate(e.target.value);
    setError("");
  };

  const formatDateForAPI = (date) => {
    return date.replace(/-/g, "");
  };

  // Read through a ref by the effects that tell a failure: a change of language alone never reads a timetable again.
  const tRef = useRef(t);
  tRef.current = t;
  // Only the newest request applies its answer: a slow answer for line A never overwrites line B's grid.
  const stopsRequestsRef = useRef(latestRequest());

  // With no timetable on screen (an idle day, a failure) nothing re-reads it after an edit, and « this line does not
  // run » may have become false: a change of the data reads the directions again.
  const [directionsReread, setDirectionsReread] = useState(0);
  const versionReadRef = useRef(dataVersion);
  useEffect(() => {
    if (dataVersion === versionReadRef.current) return;
    versionReadRef.current = dataVersion;
    if (!selectedDirectionRef.current) setDirectionsReread((n) => n + 1);
  }, [dataVersion, selectedDirectionRef]);

  useEffect(() => {
    if (!selectedRoute || !isRealDay(selectedDate)) return;
    // The direction is never blanked while the new directions load: the render gate would unmount the grid and
    // the map (Leaflet re-init). Stale fetches are blocked by directionsLoadedKeyRef instead.
    const previousDirection = selectedDirectionRef.current;
    const controller = new AbortController();
    const fetchDirections = async () => {
      try {
        const formattedDate = formatDateForAPI(selectedDate);
        const response = await fetchWithSession(
          `${baseUrl}/directions/${encodeURIComponent(selectedRoute)}/${formattedDate}`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          const failure = new Error(await response.text().catch(() => ""));
          failure.status = response.status;
          throw failure;
        }
        const data = await response.json();
        if (controller.signal.aborted) return;
        setDirections(data);
        // The key is set before setSelectedDirection so the commit it triggers already sees it (the one real
        // fetch), while the stale fetch of the same commit was blocked by the old key.
        directionsLoadedKeyRef.current = `${selectedRoute}|${selectedDate}`;
        // Refetches the trips even when the resolved direction is unchanged (a date change keeping direction 0).
        setScheduleRefetchToken((n) => n + 1);
        const dirValues = data.map((d) =>
          d.direction_id !== null ? String(d.direction_id) : "null",
        );
        if (previousDirection && dirValues.includes(previousDirection)) {
          setSelectedDirection(previousDirection);
          selectedDirectionRef.current = previousDirection;
        } else if (data.length >= 1) {
          const preferred = dirValues.includes("0") ? "0" : dirValues[0];
          setSelectedDirection(preferred);
          selectedDirectionRef.current = preferred;
        } else {
          // The line does not run that day: the state says so, and holds no timetable of the line or day left.
          stopsRequestsRef.current.take();
          setSelectedDirection("");
          selectedDirectionRef.current = "";
          setStopsAndTimes(emptyTimetable({ idle: `${selectedRoute}|${selectedDate}` }));
          setShapes({});
          setLoading(false);
          setError("");
        }
      } catch (err) {
        if (err.name === "AbortError" || controller.signal.aborted) return;
        console.error("Error fetching directions:", err);
        // No timetable is held under a line whose directions could not be read: the line left would stay on screen
        // under this one's name, and its late answer is dropped with the ticket taken here.
        stopsRequestsRef.current.take();
        directionsLoadedKeyRef.current = "";
        setDirections([]);
        setSelectedDirection("");
        selectedDirectionRef.current = "";
        setStopsAndTimes(emptyTimetable());
        setShapes({});
        setLoading(false);
        setError(failureText(err, tRef.current));
      }
    };
    fetchDirections();
    return () => controller.abort();
    // lensKey: the draft or the working copy, read again on a switch.
  }, [selectedRoute, selectedDate, baseUrl, lensKey, directionsReread, directionsLoadedKeyRef, selectedDirectionRef, setDirections, setScheduleRefetchToken, setSelectedDirection, setStopsAndTimes, setShapes, setLoading, setError]);

  const fetchStopsAndTimes = async () => {
    // Waits for the directions of this exact route|date: blocks the stale fetch (old direction, new route or date)
    // of the same commit, which would load everything twice.
    const directionsReady =
      directionsLoadedKeyRef.current === `${selectedRoute}|${selectedDate}`;
    if (
      !selectedRoute ||
      !selectedDirection ||
      !selectedDate ||
      !directionsReady
    )
      return;
    const formattedDate = formatDateForAPI(selectedDate);
    const current = stopsRequestsRef.current.take();
    setLoading(true);
    setError("");
    try {
      const stopsTimesResponse = await fetchWithSession(
        `${baseUrl}/stops_and_times/${encodeURIComponent(selectedRoute)}/${encodeURIComponent(selectedDirection)}/${formattedDate}`,
      );
      if (!stopsTimesResponse.ok) {
        const errorText = await stopsTimesResponse.text();
        const requestError = new Error(errorText);
        requestError.status = stopsTimesResponse.status;
        throw requestError;
      }
      const stopsTimesData = await stopsTimesResponse.json();
      if (!current()) return;
      setStopsAndTimes(stopsTimesData);

      // A shapes failure must not discard the schedule just loaded, nor read as "no service".
      try {
        const shapesResponse = await fetchWithSession(
          `${baseUrl}/shapes/${encodeURIComponent(selectedRoute)}/${encodeURIComponent(selectedDirection)}`,
        );

        if (!shapesResponse.ok) {
          const errorText = await shapesResponse.text();
          throw new Error(errorText);
        }
        const shapesData = await shapesResponse.json();
        if (!current()) return;
        const shapesRaw = shapesData.reduce((acc, shape) => {
          if (!acc[shape.shape_id]) acc[shape.shape_id] = [];
          acc[shape.shape_id].push({
            lat: parseFloat(shape.shape_pt_lat),
            lon: parseFloat(shape.shape_pt_lon),
            seq: parseInt(shape.shape_pt_sequence, 10),
          });
          return acc;
        }, {});
        const shapesById = {};
        for (const [id, pts] of Object.entries(shapesRaw)) {
          shapesById[id] = pts
            .sort((a, b) => a.seq - b.seq)
            .map((p) => [p.lat, p.lon]);
        }
        setShapes(shapesById);
      } catch (shapesError) {
        if (!current()) return;
        console.error("Error fetching shapes:", shapesError);
        setShapes({});
      }
    } catch (error) {
      if (!current()) return;
      console.error("Error fetching route data:", error);
      setError(classifyFetchError(error) === "no-service" ? t("app.noService") : failureText(error, t));
      setStopsAndTimes(emptyTimetable());
      setShapes({});
    } finally {
      if (current()) setLoading(false);
    }
  };
  const fetchStopsAndTimesRef = useRef(fetchStopsAndTimes);
  fetchStopsAndTimesRef.current = fetchStopsAndTimes;

  // Called through its ref: the fetch fires on these four triggers only, never on the closure's identity.
  useEffect(() => {
    fetchStopsAndTimesRef.current();
  }, [selectedRoute, selectedDirection, selectedDate, scheduleRefetchToken]);

  // Read through refs so the silent refetch fires on an edit, undo or redo only, never on a route or date change.
  const silentRefetchRouteRef = useRef(selectedRoute);
  const silentRefetchDirectionRef = useRef(selectedDirection);
  const silentRefetchDateRef = useRef(selectedDate);
  const silentRefetchBaseUrlRef = useRef(baseUrl);
  useEffect(() => {
    silentRefetchRouteRef.current = selectedRoute;
    silentRefetchDirectionRef.current = selectedDirection;
    silentRefetchDateRef.current = selectedDate;
    silentRefetchBaseUrlRef.current = baseUrl;
  });
  // A silent refetch still in flight belongs to the line, direction and date it was asked for: another one cancels it.
  const silentRefetchControllerRef = useRef(null);
  useEffect(() => {
    silentRefetchControllerRef.current?.abort();
  }, [selectedRoute, selectedDirection, selectedDate]);

  // No spinner, so the grid keeps its scroll and local state; no-store so an undo is never served stale.
  useEffect(() => {
    if (dataVersion === 0) return;
    const route = silentRefetchRouteRef.current;
    const direction = silentRefetchDirectionRef.current;
    const date = silentRefetchDateRef.current;
    const url = silentRefetchBaseUrlRef.current;
    if (!route || !direction || !date) return;
    const formattedDate = formatDateForAPI(date);
    const controller = new AbortController();
    silentRefetchControllerRef.current = controller;
    // Ticketed with the loud fetch: an older answer, loud or silent, never lands on a newer grid. When this one
    // supersedes a loud fetch it also ends that fetch's spinner.
    const current = stopsRequestsRef.current.take();

    fetchWithSession(
      `${url}/stops_and_times/${encodeURIComponent(route)}/${encodeURIComponent(direction)}/${formattedDate}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then(async (r) => {
        if (!current()) return null;
        if (r.ok) return r.json();
        const failure = Object.assign(new Error(await r.text().catch(() => "")), { status: r.status });
        if (!current()) return null;
        // No service left on this date (e.g. exception_type=2): the grid empties, and says why.
        if (classifyFetchError(failure) === "no-service") {
          setError(tRef.current("app.noService"));
          setStopsAndTimes(emptyTimetable());
        } else {
          // Any other failure keeps the grid on screen and says it could not be read again.
          setError(tRef.current("app.errorSchedule"));
        }
        return null;
      })
      .then((data) => {
        if (data && current()) setStopsAndTimes(data);
      })
      .catch((err) => {
        if (err.name === "AbortError" || !current()) return;
        console.warn("Silent schedule refetch after edit failed:", err);
        setError(failureText(err, tRef.current));
      })
      .finally(() => {
        if (current()) setLoading(false);
      });

    fetchWithSession(
      `${url}/shapes/${encodeURIComponent(route)}/${encodeURIComponent(direction)}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then((r) => (r.ok ? r.json() : []))
      .then((shapesData) => {
        if (!current()) return;
        const shapesRaw = shapesData.reduce((acc, shape) => {
          if (!acc[shape.shape_id]) acc[shape.shape_id] = [];
          acc[shape.shape_id].push({
            lat: parseFloat(shape.shape_pt_lat),
            lon: parseFloat(shape.shape_pt_lon),
            seq: parseInt(shape.shape_pt_sequence, 10),
          });
          return acc;
        }, {});
        const updatedShapes = {};
        for (const [id, pts] of Object.entries(shapesRaw)) {
          updatedShapes[id] = pts
            .sort((a, b) => a.seq - b.seq)
            .map((p) => [p.lat, p.lon]);
        }
        setShapes(updatedShapes);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          console.warn("Silent shapes refetch after edit failed:", err);
        }
      });

    return () => controller.abort();
  }, [dataVersion, setLoading, setShapes, setStopsAndTimes, setError]);
  return { handleDirectionChange, handleDateChange, calendarRoute };
}
