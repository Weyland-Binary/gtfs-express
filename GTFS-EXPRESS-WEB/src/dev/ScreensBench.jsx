/**
 * The draft screen's moments on a fixture, without a server, a model or the client's data; served by the dev server
 * at /dev/screens.html (never built) and captured by e2e/tools/screens-bench.mjs.
 *
 *   ?mode=light|dark  ?lang=fr|en
 *   ?view=hand                 the hand draft's panel open; no view: its decision
 *   ?view=direct&moment=…      the brief draft's whole screen; the moments past the drop are reached as a person
 *                              reaches them, the capture pressing the buttons while the stream plays the fixture
 */

import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, CssBaseline, Box, Typography } from "@mui/material";
import { themeFor } from "../Theme";
import { ThemeModeProvider, LocalizedThemeDefaults } from "../contexts/ThemeContext";
import { LanguageProvider, useLanguage } from "../contexts/LanguageContext";
import { EditModeProvider } from "../contexts/EditModeContext";
import { AccountProvider } from "../contexts/AccountContext";
import { DestructiveGuardProvider } from "../contexts/DestructiveGuardContext";
import { ShortcutsProvider } from "../contexts/ShortcutsContext";
import { DetailPanelProvider } from "../contexts/DetailPanelContext";
import { RouterProvider } from "../utils/routes";
import { workStateOf } from "../utils/workState";
import AppShell from "../components/AppShell";
import Header from "../components/Header/Header";
import StatusBar from "../components/common/StatusBar";
import Footer from "../components/Footer/Footer";
import DirectChange from "../components/transform/DirectChange";
import ReaderBody from "../components/app/ReaderBody";
import { reviewOf } from "../components/transform/changeLines";
import { HandDraft, draftStateOf } from "../components/transform/DraftBar";
import { OperationCard } from "../components/transform/ChangePlanParts";
import DecisionScreen from "../components/transform/DecisionScreen";
import ApplyDialog from "../components/transform/ApplyDialog";
import DraftRetouches from "../components/transform/DraftRetouches";
import { planStatus } from "../components/transform/gate";
import { LANG, benchProjectName, direct as DIRECT, hand as HAND, directionsOf, timetableOf } from "./screensFixtures";
import { installBenchServer } from "./benchServer";
import "../index.css";

const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") === "dark" ? "dark" : "light";
const view = params.get("view");
const moment = params.get("moment") || "drop-empty";
try {
  localStorage.setItem("gtfs:theme", mode);
  localStorage.setItem("appLanguage", LANG);
  // A remembered name makes « Appliquer » with nothing to accept the act itself.
  localStorage.setItem("gtfs:ack-name", "Claire Martin");
} catch {
  /* storage blocked: the theme follows the system */
}
if (view === "direct") installBenchServer(moment === "decide-map" ? "decide-mixed" : moment);
if (view === "hand") installBenchServer(null, { history: HAND.journal });

const Section = ({ id, title, width = 720, height = null, children }) => (
  <Box data-testid={`bench-${id}`} sx={{ p: 2, width, maxWidth: "100%", ...(height ? { height } : {}), display: "flex", flexDirection: "column", gap: 1 }}>
    <Typography sx={{ fontSize: "0.7rem", color: "text.secondary", textTransform: "uppercase", letterSpacing: 1 }}>{title}</Typography>
    {children}
  </Box>
);

const ROUTES = [{ id: "B1", short_name: "B1" }, { id: "B2", short_name: "B2" }, { id: "B6", short_name: "B6" }];
// The decision compares the draft whole with the working copy, so its plan has no operation of its own.
const handPlan = { operations: HAND.operations };
const decisionPlan = { operations: [] };

