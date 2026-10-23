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
import NewShapeDialog from "./NewShapeDialog";
import ShapeForkDialog from "../edit/ShapeForkDialog";
import LinkShapeToTripsDialog from "../edit/LinkShapeToTripsDialog";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { sortRoutesByPublisherOrder } from "../../utils/routeSort";
import {
  computeShapeLabels,
  formatShapeLabel,
  shapeDistanceM,
} from "../../utils/shapeLabel";
import { analyzeStopFit, OFF_TRACE_M } from "../../utils/shapeGeometry";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";

// The edit-mode tab for a line's shapes and stops: LineMap (chrome="studio") driving ShapeEditorOverlay
// through editShapeRequest.
export default function ShapeStudio({ agencies = [], target = null }) {
  const baseUrl = API_BASE_URL;
  const { t } = useLanguage();
  const { recordEdit, showToast, dataVersion } = useEditMode();

  const [selectedAgencyId, setSelectedAgencyId] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [coverage, setCoverage] = useState(null);
  const [filterMissing, setFilterMissing] = useState(false);
  const [selectedRouteId, setSelectedRouteId] = useState(null);
  const [routeDetail, setRouteDetail] = useState(null);
  const [routeShapes, setRouteShapes] = useState([]);
  const [loadingRoute, setLoadingRoute] = useState(false);
  // Shapes no trip references (feed-wide).
  const [unusedShapes, setUnusedShapes] = useState([]);
  const [unusedTruncated, setUnusedTruncated] = useState(false);
  const [selectedUnusedId, setSelectedUnusedId] = useState(null);

  const [search, setSearch] = useState("");
  const [railMode, setRailMode] = useState("shapes");
  const [selectedShapeId, setSelectedShapeId] = useState(null);
  const [focusedStopId, setFocusedStopId] = useState(null);
  const [placeStopSignal, setPlaceStopSignal] = useState(0);
  // Hover synced both ways between the rail cards and the map polylines.
  const [hoveredShapeId, setHoveredShapeId] = useState(null);
  const [hoverSource, setHoverSource] = useState(null); // "map" | "rail" | null

  const [editShapeRequest, setEditShapeRequest] = useState(null);
  const tokenRef = useRef(0);
  const [editingActive, setEditingActive] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  // A navigation held while the person confirms discarding unsaved shape edits.
  const [pendingNav, setPendingNav] = useState(null);

  const [newShapeOpen, setNewShapeOpen] = useState(false);
  const [forkShape, setForkShape] = useState(null); // { shape_id, trips, loading }
  const [linkShape, setLinkShape] = useState(null); // { shape_id, pointCount, distanceKm, directionId }
  const [deleteId, setDeleteId] = useState(null);
  const offTraceCursorRef = useRef(0);

  // ── Default agency
  useEffect(() => {
    if (!selectedAgencyId && agencies.length) {
      setSelectedAgencyId(agencies[0].agency_id);
    }
  }, [agencies, selectedAgencyId]);

  // ── Routes and shape coverage of the selected agency
  useEffect(() => {
    if (!selectedAgencyId) {
      setRoutes([]);
      setCoverage(null);
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
    fetchWithSession(`${baseUrl}/shape_coverage/${encodeURIComponent(selectedAgencyId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        setCoverage(data && data.routes ? data.routes : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedAgencyId, baseUrl, dataVersion]);

  // ── Unused shapes (feed-wide)
  useEffect(() => {
    let cancelled = false;
    fetchWithSession(`${baseUrl}/shapes_unused`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setUnusedShapes(Array.isArray(data.shapes) ? data.shapes : []);
        setUnusedTruncated(Boolean(data.truncated));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [baseUrl, dataVersion]);

  useEffect(() => {
    if (selectedUnusedId && !unusedShapes.some((u) => u.shape_id === selectedUnusedId)) {
      setSelectedUnusedId(null);
    }
  }, [unusedShapes, selectedUnusedId]);

  // ── The selected line's detail and shapes
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
        /* network error: the empty or loading state remains */
      })
      .finally(() => {
        if (!cancelled) setLoadingRoute(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRouteId, baseUrl, dataVersion]);

  // ── Shape editor lifecycle
  useEffect(() => {
    const onActive = () => setEditingActive(true);
    const onDirty = (e) => setEditorDirty(!!e.detail?.dirty);
    const onClosed = (e) => {
      setEditingActive(false);
      setEditorDirty(false);
      setEditShapeRequest(null);
      if (e?.detail?.saved && e.detail.shapeId) {
        setSelectedUnusedId(null);
        setSelectedShapeId(e.detail.shapeId);
      }
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

  // ── Deep-link target (RouteDetail, ShapeDetail): the agency and line are selected at once, the shape or the
  // create editor once the route's data has loaded (pendingTargetRef).
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
      setSelectedUnusedId(null);
    }
    pendingTargetRef.current = {
      routeId: target.routeId || null,
      shapeId: target.shapeId || null,
      autoEdit: !!target.autoEdit,
      create: target.create || null,
    };
  }, [target]);

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
        fitStops: p.create.fitStops || null,
        context: { routeId: p.routeId, directionId: p.create.directionId ?? null },
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

  // ── Derived data
  const shapesById = useMemo(
    () => Object.fromEntries(routeShapes.map((s) => [s.shape_id, s.points])),
    [routeShapes],
  );
  const shapeLabels = useMemo(
    () => computeShapeLabels(routeShapes),
    [routeShapes],
  );
  const mapStops = routeDetail?.stops || [];

  // Each shape's fit against the line's representative stop sequence.
  const fitByShape = useMemo(() => {
    const out = new Map();
    for (const s of routeShapes) {
      if (!Array.isArray(s.stops) || s.stops.length === 0) continue;
      const pts = (s.points || []).map(([lat, lon]) => ({ lat, lon }));
      out.set(s.shape_id, analyzeStopFit(pts, s.stops, { thresholdM: OFF_TRACE_M }));
    }
    return out;
  }, [routeShapes]);

  const selectedShapeObj = useMemo(
    () => routeShapes.find((s) => s.shape_id === selectedShapeId) || null,
    [routeShapes, selectedShapeId],
  );
  const selectedUnusedObj = useMemo(
    () => unusedShapes.find((u) => u.shape_id === selectedUnusedId) || null,
    [unusedShapes, selectedUnusedId],
  );

  const selectedSummary = useMemo(() => {
    if (selectedUnusedObj) {
      return {
        shape_id: selectedUnusedObj.shape_id,
        label: selectedUnusedObj.shape_id,
        pointCount: selectedUnusedObj.point_count,
        distanceM: shapeDistanceM(selectedUnusedObj.points),
        tripCount: 0,
        isShared: false,
        unused: true,
        fit: null,
        directionId: null,
      };
    }
    if (!selectedShapeObj) return null;
    const desc = shapeLabels.get(selectedShapeObj.shape_id);
    const { primary } = formatShapeLabel(selectedShapeObj.shape_id, desc, t);
    const directionId =
      desc?.direction === "inbound" ? "1" : desc?.direction === "outbound" ? "0" : null;
    return {
      shape_id: selectedShapeObj.shape_id,
      label: primary,
      pointCount: desc?.pointCount ?? selectedShapeObj.point_count,
      distanceM: desc?.distanceM ?? shapeDistanceM(selectedShapeObj.points),
      tripCount: selectedShapeObj.trip_count,
      isShared: desc?.isShared,
      unused: false,
      fit: fitByShape.get(selectedShapeObj.shape_id) || null,
      directionId,
    };
  }, [selectedShapeObj, selectedUnusedObj, shapeLabels, fitByShape, t]);

  const editorStops = useMemo(() => {
    if (!editShapeRequest) return null;
    if (editShapeRequest.mode === "create") return editShapeRequest.fitStops || null;
    const s = routeShapes.find((x) => x.shape_id === editShapeRequest.shapeId);
    return s && Array.isArray(s.stops) && s.stops.length > 0 ? s.stops : null;
  }, [editShapeRequest, routeShapes]);

  const extraShapes = useMemo(() => {
    if (!selectedUnusedObj || editingActive) return null;
    return [
      {
        shape_id: selectedUnusedObj.shape_id,
        points: selectedUnusedObj.points,
        selected: true,
      },
    ];
  }, [selectedUnusedObj, editingActive]);

  const routeLabel = useMemo(() => {
    const r = routes.find((x) => x.route_id === selectedRouteId);
    if (!r) return selectedRouteId || "";
    return [r.route_short_name, r.route_long_name].filter(Boolean).join(" — ") || r.route_id;
  }, [routes, selectedRouteId]);

  const existingShapeIds = useMemo(
    () => new Set([...routeShapes.map((s) => s.shape_id), ...unusedShapes.map((u) => u.shape_id)]),
    [routeShapes, unusedShapes],
  );

  // ── Handlers
  // Navigation under an open editor: a clean editor closes silently, unsaved changes ask to be discarded first.
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
        setSelectedUnusedId(null);
        setRailMode("shapes");
      });
    },
    [guardNav],
  );

  const handleSelectShape = useCallback(
    (shapeId) => {
      // Selecting the shape already active (perhaps being edited) never prompts to discard.
      if (shapeId === selectedShapeId && !selectedUnusedId) return;
      if (unusedShapes.some((u) => u.shape_id === shapeId)) {
        guardNav(() => setSelectedUnusedId(shapeId));
        return;
      }
      guardNav(() => {
        setSelectedUnusedId(null);
        setSelectedShapeId(shapeId);
      });
    },
    [guardNav, selectedShapeId, selectedUnusedId, unusedShapes],
  );

  const handleSelectUnused = useCallback(
    (shapeId) => {
      if (shapeId === selectedUnusedId) return;
      guardNav(() => setSelectedUnusedId(shapeId));
    },
    [guardNav, selectedUnusedId],
  );

  const handleHoverFromRail = useCallback((id) => {
    setHoveredShapeId(id);
    setHoverSource(id ? "rail" : null);
  }, []);

  const handleHoverFromMap = useCallback((id) => {
    setHoveredShapeId(id);
    setHoverSource(id ? "map" : null);
  }, []);

  const openEditor = useCallback((shapeId) => {
    if (!shapeId) return;
    setEditShapeRequest({ shapeId, token: ++tokenRef.current });
  }, []);

  const handleEdit = useCallback(
    (shapeId) => {
      const id = typeof shapeId === "string" ? shapeId : selectedSummary?.shape_id;
      if (!id) return;
      if (editingActive && editShapeRequest?.shapeId === id) return;
      guardNav(() => {
        if (unusedShapes.some((u) => u.shape_id === id)) {
          setSelectedUnusedId(id);
        } else {
          setSelectedUnusedId(null);
          setSelectedShapeId(id);
        }
        openEditor(id);
      });
    },
    [selectedSummary, editingActive, editShapeRequest, guardNav, unusedShapes, openEditor],
  );

  const openCreate = useCallback(
    ({ shapeId, points, linkTripIds, fitStops, context }) => {
      setNewShapeOpen(false);
      setSelectedShapeId(null);
      setSelectedUnusedId(null);
      setEditShapeRequest({
        shapeId,
        mode: "create",
        initialPoints: points || [],
        linkTripIds: linkTripIds || [],
        fitStops: fitStops || null,
        context: context || { routeId: selectedRouteId, directionId: null },
        token: ++tokenRef.current,
      });
    },
    [selectedRouteId],
  );

  const handleNewShape = useCallback(() => {
    guardNav(() => setNewShapeOpen(true));
  }, [guardNav]);

  // The route listing carries only a sample of trips: load them all so the fork can move any subset.
  const handleDuplicate = useCallback(async () => {
    const id = selectedSummary?.shape_id;
    if (!id) return;
    setForkShape({ shape_id: id, trips: [], loading: true });
    try {
      const res = await fetchWithSession(`${baseUrl}/edit/shapes/${encodeURIComponent(id)}`);
      const body = await res.json().catch(() => ({}));
      setForkShape((cur) =>
        cur && cur.shape_id === id
          ? { shape_id: id, trips: res.ok && Array.isArray(body.trips) ? body.trips : [], loading: false }
          : cur,
      );
    } catch {
      setForkShape((cur) => (cur && cur.shape_id === id ? { ...cur, loading: false } : cur));
    }
  }, [selectedSummary, baseUrl]);

  const handleLink = useCallback(() => {
    if (!selectedSummary) return;
    setLinkShape({
      shape_id: selectedSummary.shape_id,
      pointCount: selectedSummary.pointCount,
      distanceKm: (selectedSummary.distanceM / 1000).toFixed(2),
      directionId: selectedSummary.directionId,
    });
  }, [selectedSummary]);

  const doDelete = useCallback(async () => {
    const id = deleteId;
    setDeleteId(null);
    if (!id) return;
    try {
      const res = await fetchWithSession(
        `${baseUrl}/edit/shapes/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        showToast(
          selectedSummary?.tripCount > 0
            ? t("shapeStudio.delete.shapeHasTrips", { count: selectedSummary.tripCount })
            : t("edit.shape.deleteError"),
          "error",
        );
        return;
      }
      const body = await res.json().catch(() => ({}));
      recordEdit(t("shapeStudio.toast.shapeDeleted", { id }), body.validation, {
        entity: "shape",
        entityId: id,
      });
      setSelectedShapeId(null);
      setSelectedUnusedId(null);
    } catch {
      showToast(t("edit.shape.deleteError"), "error");
    }
  }, [deleteId, baseUrl, recordEdit, showToast, t, selectedSummary]);

  const handleAddStop = useCallback(() => {
    setPlaceStopSignal((n) => n + 1);
  }, []);

  // Cycles through the selected shape's off-trace stops.
  const handleFlyOffTrace = useCallback(() => {
    const list = selectedSummary?.fit?.offTrace;
    if (!list || list.length === 0) return;
    const entry = list[offTraceCursorRef.current % list.length];
    offTraceCursorRef.current += 1;
    setFocusedStopId(entry.stop.stop_id);
  }, [selectedSummary]);

  const showMap = Boolean(selectedRouteId || selectedUnusedId);

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
          coverage={coverage}
          filterMissing={filterMissing}
          onFilterMissingChange={setFilterMissing}
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
              setSelectedUnusedId(null);
            })
          }
          routeShapes={routeShapes}
          shapeLabels={shapeLabels}
          fitByShape={fitByShape}
          selectedShapeId={selectedShapeId}
          onSelectShape={handleSelectShape}
          onEditShape={handleEdit}
          hoveredShapeId={hoveredShapeId}
          onHoverShape={handleHoverFromRail}
          hoverSource={hoverSource}
          railMode={railMode}
          onRailModeChange={(val) => guardNav(() => setRailMode(val))}
          onNewShape={handleNewShape}
          mapStops={mapStops}
          selectedStopId={focusedStopId}
          onSelectStop={setFocusedStopId}
          onAddStop={handleAddStop}
          loadingRoute={loadingRoute}
          unusedShapes={unusedShapes}
          unusedTruncated={unusedTruncated}
          selectedUnusedId={selectedUnusedId}
          onSelectUnused={handleSelectUnused}
        />

        <Box sx={{ flex: 1, minWidth: 0, position: "relative" }}>
          {showMap ? (
            <>
              <LineMap
                chrome="studio"
                studioMode={railMode}
                shapesById={shapesById}
                stops={mapStops}
                editShapeRequest={editShapeRequest}
                editorStops={editorStops}
                extraShapes={extraShapes}
                selectedShapeId={selectedUnusedId ? null : selectedShapeId}
                onShapeClick={handleSelectShape}
                onShapeDoubleClick={handleEdit}
                hoveredShapeId={hoveredShapeId}
                onShapeHover={handleHoverFromMap}
                focusedStopId={focusedStopId}
                placeStopSignal={placeStopSignal}
              />
              {(railMode === "shapes" || selectedUnusedId) && (
                <StudioStatusStrip
                  selectedShape={selectedSummary}
                  editingActive={editingActive}
                  onEdit={() => handleEdit()}
                  onDuplicate={handleDuplicate}
                  onLink={handleLink}
                  onDelete={() => setDeleteId(selectedSummary?.shape_id || null)}
                  onFlyOffTrace={handleFlyOffTrace}
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

      <NewShapeDialog
        open={newShapeOpen}
        onClose={() => setNewShapeOpen(false)}
        routeId={selectedRouteId}
        routeLabel={routeLabel}
        existingShapeIds={existingShapeIds}
        onCreate={openCreate}
      />

      <ShapeForkDialog
        open={Boolean(forkShape)}
        shapeId={forkShape?.shape_id}
        trips={forkShape?.trips || []}
        loadingTrips={Boolean(forkShape?.loading)}
        onClose={() => setForkShape(null)}
        onForked={(body) => {
          setForkShape(null);
          if (body?.new_shape_id) {
            setSelectedShapeId(body.new_shape_id);
            if (!body.reassigned_trips) setSelectedUnusedId(body.new_shape_id);
          }
        }}
      />

      {linkShape && (
        <LinkShapeToTripsDialog
          open
          shapeId={linkShape.shape_id}
          pointCount={linkShape.pointCount}
          distanceKm={linkShape.distanceKm}
          defaultRouteId={selectedRouteId}
          defaultDirectionId={linkShape.directionId}
          onClose={() => setLinkShape(null)}
          onLinked={() => {
            setLinkShape(null);
            setSelectedUnusedId(null);
            setSelectedShapeId(linkShape.shape_id);
          }}
        />
      )}

      <Dialog open={Boolean(deleteId)} onClose={() => setDeleteId(null)}>
        <DialogTitle>{t("shapeStudio.action.delete")}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t("shapeStudio.delete.confirmShape", { id: deleteId })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteId(null)}>{t("app.cancel")}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={doDelete}
            data-testid="studio-delete-confirm"
          >
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
