/**
 * ScreensBench — the draft screen's moments mounted on a fixture (dev/screensFixtures), without a server, a model or
 * the client's data. The dev server serves it at /dev/screens.html (never part of the build); e2e/tools/screens-bench.mjs
 * captures each, light and dark, so that a change to these screens is looked at before it is delivered.
 *
 *   ?mode=light|dark       the theme
 *   ?view=hand             by hand, the draft's panel alone, open (a drawer over the page: the capture's target is its
 *                          paper); without a view, bench-h2: its decision (the change, its checks, the act under the
 *                          person's name)
 *   ?view=direct&moment=…  with a brief, the WHOLE screen as the app frames it — the reader's top bar, the draft's bar,
 *                          DirectChange, the status bar and the legal line — with the page's requests answered by
 *                          dev/benchServer: drop-empty, drop-doc (the brief typed, its document sent), progress-early,
 *                          progress-review, progress-correction, question, decide-done, decide-mixed (a demand not
 *                          done, one to check, a change not asked), decide-map (its map of the change), decide-blocked
 *                          (a new validator error), delivering (the confirmation), applied, error-turn. The moments
 *                          past the drop are reached as a person reaches them: the capture presses « Préparer le
 *                          changement » (then « Carte », or « Appliquer » for the last two) and the turn's stream
 *                          plays the fixture's events.
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
import { reviewOf } from "../components/transform/changeLines";
import { HandDraft, draftStateOf } from "../components/transform/DraftBar";
import { OperationCard } from "../components/transform/ChangePlanParts";
import DecisionScreen from "../components/transform/DecisionScreen";
import ApplyDialog from "../components/transform/ApplyDialog";
import DraftRetouches from "../components/transform/DraftRetouches";
import { planStatus } from "../components/transform/gate";
import { direct as DIRECT, hand as HAND } from "./screensFixtures";
import { installBenchServer } from "./benchServer";
import "../index.css";

const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") === "dark" ? "dark" : "light";
const view = params.get("view");
const moment = params.get("moment") || "drop-empty";
try {
  localStorage.setItem("themeMode", mode);
  // The name a person gave at their last act: « Appliquer » with nothing to accept is then the act itself.
  localStorage.setItem("gtfs:ack-name", "Claire Martin");
} catch {
  /* storage blocked: the theme follows the system */
}
if (view === "direct") installBenchServer(moment === "decide-map" ? "decide-mixed" : moment);
// The hand's panel reads the draft's journal.
if (view === "hand") installBenchServer(null, { history: HAND.journal });

const Section = ({ id, title, width = 720, height = null, children }) => (
  <Box data-testid={`bench-${id}`} sx={{ p: 2, width, maxWidth: "100%", ...(height ? { height } : {}), display: "flex", flexDirection: "column", gap: 1 }}>
    <Typography sx={{ fontSize: "0.7rem", color: "text.secondary", textTransform: "uppercase", letterSpacing: 1 }}>{title}</Typography>
    {children}
  </Box>
);

const ROUTES = [{ id: "B1", short_name: "B1" }, { id: "B2", short_name: "B2" }, { id: "B6", short_name: "B6" }];
// The plan of the assistant waiting to join the draft (its question asked); the decision reads the draft compared
// whole with the working copy (no operation of its own).
const handPlan = { operations: HAND.operations };
const decisionPlan = { operations: [] };

/** The hand's panel, open: the state, the draft's retouches (its journal), the assistant's plan waiting, the act. */
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

/** The project a moment opens on: a brief draft on the demo network, its brief typed (and its document sent). */
const projectFor = (at) => ({
  id: "bench0001",
  job: "modify",
  name: "Offre d'hiver 2027",
  network: NETWORK,
  documents: at === "drop-empty" ? [] : [DIRECT.document],
  versions: [{ n: 1, at: "2026-10-02T09:12:00Z" }, { n: 2, at: "2026-10-12T15:40:00Z" }],
  context: { draft_kind: "brief", from_date: DIRECT.defaultDate, direct: { brief: at === "drop-empty" ? "" : DIRECT.brief } },
});

/** The brief draft's whole screen, framed as the app frames it (GTFSApp's draft screen on « Changement »). */
function DirectScreen() {
  const { t } = useLanguage();
  const [project, setProject] = useState(() => projectFor(moment));
  const [frozen, setFrozen] = useState(null);
  const work = useMemo(() => (frozen ? { kind: "applied", n: frozen.n, delivered: false } : workStateOf({ project, networkLoaded: true, ownsNetwork: true })), [project, frozen]);
  const header = <Header agenciesLoaded toolbar draft tabsShown={false} work={{ name: project.name, onRename: () => {} }} />;
  const statusBar = <StatusBar network={{ name: NETWORK.name }} work={{ state: work }} savedAt={new Date("2026-10-19T09:41:00")} validation={{ state: "ok", errors: 0, warnings: 0, at: "2026-10-19T09:40:00" }} />;
  return (
    <AppShell title={`${t("explorer.overview")} — ${NETWORK.name} — GTFS Express`} routeKey="bench" header={header} statusBar={statusBar} legal={<Box sx={{ "& .footer": { position: "static", margin: 0, padding: "2px 8px", boxShadow: "none", borderTop: "none" } }}><Footer /></Box>} flush>
      <Box data-testid="draft-screen" data-view="change" sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
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
          bar={{ onMore: () => {}, onLeave: () => {}, onDeliver: () => {} }}
        />
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