function HandPanel() {
  const { t } = useLanguage();
  const retouches = HAND.journal.length;
  const state = draftStateOf(t, { kind: "hand", frozen: null, operations: HAND.operations, previewing: false, preview: HAND.planPreview, status: planStatus({ plan: handPlan, preview: HAND.planPreview, previewing: false }), retouches });
  const card = (op) => <OperationCard key={op.id} op={op} step={HAND.planPreview.steps.find((s) => s.id === op.id) || null} def={null} index={HAND.operations.indexOf(op)} count={HAND.operations.length} busy={false} onAnswer={() => {}} onRemove={() => {}} onMove={() => {}} line={op.params?.route || null} />;
  return <HandDraft open onOpen={() => {}} onClose={() => {}} operations={HAND.operations} retouches={retouches} retouchesNode={<DraftRetouches testid="draft-hand-retouches" session="11111111-2222-4333-8444-555555555555" withPlans bare edit={{ editing: true, dataVersion: 0, undoLast: () => {}, jumpToHistory: () => {} }} />} renderOperation={card} state={state} onDeliver={() => {}} onApplied={() => {}} onApply={() => {}} applyDisabled nextN={3} onAbandonAsk={() => {}} onVersions={() => {}} onLeave={() => {}} />;
}

function HandBench() {
  return (
    <Box sx={{ backgroundColor: "background.default", minHeight: "100vh", display: "flex", flexDirection: "column", gap: 2 }}>
      <Section id="h2" title="À la main · Décider" width={900}>
        <Box sx={{ px: 2.5, border: 1, borderColor: "divider", borderRadius: "12px", backgroundColor: "background.paper" }}>
          <DecisionScreen preview={HAND.preview} reviewLines={reviewOf(HAND.preview).lines} plan={decisionPlan} routes={ROUTES} hand nextN={3} applySection={<ApplyDialog open compact hand preview={HAND.preview} plan={decisionPlan} editing enterEditMode={async () => ({ ok: true })} refresh={async () => null} commit={async () => null} onClose={() => {}} />} />
        </Box>
      </Section>
    </Box>
  );
}

const NETWORK = { network_id: "f0e1d2c3b4", name: "New York City Demo Transit", source: "sample" };

const projectFor = (at) => ({
  id: "bench0001",
  job: "modify",
  name: benchProjectName,
  network: NETWORK,
  documents: at === "drop-empty" ? [] : [DIRECT.document],
  versions: [{ n: 1, at: "2026-10-02T09:12:00Z" }, { n: 2, at: "2026-10-12T15:40:00Z" }],
  context: { draft_kind: "brief", from_date: DIRECT.defaultDate, direct: { brief: at === "drop-empty" ? "" : DIRECT.brief } },
});

const AGENCY = { agency_id: "NYCDT", agency_name: NETWORK.name };
const READER_ROUTES = DIRECT.routes.map((r) => ({ route_id: r.id, route_short_name: r.short_name, route_long_name: r.long_name, route_color: r.color, route_text_color: "FFFFFF", route_type: 3, agency_id: AGENCY.agency_id }));
const SHOWN = { route: "B2", direction: "0", date: "2027-01-09" };
const noop = () => {};

function BenchReader() {
  const ymd = SHOWN.date.replace(/-/g, "");
  const times = useMemo(() => timetableOf(SHOWN.route, SHOWN.direction, ymd, true), [ymd]);
  const compare = useMemo(() => {
    const before = new Set(timetableOf(SHOWN.route, SHOWN.direction, ymd, false).stop_times.map((s) => s.trip_id));
    const after = new Set(times.stop_times.map((s) => s.trip_id));
    return { route: SHOWN.route, before: before.size, after: after.size, added: new Set([...after].filter((id) => !before.has(id))), removed: [...before].filter((id) => !after.has(id)).length };
  }, [times, ymd]);
  const feed = { loading: false, agencies: [AGENCY], routes: READER_ROUTES, setRoutes: noop, directions: directionsOf(SHOWN.route, ymd, true), selectedAgency: AGENCY.agency_id, selectedRoute: SHOWN.route, selectedDirection: SHOWN.direction, selectedDate: SHOWN.date, stopsAndTimes: times, shapes: [], allRouteShapes: [], selectedSecondaryTab: 0, setSelectedSecondaryTab: noop, selectedRouteDetails: READER_ROUTES.find((r) => r.route_id === SHOWN.route), error: null, calendar: [], calendarDates: [], stopFilter: "", setStopFilter: noop, focusedStopId: null, setFocusedStopId: noop, handleAgencyChange: noop, handleRouteChange: noop, handleDirectionChange: noop, handleDateChange: noop, studioTarget: null };
  return <ReaderBody feed={feed} sessionLost={false} route={{ name: "projectExplorer", params: { id: "bench0001" } }} sqlConsoleVisible={false} selectedMainTab={1} setSelectedMainTab={noop} setShowValidationReport={noop} lensKey="after" validationReport={null} importAdjustments={null} backgroundValidating={false} validatingSeconds={0} features={null} showSelectorGuide={false} setShowSelectorGuide={noop} openPanel={noop} markedRoutes={new Set(READER_ROUTES.map((r) => r.route_id))} lensCompareShown={compare} />;
}

