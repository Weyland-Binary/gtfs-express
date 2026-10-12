/**
 * ProjectPage — a project at its address, /p/:id/:step/:tab? (target design
 * §2.2, §2.3, §9; D1, D4, D38, D46).
 *
 * It reads the project (utils/projectStore: the server's workspace, cached
 * in the browser), keeps the step the person is on (a bare /p/:id opens the
 * step it was left at), puts the rail of the five steps in the shell's slot
 * (StepNav, through AppShell's <Rail>) and mounts the flow of the project's
 * job for as long as the project is open — the Network Studio when
 * creating, the Change Studio when modifying — so that moving from step to
 * step keeps the conversation, the design and the simulation: only the page
 * of the step changes. The rail's states come from the flow (`onFacts` →
 * StepNav.stepStates): the page never guesses them.
 *
 * It provides the project to every step (ProjectContext): the conflict
 * notice of an autosave refused because the project changed elsewhere, and
 * the working copy's state — StepFrame says them first, at every step — the
 * documents, the deliverables wanted and the retention of ①, whether the network
 * open here is the project's (`ownNetwork`) and the retouches not frozen in
 * a version yet (`unfrozenEdits`, the server's count: « Figer en version »
 * is offered only while there are some). A document is said as the server
 * knows it: being kept (`keeping`), kept with the project, or gone (« à
 * redéposer » only once the server said so).
 *
 * A project that does not exist (another browser, past its retention) says
 * so in place, with the way back to Home. The network open in this tab is
 * the project's only when it is the one the project recorded (its handle,
 * `project.network.network_id`) and its working copy is still on the server
 * (`sessionLost`: the heartbeat said it expired). Otherwise a modify project
 * never runs its change on whatever else is open here: ① chooses the network
 * (the published one of the territory — FindNetworkPanel — or the person's
 * own file), and when the project keeps a frozen version, every step says
 * the network is to reload with ONE action, « Reprendre » (`session-resume`):
 * the last frozen version rematerialised from its zip — never a new download
 * of the catalogue (D46) — after which the flow runs again on the same
 * network (same fingerprint), said once in place (`draft-restored`, until
 * closed — kept across the remount the app's loader causes meanwhile). The
 * rail then reads what the project records.
 * The working copy the project runs on is bound to it on the server, which
 * freezes its edits as snapshot versions (D38). A flow that meets the same
 * loss in a refusal (the coherence report's « Reprendre ») calls `onRecover`:
 * that « Reprendre », or ① without a frozen version. Any frozen version can
 * also be reopened as the working copy from ⑤'s list (`reopen`, D50): from
 * its zip, journaled, the version itself left as it was frozen.
 *
 * What the chat or the Network Studio handed over to a new project (a plan,
 * a brief) — and the line the explorer was showing when « Modifier ce
 * réseau » or « Reprendre » was chosen (`focus`) — is given to the Change
 * Studio once (`onHandoverTaken`): a later visit of the step never hands it
 * over again over the person's work; a plan handed to this project while it is
 * open (`append`, « Ajouter au changement ») joins its operations.
 *
 * The draft the modify flow simulates goes back to the app (`onDraft`), whose
 * reader shows it through its « Avant | Après » lens; ③'s « Ouvrir dans le
 * lecteur » opens that reader, full width, on « Après » at the line named
 * (`onOpenReader`, 2026-10-08: one reader, never a second one inside ③).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, Button, IconButton, Tooltip, useTheme } from "@mui/material";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useProject, activeScenarioOf, DOCUMENT_EVENT, ProjectContext, remoteEnabled, withJournal } from "../../utils/projectStore";
import { bindWorkspaceSession, keepWorkspaceDocument, removeWorkspaceDocument } from "../../utils/projectApi";
import { humanError } from "../../utils/humanError";
import { useNavigate, projectPath, projectExplorerPath, HOME_PATH } from "../../utils/routes";
import { Rail } from "../AppShell";
import NetworkStudio from "../network/NetworkStudio";
import ChangeStudio from "../transform/ChangeStudio";
import FindNetworkPanel from "../FindNetworkPanel";
import StepNav, { stepFor, stepStates } from "./StepNav";
import StepFrame from "./StepFrame";
import StudioPaywall from "../billing/StudioPaywall";
import { paidLockOf, useFeatures } from "../../utils/featuresApi";
import { frozenVersionOf } from "./StepNetwork";

/** What the project itself records, for the rail when its flow is not running (its network is not open here). */
export const recordedFacts = (project) => ({
  job: project.job,
  named: Boolean(String(project.name ?? "").trim()),
  started: false,
  contract: project.contract?.status || "draft",
  clauses: (project.contract?.clauses || []).length,
  delivered: Boolean(activeScenarioOf(project)?.applied_version_id),
});

