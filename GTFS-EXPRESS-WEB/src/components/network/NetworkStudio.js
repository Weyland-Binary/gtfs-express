/**
 * NetworkStudio — create a transit network from scratch.
 *
 * Left: the brief and the conversation with the planner (the assistant
 * designs the Network Spec through server tools: geocoding, validation,
 * road routing, questions). Right: the plan under review — map, lines,
 * stops, raw JSON — every edit re-validated live. Bottom: the estimate,
 * the issues, and "Build the network", which compiles the spec into a
 * validated GTFS session and opens it in the app.
 *
 * Without the assistant (no API key) the studio still works: the user
 * fills the plan by hand, geocodes stops one by one and builds.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, Button, Chip, CircularProgress, Collapse, Dialog, IconButton, LinearProgress, Tab, Tabs, Tooltip, Typography, alpha, useMediaQuery, useTheme } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import BuildCircleOutlinedIcon from "@mui/icons-material/BuildCircleOutlined";
import MapOutlinedIcon from "@mui/icons-material/MapOutlined";
import RouteOutlinedIcon from "@mui/icons-material/RouteOutlined";
import PlaceOutlinedIcon from "@mui/icons-material/PlaceOutlined";
import DataObjectOutlinedIcon from "@mui/icons-material/DataObjectOutlined";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import RefreshIcon from "@mui/icons-material/Refresh";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useFeatures } from "../../utils/featuresApi";
import { validateSpec, estimateSpec, compileSpec, streamPlan, loadDraft, saveDraft } from "../../utils/networkStudioApi";
import NetworkMap from "./NetworkMap";
import PlanChat from "./PlanChat";
import { LinesEditor, StopsEditor, JsonEditor } from "./SpecEditors";
import { BETA_CODE_STORAGE_KEY } from "../edit/BetaGateDialog";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { PRICING_EVENT } from "../PricingDialog";

const EMPTY_SPEC = { agency: { name: "", url: "", timezone: "" }, stops: [], lines: [] };
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const centroid = (stops) => {
  const pts = (stops || []).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  if (!pts.length) return null;
  return { lat: pts.reduce((a, s) => a + s.lat, 0) / pts.length, lon: pts.reduce((a, s) => a + s.lon, 0) / pts.length };
};

// Turn a normalised spec (server) back into the editable shape (services
// keep `calendar` names; stops keep coordinates).
const editableFromNormalized = (spec) => ({
  ...spec,
  lines: (spec.lines || []).map((l) => ({ ...l, services: (l.services || []).map((s) => ({ ...s, calendar: s.calendar ?? s.calendar_id })) })),
});

export default function NetworkStudio({ open, onClose, onCreated }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const { features } = useFeatures();
  const chatEnabled = Boolean(features?.chat?.enabled);

  const [spec, setSpec] = useState(EMPTY_SPEC);
  const [validation, setValidation] = useState(null); // { ok, spec, issues, blockers, estimate, plan }
  const [geometry, setGeometry] = useState([]);
  const [geometryStale, setGeometryStale] = useState(false);
  const [routing, setRouting] = useState(false);
  const [turns, setTurns] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [pendingTool, setPendingTool] = useState(null);
  const [tab, setTab] = useState("map");
  const [selectedStopId, setSelectedStopId] = useState(null);
  const [placingStopId, setPlacingStopId] = useState(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [compile, setCompile] = useState({ state: "idle" });
  const [fitEpoch, setFitEpoch] = useState(0);
  const [restored, setRestored] = useState(false);
  const [shared, setShared] = useState(false);
  const abortRef = useRef(null);
  const validateTimer = useRef(null);

  // Draft persistence: the plan survives a reload.
  useEffect(() => {
    if (!open || restored) return;
    const draft = loadDraft();
    if (draft && draft.spec) {
      setSpec(draft.spec);
      setTurns(Array.isArray(draft.turns) ? draft.turns.filter((x) => x.status !== "streaming") : []);
      setGeometryStale(true);
    }
    setRestored(true);
  }, [open, restored]);
  useEffect(() => {
    if (!restored) return;
    const hasContent = (spec.lines || []).length > 0 || (spec.stops || []).length > 0 || turns.length > 0;
    saveDraft(hasContent ? { spec, turns: turns.slice(-12) } : null);
  }, [spec, turns, restored]);

  // Live validation (debounced) on every change.
  useEffect(() => {
    if (!open) return undefined;
    const empty = !(spec.lines || []).length && !(spec.stops || []).length && !spec.agency?.name;
    if (empty) {
      setValidation(null);
      return undefined;
    }
    clearTimeout(validateTimer.current);
    validateTimer.current = setTimeout(() => {
      validateSpec(spec)
        .then(setValidation)
        .catch(() => {});
    }, 350);
    return () => clearTimeout(validateTimer.current);
  }, [spec, open]);

  const refreshRoutes = useCallback(async () => {
    if (routing) return;
    setRouting(true);
    try {
      const r = await estimateSpec(spec);
      const geo = [];
      for (const l of r.lines || []) for (const d of l.directions || []) if (d.routable) geo.push({ lineId: l.id, directionId: d.id, color: l.color, points: d.points, distance_km: d.distance_km, running_min: d.running_min });
      setGeometry(geo);
      setGeometryStale(false);
      setFitEpoch((e) => e + 1);
    } catch {
      /* keep the previous geometry */
    } finally {
      setRouting(false);
    }
  }, [spec, routing]);

  // Route automatically once every stop has coordinates and the plan changed.
  useEffect(() => {
    if (!validation || !geometryStale || routing) return undefined;
    if (validation.estimate?.stops_without_coordinates > 0 || !(validation.spec?.lines || []).length) return undefined;
    const id = setTimeout(refreshRoutes, 600);
    return () => clearTimeout(id);
  }, [validation, geometryStale, routing, refreshRoutes]);

  const updateSpec = useCallback((next) => {
    setSpec(next);
    setGeometryStale(true);
  }, []);

  const near = useMemo(() => centroid(spec.stops), [spec.stops]);

  // ── Planner turn ─────────────────────────────────────────────────────────
  const runPlan = useCallback(
    async (message, { answersFor = null } = {}) => {
      if (streaming) return;
      const userTurn = { id: newId(), role: "user", content: message };
      const assistantTurn = { id: newId(), role: "assistant", content: "", steps: [], questions: [], status: "streaming" };
      setTurns((prev) => [...prev.map((x) => (answersFor && x.id === answersFor ? { ...x, answered: true } : x)), userTurn, assistantTurn]);
      setStreaming(true);
      setPendingTool(null);
      const abort = new AbortController();
      abortRef.current = abort;
      const patch = (fn) => setTurns((prev) => prev.map((x) => (x.id === assistantTurn.id ? { ...x, ...fn(x) } : x)));
      const history = turns.filter((x) => x.content).map((x) => ({ role: x.role, content: x.content }));
      const hasSpec = (spec.lines || []).length > 0;
      try {
        await streamPlan({
          brief: message,
          spec: hasSpec ? spec : null,
          messages: history,
          language,
          near,
          signal: abort.signal,
          onEvent: (event, data) => {
            switch (event) {
              case "token":
                patch((x) => ({ content: x.content + (data.text || "") }));
                break;
              case "tool_pending":
                setPendingTool(data.name || null);
                break;
              case "step":
                patch((x) => ({ steps: [...x.steps, data] }));
                break;
              case "spec":
                setSpec(editableFromNormalized(data.spec));
                setValidation({ ok: data.ok, spec: data.spec, issues: data.issues, blockers: data.blockers, estimate: data.estimate, plan: validation?.plan || null });
                setGeometryStale(true);
                patch((x) => ({ steps: [...x.steps, { kind: "spec", ok: data.ok, blockers: (data.blockers || []).length }] }));
                break;
              case "geometry": {
                const geo = [];
                for (const l of data.lines || []) for (const d of l.directions || []) if (d.routable) geo.push({ lineId: l.id, directionId: d.id, color: l.color, points: d.points, distance_km: d.distance_km, running_min: d.running_min });
                setGeometry(geo);
                setGeometryStale(false);
                setFitEpoch((e) => e + 1);
                patch((x) => ({ steps: [...x.steps, { kind: "geometry" }] }));
                break;
              }
              case "questions":
                patch(() => ({ questions: data.questions || [] }));
                break;
              case "error":
                patch(() => ({ error: data.message || data.code, status: "error" }));
                break;
              case "done":
                patch((x) => ({ status: x.status === "error" ? "error" : "complete" }));
                break;
              default:
            }
          },
        });
      } catch (err) {
        patch(() => ({ status: "error", error: err.code === "ABORTED" ? t("network.stopped") : err.message }));
      } finally {
        abortRef.current = null;
        setStreaming(false);
        setPendingTool(null);
      }
    },
    [streaming, turns, spec, language, near, t, validation],
  );

  const stopPlan = useCallback(() => abortRef.current?.abort(), []);

  // ── Build ────────────────────────────────────────────────────────────────
  const build = useCallback(async () => {
    if (compile.state === "running") return;
    setCompile({ state: "running" });
    try {
      const result = await compileSpec(spec, { shapes: true });
      setCompile({ state: "done", result });
    } catch (err) {
      setCompile({ state: "error", error: err.message, code: err.code, issues: err.body?.issues || null });
    }
  }, [compile.state, spec]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setSpec(EMPTY_SPEC);
    setValidation(null);
    setGeometry([]);
    setTurns([]);
    setCompile({ state: "idle" });
    setSelectedStopId(null);
    setPlacingStopId(null);
    saveDraft(null);
  }, []);

  const openResult = useCallback(() => {
    if (compile.state !== "done") return;
    const result = compile.result;
    saveDraft(null);
    setCompile({ state: "idle" });
    onCreated(result);
  }, [compile, onCreated]);

  const issues = validation?.issues || [];
  const blockers = validation?.blockers || [];
  const warnings = issues.filter((i) => i.level === "warning");
  const estimate = validation?.estimate || null;
  const plan = validation?.plan || null;
  const canBuild = Boolean(validation && validation.ok && !plan?.over_limit) && compile.state !== "running";
  const hasCode = (() => {
    try {
      return Boolean(localStorage.getItem(BETA_CODE_STORAGE_KEY));
    } catch {
      return false;
    }
  })();
  const canPlan = chatEnabled && (hasCode || features?.chat?.freeMessages > 0);
  const disabledReason = !chatEnabled ? t("network.assistantOff") : !canPlan ? t("network.assistantNeedsCode") : null;

  const validationSummary = (report) => {
    const counts = report?.counts || {};
    const errors = counts.errors ?? (report?.valid === false ? 1 : 0);
    return { errors, warnings: counts.warnings ?? 0 };
  };

  return (
    <Dialog open={open} onClose={onClose} fullScreen PaperProps={{ sx: { background: theme.palette.background.default } }} data-testid="network-studio">
      {/* Header */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, px: 2, py: 1, borderBottom: `1px solid ${alpha(theme.palette.divider, 1)}`, background: theme.palette.background.paper }}>
        <Box sx={{ width: 34, height: 34, borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart}, ${theme.palette.ai.gradientEnd})`, color: theme.palette.ai.contrastText }}>
          <BuildCircleOutlinedIcon sx={{ fontSize: 20 }} />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 800, fontSize: "1rem", lineHeight: 1.2 }}>{t("network.title")}</Typography>
          <Typography sx={{ fontSize: "0.74rem", color: "text.secondary" }} noWrap>
            {t("network.subtitle")}
          </Typography>
        </Box>
        {plan && plan.max_lines != null && plan.name === "free" && (
          <Tooltip title={t("network.plan.freeHint", { max: plan.max_lines })}>
            <Chip size="small" icon={<LockOutlinedIcon sx={{ fontSize: 13 }} />} label={t("network.plan.free", { max: plan.max_lines })} color={plan.over_limit ? "warning" : "default"} onClick={() => window.dispatchEvent(new CustomEvent(PRICING_EVENT, { detail: { reason: plan.over_limit ? "network_limit" : null } }))} data-testid="network-plan-chip" sx={{ height: 22, fontSize: "0.66rem", fontWeight: 700 }} />
          </Tooltip>
        )}
        <Tooltip title={t("network.startOver")}>
          <span>
            <IconButton size="small" onClick={reset} disabled={streaming} aria-label={t("network.startOver")} data-testid="network-reset">
              <RestartAltIcon />
            </IconButton>
          </span>
        </Tooltip>
        <IconButton size="small" onClick={onClose} aria-label={t("app.close")} data-testid="network-close">
          <CloseIcon />
        </IconButton>
      </Box>

      {/* Body */}
      <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: isMobile ? "column" : "row" }}>
        <Box sx={{ width: isMobile ? "100%" : 440, flexShrink: 0, borderRight: isMobile ? "none" : `1px solid ${alpha(theme.palette.divider, 1)}`, background: theme.palette.background.paper, minHeight: isMobile ? 320 : 0, display: "flex", flexDirection: "column" }}>
          <PlanChat turns={turns} streaming={streaming} pendingTool={pendingTool} onSend={runPlan} onStop={stopPlan} canPlan={canPlan} disabledReason={disabledReason} />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <Box sx={{ display: "flex", alignItems: "center", px: 1.5, borderBottom: `1px solid ${alpha(theme.palette.divider, 1)}`, background: theme.palette.background.paper }}>
            <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ minHeight: 40, "& .MuiTab-root": { minHeight: 40, textTransform: "none", fontWeight: 600, fontSize: "0.8rem" } }}>
              <Tab value="map" icon={<MapOutlinedIcon sx={{ fontSize: 16 }} />} iconPosition="start" label={t("network.tab.map")} data-testid="network-tab-map" />
              <Tab value="lines" icon={<RouteOutlinedIcon sx={{ fontSize: 16 }} />} iconPosition="start" label={`${t("network.tab.lines")}${spec.lines?.length ? ` (${spec.lines.length})` : ""}`} data-testid="network-tab-lines" />
              <Tab value="stops" icon={<PlaceOutlinedIcon sx={{ fontSize: 16 }} />} iconPosition="start" label={`${t("network.tab.stops")}${spec.stops?.length ? ` (${spec.stops.length})` : ""}`} data-testid="network-tab-stops" />
              <Tab value="json" icon={<DataObjectOutlinedIcon sx={{ fontSize: 16 }} />} iconPosition="start" label="JSON" data-testid="network-tab-json" />
            </Tabs>
            <Box sx={{ flex: 1 }} />
            <Tooltip title={t("network.refreshRoutes")}>
              <span>
                <IconButton size="small" onClick={refreshRoutes} disabled={routing || !validation || validation.estimate?.stops_without_coordinates > 0} aria-label={t("network.refreshRoutes")}>
                  {routing ? <CircularProgress size={16} /> : <RefreshIcon sx={{ fontSize: 18, color: geometryStale ? "warning.main" : "inherit" }} />}
                </IconButton>
              </span>
            </Tooltip>
          </Box>
          <Box sx={{ flex: 1, minHeight: 0, position: "relative", overflow: tab === "map" ? "hidden" : "auto", p: tab === "map" ? 0 : 1.5 }}>
            {tab === "map" && (
              <>
                <NetworkMap stops={spec.stops || []} lines={validation?.spec?.lines || spec.lines || []} geometry={geometry} selectedStopId={selectedStopId} placingStopId={placingStopId} onSelectStop={setSelectedStopId} onMoveStop={(id, lat, lon) => updateSpec({ ...spec, stops: spec.stops.map((s) => (s.id === id ? { ...s, lat, lon } : s)) })} onPlaceStop={(id, lat, lon) => { updateSpec({ ...spec, stops: spec.stops.map((s) => (s.id === id ? { ...s, lat, lon } : s)) }); setPlacingStopId(null); }} fitEpoch={fitEpoch} />
                {placingStopId && (
                  <Box sx={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 1000, px: 1.5, py: 0.6, borderRadius: 99, background: theme.palette.warning.main, color: theme.palette.warning.contrastText, fontSize: "0.76rem", fontWeight: 700, boxShadow: 3 }}>
                    {t("network.placingHint", { name: (spec.stops || []).find((s) => s.id === placingStopId)?.name || "" })}
                  </Box>
                )}
                {!(spec.stops || []).some((s) => Number.isFinite(s.lat)) && (
                  <Box sx={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none", zIndex: 900 }}>
                    <Typography sx={{ px: 2, py: 1, borderRadius: 2, background: alpha(theme.palette.background.paper, 0.9), fontSize: "0.82rem", color: "text.secondary", maxWidth: 360, textAlign: "center" }}>{t("network.map.empty")}</Typography>
                  </Box>
                )}
              </>
            )}
            {tab === "lines" && <LinesEditor spec={spec} onChange={updateSpec} />}
            {tab === "stops" && <StopsEditor spec={spec} onChange={updateSpec} selectedStopId={selectedStopId} onSelectStop={setSelectedStopId} placingStopId={placingStopId} onPlaceRequest={(id) => { setPlacingStopId(id); if (id) setTab("map"); }} near={near} />}
            {tab === "json" && <JsonEditor key={turns.length} spec={spec} onChange={updateSpec} />}
          </Box>

          {/* Footer: estimate, issues, build */}
          <Box sx={{ borderTop: `1px solid ${alpha(theme.palette.divider, 1)}`, background: theme.palette.background.paper }}>
            <Collapse in={issuesOpen && issues.length > 0}>
              <Box sx={{ maxHeight: 180, overflowY: "auto", px: 2, py: 1, display: "flex", flexDirection: "column", gap: 0.3 }} data-testid="network-issues">
                {[...blockers, ...warnings].slice(0, 60).map((i, k) => (
                  <Box key={k} sx={{ display: "flex", alignItems: "flex-start", gap: 0.6, fontSize: "0.74rem", color: i.level === "error" ? "error.main" : "text.secondary" }}>
                    {i.level === "error" ? <ErrorOutlineIcon sx={{ fontSize: 14, mt: 0.2 }} /> : <WarningAmberIcon sx={{ fontSize: 14, mt: 0.2 }} />}
                    <span>
                      {i.message} <Box component="span" sx={{ fontFamily: "monospace", color: "text.disabled" }}>{i.path}</Box>
                    </span>
                  </Box>
                ))}
              </Box>
            </Collapse>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 1, flexWrap: "wrap" }}>
              {estimate ? (
                <>
                  <Chip size="small" label={t("network.estimate.lines", { count: estimate.lines })} sx={{ height: 22, fontSize: "0.68rem" }} />
                  <Chip size="small" label={t("network.estimate.stops", { count: estimate.stops })} color={estimate.stops_without_coordinates ? "warning" : "default"} sx={{ height: 22, fontSize: "0.68rem" }} />
                  <Chip size="small" label={t("network.estimate.trips", { count: estimate.trips })} sx={{ height: 22, fontSize: "0.68rem" }} />
                  {geometry.length > 0 && <Chip size="small" label={t("network.estimate.km", { km: Math.round(geometry.reduce((a, g) => a + (g.distance_km || 0), 0)) })} sx={{ height: 22, fontSize: "0.68rem" }} />}
                  <Box component="button" type="button" onClick={() => setIssuesOpen((v) => !v)} data-testid="network-issues-toggle" sx={{ all: "unset", cursor: issues.length ? "pointer" : "default", display: "flex", alignItems: "center", gap: 0.5, fontSize: "0.74rem", fontWeight: 700, color: blockers.length ? "error.main" : warnings.length ? "warning.dark" : "success.main" }}>
                    {blockers.length ? <ErrorOutlineIcon sx={{ fontSize: 15 }} /> : warnings.length ? <WarningAmberIcon sx={{ fontSize: 15 }} /> : <CheckCircleOutlineIcon sx={{ fontSize: 15 }} />}
                    {blockers.length ? t("network.issues.blockers", { count: blockers.length }) : warnings.length ? t("network.issues.warnings", { count: warnings.length }) : t("network.issues.none")}
                    {issues.length > 0 && <ExpandMoreIcon sx={{ fontSize: 15, transform: issuesOpen ? "rotate(180deg)" : "none", transition: "transform 160ms" }} />}
                  </Box>
                </>
              ) : (
                <Typography sx={{ fontSize: "0.76rem", color: "text.disabled" }}>{t("network.estimate.empty")}</Typography>
              )}
              <Box sx={{ flex: 1 }} />
              <Button variant="contained" disableElevation disabled={!canBuild} onClick={build} startIcon={compile.state === "running" ? <CircularProgress size={14} color="inherit" /> : <BuildCircleOutlinedIcon />} data-testid="network-build" sx={{ textTransform: "none", fontWeight: 800 }}>
                {compile.state === "running" ? t("network.building") : t("network.build")}
              </Button>
            </Box>
            {compile.state === "running" && <LinearProgress sx={{ height: 3 }} />}
            {compile.state === "error" && (
              <Alert
                severity="error"
                onClose={() => setCompile({ state: "idle" })}
                action={compile.code === "PLAN_LIMIT" ? <Button color="inherit" size="small" onClick={() => window.dispatchEvent(new CustomEvent(PRICING_EVENT, { detail: { reason: "network_limit" } }))} sx={{ textTransform: "none", fontWeight: 700 }}>{t("network.plan.upgrade")}</Button> : null}
                sx={{ mx: 2, mb: 1, fontSize: "0.78rem" }}
              >
                {compile.code === "PLAN_LIMIT" ? t("network.plan.limitReached") : compile.error}
              </Alert>
            )}
          </Box>
        </Box>
      </Box>

      {/* Result */}
      <Dialog open={compile.state === "done"} onClose={() => setCompile({ state: "idle" })} maxWidth="xs" fullWidth data-testid="network-result">
        {compile.state === "done" && (
          <Box sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.25 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <CheckCircleOutlineIcon sx={{ fontSize: 30, color: "success.main" }} />
              <Typography sx={{ fontWeight: 800, fontSize: "1.05rem" }}>{t("network.result.title")}</Typography>
            </Box>
            <Typography sx={{ fontSize: "0.82rem", color: "text.secondary", lineHeight: 1.5 }}>
              {t("network.result.body", { routes: compile.result.counts?.routes ?? 0, stops: compile.result.counts?.stops ?? 0, trips: compile.result.counts?.trips ?? 0, stopTimes: compile.result.counts?.stop_times ?? 0 })}
            </Typography>
            {(() => {
              const v = validationSummary(compile.result.validationReport);
              return (
                <Chip size="small" icon={v.errors ? <ErrorOutlineIcon sx={{ fontSize: 14 }} /> : <CheckCircleOutlineIcon sx={{ fontSize: 14 }} />} color={v.errors ? "error" : "success"} variant="outlined" label={v.errors ? t("network.result.validationErrors", { errors: v.errors, warnings: v.warnings }) : t("network.result.validationOk", { warnings: v.warnings })} sx={{ alignSelf: "flex-start", height: 24, fontSize: "0.7rem", fontWeight: 700 }} />
              );
            })()}
            {compile.result.stats?.routing_fallback_legs > 0 && <Typography sx={{ fontSize: "0.74rem", color: "warning.dark" }}>{t("network.result.fallback", { count: compile.result.stats.routing_fallback_legs })}</Typography>}
            <Box sx={{ display: "flex", gap: 1, justifyContent: "flex-end", mt: 0.5, flexWrap: "wrap" }}>
              <Button
                size="small"
                startIcon={shared ? <CheckCircleOutlineIcon /> : <ContentCopyIcon />}
                onClick={async () => {
                  const c = compile.result.counts || {};
                  try {
                    await navigator.clipboard.writeText(t("network.result.shareText", { routes: c.routes ?? 0, stops: c.stops ?? 0, trips: c.trips ?? 0 }));
                    setShared(true);
                  } catch {
                    /* clipboard unavailable */
                  }
                }}
                data-testid="network-share"
                sx={{ textTransform: "none", mr: "auto" }}
              >
                {shared ? t("network.result.shared") : t("network.result.share")}
              </Button>
              <Button onClick={() => setCompile({ state: "idle" })} sx={{ textTransform: "none" }}>
                {t("network.result.stay")}
              </Button>
              <Button variant="contained" disableElevation onClick={openResult} data-testid="network-open" sx={{ textTransform: "none", fontWeight: 800 }}>
                {t("network.result.open")}
              </Button>
            </Box>
          </Box>
        )}
      </Dialog>
    </Dialog>
  );
}
