/**
 * useTimetable — the timetable of the line chosen in the reader: its calendar (the dates the picker offers, a date
 * picked by itself: today when served, else the first), the directions on that date (the previous one kept when it
 * still exists, else the publisher's first), its trips and shapes, and the silent re-read of both after an edit. The
 * directions' key gates the trips' read so a change of line or date loads the grid and the map once, never twice,
 * and the direction is never blanked (that would unmount them). Of overlapping reads, only the newest applies.
 */
import { useEffect, useRef } from "react";
import { fetchWithSession } from "../../utils/sessionManager";
import { latestRequest } from "../../utils/latestRequest";
import { classifyFetchError } from "../../utils/scheduleErrors";

export default function useTimetable({ baseUrl, t, dataVersion, lensKey, selectedRoute, selectedDate, setSelectedDate, selectedDirection, setSelectedDirection, selectedDirectionRef, directionsLoadedKeyRef, setDirections, scheduleRefetchToken, setScheduleRefetchToken, setStopsAndTimes, setShapes, setAllRouteShapes, calendar, setCalendar, calendarDates, setCalendarDates, setLoading, setError }) {
  // Fetch calendar data when route changes (needed for CalendarPicker)
  useEffect(() => {
    if (!selectedRoute) {
      setCalendar([]);
      setCalendarDates([]);
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
      } catch (err) {
        if (err.name !== "AbortError") {
          console.error("Error fetching calendar data:", err);
        }
      }
    };
    fetchCalendarData();
    return () => controller.abort();
  }, [selectedRoute, baseUrl, dataVersion, lensKey, setCalendar, setCalendarDates]);

  // Fetch ALL shapes for the route (across all directions) so the map can
  // display and fly-to any shape the user clicks in RouteDetail.
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
          byId[item.shape_id] = item.points; // already [[lat, lon], ...]
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

  // Auto-select a sensible default date so the schedule grid populates
  // automatically: today if it falls within a service period (most useful
  // case), otherwise the earliest start_date or calendar_dates exception
  // available. Bails out as soon as the user picks a date.
  useEffect(() => {
    if (selectedDate) return;
    if (calendar.length === 0 && calendarDates.length === 0) return;

    const today = new Date();
    const todayStr =
      today.getFullYear().toString() +
      String(today.getMonth() + 1).padStart(2, "0") +
      String(today.getDate()).padStart(2, "0");

    // Check if today falls within any calendar period
    const todayInRange = calendar.some(
      (c) => todayStr >= c.start_date && todayStr <= c.end_date,
    );
    // Also check calendar_dates for added service today
    const todayHasException = calendarDates.some(
      (cd) => String(cd.date) === todayStr && String(cd.exception_type) === "1",
    );
    if (todayInRange || todayHasException) {
      const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      setSelectedDate(todayIso);
      return;
    }

    // Find the earliest date across calendar entries and calendar_dates
    let earliest = null;
    for (const c of calendar) {
      if (c.start_date && (!earliest || c.start_date < earliest))
        earliest = c.start_date;
    }
    for (const cd of calendarDates) {
      const d = String(cd.date);
      if (d.length === 8 && String(cd.exception_type) === "1") {
        if (!earliest || d < earliest) earliest = d;
      }
    }
    if (earliest && earliest.length === 8) {
      const iso = `${earliest.substring(0, 4)}-${earliest.substring(4, 6)}-${earliest.substring(6, 8)}`;
      setSelectedDate(iso);
    }
  }, [calendar, calendarDates, selectedDate, setSelectedDate]);

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

  // Fetch directions when route + date are both selected
  useEffect(() => {
    if (!selectedRoute || !selectedDate) return;
    // Save the current direction to restore it when still valid for the new
    // route/date. We deliberately do NOT blank selectedDirection while the new
    // directions load: the render gate would unmount the grid+map block
    // (Leaflet re-init) and flash the "select" prompt on every filter change.
    // Stale fetches are blocked by the keyRef guard instead; the refetch is
    // re-triggered via scheduleRefetchToken once the new directions resolve.
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
          setDirections([]);
          return;
        }
        const data = await response.json();
        setDirections(data);
        // Directions for THIS route|date are now authoritative. Set the key
        // BEFORE setSelectedDirection(...) so the commit it triggers already
        // sees a matching key (the real, single fetch), while the same-commit
        // stale fetch was blocked because the key still held the old combo.
        directionsLoadedKeyRef.current = `${selectedRoute}|${selectedDate}`;
        // Force the stops effect to refetch for this route|date even when the
        // resolved direction value is unchanged (e.g. a date change that keeps
        // direction 0), without blanking the direction to force a re-fire.
        setScheduleRefetchToken((n) => n + 1);
        // Preserve current selection if still valid, otherwise auto-select
        const dirValues = data.map((d) =>
          d.direction_id !== null ? String(d.direction_id) : "null",
        );
        if (previousDirection && dirValues.includes(previousDirection)) {
          // Restore the previous direction — it is still valid
          setSelectedDirection(previousDirection);
          selectedDirectionRef.current = previousDirection;
        } else if (data.length >= 1) {
          // Prefer direction 0 (publisher's primary direction), else fall
          // back to the first available so the schedule grid always loads.
          const preferred = dirValues.includes("0") ? "0" : dirValues[0];
          setSelectedDirection(preferred);
          selectedDirectionRef.current = preferred;
        } else {
          setSelectedDirection("");
          selectedDirectionRef.current = "";
        }
      } catch (err) {
        if (err.name !== "AbortError") {
          console.error("Error fetching directions:", err);
          setDirections([]);
        }
      }
    };
    fetchDirections();
    return () => controller.abort();
    // The lens changed: the directions (then the trips) are read again, from the draft or the working copy.
  }, [selectedRoute, selectedDate, baseUrl, lensKey, directionsLoadedKeyRef, selectedDirectionRef, setDirections, setScheduleRefetchToken, setSelectedDirection]);

  // Of overlapping timetable requests, only the newest applies its answer (utils/latestRequest): a slow answer
  // for line A landing after line B's never overwrites B's grid and shapes.
  const stopsRequestsRef = useRef(latestRequest());
  const fetchStopsAndTimes = async () => {
    // Gate: only fetch once the directions effect has confirmed this exact
    // route|date is authoritative AND a direction is selected. This blocks the
    // stale-closure fetch (old direction, new route/date) that runs in the same
    // commit as a route/date change, before the directions effect resolves,
    // and would load everything twice on every filter change.
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

      // Shapes only decorate the map: a shapes failure must not discard the
      // schedule that just loaded, nor be reported as "no service".
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
      const errorKind = classifyFetchError(error);
      if (errorKind === "rate-limit") {
        setError(`⚠️ ${error.message}`);
      } else if (errorKind === "no-service") {
        setError(t("app.noService"));
      } else {
        setError(t("app.errorSchedule"));
      }
      setStopsAndTimes({
        stops: [],
        stop_times: [],
        has_frequencies: false,
        has_normal_times: true,
        frequency_info: [],
      });
      setShapes({});
    } finally {
      // A newer request owns the spinner.
      if (current()) setLoading(false);
    }
  };
  const fetchStopsAndTimesRef = useRef(fetchStopsAndTimes);
  fetchStopsAndTimesRef.current = fetchStopsAndTimes;

  // Refetch on route/direction/date change → show spinner (normal UX).
  // scheduleRefetchToken re-fires this after directions (re)load even when the
  // direction value didn't change, so the direction is never blanked (that
  // would unmount the grid+map block and reload it visibly twice).
  // The closure of this render is called through its ref: the fetch fires on these four triggers only, never
  // on the closure's identity.
  useEffect(() => {
    fetchStopsAndTimesRef.current();
  }, [selectedRoute, selectedDirection, selectedDate, scheduleRefetchToken]);

  // Refs so the silent-refetch effect can read the latest values without
  // listing them as deps (which would cause it to fire on route/date changes
  // instead of only on mutation/undo/redo).
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

  // Silent refetch after edit mutations (dataVersion bump) — no spinner,
  // the grid stays visible so the user can keep editing without losing
  // scroll position or local state.
  // deps: [dataVersion] only — fires exclusively on mutation/undo/redo.
  // cache: 'no-store' — bypasses browser HTTP cache so reverted DB values
  // are never served stale after an undo.
  useEffect(() => {
    if (dataVersion === 0) return; // skip initial mount
    const route = silentRefetchRouteRef.current;
    const direction = silentRefetchDirectionRef.current;
    const date = silentRefetchDateRef.current;
    const url = silentRefetchBaseUrlRef.current;
    if (!route || !direction || !date) return;
    const formattedDate = formatDateForAPI(date);
    const controller = new AbortController();

    // Silent refetch of stops_and_times
    fetchWithSession(
      `${url}/stops_and_times/${encodeURIComponent(route)}/${encodeURIComponent(direction)}/${formattedDate}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then((r) => {
        if (r.ok) return r.json();
        // Service removed for this date (e.g. exception_type=2) → clear grid
        setStopsAndTimes({
          stops: [],
          stop_times: [],
          has_frequencies: false,
          has_normal_times: true,
          frequency_info: [],
        });
        return null;
      })
      .then((data) => {
        if (data) setStopsAndTimes(data);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          console.warn("Silent schedule refetch after edit failed:", err);
        }
      });

    // Silent refetch of shapes (so map polylines reflect edits)
    fetchWithSession(
      `${url}/shapes/${encodeURIComponent(route)}/${encodeURIComponent(direction)}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then((r) => (r.ok ? r.json() : []))
      .then((shapesData) => {
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
  }, [dataVersion, setShapes, setStopsAndTimes]);
  return { handleDirectionChange, handleDateChange };
}
