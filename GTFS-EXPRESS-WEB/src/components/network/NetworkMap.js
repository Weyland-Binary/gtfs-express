/**
 * NetworkMap — the plan on a map: stops (draggable to fix their place),
 * the routed path of each direction, and a "place this stop" mode: click
 * the map to give coordinates to a stop the geocoder did not find.
 */

import React, { useEffect, useMemo } from "react";
import { MapContainer, TileLayer, Polyline, CircleMarker, Marker, Tooltip as LeafletTooltip, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { Box, useTheme } from "@mui/material";

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

export default function NetworkMap({ stops = [], lines = [], geometry = [], selectedStopId = null, placingStopId = null, onSelectStop = null, onMoveStop = null, onPlaceStop = null, fitEpoch = 0, height = "100%" }) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const located = useMemo(() => stops.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon)), [stops]);
  const points = useMemo(() => {
    const pts = located.map((s) => [s.lat, s.lon]);
    for (const g of geometry) for (const p of g.points || []) pts.push(p);
    return pts;
  }, [located, geometry]);
  const colorOfStop = useMemo(() => {
    const m = new Map();
    for (const line of lines) for (const d of line.directions || []) for (const id of d.stops || []) if (!m.has(id)) m.set(id, `#${line.color || "1E88E5"}`);
    return m;
  }, [lines]);
  const center = points.length ? points[0] : [48.85, 2.35];

  return (
    <Box sx={{ height, width: "100%", position: "relative", "& .leaflet-container": { height: "100%", width: "100%", background: isDark ? "#0f172a" : "#e5e7eb", cursor: placingStopId ? "crosshair" : undefined } }} data-testid="network-map">
      <MapContainer center={center} zoom={12} scrollWheelZoom style={{ height: "100%", width: "100%" }}>
        <TileLayer
          key={isDark ? "dark" : "light"}
          url={isDark ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"}
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        />
        <FitBounds points={points} epoch={fitEpoch} />
        <ClickToPlace active={Boolean(placingStopId)} onPlace={(lat, lon) => onPlaceStop && onPlaceStop(placingStopId, lat, lon)} />
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
