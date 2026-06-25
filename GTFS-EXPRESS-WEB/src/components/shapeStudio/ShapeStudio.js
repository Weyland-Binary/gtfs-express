import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Box,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
} from "@mui/material";
import EditLocationAltIcon from "@mui/icons-material/EditLocationAlt";
import LineMap from "../LineMap";
import StudioLineRail from "./StudioLineRail";
import StudioStatusStrip from "./StudioStatusStrip";
import ShapeForkDialog from "../edit/ShapeForkDialog";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { sortRoutesByPublisherOrder } from "../../utils/routeSort";
import {
  computeShapeLabels,
  formatShapeLabel,
  shapeDistanceM,
} from "../../utils/shapeLabel";
import {
  routeThroughStops,
  straightThroughStops,
} from "../../utils/osrmRouting";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";

// Shape Studio — the dedicated, edit-mode-only tab for editing/creating route
// shapes and stops. Embeds LineMap verbatim (chrome="studio") and drives the
// existing ShapeEditorOverlay through the editShapeRequest prop. No backend
// changes: reuses /route_detail, /shapes_for_route and /edit/shapes[...].
export default function ShapeStudio({ agencies = [], target = null }) {
  const baseUrl = API_BASE_URL;
  const { t } = useLanguage();
  const { recordEdit, showToast, dataVersion } = useEditMode();

  const [selectedAgencyId, setSelectedAgencyId] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [selectedRouteId, setSelectedRouteId] = useState(null);
  const [routeDetail, setRouteDetail] = useState(null);
  const [routeShapes, setRouteShapes] = useState([]);
  const [loadingRoute, setLoadingRoute] = useState(false);

  const [search, setSearch] = useState("");
  const [railMode, setRailMode] = useState("shapes");
  const [selectedShapeId, setSelectedShapeId] = useState(null);
  const [focusedStopId, setFocusedStopId] = useState(null);
  const [placeStopSignal, setPlaceStopSignal] = useState(0);
  // Two-way hover sync between the rail cards and the map polylines.
  const [hoveredShapeId, setHoveredShapeId] = useState(null);
  const [hoverSource, setHoverSource] = useState(null); // "map" | "rail" | null

  // Local edit-request state drives the embedded ShapeEditorOverlay.
  const [editShapeRequest, setEditShapeRequest] = useState(null);
  const tokenRef = useRef(0);
  const [editingActive, setEditingActive] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  // A deferred navigation action, held while we ask the user to confirm
  // discarding unsaved shape edits before leaving the current tracé.
  const [pendingNav, setPendingNav] = useState(null);

  const [forkShape, setForkShape] = useState(null);
  const [deleteId, setDeleteId] = useState(null);

  // ── Default agency ──
  useEffect(() => {
    if (!selectedAgencyId && agencies.length) {
      setSelectedAgencyId(agencies[0].agency_id);
    }
  }, [agencies, selectedAgencyId]);

  // ── Routes for the selected agency ──
  useEffect(() => {
    if (!selectedAgencyId) {
      setRoutes([]);
      return undefined;
    }
    let cancelled = false;
    fetchWithSession(`${baseUrl}/routes/${encodeURIComponent(selectedAgencyId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !Array.isArray(data)) return;
        setRoutes(sortRoutesByPublisherOrder(data));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedAgencyId, baseUrl, dataVersion]);

  // ── Route detail (stops + directions) + shapes for the selected line ──
  useEffect(() => {
    if (!selectedRouteId) {
      setRouteDetail(null);
      setRouteShapes([]);
      return undefined;
    }
    let cancelled = false;
    setLoadingRoute(true);
    Promise.all([
      fetchWithSession(
        `${baseUrl}/route_detail/${encodeURIComponent(selectedRouteId)}`,
      ).then((r) => r.json()),
      fetchWithSession(
        `${baseUrl}/shapes_for_route/${encodeURIComponent(selectedRouteId)}`,
      ).then((r) => r.json()),
    ])
      .then(([detail, shapes]) => {
        if (cancelled) return;
        setRouteDetail(detail && !detail.error ? detail : null);
        setRouteShapes(Array.isArray(shapes) ? shapes : []);
      })
      .catch(() => {
        /* network error — the empty/loading state remains */
      })
      .finally(() => {
        if (!cancelled) setLoadingRoute(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRouteId, baseUrl, dataVersion, showToast, t]);

  // ── Shape editor lifecycle ──
  useEffect(() => {
    const onActive = () => setEditingActive(true);
    const onDirty = (e) => setEditorDirty(!!e.detail?.dirty);
    const onClosed = () => {
      setEditingActive(false);
      setEditorDirty(false);
      setEditShapeRequest(null);
    };
    window.addEventListener("shapeEditorActive", onActive);
    window.addEventListener("shapeEditorDirtyChanged", onDirty);
    window.addEventListener("shapeEditorClosed", onClosed);
    return () => {
      window.removeEventListener("shapeEditorActive", onActive);
      window.removeEventListener("shapeEditorDirtyChanged", onDirty);
      window.removeEventListener("shapeEditorClosed", onClosed);
    };
  }, []);

  // ── Deep-link target (from RouteDetail / ShapeDetail, via GTFSApp) ──
  // Selects the agency + line synchronously; the shape selection / create
  // editor is deferred to pendingTargetRef until the route's data has loaded.
  const pendingTargetRef = useRef(null);
  const appliedTargetTokenRef = useRef(null);

  useEffect(() => {
    if (!target || target.token === appliedTargetTokenRef.current) return;
    appliedTargetTokenRef.current = target.token;
    if (target.agencyId) setSelectedAgencyId(target.agencyId);
    if (target.routeId) {
      setSelectedRouteId(target.routeId);
      setRailMode("shapes");
      setSelectedShapeId(null);
    }
    pendingTargetRef.current = {
      routeId: target.routeId || null,
      shapeId: target.shapeId || null,
      autoEdit: !!target.autoEdit,
      create: target.create || null,
    };
  }, [target]);

  // Apply the pending target once the targeted route's shapes have loaded.
  useEffect(() => {
    const p = pendingTargetRef.current;
    if (!p || loadingRoute) return;
    if (p.routeId && p.routeId !== selectedRouteId) return; // route still settling
    if (p.create) {
      setSelectedShapeId(null);
      setEditShapeRequest({
        shapeId: p.create.shapeId,
        mode: "create",
        initialPoints: p.create.initialPoints || [],
        linkTripIds: p.create.linkTripIds || [],
        token: ++tokenRef.current,
      });
    } else if (p.shapeId) {
      setSelectedShapeId(p.shapeId);
      if (p.autoEdit) {
        setEditShapeRequest({ shapeId: p.shapeId, token: ++tokenRef.current });
      }
    }
    pendingTargetRef.current = null;
  }, [routeShapes, loadingRoute, selectedRouteId]);

  // ── Derived data ──
  const shapesById = useMemo(
    () => Object.fromEntries(routeShapes.map((s) => [s.shape_id, s.points])),
    [routeShapes],
  );
  const shapeLabels = useMemo(
    () => computeShapeLabels(routeShapes),
    [routeShapes],
  );
  const mapStops = routeDetail?.stops || [];

  const selectedShapeObj = useMemo(
    () => routeShapes.find((s) => s.shape_id === selectedShapeId) || null,
    [routeShapes, selectedShapeId],
  );

  const selectedSummary = useMemo(() => {
    if (!selectedShapeObj) return null;
    const desc = shapeLabels.get(selectedShapeObj.shape_id);
    const { primary } = formatShapeLabel(selectedShapeObj.shape_id, desc, t);
    return {
      shape_id: selectedShapeObj.shape_id,
      label: primary,
      pointCount: desc?.pointCount ?? selectedShapeObj.point_count,
      distanceM: desc?.distanceM ?? shapeDistanceM(selectedShapeObj.points),
      tripCount: selectedShapeObj.trip_count,
      isShared: desc?.isShared,
    };
  }, [selectedShapeObj, shapeLabels, t]);

  // ── Handlers ──
  // Guard navigation that would pull the context out from under an open editor.
  // No editing → run immediately. Editing but clean → close the editor silently
  // and run. Editing with unsaved changes → defer and ask the user to confirm.
  const guardNav = useCallback(
    (action) => {
      if (!editingActive) {
        action();
        return;
      }
      if (editorDirty) {
        setPendingNav(() => action);
        return;
      }
      window.dispatchEvent(new CustomEvent("cancelShapeEditor"));
      action();
    },
    [editingActive, editorDirty],
  );

  const confirmDiscardNav = useCallback(() => {
    window.dispatchEvent(new CustomEvent("cancelShapeEditor"));
    if (pendingNav) pendingNav();
    setPendingNav(null);
  }, [pendingNav]);

  const handleSelectRoute = useCallback(
    (routeId) => {
      guardNav(() => {
        setSelectedRouteId(routeId);
        setSelectedShapeId(null);
        setRailMode("shapes");
      });
    },
    [guardNav],
  );

  const handleSelectShape = useCallback(
    (shapeId) => {
      // Re-clicking the already-selected (e.g. currently-edited) tracé is a
      // no-op — never prompt to discard for selecting what's already active.
      if (shapeId === selectedShapeId) return;
      guardNav(() => setSelectedShapeId(shapeId));
    },
    [guardNav, selectedShapeId],
  );

  const handleHoverFromRail = useCallback((id) => {
    setHoveredShapeId(id);
    setHoverSource(id ? "rail" : null);
  }, []);

  const handleHoverFromMap = useCallback((id) => {
    setHoveredShapeId(id);
    setHoverSource(id ? "map" : null);
  }, []);

  const handleEdit = useCallback(() => {
    if (!selectedShapeId) return;
    setEditShapeRequest({
      shapeId: selectedShapeId,
      token: ++tokenRef.current,
    });
  }, [selectedShapeId]);

  const openCreate = useCallback((shapeId, initialPoints, linkTripIds) => {
    setSelectedShapeId(null);
    setEditShapeRequest({
      shapeId,
      mode: "create",
      initialPoints,
      linkTripIds,
      token: ++tokenRef.current,
    });
  }, []);

  const handleNewShape = useCallback(
    async ({ mode, direction }) => {
      const dirId =
        direction?.direction_id != null ? String(direction.direction_id) : "x";
      const newShapeId = `shp_${selectedRouteId}_${dirId}_${Date.now()}`;
      const linkTripIds = direction?.trip_ids || [];

      if (mode === "draw") {
        openCreate(newShapeId, [], []);
        return;
      }
      const orderedStops = direction?.stops_ordered || [];
      if (orderedStops.length < 2) {
        showToast(t("shapeStudio.create.noStops"), "warning");
        return;
      }
      if (mode === "straight") {
        openCreate(newShapeId, straightThroughStops(orderedStops), linkTripIds);
        return;
      }
      // mode === "auto" — route along roads (OSRM), straight-line fallback.
      try {
        const { points } = await routeThroughStops(orderedStops, {
          onProgress: (done, total) => {
            if (done === total || done % 5 === 0) {
              showToast(
                t("shapeStudio.create.autoGenProgress", { done, total }),
                "info",
              );
            }
          },
        });
        openCreate(newShapeId, points, linkTripIds);
      } catch {
        /* aborted — ignore */
      }
    },
    [selectedRouteId, openCreate, showToast, t],
  );

  const handleDuplicate = useCallback(() => {
    if (selectedShapeObj) setForkShape(selectedShapeObj);
  }, [selectedShapeObj]);

  const doDelete = useCallback(async () => {
    const id = deleteId;
    setDeleteId(null);
    if (!id) return;
    try {
      const res = await fetchWithSession(
        `${baseUrl}/edit/shapes/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(body.error || t("shapeStudio.delete.shapeHasTrips", { count: selectedSummary?.tripCount || 0 }), "error");
        return;
      }
      recordEdit(t("shapeStudio.toast.shapeDeleted", { id }), body.validation, {
        entity: "shape",
        entityId: id,
      });
      setSelectedShapeId(null);
    } catch (err) {
      showToast(err.message, "error");
    }
  }, [deleteId, baseUrl, recordEdit, showToast, t, selectedSummary]);

  const handleAddStop = useCallback(() => {
    setPlaceStopSignal((n) => n + 1);
  }, []);

  return (
    <Box
      data-testid="shape-studio"
      sx={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        mx: -2,
      }}
    >
      <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
        <StudioLineRail
          routes={routes}
          selectedRouteId={selectedRouteId}
          onSelectRoute={handleSelectRoute}
          search={search}
          onSearchChange={setSearch}
          agencies={agencies}
          selectedAgencyId={selectedAgencyId}
          onAgencyChange={(id) =>
            guardNav(() => {
              setSelectedAgencyId(id);
              setSelectedRouteId(null);
              setSelectedShapeId(null);
            })
          }
          routeShapes={routeShapes}
          shapeLabels={shapeLabels}
          selectedShapeId={selectedShapeId}
          onSelectShape={handleSelectShape}
          hoveredShapeId={hoveredShapeId}
          onHoverShape={handleHoverFromRail}
          hoverSource={hoverSource}
          routeDetail={routeDetail}
          railMode={railMode}
          onRailModeChange={(val) => guardNav(() => setRailMode(val))}
          onNewShape={handleNewShape}
          mapStops={mapStops}
          selectedStopId={focusedStopId}
          onSelectStop={setFocusedStopId}
          onAddStop={handleAddStop}
          loadingRoute={loadingRoute}
        />

        <Box sx={{ flex: 1, minWidth: 0, position: "relative" }}>
          {selectedRouteId ? (
            <>
              <LineMap
                chrome="studio"
                studioMode={railMode}
                shapesById={shapesById}
                stops={mapStops}
                editShapeRequest={editShapeRequest}
                selectedShapeId={selectedShapeId}
                onShapeClick={handleSelectShape}
                hoveredShapeId={hoveredShapeId}
                onShapeHover={handleHoverFromMap}
                focusedStopId={focusedStopId}
                placeStopSignal={placeStopSignal}
              />
              {railMode === "shapes" && (
                <StudioStatusStrip
                  selectedShape={selectedSummary}
                  editingActive={editingActive}
                  onEdit={handleEdit}
                  onDuplicate={handleDuplicate}
                  onDelete={() => setDeleteId(selectedShapeId)}
                />
              )}
            </>
          ) : (
            <Box
              sx={{
                height: "100%",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 2,
                color: "text.secondary",
                px: 4,
                textAlign: "center",
              }}
            >
              <EditLocationAltIcon sx={{ fontSize: 56, opacity: 0.35 }} />
              <Typography variant="h6" color="text.secondary">
                {t("shapeStudio.empty.pickLine")}
              </Typography>
            </Box>
          )}
        </Box>
      </Box>

      {/* Duplicate / fork the selected shape */}
      <ShapeForkDialog
        open={Boolean(forkShape)}
        shapeId={forkShape?.shape_id}
        trips={forkShape?.trips || []}
        onClose={() => setForkShape(null)}
        onForked={() => setForkShape(null)}
      />

      {/* Delete confirmation */}
      <Dialog open={Boolean(deleteId)} onClose={() => setDeleteId(null)}>
        <DialogTitle>{t("shapeStudio.action.delete")}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t("shapeStudio.delete.confirmShape", { id: deleteId })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteId(null)}>{t("app.cancel")}</Button>
          <Button color="error" variant="contained" onClick={doDelete}>
            {t("shapeStudio.action.delete")}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Unsaved-changes guard when navigating away from an open editor */}
      <Dialog open={Boolean(pendingNav)} onClose={() => setPendingNav(null)}>
        <DialogContent>
          <DialogContentText>
            {t("edit.shape.unsavedWarning")}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingNav(null)}>{t("app.cancel")}</Button>
          <Button
            color="warning"
            variant="contained"
            onClick={confirmDiscardNav}
          >
            {t("edit.shape.discardAndContinue")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
