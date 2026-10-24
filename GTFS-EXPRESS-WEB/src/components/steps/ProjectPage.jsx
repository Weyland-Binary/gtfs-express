/**
 * A modify project at /p/:id/:step: its steps until its network is open in this tab, then its draft's one screen
 * (the Change Studio beside the reader, `panel`). The network open here is the project's only when it is the one
 * the project recorded and its working copy still lives on the server; otherwise « Reprendre » brings the last
 * frozen version back from its zip, never by downloading the catalogue again.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, Button, IconButton, Tooltip, useTheme } from "@mui/material";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useProject, activeScenarioOf, ProjectContext, remoteEnabled, withJournal } from "../../utils/projectStore";
import { bindWorkspaceSession, keepWorkspaceDocument, removeWorkspaceDocument } from "../../utils/projectApi";
import { humanError } from "../../utils/humanError";
import { useNavigate, projectPath, projectExplorerPath, HOME_PATH } from "../../utils/routes";
import { Rail } from "../AppShell";
import ChangeStudio from "../transform/ChangeStudio";
import FindNetworkPanel from "../FindNetworkPanel";
import StepNav, { stepFor, stepStates } from "./StepNav";
import StepFrame from "./StepFrame";
import StudioPaywall from "../billing/StudioPaywall";
import { licenceLockOf, useFeatures } from "../../utils/featuresApi";
import { frozenVersionOf } from "../../utils/projectVersions";
import { DOCUMENT_EVENT, PROJECT_RESTORED_EVENT } from "../../utils/appEvents";

/** The rail's facts when the project's flow is not running here. */
export const recordedFacts = (project) => ({
  named: Boolean(String(project.name ?? "").trim()),
  started: false,
  delivered: Boolean(activeScenarioOf(project)?.applied_version_id),
});

export const ownsNetwork = (project, networkLoaded, networkHandle) => Boolean(networkLoaded && project?.network?.network_id && project.network.network_id === networkHandle);

export function NetworkSource({ onOpened, onPickFile, onDropFile = null }) {
  return (
    <Box data-testid="network-source" sx={{ display: "flex", flexDirection: "column", px: { xs: 0, md: 2 } }}>
      <FindNetworkPanel onOpened={onOpened} onUploadInstead={onPickFile} onDropFile={onDropFile} />
    </Box>
  );
}

// Working copies brought back in this tab, until their notice is closed: project id → { n, at }.
const RESTORED = new Map();
// Projects this tab already restored by itself: once per tab, a failure leaves « Reprendre ».
const AUTO_RESUMED = new Set();

/** Another network open in this tab is never replaced without the person's « Reprendre ». */
export const autoResumes = ({ project, frozen, ownNetwork, networkLoaded, sessionLost, canResume }) => Boolean(project && frozen && canResume && !ownNetwork && (!networkLoaded || sessionLost) && !AUTO_RESUMED.has(project.id));

