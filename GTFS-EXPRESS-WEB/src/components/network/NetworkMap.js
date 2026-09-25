/**
 * NetworkMap — the plan on a map: stops (draggable to fix their place),
 * the routed path of each direction, and a "place this stop" mode: click
 * the map to give coordinates to a stop the geocoder did not find.
 */

import React, { useEffect, useMemo } from "react";
import { MapContainer, Polyline, CircleMarker, Marker, Rectangle, Tooltip as LeafletTooltip, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { Box, useTheme } from "@mui/material";
import { BasemapTileLayer, useBasemap } from "../map/BasemapControl";

const FitBounds = ({ points, epoch }) => {
  const map = useMap();
  useEffect(() => {
    if (!points.length) return;
    if (points.length === 1) {
      map.setView(points[0], 14);
      return;
    }
    map.fitBounds(L.latLngBounds(points), { padding: [28, 28] });
  }, [map, epoch]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
};

const ClickToPlace = ({ active, onPlace }) => {
  useMapEvents({
    click(e) {
      if (active && onPlace) onPlace(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
};

const stopIcon = (color, selected) =>
  L.divIcon({
    className: "",
    html: `<div style="width:${selected ? 16 : 12}px;height:${selected ? 16 : 12}px;border-radius:50%;background:#fff;border:3px solid ${color};box-shadow:0 0 0 2px rgba(0,0,0,0.15)"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });

const POI_COLOR = { school: "#F9A825", college: "#F57F17", hospital: "#D32F2F", civic: "#5E35B1", market: "#00897B", station: "#1E88E5", leisure: "#43A047", work: "#6D4C41" };

export default function NetworkMap({ stops = [], lines = [], geometry = [], existingStops = [], pois = [], corridors = [], population = null, focusBbox = null, selectedStopId = null, placingStopId = null, onSelectStop = null, onMoveStop = null, onPlaceStop = null, onPickExistingStop = null, fitEpoch = 0, height = "100%" }) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const [basemap] = useBasemap();
  const located = useMemo(() => stops.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon)), [stops]);
  // Fit the plan when it has places; otherwise the territory being studied.
  const points = useMemo(() => {
    const pts = located.map((s) => [s.lat, s.lon]);
    for (const g of geometry) for (const p of g.points || []) pts.push(p);
    if (!pts.length && Array.isArray(focusBbox) && focusBbox.length === 4 && focusBbox.every(Number.isFinite)) {
      pts.push([focusBbox[0], focusBbox[1]], [focusBbox[2], focusBbox[3]]);
    }
    return pts;
  }, [located, geometry, focusBbox]);
  const colorOfStop = useMemo(() => {
    const m = new Map();
    for (const line of lines) for (const d of line.directions || []) for (const id of d.stops || []) if (!m.has(id)) m.set(id, `#${line.color || "1E88E5"}`);
    return m;
  }, [lines]);
  const center = points.length ? points[0] : [48.85, 2.35];
  // Residents: one translucent square per grid cell, darker where denser.
  const popCells = useMemo(() => {
    if (!population || !population.cells?.length) return [];
    const max = Math.max(...population.cells.map((c) => c.pop));
    const half = (population.cell_m || 250) / 2;
    return population.cells.slice(0, 1500).map((c) => {
      const dLat = half / 111320;
      const dLon = half / (111320 * Math.cos((c.lat * Math.PI) / 180));
      return { key: `${c.lat},${c.lon}`, bounds: [[c.lat - dLat, c.lon - dLon], [c.lat + dLat, c.lon + dLon]], opacity: 0.08 + 0.42 * (c.pop / max), pop: c.pop };
    });
  }, [population]);

  return (
    <Box sx={{ height, width: "100%", position: "relative", "& .leaflet-container": { height: "100%", width: "100%", background: isDark ? "#0f172a" : "#e5e7eb", cursor: placingStopId ? "crosshair" : undefined } }} data-testid="network-map">
      <MapContainer center={center} zoom={12} scrollWheelZoom style={{ height: "100%", width: "100%" }}>
        <BasemapTileLayer basemap={basemap} isDark={isDark} />
        <FitBounds points={points} epoch={fitEpoch} />
        <ClickToPlace active={Boolean(placingStopId)} onPlace={(lat, lon) => onPlaceStop && onPlaceStop(placingStopId, lat, lon)} />
        {popCells.map((c) => (
          <Rectangle key={c.key} bounds={c.bounds} pathOptions={{ color: "transparent", fillColor: isDark ? "#fbbf24" : "#7c3aed", fillOpacity: c.opacity, weight: 0 }} interactive={false} />
        ))}
        {pois.map((p) => (
          <CircleMarker key={p.id} center={[p.lat, p.lon]} radius={3 + Math.min(3, p.weight || 1)} pathOptions={{ color: POI_COLOR[p.category] || "#888", fillColor: POI_COLOR[p.category] || "#888", fillOpacity: 0.55, weight: 1 }}>
            <LeafletTooltip direction="top" offset={[0, -4]}>{`${p.name}`}</LeafletTooltip>
          </CircleMarker>
        ))}
        {existingStops.map((s) => (
          <CircleMarker
            key={s.id}
            center={[s.lat, s.lon]}
            radius={s.kind === "station" ? 5 : 3}
            pathOptions={{ color: isDark ? "#cbd5e1" : "#475569", fillColor: isDark ? "#0f172a" : "#fff", fillOpacity: 1, weight: 1.5, dashArray: s.kind === "station" ? null : "2 2" }}
            eventHandlers={{ click: () => onPickExistingStop && onPickExistingStop(s) }}
          >
            <LeafletTooltip direction="top" offset={[0, -4]}>{s.name || s.kind}</LeafletTooltip>
          </CircleMarker>
        ))}
        {corridors.map((c) => (
          <Polyline key={c.id} positions={c.points} pathOptions={{ color: isDark ? "#94a3b8" : "#64748b", weight: 2, opacity: 0.55, dashArray: "3 8" }}>
            <LeafletTooltip sticky>{`${c.from} → ${c.to}`}</LeafletTooltip>
          </Polyline>
        ))}
        {geometry.map((g) => (
          <Polyline key={`${g.lineId}_${g.directionId}`} positions={g.points} pathOptions={{ color: `#${g.color || "1E88E5"}`, weight: g.directionId === "0" ? 5 : 3, opacity: g.directionId === "0" ? 0.85 : 0.5, dashArray: g.directionId === "0" ? null : "6 6" }} />
        ))}
        {located.map((s) =>
          onMoveStop ? (
            <Marker
              key={s.id}
              position={[s.lat, s.lon]}
              draggable
              icon={stopIcon(colorOfStop.get(s.id) || theme.palette.text.secondary, s.id === selectedStopId)}
              eventHandlers={{
                click: () => onSelectStop && onSelectStop(s.id),
                dragend: (e) => {
                  const ll = e.target.getLatLng();
                  onMoveStop(s.id, ll.lat, ll.lng);
                },
              }}
            >
              <LeafletTooltip direction="top" offset={[0, -8]}>{s.name}</LeafletTooltip>
            </Marker>
          ) : (
            <CircleMarker key={s.id} center={[s.lat, s.lon]} radius={s.id === selectedStopId ? 8 : 5} pathOptions={{ color: colorOfStop.get(s.id) || theme.palette.text.secondary, fillColor: "#fff", fillOpacity: 1, weight: 3 }} eventHandlers={{ click: () => onSelectStop && onSelectStop(s.id) }}>
              <LeafletTooltip direction="top" offset={[0, -6]}>{s.name}</LeafletTooltip>
            </CircleMarker>
          ),
        )}
      </MapContainer>
    </Box>
  );
}
