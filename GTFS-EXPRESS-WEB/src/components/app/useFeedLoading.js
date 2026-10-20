/**
 * useFeedLoading — the reader's data and how it is read: the agencies of the network open here, the lines of the
 * agency chosen, the directions of a line on a date, the timetable and the shapes drawn with it, the calendar that
 * names the dates; the first agency and line picked by themselves when a network opens; every list read again
 * silently after an edit (`dataVersion`) or a change of the reader's lens (`lensKey`), the grid staying on screen;
 * and the reader's navigation asked by its own events (editShape / createShape into the shape studio, gtfs:navigate
 * from the assistant, a shape of another line from the detail panel). The loading closures are rebuilt every render
 * and reached through refs by the effects, which fire on their own events only.
 */
import { useEffect, useRef, useState } from "react";
import { fetchWithSession } from "../../utils/sessionManager";
import { sortRoutesByPublisherOrder } from "../../utils/routeSort";
import useTimetable from "./useTimetable";
import useReaderNavigation from "./useReaderNavigation";

export default function useFeedLoading({ baseUrl, t, dataVersion, lensKey, entity, editing, showToast, networkIdRef, setSelectedMainTab, setShowValidationReport }) {
  const [loading, setLoading] = useState(false);
  const [agencies, setAgencies] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [selectedRoute, setSelectedRoute] = useState(null);
  const [selectedDirection, setSelectedDirection] = useState("");
  const selectedDirectionRef = useRef("");
  // Marks the route|date combination whose directions have been resolved and
  // are now authoritative. The stops effect refuses to fetch until this key
  // matches the current selectedRoute|selectedDate, which suppresses the
  // stale-closure fetch that would fire in the same commit as a route/date
  // change (before the directions effect's setSelectedDirection settles) and
  // load the schedule grid / map twice on every filter change.
  const directionsLoadedKeyRef = useRef("");
  const [directions, setDirections] = useState([]);
  // Bumped each time directions are (re)loaded for a new route|date so the
  // stops effect refetches even when the resolved direction value is unchanged
  // — blanking selectedDirection to force a re-fire would unmount the grid+map
  // block (Leaflet re-init) and load it twice.
  const [scheduleRefetchToken, setScheduleRefetchToken] = useState(0);
  const [selectedDate, setSelectedDate] = useState("");
  const [stopsAndTimes, setStopsAndTimes] = useState({
    stops: [],
    stop_times: [],
    has_frequencies: false,
    has_normal_times: true,
    frequency_info: [],
  });
  const [shapes, setShapes] = useState({});
  const [allRouteShapes, setAllRouteShapes] = useState({});
  // (no eager /stops/all fetch: InsertStopDialog pulls the list on demand
  // when it opens, so the 6-15 MB JSON is not paid on every dataVersion bump.)
  const [selectedSecondaryTab, setSelectedSecondaryTab] = useState(0);
  const [selectedAgency, setSelectedAgency] = useState("");
  const [selectedRouteDetails, setSelectedRouteDetails] = useState(null);
  const [error, setError] = useState("");
  const [calendar, setCalendar] = useState([]);
  const [calendarDates, setCalendarDates] = useState([]);
  const [stopFilter, setStopFilter] = useState("");
  const [focusedStopId, setFocusedStopId] = useState(null);
  // The line the person chose in the reader (the timetables' line picker, a line's detail panel) — never the line the
  // explorer picks by itself when a network opens: carried into the change as the line in focus of its maps
  // (utils/changeStates), with « Modifier ce réseau », « Reprendre » or « Retour au changement » (the reader is the
  // change's context).
  const chosenRouteRef = useRef(null); // { network: the handle it was chosen on, route: its route_id }
  // ── Auto-pick first agency + first route on fresh data load ────────────
  // Honors the GTFS spec ordering: route_sort_order ASC NULLS LAST, then
  // route_short_name (numeric-aware) and route_id as deterministic fallbacks.
  // The downstream chain (calendar → date, directions → direction) fills the
  // rest. Armed by armAutopick() at every entry point that reloads data so
  // the user lands on a populated Schedule & Map view instead of empty
  // selectors. Once a pick is made, the ref is consumed and won't override
  // any subsequent user choice.
  const autopickAgencyRef = useRef(false);
  const autopickRouteRef = useRef(false);
  const armAutopick = () => {
    autopickAgencyRef.current = true;
    autopickRouteRef.current = true;
  };

  // Re-fetch agencies silently when dataVersion changes (e.g. after editing an agency name).
  // Only updates the list — does NOT reset selectedAgency or any downstream selection.
  // …and when the reader's lens changes (« Avant | Après »: the same list, read from the draft or the working copy).
  const dataVersionAgenciesRef = useRef(`${dataVersion}|${lensKey}`);
  useEffect(() => {
    if (`${dataVersion}|${lensKey}` === dataVersionAgenciesRef.current) return;
    dataVersionAgenciesRef.current = `${dataVersion}|${lensKey}`;
    if (!agencies.length) return; // not yet initially loaded
    const controller = new AbortController();
    fetchWithSession(`${baseUrl}/agencies`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (Array.isArray(data)) setAgencies(data);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          console.warn("Silent agencies refetch after edit failed:", err);
        }
      });
    return () => controller.abort();
    // The key kept in the ref makes a run on a change of `agencies.length` alone a no-op.
  }, [dataVersion, lensKey, baseUrl, agencies.length]);

  // Re-fetch routes silently when dataVersion changes (undo / edit mutation).
  // Skip initial mount (dataVersion === 0) and skip when no agency is selected.
  const dataVersionRef = useRef(`${dataVersion}|${lensKey}`);
  useEffect(() => {
    if (`${dataVersion}|${lensKey}` === dataVersionRef.current) return;
    dataVersionRef.current = `${dataVersion}|${lensKey}`;
    if (!selectedAgency) return;
    const controller = new AbortController();
    // Silent re-fetch: don't reset selection, just update the list
    fetchWithSession(
      `${baseUrl}/routes/${encodeURIComponent(selectedAgency)}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then((r) => r.ok && r.json())
      .then((data) => {
        if (data) setRoutes(data);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          console.warn("Silent route refetch after edit failed:", err);
        }
      });
    return () => controller.abort();
  }, [dataVersion, lensKey, selectedAgency, baseUrl]);

  // The full list of stops is never fetched here on a dataVersion change:
  // on large feeds (~30k stops + parent stations = 6-15 MB JSON) that would
  // cost bandwidth and parse time on every edit. Its one consumer,
  // InsertStopDialog, fetches it when it opens. allStops stays as state only
  // so ScheduleGrid still receives an array (it tolerates an empty one and
  // falls back to the route's stops).
  // The loading closures below (fetchAgencies, fetchRoutes, fetchStopsAndTimes) read `baseUrl` and `t` and are
  // rebuilt every render. The effects that call them fire on their own events only (the boot status, a new
  // agency list, a new line, direction or date), so they reach the latest closure through these refs: a lens
  // or language change alone never refetches. Each ref is assigned right after its closure's definition.
  const fetchAgenciesRef = useRef(null);
  // `keepView`: a hydration keeps the view the URL names instead of
  // returning to the overview.
  // Resolves with the agencies read (null when the read failed), for a caller that names the network after them.
  const fetchAgencies = async ({ keepView = false } = {}) => {
    let loadedAgencies = null;
    setLoading(true);
    armAutopick();
    try {
      const response = await fetchWithSession(`${baseUrl}/agencies`);
      const data = await response.json().catch(() => null);
      // CONTRACT: `agencies` state must ALWAYS be an array. Error envelopes
      // ({error: …} on 4xx/5xx — e.g. the session DB is missing because the
      // upload-time migration failed) must surface as the error banner, never
      // be stored as state: downstream consumers (.map in chatSessionContext,
      // selectors, FAB gate) assume an array and would white-screen.
      if (!response.ok || !Array.isArray(data)) {
        console.warn(
          `GET /agencies returned ${response.status} with a non-array body:`,
          data,
        );
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
      setAgencies(data);
      loadedAgencies = data;
      setRoutes([]);
      setSelectedAgency("");
      setSelectedRoute(null);
      setSelectedDirection("");
      selectedDirectionRef.current = "";
      setDirections([]);
      setSelectedDate("");
      setStopsAndTimes({
        stops: [],
        stop_times: [],
        has_frequencies: false,
        has_normal_times: true,
        frequency_info: [],
      });
      setShapes({});
      setCalendar([]);
      setCalendarDates([]);
      // Back to the overview of the network just loaded.
      if (!keepView) setSelectedMainTab(0, { replace: true });
      setError("");
    } catch (error) {
      console.error("Error fetching agencies:", error);
      if (error.isRateLimit) {
        setError(`⚠️ ${error.message}`);
      } else {
        setError(t("app.errorAgencies"));
      }
    } finally {
      setLoading(false);
    }
    return loadedAgencies;
  };
  fetchAgenciesRef.current = fetchAgencies;

  const fetchRoutes = async (agencyId) => {
    setLoading(true);
    try {
      const response = await fetchWithSession(
        `${baseUrl}/routes/${encodeURIComponent(agencyId)}`,
      );
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText);
      }
      const data = await response.json();
      setRoutes(data);
      setSelectedRoute(null);
      setSelectedDirection("");
      selectedDirectionRef.current = "";
      setDirections([]);
      setSelectedDate("");
    } catch (error) {
      console.error("Error fetching routes:", error);
      if (error.isRateLimit) {
        setError(`⚠️ ${error.message}`);
      } else {
        setError(t("app.errorRoutes"));
      }
    } finally {
      setLoading(false);
    }
  };
  const fetchRoutesRef = useRef(fetchRoutes);
  fetchRoutesRef.current = fetchRoutes;

  const handleAgencyChange = async (e) => {
    const agencyId = e.target.value;
    setSelectedAgency(agencyId);
    await fetchRoutes(agencyId);
  };

  const handleRouteChange = async (e) => {
    const routeId = e.target.value;
    setSelectedRoute(routeId);
    // Chosen by the person: the line a change started from here puts in focus.
    chosenRouteRef.current = routeId ? { network: networkIdRef.current, route: String(routeId) } : null;
    // Do NOT blank selectedDirection / directions here: the selectedDirection
    // render gate unmounts the entire grid+map block (re-initialising Leaflet)
    // whenever it is falsy, which would make the schedule/map appear to load
    // twice on a route change. The keyRef guard in fetchStopsAndTimes already
    // blocks any stale fetch, and the directions effect re-selects the correct
    // direction (and bumps scheduleRefetchToken) once R2's directions load.
    setStopFilter("");
    // The date is kept when the route changes
    const selectedRouteDetail = routes.find(
      (route) => route.route_id === routeId,
    );
    setSelectedRouteDetails(selectedRouteDetail);
    setError("");
  };

  // Keep selectedRouteDetails in sync with the routes list after silent
  // refetches (undo/redo may revert route_short_name or route_long_name).
  useEffect(() => {
    if (!selectedRoute || !routes.length) return;
    const detail = routes.find((r) => r.route_id === selectedRoute);
    if (detail) setSelectedRouteDetails(detail);
  }, [routes, selectedRoute]);

  // Auto-pick first agency once after fresh data load.
  // Most feeds have a single agency; when several are present, fall back to
  // a numeric-aware sort on agency_id so "1, 2, 10" doesn't become "1, 10, 2".
  useEffect(() => {
    if (!autopickAgencyRef.current) return;
    if (!agencies.length) return;
    if (selectedAgency) {
      autopickAgencyRef.current = false;
      return;
    }
    const sorted = [...agencies].sort((a, b) =>
      String(a.agency_id || "").localeCompare(
        String(b.agency_id || ""),
        undefined,
        {
          numeric: true,
          sensitivity: "base",
        },
      ),
    );
    const first = sorted[0];
    if (!first) return;
    autopickAgencyRef.current = false;
    setSelectedAgency(first.agency_id);
    fetchRoutesRef.current(first.agency_id);
  }, [agencies, selectedAgency]);

  // Auto-pick first route once after fresh data load. The shared
  // sortRoutesByPublisherOrder util drives both this auto-pick and the
  // LineSelector display, so the user sees the same "first route" everywhere.
  useEffect(() => {
    if (!autopickRouteRef.current) return;
    if (!selectedAgency) return;
    if (!routes.length) return;
    if (selectedRoute) {
      autopickRouteRef.current = false;
      return;
    }
    const first = sortRoutesByPublisherOrder(routes)[0];
    if (!first) return;
    autopickRouteRef.current = false;
    setSelectedRoute(first.route_id);
    setSelectedRouteDetails(first);
    // Date and direction will be auto-filled by the existing useEffects
    // downstream (calendar load → first available date, directions fetch →
    // direction 0 if present, else first available).
  }, [selectedAgency, routes, selectedRoute]);

  // The line's timetable (app/useTimetable): its calendar, directions, trips and shapes.
  const { handleDirectionChange, handleDateChange } = useTimetable({ baseUrl, t, dataVersion, lensKey, selectedRoute, selectedDate, setSelectedDate, selectedDirection, setSelectedDirection, selectedDirectionRef, directionsLoadedKeyRef, setDirections, scheduleRefetchToken, setScheduleRefetchToken, setStopsAndTimes, setShapes, setAllRouteShapes, calendar, setCalendar, calendarDates, setCalendarDates, setLoading, setError });

  // The reader moved by events (app/useReaderNavigation): the shape studio's target, the assistant's, the detail panel's.
  const { studioTarget } = useReaderNavigation({ baseUrl, t, entity, editing, showToast, routes, setRoutes, selectedAgency, setSelectedAgency, selectedRoute, setSelectedRoute, setSelectedRouteDetails, setSelectedDirection, selectedDirectionRef, setDirections, setSelectedDate, setStopFilter, setError, setSelectedMainTab, setShowValidationReport, setSelectedSecondaryTab });
  return { loading, agencies, setAgencies, routes, setRoutes, selectedRoute, setSelectedRoute, selectedDirection, directions, selectedDate, stopsAndTimes, shapes, allRouteShapes, selectedSecondaryTab, setSelectedSecondaryTab, selectedAgency, setSelectedAgency, selectedRouteDetails, setSelectedRouteDetails, error, setError, calendar, calendarDates, stopFilter, setStopFilter, focusedStopId, setFocusedStopId, chosenRouteRef, fetchAgencies, fetchAgenciesRef, handleAgencyChange, handleRouteChange, handleDirectionChange, handleDateChange, studioTarget };
}
