/**
 * The reader's data: every list read again silently after an edit (`dataVersion`) or a change of lens (`lensKey`),
 * the grid staying on screen.
 */
import { useEffect, useRef, useState } from "react";
import { fetchWithSession } from "../../utils/sessionManager";
import { sortRoutesByPublisherOrder } from "../../utils/routeSort";
import { latestRequest } from "../../utils/latestRequest";
import useTimetable from "./useTimetable";
import useReaderNavigation from "./useReaderNavigation";

export default function useFeedLoading({ baseUrl, t, dataVersion, lensKey, entity, editing, showToast, networkIdRef, setSelectedMainTab, setShowValidationReport }) {
  const [loading, setLoading] = useState(false);
  const [agencies, setAgencies] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [selectedRoute, setSelectedRoute] = useState(null);
  const [selectedDirection, setSelectedDirection] = useState("");
  const selectedDirectionRef = useRef("");
  // The route|date whose directions are resolved. The stops effect waits for it to match the current selection, so
  // a route or date change never fires a stale-closure fetch that would load the grid and map twice.
  const directionsLoadedKeyRef = useRef("");
  const [directions, setDirections] = useState([]);
  // Bumped on every directions load so the stops effect refetches even when the direction is unchanged: blanking
  // selectedDirection instead would unmount the grid and map (Leaflet re-init).
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
  // No eager /stops/all fetch: InsertStopDialog pulls the 6-15 MB list on demand.
  const [selectedSecondaryTab, setSelectedSecondaryTab] = useState(0);
  const [selectedAgency, setSelectedAgency] = useState("");
  const [selectedRouteDetails, setSelectedRouteDetails] = useState(null);
  const [error, setError] = useState("");
  const [calendar, setCalendar] = useState([]);
  const [calendarDates, setCalendarDates] = useState([]);
  const [stopFilter, setStopFilter] = useState("");
  const [focusedStopId, setFocusedStopId] = useState(null);
  // The line the person chose, never the one picked by itself when a network opens: it is the change's line in focus.
  const chosenRouteRef = useRef(null); // { network: the handle it was chosen on, route: its route_id }
  // Auto-pick the first agency and route on a fresh load, in the GTFS order (route_sort_order, then route_short_name
  // numeric-aware, then route_id). Armed by armAutopick() at every reload, consumed once, so it never overrides the
  // person's choice.
  const autopickAgencyRef = useRef(false);
  const autopickRouteRef = useRef(false);
  const armAutopick = () => {
    autopickAgencyRef.current = true;
    autopickRouteRef.current = true;
  };

  // Only the list: the selection is kept. Also on a lens change (the same list from the draft or the working copy).
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

  const dataVersionRef = useRef(`${dataVersion}|${lensKey}`);
  useEffect(() => {
    if (`${dataVersion}|${lensKey}` === dataVersionRef.current) return;
    dataVersionRef.current = `${dataVersion}|${lensKey}`;
    if (!selectedAgency) return;
    const controller = new AbortController();
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

  // The loading closures below read `baseUrl` and `t` and are rebuilt every render; the effects that call them fire
  // on their own events only, so they reach the latest closure through these refs: a lens or language change alone
  // never refetches.
  const fetchAgenciesRef = useRef(null);
  // `keepView`: a hydration keeps the view the URL names. Resolves with the agencies read (null when the read
  // failed).
  const fetchAgencies = async ({ keepView = false } = {}) => {
    let loadedAgencies = null;
    setLoading(true);
    armAutopick();
    try {
      const response = await fetchWithSession(`${baseUrl}/agencies`);
      const data = await response.json().catch(() => null);
      // `agencies` must always be an array: an error envelope ({ error } on 4xx/5xx) goes to the error banner, since its
      // consumers map over it and would white-screen.
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

  // Only the newest agency's answer fills the list: a slow one for the agency left never wins.
  const routesRequestsRef = useRef(latestRequest());
  const fetchRoutes = async (agencyId) => {
    const current = routesRequestsRef.current.take();
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
      if (!current()) return;
      setRoutes(data);
      setSelectedRoute(null);
      setSelectedDirection("");
      selectedDirectionRef.current = "";
      setDirections([]);
      setSelectedDate("");
    } catch (error) {
      console.error("Error fetching routes:", error);
      if (!current()) return;
      if (error.isRateLimit) {
        setError(`⚠️ ${error.message}`);
      } else {
        setError(t("app.errorRoutes"));
      }
    } finally {
      if (current()) setLoading(false);
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
    chosenRouteRef.current = routeId ? { network: networkIdRef.current, route: String(routeId) } : null;
    // Never blank selectedDirection here: it gates the grid and map, which would unmount (Leaflet re-init) and load
    // twice. The keyRef guard blocks a stale fetch, and the directions effect re-selects the direction.
    setStopFilter("");
    const selectedRouteDetail = routes.find(
      (route) => route.route_id === routeId,
    );
    setSelectedRouteDetails(selectedRouteDetail);
    setError("");
  };

  // Undo or redo may revert a route's names.
  useEffect(() => {
    if (!selectedRoute || !routes.length) return;
    const detail = routes.find((r) => r.route_id === selectedRoute);
    if (detail) setSelectedRouteDetails(detail);
  }, [routes, selectedRoute]);

  // Several agencies: a numeric-aware sort on agency_id, so « 1, 2, 10 » never becomes « 1, 10, 2 ».
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

  // The same order as LineSelector's, so the first route is the same everywhere.
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
  }, [selectedAgency, routes, selectedRoute]);

  const { handleDirectionChange, handleDateChange } = useTimetable({ baseUrl, t, dataVersion, lensKey, selectedRoute, selectedDate, setSelectedDate, selectedDirection, setSelectedDirection, selectedDirectionRef, directionsLoadedKeyRef, setDirections, scheduleRefetchToken, setScheduleRefetchToken, setStopsAndTimes, setShapes, setAllRouteShapes, calendar, setCalendar, calendarDates, setCalendarDates, setLoading, setError });

  const { studioTarget } = useReaderNavigation({ baseUrl, t, entity, editing, showToast, routes, setRoutes, selectedAgency, setSelectedAgency, selectedRoute, setSelectedRoute, setSelectedRouteDetails, setSelectedDirection, selectedDirectionRef, setDirections, setSelectedDate, setStopFilter, setError, setSelectedMainTab, setShowValidationReport, setSelectedSecondaryTab });
  return { loading, agencies, setAgencies, routes, setRoutes, selectedRoute, setSelectedRoute, selectedDirection, directions, selectedDate, stopsAndTimes, shapes, allRouteShapes, selectedSecondaryTab, setSelectedSecondaryTab, selectedAgency, setSelectedAgency, selectedRouteDetails, setSelectedRouteDetails, error, setError, calendar, calendarDates, stopFilter, setStopFilter, focusedStopId, setFocusedStopId, chosenRouteRef, fetchAgencies, fetchAgenciesRef, handleAgencyChange, handleRouteChange, handleDirectionChange, handleDateChange, studioTarget };
}
