import React, { useEffect, useState, useRef, useMemo, useCallback } from "react";
import {
  MapContainer,
  TileLayer,
  Polyline,
  CircleMarker,
  useMap,
  useMapEvents,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import CircularProgress from "@mui/material/CircularProgress";
import Box from "@mui/material/Box";
import { useTheme } from "@mui/material/styles";
import L from "leaflet";
import API_BASE_URL from "../config";
import { fetchWithSession } from "../utils/sessionManager";
import StopFloatingCard from "./StopFloatingCard";
import { useDetailPanel } from "../contexts/DetailPanelContext";

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

const FitBounds = ({ shapes, stops }) => {
  const map = useMap();

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

      map.fitBounds(bounds);
    }
  }, [shapes, stops, map]);

  return null;
};

const STOPS_MIN_ZOOM = 12;

const ZoomTracker = ({ onZoom }) => {
  useMapEvents({
    zoomend: (e) => onZoom(e.target.getZoom()),
  });
  return null;
};

const ShapesMap = ({ height = "360px", agencyId = null }) => {
  const [rawShapes, setRawShapes] = useState([]);
  const [rawStops, setRawStops] = useState([]);
  const [routeColors, setRouteColors] = useState({});
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(2);
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { openPanel } = useDetailPanel();

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
        points: shape.points.length > 200 ? simplifyDP(shape.points, 0.00001) : shape.points,
        color: routeColor ? `#${routeColor}` : fallbackRouteColor,
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

  const showStops = zoom >= STOPS_MIN_ZOOM;

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

  const stopColor = isDark ? "#42a5f5" : "#1976d2";
  const stopHoverColor = isDark ? "#ffffff" : "#0d47a1";
  const stopBaseColor = isDark ? "#90caf9" : "#1976d2";

  const handleStopMouseOver = useCallback(
    (stop) => (e) => {
      e.target.setStyle({
        radius: 8,
        fillOpacity: 1,
        weight: 3,
        color: stopHoverColor,
      });
      const { clientX, clientY } = e.originalEvent;
      hoverPosRef.current = { x: clientX, y: clientY };
      setHoveredStop(stop);
      setMousePos({ x: clientX, y: clientY });
    },
    [stopHoverColor],
  );

  const handleStopMouseOut = useCallback(
    (e) => {
      e.target.setStyle({
        radius: 5,
        fillOpacity: 0.8,
        weight: 2,
        color: stopBaseColor,
      });
    },
    [stopBaseColor],
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

  return (
    <div style={{ height, width: "100%" }}>
      <MapContainer
        center={[0, 0]}
        zoom={2}
        style={{ height: "100%", width: "100%" }}
        attributionControl={false}
        preferCanvas={true}
      >
        <TileLayer
          key={isDark ? "dark" : "light"}
          url={
            isDark
              ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          }
          attribution='&copy; <a href="https://carto.com/attributions">CARTO</a>'
        />
        <FitBounds shapes={shapes} stops={stops} />
        <ZoomTracker onZoom={setZoom} />
        {shapes.map((shape, index) => (
          <Polyline
            key={index}
            positions={shape.points}
            color={shape.color}
            weight={2}
            opacity={0.6}
          />
        ))}
        {showStops &&
          stops.map((stop) => (
            <CircleMarker
              key={stop.stop_id}
              center={[stop.lat, stop.lon]}
              radius={5}
              color={stopColor}
              fillColor={stopColor}
              fillOpacity={0.8}
              weight={2}
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
    </div>
  );
};

export default ShapesMap;
