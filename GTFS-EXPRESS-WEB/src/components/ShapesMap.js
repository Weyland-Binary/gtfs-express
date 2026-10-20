import React, { useEffect, useState, useRef, useMemo, useCallback } from "react";
import {
  MapContainer,
  Polyline,
  CircleMarker,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import CircularProgress from "@mui/material/CircularProgress";
import Box from "@mui/material/Box";
import { alpha, useTheme } from "@mui/material/styles";
import L from "leaflet";
import API_BASE_URL from "../config";
import { fetchWithSession } from "../utils/sessionManager";
import StopFloatingCard from "./StopFloatingCard";
import { useDetailPanel } from "../contexts/DetailPanelContext";
import { BasemapTileLayer, useBasemap } from "./map/BasemapControl";

/* Douglas-Peucker line simplification (iterative, no recursion). */
const simplifyDP = (points, tolerance) => {
  const n = points.length;
  if (n < 3) return points;
  const sqTol = tolerance * tolerance;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxSqDist = 0;
    let index = -1;
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = points[i];
      let sqDist;
      if (lenSq === 0) {
        const ex = px - ax;
        const ey = py - ay;
        sqDist = ex * ex + ey * ey;
      } else {
        const t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
        const tc = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + tc * dx - px;
        const ey = ay + tc * dy - py;
        sqDist = ex * ex + ey * ey;
      }
      if (sqDist > maxSqDist) {
        maxSqDist = sqDist;
        index = i;
      }
    }
    if (index !== -1 && maxSqDist > sqTol) {
      keep[index] = 1;
      stack.push([first, index]);
      stack.push([index, last]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
};

// `refit`: the preview follows its box (the overview fitted to the screen, a window resized), the network fitted again.
const FitBounds = ({ shapes, stops, refit = false }) => {
  const map = useMap();
  const boundsRef = useRef(null);

  useEffect(() => {
    if (shapes.length > 0 || stops.length > 0) {
      const bounds = L.latLngBounds([]);

      shapes.forEach((shape) => {
        shape.points.forEach((point) => {
          bounds.extend([point[0], point[1]]);
        });
      });

      stops.forEach((stop) => {
        bounds.extend([stop.lat, stop.lon]);
      });

      boundsRef.current = bounds;
      map.fitBounds(bounds, { padding: refit ? [28, 28] : [0, 0] });
    }
  }, [shapes, stops, map, refit]);

  useEffect(() => {
    if (!refit || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      map.invalidateSize();
      if (boundsRef.current?.isValid()) map.fitBounds(boundsRef.current, { padding: [28, 28], animate: false });
    });
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map, refit]);

  return null;
};

// The stops appear once the streets read (below, the network is its lines).
const STOPS_MIN_ZOOM = 13;

// A line's width and a stop's radius follow the zoom: fine over the whole network, full in the streets.
const lineWidthAt = (zoom) => (zoom < 11 ? 2.25 : zoom < 13 ? 3 : zoom < 15 ? 4 : 5.5);
const stopRadiusAt = (zoom) => (zoom < 14 ? 2.75 : zoom < 16 ? 3.75 : 5);

const ZoomTracker = ({ onZoom }) => {
  const map = useMapEvents({
    zoomend: (e) => onZoom(e.target.getZoom()),
  });
  useEffect(() => {
    onZoom(map.getZoom());
  }, [map, onZoom]);
  return null;
};

// `highlight`: a route_id drawn in front, the others faded (a recommendation names its line); `children`: overlays
// drawn over the network (the zones a recommendation would serve, for instance).
// `interactive` false: a preview — no pan, no zoom, no control, no stop. `refit`: the network fitted to its box again
// whenever the box changes (a preview's default; the overview's interactive map asks for it too).
const ShapesMap = ({ height = "360px", agencyId = null, highlight = null, children = null, interactive = true, refit = !interactive }) => {
  const [rawShapes, setRawShapes] = useState([]);
  const [rawStops, setRawStops] = useState([]);
  const [routeColors, setRouteColors] = useState({});
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(2);
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { openPanel } = useDetailPanel();
  const [basemap] = useBasemap();

  useEffect(() => {
    let cancelled = false;
    const fetchShapes = async () => {
      try {
        setLoading(true);
        const url = agencyId
          ? `${API_BASE_URL}/all_shapes?agency_id=${encodeURIComponent(agencyId)}`
          : `${API_BASE_URL}/all_shapes`;
        const response = await fetchWithSession(url);
        if (cancelled) return;
        const data = await response.json();
        setRawShapes(data.shapes || []);
        setRawStops(data.stops || []);
        setRouteColors(data.routeColors || {});
      } catch (error) {
        console.error("Error fetching shapes:", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchShapes();
    return () => {
      cancelled = true;
    };
  }, [agencyId]);

  /* Pre-simplify shapes once + bake color in. Tolerance ≈ 1 m at equator.
     Routes without a route_color fall back to theme.palette.routeFallback. */
  const fallbackRouteColor = theme.palette.routeFallback;
  const shapes = useMemo(() => {
    if (!rawShapes.length) return [];
    return rawShapes.map((shape) => {
      const routeColor = routeColors[shape.route_id]?.route_color;
      return {
        routeId: shape.route_id,
        points: shape.points.length > 200 ? simplifyDP(shape.points, 0.00001) : shape.points,
        color: routeColor ? `#${routeColor}` : fallbackRouteColor,
        name: routeColors[shape.route_id]?.route_short_name || shape.route_id,
      };
    });
  }, [rawShapes, routeColors, fallbackRouteColor]);

  /* Pre-parse stop coords once. */
  const stops = useMemo(() => {
    if (!rawStops.length) return [];
    return rawStops.map((s) => ({
      ...s,
      lat: parseFloat(s.stop_lat),
      lon: parseFloat(s.stop_lon),
    }));
  }, [rawStops]);
  // What the map draws of them: the stations (location_type 1) as dark squares, the places vehicles call at (0 or
  // empty) as dots; entrances, nodes and boarding areas are no stop to a reader of the network.
  const { stationStops, callStops } = useMemo(() => {
    const kind = (s) => String(s.location_type ?? "").trim();
    return {
      stationStops: stops.filter((s) => kind(s) === "1" && Number.isFinite(s.lat) && Number.isFinite(s.lon)),
      callStops: stops.filter((s) => (kind(s) === "" || kind(s) === "0") && Number.isFinite(s.lat) && Number.isFinite(s.lon)),
    };
  }, [stops]);

  const showStops = interactive && zoom >= STOPS_MIN_ZOOM;

  const [hoveredStop, setHoveredStop] = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const hoverPosRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!hoveredStop) return;
    const handleMove = (e) => {
      const dx = e.clientX - hoverPosRef.current.x;
      const dy = e.clientY - hoverPosRef.current.y;
      if (dx * dx + dy * dy > 40 * 40) setHoveredStop(null);
    };
    window.addEventListener("pointermove", handleMove);
    return () => window.removeEventListener("pointermove", handleMove);
  }, [hoveredStop]);

  // The stops: a light dot ringed in the text's tone; under the pointer, larger, ringed in the primary colour.
  const stopFill = theme.palette.background.paper;
  const stopRing = alpha(theme.palette.text.primary, isDark ? 0.75 : 0.7);
  const stopHoverRing = theme.palette.primary.main;
  const radius = stopRadiusAt(zoom);
  const width = lineWidthAt(zoom);
  // The casing under each line: the map's own ground, so that lines crossing stay apart.
  const casing = isDark ? alpha(theme.palette.common.black, 0.75) : alpha(theme.palette.common.white, 0.95);
  // The line in front: the one a recommendation names, else the one under the pointer.
  const [hoveredRoute, setHoveredRoute] = useState(null);
  const front = highlight || hoveredRoute;

  const handleStopMouseOver = useCallback(
    (stop) => (e) => {
      e.target.setStyle({ radius: radius + 2.5, weight: 2.5, color: stopHoverRing });
      e.target.bringToFront();
      const { clientX, clientY } = e.originalEvent;
      hoverPosRef.current = { x: clientX, y: clientY };
      setHoveredStop(stop);
      setMousePos({ x: clientX, y: clientY });
    },
    [radius, stopHoverRing],
  );

  const handleStopMouseOut = useCallback(
    (e) => {
      e.target.setStyle({ radius, weight: 1.5, color: stopRing });
    },
    [radius, stopRing],
  );

  const handleStopClick = useCallback(
    (stopId) => () => openPanel("stop", stopId),
    [openPanel],
  );

  if (loading) {
    return (
      <Box
        display="flex"
        justifyContent="center"
        alignItems="center"
        height={height}
      >
        <CircularProgress />
      </Box>
    );
  }

  // The lines in front last, so that they are drawn over the others.
  const ordered = front ? [...shapes.filter((x) => x.routeId !== front), ...shapes.filter((x) => x.routeId === front)] : shapes;
  const lineOpacity = (shape) => (front ? (shape.routeId === front ? 1 : 0.18) : 0.92);
  const lineWidth = (shape) => (front && shape.routeId === front ? width + 2 : width);

  return (
    <Box
      sx={{
        height,
        width: "100%",
        // The zoom buttons in the app's look: one rounded block, a soft shadow, the theme's colours.
        "& .leaflet-control-zoom": { border: "none !important", borderRadius: "10px !important", overflow: "hidden", boxShadow: isDark ? "0 4px 14px rgba(0,0,0,0.5)" : "0 4px 14px rgba(15,23,42,0.14)" },
        "& .leaflet-control-zoom a": {
          width: "34px !important",
          height: "34px !important",
          lineHeight: "32px !important",
          fontSize: "18px !important",
          color: `${theme.palette.text.primary} !important`,
          backgroundColor: `${theme.palette.background.paper} !important`,
          borderBottom: `1px solid ${theme.palette.divider} !important`,
          transition: "background-color 150ms",
          "&:hover": { backgroundColor: `${theme.palette.action.hover} !important` },
          "&:last-of-type": { borderBottom: "none !important" },
        },
        "& .shapes-map-line-label": { px: 0.75, py: 0.1, fontSize: "0.72rem", fontWeight: 700, color: theme.palette.text.primary, backgroundColor: alpha(theme.palette.background.paper, 0.96), border: `1px solid ${theme.palette.divider}`, borderRadius: "6px", boxShadow: "none", "&::before": { display: "none" } },
      }}
    >
      <MapContainer
        center={[0, 0]}
        zoom={2}
        style={{ height: "100%", width: "100%" }}
        attributionControl
        preferCanvas={true}
        // A finer, smoother zoom: quarter steps, the wheel read gently.
        zoomSnap={0.25}
        zoomDelta={0.5}
        wheelPxPerZoomLevel={110}
        wheelDebounceTime={30}
        {...(interactive ? {} : { dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, boxZoom: false, keyboard: false, zoomControl: false })}
      >
        <BasemapTileLayer basemap={basemap} isDark={isDark} />
        <FitBounds shapes={shapes} stops={stops} refit={refit} />
        <ZoomTracker onZoom={setZoom} />
        {ordered.map((shape, index) => (
          <Polyline key={`c-${shape.routeId}-${index}`} positions={shape.points} interactive={false} pathOptions={{ color: casing, weight: lineWidth(shape) + 2.5, opacity: front && shape.routeId !== front ? 0.35 : 0.9, lineCap: "round", lineJoin: "round" }} />
        ))}
        {ordered.map((shape, index) => (
          <Polyline
            key={`l-${shape.routeId}-${index}`}
            positions={shape.points}
            pathOptions={{ color: shape.color, weight: lineWidth(shape), opacity: lineOpacity(shape), lineCap: "round", lineJoin: "round" }}
            eventHandlers={interactive ? { mouseover: () => setHoveredRoute(shape.routeId), mouseout: () => setHoveredRoute(null) } : undefined}
          >
            {interactive && (
              <Tooltip sticky direction="top" offset={[0, -8]} className="shapes-map-line-label">
                {shape.name}
              </Tooltip>
            )}
          </Polyline>
        ))}
        {children}
        {/* A station: a halo drawn before the stops, so its platforms stay on top of it. */}
        {showStops &&
          stationStops.map((stop) => (
            <CircleMarker
              key={`station-${stop.stop_id}`}
              center={[stop.lat, stop.lon]}
              radius={radius + 6}
              color={theme.palette.text.primary}
              weight={2}
              opacity={0.85}
              fillColor={stopFill}
              fillOpacity={0.9}
              eventHandlers={{
                mouseover: handleStopMouseOver(stop),
                mouseout: handleStopMouseOut,
                click: handleStopClick(stop.stop_id),
              }}
            />
          ))}
        {showStops &&
          callStops.map((stop) => (
            <CircleMarker
              key={stop.stop_id}
              center={[stop.lat, stop.lon]}
              radius={radius}
              color={stopRing}
              fillColor={stopFill}
              fillOpacity={1}
              weight={1.5}
              eventHandlers={{
                mouseover: handleStopMouseOver(stop),
                mouseout: handleStopMouseOut,
                click: handleStopClick(stop.stop_id),
              }}
            />
          ))}
      </MapContainer>
      <StopFloatingCard
        stop={hoveredStop}
        isDark={isDark}
        x={mousePos.x}
        y={mousePos.y}
      />
    </Box>
  );
};

export default ShapesMap;
