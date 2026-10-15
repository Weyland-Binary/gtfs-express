/**
 * ChangeMap — what the plan changes, on a map (the preview's `geo`): each
 * line it touches before (grey, dashed) and after (in the line's colour),
 * the stops it adds, removes or moves (an arrow from the old place to the
 * new), and those that lose or gain service. Only what the plan touches is
 * drawn; the map fits it. A legend names what is shown, popups name lines
 * and stops. Without a simulation, or on a server whose previews carry no
 * geometry, a plain message says so.
 *
 * The map says which network it shows (`change-map-state`, utils/changeStates):
 * the network the change starts from, nothing simulated (`source`); the
 * draft simulated on a copy, nothing applied (`draft`); the change applied in
 * vN (`applied`) — its legend's « avant / après » in those words, never
 * « tracé actuel » once the change is the network's. Beside a drawn change it
 * says that a plausible line is no proof the brief is met, with the way to the
 * objectives' measured verdict (`onOpenObjectives`, `change-map-objectives`).
 * `focus`: the line the person is looking at (carried from the reader, picked
 * on an operation or an objective): drawn in front, the map fitted on it when
 * the change touches it, named in a chip that clears it (`change-map-focus`).
 */

import React, { useEffect, useMemo } from "react";
import { MapContainer, Polyline, CircleMarker, Marker, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { Box, Button, Chip, CircularProgress, Typography, alpha, useTheme } from "@mui/material";
import MapOutlinedIcon from "@mui/icons-material/MapOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { BasemapTileLayer, useBasemap } from "../map/BasemapControl";
import { soft } from "../network/StudioUI";

export const STOP_COLORS = { added: "#2E7D32", removed: "#D32F2F", moved: "#7B1FA2", lost_service: "#EF6C00", gained_service: "#1E88E5" };
const STOP_ORDER = ["added", "removed", "moved", "lost_service", "gained_service"];
const ROUTE_ORDER = ["added", "changed", "removed"];

const finite = (x) => x !== null && x !== undefined && x !== "" && Number.isFinite(Number(x));
const valid = (p) => Array.isArray(p) && p.length >= 2 && finite(p[0]) && finite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;
const line = (pts) => (Array.isArray(pts) ? pts.filter(valid).map((p) => [Number(p[0]), Number(p[1])]) : []);
const colorOf = (c) => (/^[0-9a-fA-F]{6}$/.test(String(c || "").replace(/^#/, "")) ? `#${String(c).replace(/^#/, "")}` : "#1E88E5");

/** Metres between two [lat, lon]. */
const metres = (a, b) => {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
};
/** Bearing in degrees (0 = north) from a to b. */
const bearing = (a, b) => (Math.atan2((b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180), b[0] - a[0]) * 180) / Math.PI;

const arrowIcon = (deg, color) =>
  L.divIcon({
    className: "",
    html: `<div style="width:16px;height:16px;transform:rotate(${Math.round(deg)}deg)"><svg viewBox="0 0 16 16" width="16" height="16"><path d="M8 1 L14 14 L8 10.5 L2 14 Z" fill="${color}" stroke="#fff" stroke-width="1.2"/></svg></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });

/** The geometry, cleaned: polylines and stops with valid coordinates only. */
export const readGeo = (geo) => {
  const routes = (geo?.routes || []).map((r) => ({ ...r, before: line(r.before), after: line(r.after), color: colorOf(r.color) })).filter((r) => r.before.length > 1 || r.after.length > 1);
  const stops = (geo?.stops || []).filter((s) => valid([s.lat, s.lon])).map((s) => ({ ...s, lat: Number(s.lat), lon: Number(s.lon), before: valid(s.before) ? [Number(s.before[0]), Number(s.before[1])] : null }));
  const bbox = Array.isArray(geo?.bbox) && geo.bbox.length === 4 && geo.bbox.every((x) => Number.isFinite(Number(x))) ? geo.bbox.map(Number) : null;
  return { routes, stops, bbox };
};

const FitBounds = ({ points, bbox, focus = null }) => {
  const map = useMap();
  const key = focus?.length ? `f:${focus.length}:${focus[0].join(",")}` : bbox ? bbox.join(",") : `${points.length}:${points[0]?.join(",") || ""}`;
  useEffect(() => {
    // The line in focus first (the change touches it): the person came for it.
    if (focus?.length > 1) map.fitBounds(L.latLngBounds(focus), { padding: [48, 48] });
    else if (bbox) map.fitBounds(L.latLngBounds([bbox[0], bbox[1]], [bbox[2], bbox[3]]), { padding: [32, 32] });
    else if (points.length === 1) map.setView(points[0], 15);
    else if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [32, 32] });
  }, [map, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
};

/** Which network the map shows, in words (utils/changeStates.mapStateOf: a simulation running is the draft's). */
export function MapState({ state = "source", appliedIn = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const shown = state === "simulating" ? "draft" : state;
  const tone = shown === "applied" ? theme.palette.success.main : shown === "draft" ? theme.palette.warning.dark : theme.palette.text.secondary;
  return (
    <Typography component="span" data-testid="change-map-state" data-state={shown} sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, alignSelf: "flex-start", px: 0.75, py: 0.125, borderRadius: 99, border: `1px solid ${alpha(tone, 0.6)}`, color: tone, fontSize: "0.68rem", fontWeight: 700, lineHeight: 1.5, whiteSpace: "normal" }}>
      {shown === "applied" ? t("change.map.state.applied", { n: appliedIn ?? "" }) : t(`change.map.state.${shown}`)}
    </Typography>
  );
}

/** The line in focus, named, with the way to clear it. */
function FocusChip({ label, untouched = false, onClear = null }) {
  const { t } = useLanguage();
  if (!label) return null;
  return <Chip size="small" color="primary" variant="outlined" data-testid="change-map-focus" data-untouched={untouched ? "true" : "false"} label={t(untouched ? "change.map.focus.untouched" : "change.map.focus", { line: label })} onDelete={onClear || undefined} sx={{ alignSelf: "flex-start", height: "auto", py: 0.25, "& .MuiChip-label": { whiteSpace: "normal", fontSize: "0.7rem" } }} />;
}

/** A plausible line is no proof: the objectives' measured verdict says whether the brief is met. */
function NotProof({ onOpenObjectives = null }) {
  const { t } = useLanguage();
  return (
    <Typography component="span" data-testid="change-map-not-proof" sx={{ display: "block", fontSize: "0.7rem", color: "text.secondary", lineHeight: 1.45 }}>
      {t("change.map.notProof")}
      {onOpenObjectives && (
        <Button size="small" onClick={onOpenObjectives} data-testid="change-map-objectives" sx={{ ml: 0.5, p: 0, minWidth: 0, verticalAlign: "baseline", textTransform: "none", fontSize: "0.7rem", fontWeight: 700 }}>
          {t("change.map.objectives")}
        </Button>
      )}
    </Typography>
  );
}

function Message({ testid, icon = true, busy = false, children }) {
  const theme = useTheme();
  return (
    <Box data-testid={testid} sx={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1, textAlign: "center", minHeight: 260, p: 3, borderRadius: "12px", background: soft(theme) }}>
      {busy ? <CircularProgress size={22} /> : icon && <MapOutlinedIcon sx={{ fontSize: 30, color: "text.disabled" }} />}
      <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", maxWidth: 420, lineHeight: 1.55 }}>{children}</Typography>
    </Box>
  );
}

/**
 * `reference`: the network as it is (a map node the host renders, e.g. ShapesMap): shown under the message before
 * any simulation and when the plan moves nothing on the map — the person sees what they are changing, never an
 * empty grey box.
 */
// `height`: the map's height in pixels, or "fill" — the map takes the height its column has left (the Change Studio's
// atelier on a desktop screen, which fills the window).
// `state` / `appliedIn`: which network is shown (utils/changeStates); `focus` (a route id) and `focusLabel`: the line
// in focus, cleared by `onClearFocus`; `onOpenObjectives`: the way to the objectives' measured verdict.
export default function ChangeMap({ geo, hasPreview = false, previewing = false, height = 460, reference = null, state = null, appliedIn = null, focus = null, focusLabel = null, onClearFocus = null, onOpenObjectives = null }) {
  const filling = height === "fill";
  const mapSx = filling ? { position: "absolute", inset: 0 } : { height };
  // Filling, the words float over the map's top left corner, in the look of the studio's floating controls.
  const floating = filling ? { position: "absolute", top: 12, left: 12, zIndex: 1000, maxWidth: "min(460px, calc(100% - 300px))", px: 1.5, py: 1, borderRadius: "10px", backgroundColor: "background.paper", border: (th) => `1px solid ${th.palette.divider}`, boxShadow: (th) => th.studio?.float || th.shadows[4] } : {};
  const { t } = useLanguage();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const [basemap] = useBasemap();
  const data = useMemo(() => readGeo(geo), [geo]);
  const points = useMemo(() => [...data.routes.flatMap((r) => [...r.before, ...r.after]), ...data.stops.flatMap((s) => [[s.lat, s.lon], ...(s.before ? [s.before] : [])])], [data]);
  const applied = state === "applied";
  const focused = focus ? data.routes.find((r) => String(r.route_id) === String(focus)) || null : null;
  const focusPoints = useMemo(() => (focused ? [...focused.before, ...focused.after] : null), [focused]);
  const asIs = (testid, text, busy = false) =>
    reference ? (
      <Box data-testid="change-map-reference" sx={{ display: "flex", flexDirection: "column", gap: 1, ...(filling ? { height: "100%", position: "relative" } : {}) }}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, ...floating }}>
          {state && <MapState state={state} appliedIn={appliedIn} />}
          <Typography data-testid={testid} sx={{ display: "flex", alignItems: "center", gap: 0.75, fontSize: "0.8rem", color: "text.secondary", lineHeight: 1.5 }}>
            {busy ? <CircularProgress size={14} /> : <MapOutlinedIcon aria-hidden sx={{ fontSize: 18, color: "text.disabled" }} />}
            {text}
          </Typography>
          <FocusChip label={focus ? focusLabel : null} onClear={onClearFocus} />
        </Box>
        <Box sx={{ ...mapSx, borderRadius: filling ? 0 : "12px", overflow: "hidden" }}>{reference}</Box>
      </Box>
    ) : (
      <Message testid={testid} busy={busy}>
        {text}
      </Message>
    );
  // Applied and read back (a reload: a frozen scenario is never simulated again): the network shown IS vN.
  if (!hasPreview && applied && !previewing) return asIs("change-map-empty", t(reference ? "change.map.applied.reference" : "change.map.applied.noPreview", { n: appliedIn ?? "" }));
  if (!hasPreview) return asIs("change-map-empty", previewing ? t("transform.map.loading") : t(reference ? "transform.map.reference" : "transform.map.noPreview"), previewing);
  if (previewing && !geo) return asIs("change-map-loading", t("transform.map.loading"), true);
  if (!geo) return <Message testid="change-map-nogeo">{t("transform.map.noGeo")}</Message>;
  if (!data.routes.length && !data.stops.length) return asIs("change-map-nothing", t("transform.map.nothing"));

  const grey = isDark ? "#94a3b8" : "#6b7280";
  const routeCounts = Object.fromEntries(ROUTE_ORDER.map((k) => [k, data.routes.filter((r) => r.status === k).length]));
  const stopCounts = Object.fromEntries(STOP_ORDER.map((k) => [k, data.stops.filter((s) => s.status === k).length]));
  const hasBefore = data.routes.some((r) => r.before.length > 1);
  const hasAfter = data.routes.some((r) => r.after.length > 1);
  const routeName = (r) => t("transform.line", { line: r.short_name || r.route_id });
  // « Avant / après » in the words of the state shown: the draft is simulated, the applied change is vN's.
  const beforeWords = state ? t("change.map.before") : t("transform.map.before");
  const afterWords = applied ? t("change.map.after.applied", { n: appliedIn ?? "" }) : state ? t("change.map.after.draft") : t("transform.map.after");
  // The line in focus in front, the others behind it.
  const dim = (r) => (focus && String(r.route_id) !== String(focus) ? 0.35 : 1);
  const center = points[0] || [48.85, 2.35];
  return (
    <Box data-testid="change-map" data-state={state || undefined} sx={{ display: "flex", flexDirection: "column", gap: 1, ...(filling ? { height: "100%", position: "relative" } : {}) }}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, ...floating }}>
        {state && <MapState state={state} appliedIn={appliedIn} />}
        <Box data-testid="change-map-summary" sx={{ display: "flex", flexWrap: "wrap", gap: 0.75, alignItems: "baseline" }}>
          <Typography sx={{ fontSize: "0.8rem", fontWeight: 700 }}>{t("transform.map.summary", { routes: data.routes.length, stops: data.stops.length })}</Typography>
          {ROUTE_ORDER.filter((k) => routeCounts[k]).map((k) => (
            <Typography key={k} sx={{ fontSize: "0.72rem", color: "text.secondary" }}>
              · {t(`transform.map.routes.${k}`, { count: routeCounts[k] })}
            </Typography>
          ))}
        </Box>
        <FocusChip label={focus ? focusLabel : null} untouched={Boolean(focus) && !focused} onClear={onClearFocus} />
        {state && <NotProof onOpenObjectives={onOpenObjectives} />}
      </Box>
      <Box sx={{ position: "relative", ...mapSx, borderRadius: filling ? 0 : "12px", overflow: "hidden", "& .leaflet-container": { height: "100%", width: "100%", background: isDark ? "#0f172a" : "#e5e7eb" } }}>
        <MapContainer center={center} zoom={13} scrollWheelZoom style={{ height: "100%", width: "100%" }}>
          <BasemapTileLayer basemap={basemap} isDark={isDark} />
          <FitBounds points={points} bbox={data.bbox} focus={focusPoints} />
          {data.routes
            .filter((r) => r.before.length > 1)
            .map((r) => (
              <Polyline key={`b-${r.route_id}`} positions={r.before} pathOptions={{ color: grey, weight: 4, opacity: 0.85 * dim(r), dashArray: "6 7" }}>
                <Popup>
                  <strong>{routeName(r)}</strong>
                  <br />
                  {t(`transform.map.route.${r.status}`)} — {beforeWords}
                </Popup>
              </Polyline>
            ))}
          {data.routes
            .filter((r) => r.after.length > 1)
            .map((r) => (
              <Polyline key={`a-${r.route_id}`} positions={r.after} pathOptions={{ color: r.color, weight: focused === r ? 7 : 5, opacity: 0.9 * dim(r) }}>
                <Popup>
                  <strong>{routeName(r)}</strong>
                  <br />
                  {t(`transform.map.route.${r.status}`)} — {afterWords}
                </Popup>
              </Polyline>
            ))}
          {data.stops
            .filter((s) => s.status === "moved" && s.before)
            .map((s) => (
              <React.Fragment key={`m-${s.stop_id}`}>
                <CircleMarker center={s.before} radius={5} pathOptions={{ color: STOP_COLORS.moved, fillColor: "#fff", fillOpacity: 1, weight: 2, dashArray: "2 2" }}>
                  <Popup>
                    <strong>{s.name}</strong>
                    <br />
                    {t("transform.map.oldPlace")}
                  </Popup>
                </CircleMarker>
                <Polyline positions={[s.before, [s.lat, s.lon]]} pathOptions={{ color: STOP_COLORS.moved, weight: 2.5, opacity: 0.9, dashArray: "4 4" }} />
                <Marker position={[s.lat, s.lon]} icon={arrowIcon(bearing(s.before, [s.lat, s.lon]), STOP_COLORS.moved)}>
                  <Popup>
                    <strong>{s.name}</strong>
                    <br />
                    {t("transform.map.movedBy", { meters: metres(s.before, [s.lat, s.lon]) })}
                  </Popup>
                </Marker>
              </React.Fragment>
            ))}
          {data.stops
            .filter((s) => !(s.status === "moved" && s.before))
            .map((s) => (
              <CircleMarker key={`s-${s.stop_id}-${s.status}`} center={[s.lat, s.lon]} radius={s.status === "added" || s.status === "removed" ? 7 : 6} pathOptions={{ color: STOP_COLORS[s.status] || grey, fillColor: s.status === "removed" ? "#fff" : STOP_COLORS[s.status] || grey, fillOpacity: s.status === "removed" ? 1 : 0.85, weight: 3 }}>
                <Popup>
                  <strong>{s.name}</strong>
                  <br />
                  {t(`transform.map.stop.${s.status}`)}
                </Popup>
              </CircleMarker>
            ))}
        </MapContainer>
        <Box data-testid="change-map-legend" sx={{ position: "absolute", top: 10, right: 10, zIndex: 1000, maxWidth: 230, p: 1, borderRadius: "12px", background: alpha(theme.palette.background.paper, 0.94), backdropFilter: "blur(8px)", boxShadow: isDark ? "0 8px 24px rgba(0,0,0,0.45)" : "0 8px 24px rgba(15,23,42,0.12)", display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Typography sx={{ fontSize: "0.62rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "text.secondary" }}>{t("transform.map.legend")}</Typography>
          {hasBefore && (
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
              <Box sx={{ width: 22, borderTop: `3px dashed ${grey}` }} />
              <Typography data-testid="change-map-legend-before" sx={{ fontSize: "0.72rem" }}>{beforeWords}</Typography>
            </Box>
          )}
          {hasAfter && (
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
              <Box sx={{ width: 22, height: 4, borderRadius: 2, background: data.routes.find((r) => r.after.length > 1)?.color || "#1E88E5" }} />
              <Typography data-testid="change-map-legend-after" sx={{ fontSize: "0.72rem" }}>{afterWords}</Typography>
            </Box>
          )}
          {STOP_ORDER.filter((k) => stopCounts[k]).map((k) => (
            <Box key={k} data-testid={`change-map-legend-${k}`} sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
              <Box sx={{ width: 10, height: 10, mx: "6px", borderRadius: "50%", boxSizing: "border-box", border: `2px solid ${STOP_COLORS[k]}`, background: k === "removed" ? "transparent" : STOP_COLORS[k] }} />
              <Typography sx={{ fontSize: "0.72rem", flex: 1 }}>{t(`transform.map.stop.${k}`)}</Typography>
              <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>{stopCounts[k]}</Typography>
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
