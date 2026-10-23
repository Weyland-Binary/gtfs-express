/**
 * The timetable of the line chosen in the reader: its calendar, a default date, the directions on that date, its
 * trips and shapes, and their silent re-read after an edit. A change of line or date loads the grid and the map once.
 */
import { useEffect, useRef } from "react";
import { fetchWithSession } from "../../utils/sessionManager";
import { latestRequest } from "../../utils/latestRequest";
import { classifyFetchError } from "../../utils/scheduleErrors";

export default function useTimetable({ baseUrl, t, dataVersion, lensKey, selectedRoute, selectedDate, setSelectedDate, selectedDirection, setSelectedDirection, selectedDirectionRef, directionsLoadedKeyRef, setDirections, scheduleRefetchToken, setScheduleRefetchToken, setStopsAndTimes, setShapes, setAllRouteShapes, calendar, setCalendar, calendarDates, setCalendarDates, setLoading, setError }) {
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

  // Default date: today when served, else the earliest service date; never once a date is picked.
  useEffect(() => {
    if (selectedDate) return;
    if (calendar.length === 0 && calendarDates.length === 0) return;

    const today = new Date();
    const todayStr =
      today.getFullYear().toString() +
      String(today.getMonth() + 1).padStart(2, "0") +
      String(today.getDate()).padStart(2, "0");

    const todayInRange = calendar.some(
      (c) => todayStr >= c.start_date && todayStr <= c.end_date,
    );
    const todayHasException = calendarDates.some(
      (cd) => String(cd.date) === todayStr && String(cd.exception_type) === "1",
    );
    if (todayInRange || todayHasException) {
      const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      setSelectedDate(todayIso);
      return;
    }

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

  useEffect(() => {
    if (!selectedRoute || !selectedDate) return;
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
          setDirections([]);
          return;
        }
        const data = await response.json();
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
    // lensKey: the draft or the working copy, read again on a switch.
  }, [selectedRoute, selectedDate, baseUrl, lensKey, directionsLoadedKeyRef, selectedDirectionRef, setDirections, setScheduleRefetchToken, setSelectedDirection]);

  // Only the newest request applies its answer: a slow answer for line A never overwrites line B's grid.
  const stopsRequestsRef = useRef(latestRequest());
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
    // Ticketed with the loud fetch: an older answer, loud or silent, never lands on a newer grid. When this one
    // supersedes a loud fetch it also ends that fetch's spinner.
    const current = stopsRequestsRef.current.take();

    fetchWithSession(
      `${url}/stops_and_times/${encodeURIComponent(route)}/${encodeURIComponent(direction)}/${formattedDate}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then((r) => {
        if (!current()) return null;
        if (r.ok) return r.json();
        // No service left on this date (e.g. exception_type=2).
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
        if (data && current()) setStopsAndTimes(data);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          console.warn("Silent schedule refetch after edit failed:", err);
        }
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
  }, [dataVersion, setLoading, setShapes, setStopsAndTimes]);
  return { handleDirectionChange, handleDateChange };
}