export default function ProjectPage({ id, step = null, networkLoaded = false, networkHandle = null, sessionLost = false, unfrozenEdits = null, onNetworkOpened = null, onPickFile = null, onDropFile = null, onResume = null, handover = null, onHandoverTaken = null, actor = null, onOpenReader = null, onDraft = null, lens = null, panel = false, view = null, onView = null, barHost = null, headerHost = null, sideHost = null, panelOpen = null, onPanelOpened = null, onLeave = null }) {
  const { t } = useLanguage();
  const studio = Boolean(useTheme().studio);
  const navigate = useNavigate();
  const [project, update] = useProject(id);
  const { features } = useFeatures();
  const studioLock = licenceLockOf(features?.access);
  const [facts, setFacts] = useState({});
  const [resuming, setResuming] = useState({ busy: false, error: null });
  // Kept across a remount of the page (the app shows its loader while it restores).
  const [restored, setRestoredState] = useState(() => RESTORED.get(id) || null);
  const setRestored = useCallback(
    (value) => {
      if (value) RESTORED.set(id, value);
      else RESTORED.delete(id);
      setRestoredState(value);
      window.dispatchEvent(new CustomEvent(PROJECT_RESTORED_EVENT, { detail: { id } }));
    },
    [id],
  );
  useEffect(() => {
    const handler = (e) => {
      if (e?.detail?.id === id) setRestoredState(RESTORED.get(id) || null);
    };
    window.addEventListener(PROJECT_RESTORED_EVENT, handler);
    return () => window.removeEventListener(PROJECT_RESTORED_EVENT, handler);
  }, [id]);
  // A step the rail does not show (④, an old address) opens the next one.
  const current = stepFor(step || project?.step || 1);

  useEffect(() => {
    if (!project || panel) return;
    if (!step) navigate(projectPath(id, stepFor(project.step || 1)), { replace: true });
    else if (stepFor(step) !== step) navigate(projectPath(id, stepFor(step)), { replace: true });
    else if (project.step !== step) update({ step });
  }, [project, step, id, navigate, update, panel]);
  // Kept with the project: the list of works shows them.
  const states = stepStates(facts);
  const statesSignature = JSON.stringify(Object.fromEntries(Object.entries(states).map(([n, s]) => [n, s.state])));
  useEffect(() => {
    if (!project) return;
    const steps = JSON.parse(statesSignature);
    if (JSON.stringify(project.steps) !== statesSignature) update((p) => ({ ...p, steps }));
    // The signature says when the states changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statesSignature, Boolean(project)]);

  const onStep = useCallback((n) => navigate(projectPath(id, n)), [navigate, id]);
  const handoverTaken = useCallback(() => onHandoverTaken?.(id), [onHandoverTaken, id]);
  const ownNetwork = !sessionLost && ownsNetwork(project, networkLoaded, networkHandle);
  const waitsForNetwork = Boolean(project && !ownNetwork);
  const recordedSignature = project && waitsForNetwork ? JSON.stringify(recordedFacts(project)) : null;
  useEffect(() => {
    if (recordedSignature) setFacts(JSON.parse(recordedSignature));
  }, [recordedSignature]);

  // Bound on the server, the working copy's edits become snapshot versions.
  const bound = useRef(null);
  useEffect(() => {
    if (!project || !ownNetwork || !remoteEnabled()) return;
    const key = `${project.id}:${networkHandle}`;
    if (bound.current === key) return;
    bound.current = key;
    bindWorkspaceSession(project.id).catch(() => {
      bound.current = null;
    });
  }, [project, ownNetwork, networkHandle]);

  useEffect(() => {
    if (!project) return undefined;
    const pid = project.id;
    const handler = (e) => {
      const { action, document: d } = e?.detail || {};
      if (!d?.id) return;
      if (action === "removed") {
        update((p) => ({ ...p, documents: (p.documents || []).filter((x) => x.id !== d.id) }));
        if (remoteEnabled()) removeWorkspaceDocument(pid, d.id).catch(() => {});
        return;
      }
      // `expires_at` is the studio's memory's until the server keeps the document.
      const keeping = remoteEnabled();
      const record = { id: d.id, name: d.name, kind: d.kind || null, pages: d.pages ?? null, size: d.size ?? null, sent_to_assistant: d.sent_to_assistant !== false, kept: false, keeping, gone: false, expires_at: d.expiresAt || null };
      update((p) => withJournal({ ...p, documents: [...(p.documents || []).filter((x) => x.id !== d.id), record] }, { actor, action: "document", object: d.name }));
      if (!keeping) return;
      const settle = (change) => update((p) => ({ ...p, documents: (p.documents || []).map((x) => (x.id === d.id ? { ...x, keeping: false, ...change(x) } : x)) }));
      keepWorkspaceDocument(pid, d.id)
        .then((out) => settle((x) => ({ kept: true, gone: false, expires_at: out.document?.expires_at || x.expires_at })))
        // Gone only when the server says so; otherwise still usable until its date.
        .catch((err) => settle(() => ({ kept: false, gone: err?.code === "DOCUMENT_NOT_FOUND", keep_error: err?.code || null })));
    };
    window.addEventListener(DOCUMENT_EVENT, handler);
    return () => window.removeEventListener(DOCUMENT_EVENT, handler);
    // One listener per project; `update` and `actor` are read when a document arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const frozen = frozenVersionOf(project);
  const needsNetwork = Boolean(project && !ownNetwork);
  const resume = useCallback(async () => {
    if (!frozen || !onResume) return;
    setResuming({ busy: true, error: null });
    try {
      await onResume(project, frozen);
      update((p) => withJournal(p, { actor, action: "resumed", object: `v${frozen.n}`, reason: "working_copy_expired" }));
      setResuming({ busy: false, error: null });
      setRestored({ n: frozen.n, at: frozen.at || null });
    } catch (err) {
      setResuming({ busy: false, error: humanError(err, t).message });
    }
  }, [frozen, onResume, project, update, actor, t, setRestored]);
  // Opened where its network is not (a new tab, a reload after the working copy expired): the last frozen version
  // comes back by itself, once per tab; a failure keeps « Reprendre ».
  const autoResume = autoResumes({ project, frozen, ownNetwork, networkLoaded, sessionLost, canResume: Boolean(onResume) });
  useEffect(() => {
    // Checked again here: an effect run twice (a remount) must not restore twice.
    if (!autoResume || AUTO_RESUMED.has(project.id)) return;
    AUTO_RESUMED.add(project.id);
    resume();
  }, [autoResume, project, resume]);
  // Any frozen version becomes this tab's working copy, from its zip; the version itself stays frozen. Throws
  // the server's refusal.
  const reopen = useCallback(
    async (version) => {
      if (!onResume || !version) return null;
      const out = await onResume(project, version);
      update((p) => withJournal(p, { actor, action: "restored", object: `v${version.n}`, reason: "version_restore" }));
      setRestored({ n: version.n, at: version.at || null });
      return out;
    },
    [onResume, project, update, actor, setRestored],
  );
  // The working copy gone (SESSION_NOT_FOUND): « Reprendre », or ① to choose the network again.
  const recover = useCallback(() => (frozen && onResume ? resume() : onStep(1)), [frozen, onResume, resume, onStep]);
  const context = useMemo(
    () => (project ? { project, update, actor, ownNetwork, unfrozenEdits: ownNetwork ? unfrozenEdits : null, resume: needsNetwork && (frozen || current > 1) ? { version: frozen, onResume: resume, busy: resuming.busy, error: resuming.error } : null, restored: needsNetwork ? null : restored, onRestoredSeen: () => setRestored(null), reopen: onResume ? reopen : null } : null),
    [project, update, actor, ownNetwork, unfrozenEdits, needsNetwork, frozen, current, resume, resuming, restored, setRestored, onResume, reopen],
  );

  if (!project || project.job !== "modify") {
    return (
      <Box sx={{ py: 3, maxWidth: 720 }}>
        <Alert severity="warning" data-testid="project-not-found" action={<Button color="inherit" size="small" onClick={() => navigate(HOME_PATH)} sx={{ textTransform: "none", fontWeight: 700 }}>{t("refusal.PROJECT_NOT_FOUND.action")}</Button>}>
          <strong>{t("refusal.PROJECT_NOT_FOUND.title")}</strong> — {t("refusal.PROJECT_NOT_FOUND.body")}
        </Alert>
      </Box>
    );
  }

  const seeNetwork = !ownNetwork ? null : studio ? (
    <Tooltip title={t("step.seeNetwork")}>
      <IconButton size="small" onClick={() => navigate(projectExplorerPath(id))} aria-label={t("step.seeNetwork")} data-testid="project-see-network" sx={{ ml: 0.5 }}>
        <VisibilityOutlinedIcon sx={{ fontSize: 18 }} />
      </IconButton>
    </Tooltip>
  ) : (
    <Button size="small" startIcon={<VisibilityOutlinedIcon />} onClick={() => navigate(projectExplorerPath(id))} data-testid="project-see-network" sx={{ textTransform: "none", fontWeight: 700, flexShrink: 0 }}>
      {t("step.seeNetwork")}
    </Button>
  );
  const rail = (
    <Rail>
      <StepNav current={current} states={states} onSelect={onStep} actions={seeNetwork} />
    </Rail>
  );
  const provide = (children) => <ProjectContext.Provider value={context}>{children}</ProjectContext.Provider>;

  // The project is kept; its work waits for the licence.
  if (studioLock === "sign_in_required" || studioLock === "subscription_required") {
    return (
      <>
        {rail}
        <StudioPaywall state={studioLock} project={project} />
      </>
    );
  }

  if (panel) {
    if (waitsForNetwork) return null;
    return provide(
      <ChangeStudio key={`${id}:${networkHandle || "none"}`} view={view} onView={onView} barHost={barHost} headerHost={headerHost} sideHost={sideHost} initialKind={handover?.kind || null} panelOpen={panelOpen} onPanelOpened={onPanelOpened} onLeave={onLeave} project={project} onUpdateProject={update} onFacts={setFacts} initialBrief={handover?.brief || null} initialFocus={handover?.focus || null} onHandoverTaken={handoverTaken} onRecover={recover} onOpenReader={onOpenReader ? (line) => onOpenReader(id, line) : null} onDraft={onDraft} lens={lens} />,
    );
  }

  // GTFSApp leads the address to the draft's screen.
  if (!waitsForNetwork) return null;
  if (current > 1) {
    // StepFrame's session-expired notice is the one message: never a second banner that contradicts it.
    return provide(
      <>
        {rail}
        <StepFrame step={current} primary={frozen ? { label: t("recovery.resume"), onClick: resume, busy: resuming.busy, arrow: false } : { label: t("step.back.network"), onClick: () => onStep(1) }} back={{ onClick: () => onStep(current - 1) }} />
      </>,
    );
  }
  // ①: never the card of another network that happens to be open here.
  return provide(
    <>
      {rail}
      <StepFrame step={1} intro={t("step.1.intro.modify")} primary={{ label: t("step.primary.1.modify"), onClick: () => onStep(2), disabled: true, reason: t("step.reason.network") }} testid="step-network" headless>
        {resuming.busy ? null : <NetworkSource onOpened={onNetworkOpened} onPickFile={onPickFile} onDropFile={onDropFile} />}
      </StepFrame>
    </>,
  );
}