/** Whether the network open in this tab is the project's own (the handle it recorded). */
export const ownsNetwork = (project, networkLoaded, networkHandle) => Boolean(networkLoaded && project?.network?.network_id && project.network.network_id === networkHandle);

/**
 * ① of a modify project without its network: where it comes from — the
 * published network of the territory (the catalogue, found by town) or the
 * person's own GTFS file, dropped on the panel (`onDropFile`) or chosen from
 * the disk (`find-network-upload`). The panel says it all, in the middle of
 * the page (Lot H): no banner over it, nothing else to fill before the
 * network is open — the brief comes right after, beside it.
 */
export function NetworkSource({ onOpened, onPickFile, onDropFile = null }) {
  return (
    <Box data-testid="network-source" sx={{ display: "flex", flexDirection: "column", px: { xs: 0, md: 2 } }}>
      <FindNetworkPanel onOpened={onOpened} onUploadInstead={onPickFile} onDropFile={onDropFile} />
    </Box>
  );
}

// The working copies brought back by « Reprendre » in this tab, until their notice is closed: project id → { n, at }.
const RESTORED = new Map();
const RESTORED_EVENT = "gtfs:project-restored";
// The modify projects whose network this tab already brought back by itself (once per tab: a failure leaves « Reprendre »).
const AUTO_RESUMED = new Set();

/**
 * Whether ProjectPage brings a modify project's network back by itself: the project keeps a frozen version, its
 * network is not the one open here, and no other network is (a new tab, a reload after the working copy expired).
 * Another network open in this tab is never replaced without the person's « Reprendre ».
 */
export const autoResumes = ({ project, frozen, ownNetwork, networkLoaded, sessionLost, canResume }) => Boolean(project && project.job === "modify" && frozen && canResume && !ownNetwork && (!networkLoaded || sessionLost) && !AUTO_RESUMED.has(project.id));

