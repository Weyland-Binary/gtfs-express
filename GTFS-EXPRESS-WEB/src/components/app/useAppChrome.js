/**
 * useAppChrome — the frame around every screen: one title per screen (the screen, then its object, then the product),
 * the shell's key, the work's identity in the top bar (a project's name, renamed in place) and its state in the status
 * bar beside the mode — the network read as it is, the draft in progress, the change applied in vN, a version
 * delivered —, the status bar itself (mode, saving, validation, « Livrer », the working copy's expiry, the account)
 * and the terms line under it. Values assembled from the app's state; nothing here fetches.
 */
import React, { useMemo } from "react";
import { Box } from "@mui/material";
import StatusBar, { undeliveredEditsOf, validationCaseOf } from "../common/StatusBar";
import EditModeToggle, { DeliverButton } from "../edit/EditModeToggle";
import Footer from "../Footer/Footer";
import { stepFor, stepHeading } from "../steps/StepNav";
import { documentTitle, projectPath } from "../../utils/routes";
import { workStateOf } from "../../utils/workState";
import { useProjectSync } from "../../utils/projectStore";
import { summarizeReport } from "../../utils/validationSummary";

// The title index.html ships (the indexed landing's, also its og preview):
// Home keeps it, only the other screens write their own.
const STATIC_TITLE = typeof document !== "undefined" && document.title ? document.title : documentTitle();