/** Mirrors GTFSApp's draft screen. */
function DirectScreen() {
  const { t } = useLanguage();
  const [project, setProject] = useState(() => projectFor(moment));
  const [frozen, setFrozen] = useState(null);
  const [view, setView] = useState("change");
  const [headerHost, setHeaderHost] = useState(null);
  const [sideHost, setSideHost] = useState(null);
  const work = useMemo(() => (frozen ? { kind: "applied", n: frozen.n, delivered: false } : workStateOf({ project, networkLoaded: true, ownsNetwork: true })), [project, frozen]);
  const header = <Header agenciesLoaded toolbar draft tabsShown={view === "network"} activeTab="horaires" onSelectTab={noop} work={{ name: project.name, onRename: noop }} draftSlot={setHeaderHost} />;
  const shown = (v) => ({ position: "absolute", inset: 0, display: "flex", flexDirection: "column", visibility: view === v ? "visible" : "hidden" });
  const statusBar = <StatusBar network={{ name: NETWORK.name }} work={{ state: work }} savedAt={new Date("2026-10-19T09:41:00")} validation={{ state: "ok", errors: 0, warnings: 0, at: "2026-10-19T09:40:00" }} />;
  return (
    <AppShell title={`${t("explorer.overview")} · ${NETWORK.name} | GTFS Express`} routeKey="bench" header={header} statusBar={statusBar} legal={<Box sx={{ "& .footer": { position: "static", margin: 0, padding: "2px 8px", boxShadow: "none", borderTop: "none" } }}><Footer /></Box>} flush>
      <Box data-testid="draft-screen" data-view={view} sx={{ flex: 1, minHeight: 0, display: "flex" }}>
        <Box sx={{ flex: 1, minWidth: 0, position: "relative" }}>
        <Box data-testid="draft-network" sx={{ ...shown("network"), overflowY: "auto" }}>{view === "network" && <BenchReader />}</Box>
        <Box data-testid="draft-change" sx={shown("change")}>
        <DirectChange
          project={project}
          onUpdateProject={(fn) => setProject((p) => fn(p))}
          editing
          enterEditMode={async () => ({ ok: true })}
          frozen={frozen}
          nextN={frozen ? frozen.n + 1 : 3}
          routes={DIRECT.routes}
          defaultDate={DIRECT.defaultDate}
          onCommitted={() => setFrozen({ n: 3, by: "Claire Martin", at: "2026-10-19T09:42:00Z" })}
          onAbandon={() => {}}
          onOpenApplied={() => {}}
          onNewDraft={() => setFrozen(null)}
          bar={{ host: headerHost, inHeader: Boolean(headerHost), onMore: noop, onLeave: noop, onDeliver: noop, side: "after", onSide: noop }}
          sideHost={sideHost}
          onViewWanted={setView}
        />
        </Box>
        </Box>
        <Box ref={setSideHost} data-testid="draft-side" sx={{ flexShrink: 0, display: "flex", minHeight: 0 }} />
      </Box>
    </AppShell>
  );
}

const theme = themeFor(mode);
createRoot(document.getElementById("root")).render(
  view === "direct" ? (
    <ThemeModeProvider>
      <RouterProvider>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <LanguageProvider>
            <LocalizedThemeDefaults>
              <ShortcutsProvider>
                <AccountProvider>
                  <EditModeProvider>
                    <DestructiveGuardProvider>
                      <DetailPanelProvider>
                        <DirectScreen />
                      </DetailPanelProvider>
                    </DestructiveGuardProvider>
                  </EditModeProvider>
                </AccountProvider>
              </ShortcutsProvider>
            </LocalizedThemeDefaults>
          </LanguageProvider>
        </ThemeProvider>
      </RouterProvider>
    </ThemeModeProvider>
  ) : (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <LanguageProvider>{view === "hand" ? <HandPanel /> : <HandBench />}</LanguageProvider>
    </ThemeProvider>
  ),
);