export default function ProjectPage({ id, step = null, tab = null, networkLoaded = false, networkHandle = null, network = null, sessionLost = false, unfrozenEdits = null, onOpenBuilt, onOpenFeed, onNetworkOpened = null, onPickFile = null, onDropFile = null, onResume = null, handover = null, onHandoverTaken = null, actor = null, onOpenReader = null, onDraft = null }) {
  const { t } = useLanguage();
  // In the Network Studio's bar the way to the network is an icon (the bar holds the steps and the step's actions).
  const studio = Boolean(useTheme().studio);
  const navigate = useNavigate();
  const [project, update] = useProject(id);
  // The paid offer (featuresApi.paidLockOf): the studio itself is the subscription's.
  const { features } = useFeatures();
  const studioLock = paidLockOf(features?.access, "studio");
  const [facts, setFacts] = useState({});
  const [resuming, setResuming] = useState({ busy: false, error: null });
  // Said once the network is back; kept across a remount of the page (the app shows its loader while it restores).
  const [restored, setRestoredState] = useState(() => RESTORED.get(id) || null);
  const setRestored = useCallback(
    (value) => {
      if (value) RESTORED.set(id, value);
      else RESTORED.delete(id);
      setRestoredState(value);
      window.dispatchEvent(new CustomEvent(RESTORED_EVENT, { detail: { id } }));
    },
    [id],
  );
  useEffect(() => {
    const handler = (e) => {
      if (e?.detail?.id === id) setRestoredState(RESTORED.get(id) || null);
    };
    window.addEventListener(RESTORED_EVENT, handler);
    return () => window.removeEventListener(RESTORED_EVENT, handler);
  }, [id]);
  // A step the job does not show (a modify ④: its checks are read at the delivery) opens the next one it has.
  const current = stepFor(step || project?.step || 1, project?.job);

  // A bare /p/:id opens the step the project was left at; every step visited is remembered.
  useEffect(() => {
    if (!project) return;
    if (!step) navigate(projectPath(id, stepFor(project.step || 1, project.job)), { replace: true });
    else if (stepFor(step, project.job) !== step) navigate(projectPath(id, stepFor(step, project.job), tab), { replace: true });
    else if (project.step !== step) update({ step });
  }, [project, step, tab, id, navigate, update]);
  // The rail's states, kept with the project (the list of works shows them).
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
  const onTab = useCallback((slug) => navigate(projectPath(id, current, slug), { replace: true }), [navigate, id, current]);
  const handoverTaken = useCallback(() => onHandoverTaken?.(id), [onHandoverTaken, id]);
  // "Voir le réseau", and the modify job's flow: only once the project's own network is the one open in this tab.
  const ownNetwork = !sessionLost && ownsNetwork(project, networkLoaded, networkHandle);
  const waitsForNetwork = Boolean(project && project.job === "modify" && !ownNetwork);
  const recordedSignature = project && waitsForNetwork ? JSON.stringify(recordedFacts(project)) : null;
  useEffect(() => {
    if (recordedSignature) setFacts(JSON.parse(recordedSignature));
  }, [recordedSignature]);

  // The working copy the project runs on, bound on the server: its edits become snapshot versions (D38).
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

  // The documents of the flows' composers, kept with the project: listed at ①, kept by the server (§2.4).
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
      // `expires_at` is the studios' memory's until the server keeps it (then the project's); `keeping` while the request runs.
      const keeping = remoteEnabled();
      const record = { id: d.id, name: d.name, kind: d.kind || null, pages: d.pages ?? null, size: d.size ?? null, sent_to_assistant: d.sent_to_assistant !== false, kept: false, keeping, gone: false, expires_at: d.expiresAt || null };
      update((p) => withJournal({ ...p, documents: [...(p.documents || []).filter((x) => x.id !== d.id), record] }, { actor, action: "document", object: d.name }));
      if (!keeping) return;
      const settle = (change) => update((p) => ({ ...p, documents: (p.documents || []).map((x) => (x.id === d.id ? { ...x, keeping: false, ...change(x) } : x)) }));
      keepWorkspaceDocument(pid, d.id)
        .then((out) => settle((x) => ({ kept: true, gone: false, expires_at: out.document?.expires_at || x.expires_at })))
        // Not kept: gone only when the server says the document is no longer in memory; otherwise still usable until its date.
        .catch((err) => settle(() => ({ kept: false, gone: err?.code === "DOCUMENT_NOT_FOUND", keep_error: err?.code || null })));
    };
    window.addEventListener(DOCUMENT_EVENT, handler);
    return () => window.removeEventListener(DOCUMENT_EVENT, handler);
    // One listener per project; `update` and `actor` are read when a document arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  // « Reprendre » (D46): the last version frozen with the project, when its network is not the one open here.
  const frozen = frozenVersionOf(project);
  const needsNetwork = Boolean(project && !ownNetwork && (project.job === "modify" || project.network?.network_id));
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
  // A modify project opened where its network is not (a new tab, a reload after a long pause): the person came for
  // this project, and « Reprendre » was all the page offered — its last frozen version comes back by itself, said in
  // place while it does (D46: from its zip, never a new download). Once per tab; a failure keeps « Reprendre ».
  const autoResume = autoResumes({ project, frozen, ownNetwork, networkLoaded, sessionLost, canResume: Boolean(onResume) });
  useEffect(() => {
    // Read again here: an effect run twice (a remount) must not restore twice.
    if (!autoResume || AUTO_RESUMED.has(project.id)) return;
    AUTO_RESUMED.add(project.id);
    resume();
  }, [autoResume, project, resume]);
  // « Rouvrir vN comme copie de travail » (D50, ⑤'s version list): any frozen version becomes the working copy of
  // this tab, from its zip — journaled; the version itself stays frozen. Throws the server's refusal.
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
  // A refusal that says the working copy is gone (SESSION_NOT_FOUND…), from inside a flow: the same « Reprendre » —
  // the last frozen version brought back — or, without one, ① to choose the network again.
  const recover = useCallback(() => (frozen && onResume ? resume() : onStep(1)), [frozen, onResume, resume, onStep]);
  const context = useMemo(
    () => (project ? { project, update, actor, ownNetwork, unfrozenEdits: ownNetwork ? unfrozenEdits : null, resume: needsNetwork && (frozen || project.job === "modify") && (frozen || current > 1) ? { version: frozen, onResume: resume, busy: resuming.busy, error: resuming.error } : null, restored: needsNetwork ? null : restored, onRestoredSeen: () => setRestored(null), reopen: onResume ? reopen : null } : null),
    [project, update, actor, ownNetwork, unfrozenEdits, needsNetwork, frozen, current, resume, resuming, restored, setRestored, onResume, reopen],
  );

  if (!project) {
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
      <StepNav job={project.job} current={current} states={states} onSelect={onStep} actions={seeNetwork} />
    </Rail>
  );
  const provide = (children) => <ProjectContext.Provider value={context}>{children}</ProjectContext.Provider>;

  // The paid offer: the project is kept, its work waits for the subscription (the steps stay in the bar).
  if (studioLock === "sign_in_required" || studioLock === "subscription_required") {
    return (
      <>
        {rail}
        <StudioPaywall state={studioLock} project={project} />
      </>
    );
  }

  if (project.job === "modify") {
    // The change needs the project's own network open in this tab: ① chooses it; the other steps say it is to reload.
    if (waitsForNetwork && current > 1) {
      // The project's notice (StepFrame's session-expired: reopening, « Reprendre », or ① to choose the network again)
      // is the one message: never a second banner that contradicts it.
      return provide(
        <>
          {rail}
          <StepFrame step={current} job="modify" primary={frozen ? { label: t("recovery.resume"), onClick: resume, busy: resuming.busy, arrow: false } : { label: t("step.back.network"), onClick: () => onStep(1) }} back={{ onClick: () => onStep(current - 1) }} />
        </>,
      );
    }
    if (waitsForNetwork) {
      // ①, the network to choose (or to bring back): never the card of another network that happens to be open here.
      // The one question of the page; the objectives and the change need its answer: the primary waits for it, and says so.
      return provide(
        <>
          {rail}
          <StepFrame step={1} job="modify" intro={t("step.1.intro.modify")} primary={{ label: t("step.primary.1.modify"), onClick: () => onStep(2), disabled: true, reason: t("step.reason.network") }} testid="step-network" headless>
            {resuming.busy ? null : <NetworkSource onOpened={onNetworkOpened} onPickFile={onPickFile} onDropFile={onDropFile} />}
          </StepFrame>
        </>,
      );
    }
    return provide(
      <>
        {rail}
        <ChangeStudio key={`${id}:${networkHandle || "none"}`} project={project} step={current} tab={tab} onTab={onTab} onStep={onStep} onUpdateProject={update} onFacts={setFacts} initialPlan={handover?.plan || null} initialPlanMode={handover?.append ? "append" : "replace"} initialBrief={handover?.brief || null} initialFocus={handover?.focus || null} onHandoverTaken={handoverTaken} network={network} onChooseNetwork={() => onStep(1)} onRecover={recover} onOpenReader={onOpenReader ? (line) => onOpenReader(id, line) : null} onDraft={onDraft} />
      </>,
    );
  }
  return provide(
    <>
      {rail}
      <NetworkStudio key={id} project={project} step={current} tab={tab} onTab={onTab} onStep={onStep} onUpdateProject={update} onFacts={setFacts} onOpenBuilt={(result, options) => onOpenBuilt?.(result, { ...options, projectId: id })} onOpenFeed={onOpenFeed} />
    </>,
  );
}