export default function useAppChrome({ route, project, inExplorer, view, agencies, t, networkIdRef, sessionClock, sessionLost, navigate, updateOpenProject, editing, pendingEdits, dataVersion, backgroundValidating, validatingSeconds, validationStale, reportAt, features, vouchedValidation, dataLoading, validationReport, shareToken, draftScreen, openPanel, setShowValidationReport, pollSession }) {
  // When the work was last written, for the status bar's "Enregistré 14:32":
  // in edit mode every edit (and every undo) is saved on the server as it is
  // made, so the time moves with the undelivered count and the data version.
  const savedAt = useMemo(() => (editing ? new Date() : null), [editing, pendingEdits, dataVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const networkName = agencies[0]?.agency_name || agencies[0]?.agency_id || "";
  const viewLabels = {
    apercu: t("explorer.overview"),
    horaires: t("header.tabSchedules"),
    traces: t("explorer.shapes"),
    sql: t("sqlConsole.headerBtn"),
    comparer: t("compare.tab"),
    validation: t("explorer.validation"),
  };
  // Inside a project: its step ("Étape 3 sur 5 : Changement — Rentrée 2026 — GTFS Express"), or its explorer.
  const projectStep = route.name === "project" ? route.params.step || project?.step || 1 : null;
  const stepJob = project?.job === "modify" ? "modify" : "create";
  // One title per screen (RGAA 8.6): the screen, then its object, then the product.
  const pageTitle =
    route.name === "legal"
      ? documentTitle(t(`legal.tab.${route.params.tab}`))
      : route.name === "rules"
        ? documentTitle(t("rules.title"))
        : route.name === "accessibility"
          ? documentTitle(t("a11y.statement"))
          : route.name === "share"
            ? documentTitle(t("share.landingKicker"))
            : route.name === "project" && project
              ? documentTitle(stepHeading(t, stepFor(projectStep || 1, stepJob), stepJob), project.name)
              : route.name === "project"
                ? documentTitle(t("refusal.PROJECT_NOT_FOUND.title"))
                : inExplorer && agencies.length
                  ? documentTitle(viewLabels[view], route.name === "projectExplorer" && project ? project.name : networkName)
                  : route.name === "home"
                    ? documentTitle(t("home.projects"))
                    : STATIC_TITLE;
  const routeKey = route.name === "legal" ? `conditions/${route.params.tab}` : inExplorer ? `${route.params.id}/${view}` : route.name === "project" ? `p/${route.params.id}/${projectStep}` : route.name || "redirect";
  // In a project, the mode and the delivery belong to its network once it is the one open here.
  // A project owns the network open here only when it is its own (the handle it recorded), whatever its job: a
  // modify project whose tab now holds another network must not show that network's mode nor deliver it.
  const projectOwnsNetwork = !project || Boolean(project.network?.network_id && project.network.network_id === networkIdRef.current);
  // The work's identity in the top bar of the reader and of a project's steps (Header/BarParts): a project's name,
  // renamed in place — the network's name is already the page's (the overview's title, the timetables' agency). Its
  // state stands in the status bar beside the mode, so that the top bars keep their room for the tools. The state: the
  // network read as it is, or the project's draft — its operations not applied and the retouches since its last
  // version (the server's count) —, the change applied in vN, a version delivered. The state leads to where its
  // work is done: the change (③) while something is in progress, the delivery (⑤) once a version holds it.
  const workState = workStateOf({ project, networkLoaded: agencies.length > 0 && !sessionLost, ownsNetwork: Boolean(project) && projectOwnsNetwork, edits: sessionClock?.edits || 0, baseVersionId: sessionClock?.base || null });
  const openWork = project && workState ? () => navigate(projectPath(project.id, workState.kind === "applied" || workState.kind === "version" ? 5 : 3)) : null;
  const work = project ? { name: String(project.name ?? "").trim(), onRename: (name) => updateOpenProject({ name }) } : null;
  const statusWork = workState ? { state: workState, onOpen: openWork } : null;
  const projectSync = useProjectSync(project?.id || null);
  // From T-10 min the status bar says when the working copy expires, with "Prolonger" (a heartbeat at once).
  const sessionMinutes = agencies.length && !sessionLost && sessionClock && sessionClock.remainingMs <= 10 * 60 * 1000 ? Math.max(0, Math.ceil(sessionClock.remainingMs / 60000)) : null;
  const showNetworkCases = agencies.length > 0 && projectOwnsNetwork;
  const reportSummary = summarizeReport(validationReport);
  // The validation case: an act's own run on the network as it now is (an application) over a report read again.
  const validationCase = validationCaseOf({ running: backgroundValidating, summary: reportSummary, stale: validationStale, at: reportAt, unavailable: features?.access?.validator === "unavailable", vouched: vouchedValidation });
  // Home is the screen shown (the same test as the screens' choice below): it is edge to edge.
  const homeShown = !["legal", "rules", "accessibility", "project", "create", "modify"].includes(route.name) && !dataLoading && !(validationReport?.valid === false && validationReport?.structural) && (route.name === "home" || (!agencies.length && !shareToken));
  const statusBar = (
    <StatusBar
      network={showNetworkCases ? { name: networkName } : project ? { name: project.network?.name || project.name } : null}
      mode={showNetworkCases && !draftScreen ? (editing ? "edit" : "read") : null}
      work={statusWork}
      // On a project's steps the acts are the project's own (⑤ applies and delivers, the scenario undoes): the bar
      // says the mode and holds no edit toggle nor « Livrer… » there; the reader
      // inside a project (/p/:id/voir) keeps them for its retouches. Both stay mounted silent there: ⑤'s « Livrer »
      // opens the export preflight by `gtfs:open-export-preflight`, the palette enters edit mode by its event.
      // The toggle stays mounted silent everywhere: « Modifier » in the header leads to the draft, whose edit mode is its own.
      modeControls={showNetworkCases ? (route.name === "project" ? <><EditModeToggle silent /><DeliverButton silent /></> : <EditModeToggle silent />) : null}
      // In a project whose working copy the server binds to its versions, an edit frozen in a version is not « non
      // livrée »: the version case says whether that version is delivered and the retouches no version holds yet.
      pendingEdits={undeliveredEditsOf({ pendingEdits, unfrozenEdits: sessionClock ? sessionClock.edits : null, inProject: Boolean(project && projectOwnsNetwork) })}
      savedAt={savedAt}
      onOpenJournal={() => openPanel("edit_history", "history")}
      validation={showNetworkCases ? { ...validationCase, seconds: validatingSeconds } : null}
      onOpenValidation={showNetworkCases && reportSummary.validated ? () => setShowValidationReport(true) : undefined}
      deliver={showNetworkCases && route.name !== "project" && !draftScreen ? <DeliverButton /> : null}
      projectSave={projectSync ? { state: projectSync.state, at: projectSync.saved_at || null } : null}
      session={sessionMinutes !== null ? { minutes: sessionMinutes, onExtend: () => pollSession({ touch: true }) } : null}
    />
  );
  // The terms and contact line, in the flow under the status bar (never a
  // fixed footer over the page).
  const legal = (
    <Box sx={{ "& .footer": { position: "static", margin: 0, padding: "2px 8px", boxShadow: "none", borderTop: "none" } }}>
      <Footer compact={route.name === "project"} />
    </Box>
  );
  return { networkName, pageTitle, routeKey, work, homeShown, statusBar, legal };
}
