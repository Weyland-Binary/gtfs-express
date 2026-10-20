/**
 * useReaderNavigation — the reader moved by events: a shape to edit or create (editShape / createShape from the
 * read panels) is rerouted into the shape studio with the line and shape armed (`studioTarget`); the assistant's
 * "show route 12" (gtfs:navigate) selects the line, its date and the view; a shape of another line focused in the
 * detail panel switches the reader to that line, its direction kept, and the map comes to the front.
 */
import { useEffect, useRef, useState } from "react";
import { fetchWithSession } from "../../utils/sessionManager";

export default function useReaderNavigation({ baseUrl, t, entity, editing, showToast, routes, setRoutes, selectedAgency, setSelectedAgency, selectedRoute, setSelectedRoute, setSelectedRouteDetails, setSelectedDirection, selectedDirectionRef, setDirections, setSelectedDate, setStopFilter, setError, setSelectedMainTab, setShowValidationReport, setSelectedSecondaryTab }) {
  // Shape edit request: { shapeId, token } or null.
  // Geometry editing lives in the dedicated Shape Studio tab. The read panels
  // (RouteDetail / ShapeDetail) still dispatch editShape / createShape, so we
  // reroute those events INTO Shape Studio with the line + shape (or create
  // intent) armed — instead of editing in the read-only Lines map.
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

  // View-level navigation requested by the chat assistant ("show route 12",
  // "open the shape studio"): {target: schedule|shape_studio|home, routeId?,
  // agencyId?}. Entity panels are opened by the chat itself.
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
    window.addEventListener("gtfs:navigate", handler);
    return () => window.removeEventListener("gtfs:navigate", handler);
    // Setters and refs are stable; baseUrl/showToast/t are constants of the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, showToast, t]);

  // Navigate to a different route when the detail panel targets a shape
  // from another route (e.g. clicking a shape chip in another route's RouteDetail).
  // entity.data carries { routeId, agencyId, directionId } set by the originating component.
  useEffect(() => {
    if (entity?.type !== "shape" || !entity.data?.routeId) return;
    const { routeId, agencyId, directionId } = entity.data;
    if (routeId === selectedRoute) return;

    const switchRoute = async () => {
      // Switch agency if needed (fetch its routes without resetting selection)
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
      // Preselect the direction that contains the target shape;
      // the directions fetch effect will preserve it if valid.
      const targetDir = directionId != null ? String(directionId) : "";
      setSelectedDirection(targetDir);
      selectedDirectionRef.current = targetDir;
      setDirections([]);
      setStopFilter("");
      setError("");
    };
    switchRoute();
  }, [entity, selectedRoute, selectedAgency, baseUrl, routes, selectedDirectionRef, setDirections, setError, setRoutes, setSelectedAgency, setSelectedDirection, setSelectedRoute, setSelectedRouteDetails, setStopFilter]);

  // Auto-switch to map tab when a shape is focused in the detail panel
  useEffect(() => {
    if (entity?.type === "shape") {
      setSelectedSecondaryTab(1);
    }
  }, [entity, setSelectedSecondaryTab]);
  return { studioTarget };
}
