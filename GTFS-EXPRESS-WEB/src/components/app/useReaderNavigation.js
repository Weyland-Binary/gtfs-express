/**
 * The reader moved by events: editShape / createShape from the read panels open the shape studio with the line and
 * shape armed (`studioTarget`), the assistant's gtfs:navigate selects a line, its date and the view, and a shape of
 * another line focused in the detail panel switches the reader to that line, its direction kept.
 */
import { useEffect, useRef, useState } from "react";
import { fetchWithSession } from "../../utils/sessionManager";
import { NAVIGATE_EVENT } from "../../utils/appEvents";

export default function useReaderNavigation({ baseUrl, t, entity, editing, showToast, routes, setRoutes, selectedAgency, setSelectedAgency, selectedRoute, setSelectedRoute, setSelectedRouteDetails, setSelectedDirection, selectedDirectionRef, setDirections, setSelectedDate, setStopFilter, setError, setSelectedMainTab, setShowValidationReport, setSelectedSecondaryTab }) {
  const [studioTarget, setStudioTarget] = useState(null);
  const studioTargetTokenRef = useRef(0);
  const selectedAgencyRef = useRef(selectedAgency);
  selectedAgencyRef.current = selectedAgency;
  const selectedRouteRef = useRef(selectedRoute);
  selectedRouteRef.current = selectedRoute;

  useEffect(() => {
    const handleEditShape = (e) => {
      const shapeId = e.detail?.shapeId;
      if (!shapeId) return;
      setStudioTarget({
        agencyId: e.detail?.agencyId || selectedAgencyRef.current,
        routeId: e.detail?.routeId || selectedRouteRef.current,
        shapeId,
        autoEdit: true,
        token: ++studioTargetTokenRef.current,
      });
      setSelectedMainTab(3);
    };
    const handleCreateShape = (e) => {
      const {
        shapeId,
        initialPoints,
        linkTripIds,
        routeId,
        agencyId,
        fitStops,
        directionId,
      } = e.detail || {};
      if (!shapeId) return;
      setStudioTarget({
        agencyId: agencyId || selectedAgencyRef.current,
        routeId: routeId || selectedRouteRef.current,
        create: {
          shapeId,
          initialPoints: initialPoints || [],
          linkTripIds: linkTripIds || [],
          fitStops: fitStops || null,
          directionId: directionId ?? null,
        },
        token: ++studioTargetTokenRef.current,
      });
      setSelectedMainTab(3);
    };
    window.addEventListener("editShape", handleEditShape);
    window.addEventListener("createShape", handleCreateShape);
    return () => {
      window.removeEventListener("editShape", handleEditShape);
      window.removeEventListener("createShape", handleCreateShape);
    };
  }, [setSelectedMainTab]);

  // gtfs:navigate detail: { target: schedule | shape_studio | home, routeId?, agencyId?, date? }; the chat opens
  // entity panels itself.
  const routesRef = useRef(routes);
  routesRef.current = routes;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useEffect(() => {
    const selectRoute = async (routeId, agencyId) => {
      if (!routeId) return;
      if (agencyId && agencyId !== selectedAgencyRef.current) {
        setSelectedAgency(agencyId);
        try {
          const response = await fetchWithSession(
            `${baseUrl}/routes/${encodeURIComponent(agencyId)}`,
          );
          if (response.ok) {
            const data = await response.json();
            setRoutes(data);
            setSelectedRouteDetails(data.find((r) => r.route_id === routeId) || null);
          }
        } catch (err) {
          console.error("Error fetching routes for navigation:", err);
        }
      } else {
        setSelectedRouteDetails(
          routesRef.current.find((r) => r.route_id === routeId) || null,
        );
      }
      if (routeId !== selectedRouteRef.current) {
        setSelectedRoute(routeId);
        setSelectedDirection("");
        selectedDirectionRef.current = "";
        setDirections([]);
        setStopFilter("");
        setError("");
      }
    };
    const handler = async (e) => {
      const d = e.detail || {};
      if (d.target === "home") {
        setShowValidationReport(false);
        setSelectedMainTab(0);
        return;
      }
      if (d.target === "schedule") {
        setShowValidationReport(false);
        await selectRoute(d.routeId, d.agencyId);
        const day = String(d.date || "").replace(/-/g, "");
        if (/^\d{8}$/.test(day)) setSelectedDate(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`);
        setSelectedMainTab(1);
        return;
      }
      if (d.target === "shape_studio") {
        setShowValidationReport(false);
        if (!editingRef.current) {
          showToast(t("chat.nav.needsEditMode"), "warning");
          await selectRoute(d.routeId, d.agencyId);
          setSelectedMainTab(1);
          return;
        }
        setStudioTarget({
          agencyId: d.agencyId || selectedAgencyRef.current,
          routeId: d.routeId || selectedRouteRef.current,
          token: ++studioTargetTokenRef.current,
        });
        setSelectedMainTab(3);
      }
    };
    window.addEventListener(NAVIGATE_EVENT, handler);
    return () => window.removeEventListener(NAVIGATE_EVENT, handler);
    // Setters and refs are stable; baseUrl/showToast/t are constants of the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, showToast, t]);

  // A shape of another line focused in the detail panel: entity.data carries { routeId, agencyId, directionId }.
  useEffect(() => {
    if (entity?.type !== "shape" || !entity.data?.routeId) return;
    const { routeId, agencyId, directionId } = entity.data;
    if (routeId === selectedRoute) return;

    const switchRoute = async () => {
      if (agencyId && agencyId !== selectedAgency) {
        setSelectedAgency(agencyId);
        try {
          const response = await fetchWithSession(
            `${baseUrl}/routes/${encodeURIComponent(agencyId)}`,
          );
          if (response.ok) {
            const data = await response.json();
            setRoutes(data);
            setSelectedRouteDetails(
              data.find((r) => r.route_id === routeId) || null,
            );
          }
        } catch (err) {
          console.error("Error fetching routes for agency switch:", err);
        }
      } else {
        setSelectedRouteDetails(
          routes.find((r) => r.route_id === routeId) || null,
        );
      }

      setSelectedRoute(routeId);
      // The directions effect keeps this direction when it is valid on the new line.
      const targetDir = directionId != null ? String(directionId) : "";
      setSelectedDirection(targetDir);
      selectedDirectionRef.current = targetDir;
      setDirections([]);
      setStopFilter("");
      setError("");
    };
    switchRoute();
  }, [entity, selectedRoute, selectedAgency, baseUrl, routes, selectedDirectionRef, setDirections, setError, setRoutes, setSelectedAgency, setSelectedDirection, setSelectedRoute, setSelectedRouteDetails, setStopFilter]);

  useEffect(() => {
    if (entity?.type === "shape") {
      setSelectedSecondaryTab(1);
    }
  }, [entity, setSelectedSecondaryTab]);
  return { studioTarget };
}
