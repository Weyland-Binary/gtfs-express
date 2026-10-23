/**
 * The draft's one screen of a modify project, beside the project's reader: a draft of one kind (by hand, the reader
 * is the editor and the draft a session of its own; with a brief, DirectChange). Nothing touches the working copy
 * until the act, which writes the whole change as ONE edit; the scenario is then frozen « appliqué en vN » and its
 * operations are never simulated again (a second simulation on vN would apply them twice).
 * The working plan is cached in the browser (utils/changeScenarios) and written into the project, which the server
 * keeps: a browser that holds nothing for this network opens on the project's plan.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Alert, Box, Button, Dialog, Snackbar, Typography, useTheme } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { useAccount } from "../../contexts/AccountContext";
import { useFeatures } from "../../utils/featuresApi";
import { fetchOperations, fetchOverview, previewChangePlan, withParam, nextOpId, fetchDraft, openDraft, dropDraft, previewDraft, mergeIntoDraft, applyDraft, reopenDraft } from "../../utils/transformApi";
import { EMPTY_PLAN, activate, activePlan, activeScenario, feedFingerprint, isPlanEmpty, loadWorkspace, workspaceKey, markApplied, replaceDraft, saveWorkspace, withActivePlan } from "../../utils/changeScenarios";
import { activeScenarioOf, latestVersionOf, nextVersionNumber, withScenario, withScenarioFromVersion, withVersion, withoutAppliedVersion } from "../../utils/projectStore";
import { draftKindOf, routeLabelOf, routeOfOperation, touchedLinesOf } from "../../utils/changeStates";
import { humanError } from "../../utils/humanError";
import { announceValidated } from "../../utils/vouchedValidation";
import { coherenceForNote, downloadCoherenceCsv, forgetCoherence, frozenCoherence, noteCoherence } from "../../utils/coherenceApi";
import { rememberedName } from "../common/AcknowledgementForm";
import useElapsed from "../common/useElapsed";
import { useCoherenceDownloads } from "../common/CoherenceReport";
import { retentionDaysOf } from "../../utils/projectVersions";
import { StepFrameInDialog } from "../steps/StepFrame";
import { OperationCard, SHARED_QUESTIONS, sharedKey } from "./ChangePlanParts";
import DraftRetouches from "./DraftRetouches";
import DirectChange from "./DirectChange";
import ApplyDialog from "./ApplyDialog";
import { gateOf, planStatus } from "./gate";
import { appliedNoteOf, buildSynthesisHtml, downloadSynthesis, noteSummaryOf } from "./synthesis";
import useReviewKeys from "./useReviewKeys";
import { reviewOf } from "./changeLines";
import DecisionChecks from "./DecisionChecks";
import DraftBar, { DraftMenus, HandDraft, draftStateOf } from "./DraftBar";
import Notices from "./Notices";
import { DeliveryList } from "./DeliveryList";
import DeliveryPackage from "../steps/DeliveryPackage";
import DecisionScreen from "./DecisionScreen";
import WayChoice from "./WayChoice";
import { EXPORT_PREFLIGHT_CLOSED_EVENT, OPEN_DECISION_EVENT, OPEN_EXPORT_PREFLIGHT_EVENT, RESIMULATE_EVENT } from "../../utils/appEvents";

// How long the application waits for the simulation's coherence report it keeps (read in the decision already, most often).
const COHERENCE_CAPTURE_MS = 15000;
// How long a simulation stays unchanged before the canonical validator runs on it by itself: retouches come one after
// the other, and the validator's run (tens of seconds) would hold the editor at each one.
const AUTO_VALIDATE_MS = 8000;
// How long the plan stays unchanged before it is written into the project (the autosave's own debounce follows).
const PROJECT_PLAN_MS = 800;
// What an assistant's plan joining a draft by hand waits on the person's word for (the engine's gate items of the plan).
const MERGE_ASKS = new Set(["clauses_failing", "clauses_unknown", "sources_unverified", "changes_not_asked"]);

const routeIdsKey = (overview) => (overview?.routes || []).map((r) => String(r.id)).sort().slice(0, 5).join("|");
const stamp = (iso, lang) => {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(`${String(lang || "en").slice(0, 2)}-u-nu-latn`, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
};

/** A cheap, stable fingerprint of a plan and its clauses: the decision says which plan the validator judged. */
const planKeyOf = (plan) => {
  const text = JSON.stringify({ operations: plan?.operations || [], clauses: plan?.requirements?.clauses || [] });
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return `${text.length}:${(h >>> 0).toString(16)}`;
};

export default function ChangeStudio({ project = null, view = null, onView = null, barHost = null, headerHost = null, sideHost = null, initialKind = null, panelOpen = null, onPanelOpened = null, onLeave = null, onUpdateProject = null, onFacts = null, initialBrief = null, initialFocus = null, onHandoverTaken = null, onRecover = null, onOpenReader = null, onDraft = null, lens = null }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  // The draft's kind, and the view it shows: by hand the reader, with a brief (or to choose) the change.
  const kind = draftKindOf(project);
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const shownView = view || (kind === "brief" ? "change" : "network");
  useEffect(() => {
    // A brief draft chooses its own: its desk until a result, then the network with its report beside it. A draft
    // without a way shows its network, the choice asked over it.
    if (kind === "brief") return;
    onView?.("network");
    // The kind leads the view; « Pleine largeur » and the header's tabs show the reader in between.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);
  const [panelDialog, setPanelDialog] = useState(() => (panelOpen === "apply" ? panelOpen : null)); // null | "apply"
  useEffect(() => {
    if (!panelOpen) return;
    if (panelOpen === "apply") setPanelDialog(panelOpen);
    onPanelOpened?.();
    // The address asks once (the reader's « Modifier » with ?ouvrir=…).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen]);
  const { editing, enterEditMode, exitEditMode, recordEdit, undoLast, jumpToHistory, dataVersion, showToast } = useEditMode();
  // The draft's retouches (DraftRetouches) undo and jump with the edit mode's own acts.
  const retouchEdit = { editing, dataVersion, undoLast, jumpToHistory };
  const { features } = useFeatures();
  const { signedIn } = useAccount();

  const [catalogue, setCatalogue] = useState([]);
  const [overview, setOverview] = useState(null);
  const [plan, setPlan] = useState(EMPTY_PLAN);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [validating, setValidating] = useState(false);
  const validateSeconds = useElapsed(validating);
  // The decision's checks: the validator's, or the changes the simulation makes.
  const [applyState, setApplyState] = useState({ canApply: false, busy: false, blocking: false, toAccept: false });
  const applyRef = useRef(null);
  const [undoing, setUndoing] = useState(false);
  // What was applied here: { editId, n } (the project's version, else this page's own record).
  const [appliedLocal, setAppliedLocal] = useState(null);
  const frozenRef = useRef(false);
  // The simulation's coherence report read just before the application (frozenCoherence), kept with the frozen scenario.
  const appliedCoherenceRef = useRef(null);
  const coherenceDownloads = useCoherenceDownloads();
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null); // { kind, severity, params }
  // A brief handed over (the chat), for DirectChange's field.
  const [handedBrief, setHandedBrief] = useState(null);
  const wsRef = useRef(null); // the plans kept for this feed (utils/changeScenarios)
  const planRef = useRef(plan);
  const previewSeq = useRef(0); // the latest preview asked: an older answer never replaces a newer one
  const autoValidated = useRef(null); // the preview the validator already ran on by itself
  const hydrated = useRef({ fp: null, ids: null });
  const storageWarned = useRef(false);
  planRef.current = plan;
  // The project's active scenario, read by the effects below (a frozen one carries the plan it was applied with).
  const projectScenarioRef = useRef(null);
  projectScenarioRef.current = activeScenarioOf(project);
  // The plan the canonical validator ran on (planKeyOf): the decision reads its simulation without a second run.
  const [validatedKey, setValidatedKey] = useState(null);
  // By hand, the draft is a session of its own (`draft` { session, edits, restored }); the decision reads its whole
  // comparison with the working copy (`draftPreview`, made at data version `draftPreviewAt`).
  const [draft, setDraft] = useState(null);
  const draftRef = useRef(null);
  draftRef.current = draft;
  const [draftPreview, setDraftPreview] = useState(null);
  const [draftPreviewAt, setDraftPreviewAt] = useState(null);
  const draftSeq = useRef(0);
  // What the decision reads: the draft's comparison by hand, the plan's simulation otherwise.
  const decisionPreview = kind === "hand" ? draftPreview : preview;

  const routes = overview?.routes || [];
  const fp = useMemo(() => feedFingerprint(overview), [overview]);
  // The browser's draft is this project's own on this network (two projects on one network never share it).
  const wsKey = workspaceKey(fp, project?.id || null);
  const lang = String(language || "en").slice(0, 2);
  useEffect(() => {
    // Unreadable overview: no fingerprint (plans kept in memory only).
    fetchOverview()
      .then(setOverview)
      .catch(() => setOverview({ counts: null, range: null, routes: [], failed: true }));
  }, []);
  useEffect(() => {
    fetchOperations({ lang })
      .then((d) => setCatalogue(d.operations || []))
      .catch(() => setCatalogue([]));
  }, [lang]);

  // The plan simulated on a copy (POST /transform/preview), `validate` with the canonical validator. A brief draft
  // simulates nothing here: its change is the direct turn's.
  const refresh = useCallback(
    async (next, { validate = false } = {}) => {
      // By hand, a plan (the assistant's) is simulated on the draft itself, once it is open.
      if (!next?.operations?.length || kindRef.current === "brief" || (kindRef.current === "hand" && !draftRef.current?.session)) {
        // Nothing to simulate: an answer still in flight for an older plan is dropped.
        previewSeq.current += 1;
        setPreviewing(false);
        setValidating(false);
        setPreview(null);
        return null;
      }
      setError(null);
      const seq = ++previewSeq.current;
      setValidating(validate);
      setPreviewing(!validate);
      try {
        const p = await previewChangePlan(next, { validate, language: lang, ...(kindRef.current === "hand" ? { session: draftRef.current.session } : {}) });
        // (A scenario applied meanwhile is frozen: an answer computed on the network it changed is never its own.)
        if (seq === previewSeq.current && !frozenRef.current) {
          setPreview(p);
          if (p?.validation && !p.validation.error) setValidatedKey(planKeyOf(next));
        }
        return p;
      } catch (err) {
        // The refusal in the person's words (its title, its action, the wait when there is one), never the server's English.
        if (seq === previewSeq.current) setError(humanError(err, t));
        return null;
      } finally {
        if (seq === previewSeq.current) {
          setPreviewing(false);
          setValidating(false);
        }
      }
    },
    [lang, t],
  );

  // The draft by hand compared whole with the working copy (POST /transform/draft/preview): what its decision reads.
  const refreshDraft = useCallback(
    async ({ validate = false } = {}) => {
      const seq = ++draftSeq.current;
      const at = dataVersion;
      setError(null);
      setValidating(validate);
      setPreviewing(!validate);
      try {
        const p = await previewDraft({ validate, language: lang });
        if (seq === draftSeq.current && !frozenRef.current) {
          setDraftPreview(p);
          setDraftPreviewAt(at);
        }
        return p;
      } catch (err) {
        if (seq === draftSeq.current) setError(humanError(err, t));
        return null;
      } finally {
        if (seq === draftSeq.current) {
          setPreviewing(false);
          setValidating(false);
        }
      }
    },
    [lang, t, dataVersion],
  );

  // The plan written without a simulation of its own (emptied, read back frozen, a retouche awaiting its pause): an
  // answer still in flight describes another plan, and is dropped.
  const dropSimulations = useCallback(() => {
    previewSeq.current += 1;
    setPreviewing(false);
    setValidating(false);
  }, []);

  // ── The plans kept for this feed ──
  const commitWs = useCallback(
    (next, { save = true } = {}) => {
      wsRef.current = next;
      if (!save || !fp) return;
      const out = saveWorkspace(wsKey, next);
      if (!out.ok && out.error !== "NO_STORAGE" && !storageWarned.current) {
        storageWarned.current = true;
        setNotice({ kind: "storage", severity: "warning" });
      }
    },
    [fp, wsKey],
  );
  // The plan read back at the mount, simulated on the network as it is.
  const showPlan = useCallback(
    (next) => {
      setPlan(next);
      setPreview(null);
      refresh(next);
    },
    [refresh],
  );

  // On opening (or when the feed changed): the plans kept for it. A brief draft reads none: operations a plan of an
  // older kind left in its scenario are no part of it (the draft abandoned, they go with it).
  useEffect(() => {
    if (!fp || hydrated.current.fp === fp) return;
    const ids = routeIdsKey(overview);
    const sameNetwork = hydrated.current.ids === ids;
    const first = hydrated.current.fp === null;
    hydrated.current = { fp, ids };
    let next = loadWorkspace(wsKey);
    if (kindRef.current === "brief") {
      commitWs(next, { save: false });
      return;
    }
    const current = planRef.current;
    const keepAs = t("transform.scenario.previousDraft", { date: stamp(null, lang) });
    const own = projectScenarioRef.current;
    if (own?.applied_version_id && !isPlanEmpty(own.plan)) {
      // Frozen "applied in vN": the plan it was applied with, from the project, read only — never simulated
      // again (a second simulation of the same operations on vN would apply them twice).
      commitWs(next, { save: false });
      dropSimulations();
      setPlan(own.plan);
      setPreview(null);
      return;
    }
    const stored = activePlan(next);
    if (!isPlanEmpty(current) && (first || sameNetwork)) {
      // The same network changed while a plan was open (or a plan was started before the feed was read): it stays.
      next = replaceDraft(activate(next, null), current, { keepAs });
      commitWs(next);
      if (!first) setNotice({ kind: "carried", severity: "info" });
      return;
    }
    commitWs(next, { save: false });
    if (!isPlanEmpty(stored)) {
      showPlan(stored);
      const s = activeScenario(next);
      setNotice({ kind: "restored", severity: "info", params: { name: s ? s.name : t("transform.scenario.draft"), date: stamp(s ? s.updated_at : next.draft.updated_at, lang) } });
    } else if (!isPlanEmpty(own?.plan)) {
      // Nothing kept for this feed (an application changed it): the project's scenario — a new scenario on vN
      // copied from the frozen one — is the plan, simulated on the network as it is now.
      showPlan(own.plan);
    } else if (!isPlanEmpty(current)) {
      dropSimulations();
      setPlan(EMPTY_PLAN);
      setPreview(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fp]);

  // A frozen scenario opens on the plan it was applied with, from the project, even when the feed cannot be read
  // (no fingerprint, no workspace): its operations stay listed, read only, and are never simulated again.
  useEffect(() => {
    const own = projectScenarioRef.current;
    if (kindRef.current !== "brief" && own?.applied_version_id && !isPlanEmpty(own.plan) && isPlanEmpty(planRef.current)) {
      setPlan(own.plan);
      setPreview(null);
    }
  }, []);

  // The working plan is saved as it changes.
  useEffect(() => {
    if (!fp || hydrated.current.fp !== fp || !wsRef.current) return;
    // A frozen plan is the project's record, not a draft of this feed; a brief draft keeps none.
    if (frozenRef.current || kindRef.current === "brief") return;
    if (activePlan(wsRef.current) === plan) return;
    commitWs(withActivePlan(wsRef.current, plan));
  }, [plan, fp, commitWs]);

  // …and into the project (scenarios[active].plan), which survives another device or a cleared cache. Never over a
  // frozen scenario (its plan is the record of vN), never before this network's plans were read, never for a brief
  // draft; a write still waiting when the studio closes is made at once, never dropped.
  const closing = useRef(false);
  useEffect(() => {
    closing.current = false;
    // Declared before the write below: on unmount this runs first, so the write's cleanup knows the studio closes.
    return () => {
      closing.current = true;
    };
  }, []);
  useEffect(() => {
    if (!project || !onUpdateProject || frozenRef.current || kindRef.current === "brief") return undefined;
    if (!hydrated.current.fp && isPlanEmpty(plan)) return undefined;
    const own = projectScenarioRef.current;
    if (!own || own.applied_version_id) return undefined;
    const next = isPlanEmpty(plan) ? null : plan;
    if (JSON.stringify(own.plan ?? null) === JSON.stringify(next)) return undefined;
    const write = () =>
      onUpdateProject((p) => {
        const active = activeScenarioOf(p);
        if (!active || active.applied_version_id || JSON.stringify(active.plan ?? null) === JSON.stringify(next)) return p;
        return withScenario(p, { plan: next });
      });
    const timer = setTimeout(write, PROJECT_PLAN_MS);
    return () => {
      clearTimeout(timer);
      if (closing.current) write();
    };
    // The project is read through its ref: only a new plan is a write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  const updatePlan = useCallback(
    (next) => {
      setPlan(next);
      refresh(next);
    },
    [refresh],
  );

  // ── An assistant's plan joined to a draft by hand ──
  // The chat's « Ajouter au changement »: simulated on the draft's own session, its questions answered in the panel;
  // once nothing blocks it, it joins the draft as ONE retouche (POST /transform/draft/merge).
  const merging = useRef(null);
  // What the assistant's plan carries that the person decides (a clause of its own not met, words it quotes unverified,
  // changes it does not name): the plan waits in the panel for « L'ajouter au brouillon » — never joined silently.
  const [mergeAsk, setMergeAsk] = useState(null); // { id, codes }
  const mergeAccepted = useRef(null);
  useEffect(() => {
    const p = preview;
    if (kindRef.current !== "hand" || frozenRef.current || !draft?.session || previewing || validating || !p || !plan.operations.length) return;
    if (p.empty) {
      dropSimulations();
      setPlan(EMPTY_PLAN);
      setPreview(null);
      showToast(t("draft.hand.mergeEmpty"), "info");
      return;
    }
    if (!p.id || p.blocked || merging.current === p.id) return;
    const codes = [...new Set((p.gate?.acknowledgeable || []).map((a) => a.code).filter((c) => MERGE_ASKS.has(c)))];
    if (codes.length && mergeAccepted.current !== p.id) {
      setMergeAsk({ id: p.id, codes });
      return;
    }
    setMergeAsk(null);
    merging.current = p.id;
    const title = planRef.current.title || "";
    mergeIntoDraft(p.id)
      .then((out) => {
        dropSimulations();
        setPlan(EMPTY_PLAN);
        setPreview(null);
        recordEdit(t("draft.hand.merged", { title: out?.title || title || t("draft.hand.assistant") }), null, { entity: "transform", entityId: (out?.tables || []).join(",") });
        // The draft holds one retouche more: counted at once.
        fetchDraft()
          .then((d) => setDraft(d?.draft || null))
          .catch(() => null);
      })
      .catch((err) => {
        merging.current = null;
        setError(humanError(err, t));
      });
    // The simulation, the plan it was made of and the draft lead (a simulation may land before its plan is shown).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, previewing, validating, draft?.session, plan, mergeAsk?.accepted]);
  const acceptMerge = () => {
    if (!mergeAsk) return;
    mergeAccepted.current = mergeAsk.id;
    setMergeAsk({ ...mergeAsk, accepted: true });
  };
  const refuseMerge = () => {
    setMergeAsk(null);
    dropSimulations();
    setPlan(EMPTY_PLAN);
    setPreview(null);
  };
  // A draft by hand's retouches are counted with the project (`context.hand_edits`): « Modifier » and the reader know a
  // draft is in progress (one way per draft) without opening it.
  useEffect(() => {
    if (kind !== "hand" || frozenRef.current || !draft || !onUpdateProject) return;
    const n = Number(draft.edits) || 0;
    if ((Number(project?.context?.hand_edits) || 0) === n) return;
    onUpdateProject((p) => ({ ...p, context: { ...(p.context || {}), hand_edits: n } }));
    // The draft's count leads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, draft?.edits]);
  // A plan waiting for the draft to open (a reload, an older draft's operations): simulated once it is.
  useEffect(() => {
    if (kindRef.current === "hand" && draft?.session && planRef.current.operations.length && !frozenRef.current) refresh(planRef.current);
    // The draft's session leads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.session]);

  // ── Answering the engine's questions, removing and moving operations ──
  // An answer sets the parameter asked — except a grid's stop the network does not know (timetable_stop): the stop is
  // replaced in that grid, and in every other grid of the plan that names it the same way (answered once, for all).
  const answer = (opId, param, value, ambiguity = null) => {
    // A change that starts after the feed's end: the person's answer is the date the feed's validity is extended to —
    // the operation « Prolonger la validité » placed first (one for the plan), never the plan's own date rewritten.
    if (ambiguity?.code === "after_validity" && ambiguity.extend) {
      const held = plan.operations.find((o) => o.type === "extend_validity");
      const operations = held ? plan.operations.map((o) => (o === held ? { ...o, params: { ...(o.params || {}), end_date: value } } : o)) : [{ id: nextOpId(plan), type: "extend_validity", params: { end_date: value }, source: { author: "user" } }, ...plan.operations];
      updatePlan({ ...plan, operations });
      return;
    }
    // The school zone (or the country) the calendars need is the network's, not an operation's: one answer for the
    // whole plan (the engine reads plan.region / plan.country) — never written as the name of a period.
    if (ambiguity && ["calendar_region_missing", "calendar_region_unknown"].includes(ambiguity.code)) {
      updatePlan({ ...plan, region: value });
      return;
    }
    if (ambiguity?.code === "calendar_country_missing") {
      // A two-letter code (the choices the engine offers), kept as the server keeps countries; never words cut short.
      const code = String(value || "").trim().toLowerCase();
      if (/^[a-z]{2}$/.test(code)) updatePlan({ ...plan, country: code });
      else setNotice({ kind: "countryCode", severity: "warning" });
      return;
    }
    // A question several operations ask alike (the days a line does not run): one answer for every operation asking
    // it, and for those of its kind that have not said it yet.
    if (ambiguity && SHARED_QUESTIONS.has(ambiguity.code)) {
      const key = sharedKey(ambiguity);
      const asking = (preview?.steps || []).filter((s) => (s.ambiguities || []).some((a) => sharedKey(a) === key)).map((s) => s.id);
      const type = plan.operations.find((o) => o.id === opId)?.type;
      const unsaid = plan.operations.filter((o) => o.type === type && (o.params || {})[param] == null).map((o) => o.id);
      let next = plan;
      for (const id of new Set([opId, ...asking, ...unsaid])) if (next.operations.some((o) => o.id === id)) next = withParam(next, id, param, value);
      updatePlan(next);
      return;
    }
    // A departure time no trip runs at: the time chosen replaces that one in the operation's list, the others stay
    // (never the whole list overwritten by one answer).
    if (ambiguity?.code === "time_no_trip" && ambiguity.time != null) {
      const held = plan.operations.find((o) => o.id === opId)?.params?.[param];
      const list = Array.isArray(held) ? held : held == null || held === "" ? [] : String(held).split(/[,;]/).map((x) => x.trim()).filter(Boolean);
      const asked = String(ambiguity.time);
      updatePlan(withParam(plan, opId, param, list.some((x) => String(x) === asked) ? list.map((x) => (String(x) === asked ? value : x)) : [...list, value]));
      return;
    }
    if (ambiguity?.code === "timetable_stop" && ambiguity.stop) {
      const from = String(ambiguity.stop);
      const operations = plan.operations.map((o) => {
        const stops = o?.params?.timetable?.stops;
        if (!Array.isArray(stops) || !stops.some((x) => String(x) === from)) return o;
        return { ...o, params: { ...o.params, timetable: { ...o.params.timetable, stops: stops.map((x) => (String(x) === from ? value : x)) } } };
      });
      updatePlan({ ...plan, operations });
      return;
    }
    updatePlan(withParam(plan, opId, param, value));
  };
  // An operation removed from the plan stays within reach for a moment: « Annuler » puts it back where it was.
  const [removed, setRemoved] = useState(null); // { op, index }
  const removeOp = (id) => {
    const index = plan.operations.findIndex((o) => o.id === id);
    if (index < 0) return;
    setRemoved({ op: plan.operations[index], index });
    updatePlan({ ...plan, operations: plan.operations.filter((o) => o.id !== id) });
  };
  // The operation removed, back at its place (or at the end when the plan got shorter since).
  const undoRemove = () => {
    if (!removed) return;
    const ops = plan.operations.filter((o) => o.id !== removed.op.id);
    ops.splice(Math.min(removed.index, ops.length), 0, removed.op);
    setRemoved(null);
    updatePlan({ ...plan, operations: ops });
  };
  const moveOp = (id, dir) => {
    const ops = [...plan.operations];
    const i = ops.findIndex((o) => o.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ops.length) return;
    [ops[i], ops[j]] = [ops[j], ops[i]];
    updatePlan({ ...plan, operations: ops });
  };
  /** Start over: an empty draft (named scenarios stay). */
  const reset = () => {
    if (wsRef.current) commitWs({ ...activate(wsRef.current, null), draft: { plan: EMPTY_PLAN, updated_at: null } });
    dropSimulations();
    setPlan(EMPTY_PLAN);
    setPreview(null);
    setError(null);
    setNotice(null);
  };

  // ── Apply ──
  // The plan is written as ONE edit of the working copy (vN), and the scenario frozen "applied in vN": applying its
  // operations again on vN would apply them twice.
  const onApplied = (out, committed = null, { title: givenTitle = null } = {}) => {
    // The simulation the commit replayed (the apply section simulates again on the working copy before it): the one
    // the scenario keeps, never an earlier one this page still held.
    const simulated = committed || decisionPreview;
    const byHand = kindRef.current === "hand";
    // A commit only succeeds once the canonical validator passed (the delivery gate); what a named person accepted is its record.
    const how = out?.acknowledgement ? "acknowledged" : "verified";
    // The plan's own words: the server's description is the edit log's (English, with the acknowledgement's record).
    // The direct mode has no operations: its title is the brief's first line.
    const title = givenTitle || (byHand ? t("draft.hand.appliedTitle") : plan.title) || t("transform.applied.operations", { count: (plan.operations || []).length });
    // No « Annuler » in the message: undoing a version reopens its draft (« Annuler cette version »), never the bare edit.
    recordEdit(t(`transform.applied.${how}`, { title }), null, { entity: "transform", entityId: (out?.tables || []).join(","), noUndoAction: true });
    // The commit validated the very network it leaves: the status bar says what the validator answered (never « à
    // refaire » over the run that just passed), said once the edit is recorded.
    const validator = out?.proof?.validator || out?.validation?.after || null;
    if (validator) announceValidated({ errors: validator.errors, warnings: validator.warnings });
    // A simulation still in flight was computed before the application (or on the network it just changed): dropped.
    dropSimulations();
    if (wsRef.current) commitWs(markApplied(wsRef.current));
    setNotice(null);
    // The draft applied is closed by the server: the next one opens from vN.
    setDraft(null);
    setDraftPreview(null);
    const by = out?.acknowledgement?.by?.name || rememberedName() || null;
    const next = project ? nextVersionNumber(project) : 1;
    // The comparison the decision read is kept with the scenario: the network the reports were read on has just changed.
    const coherence = appliedCoherenceRef.current;
    appliedCoherenceRef.current = null;
    forgetCoherence();
    // Without a project, this page's own record of the version: what its note says of it (appliedNoteOf).
    setAppliedLocal({ editId: out?.editId ?? null, n: next, by, at: new Date().toISOString(), title: out?.description || givenTitle || plan.title || "", coherence, validation: validator ? { errors: validator.errors ?? null, warnings: validator.warnings ?? null } : null, acknowledgement_id: out?.acknowledgement?.id || null, acknowledgement: out?.acknowledgement || null });
    // The version records the validator as the server's proof says it (its errors, warnings, rules, engine), never a
    // figure written here.
    // What the note reads of the simulation is kept with the scenario too: the note of vN is written again after a reload.
    onUpdateProject?.((p) => withVersion(withScenario({ ...p, context: { ...(p.context || {}), hand_edits: 0 } }, { plan, verdict: simulated?.verdict ?? null, validation: out?.validation || null, applied_edit_id: out?.editId ?? null, coherence, coherence_id: coherence ? coherence.preview_id || coherence.computed_at || null : null, note_preview: noteSummaryOf(simulated) }), { kind: "applied", by, name: givenTitle || (byHand ? t("draft.hand.appliedTitle") : plan.title) || p.name, verdict: simulated?.verdict ?? null, validation: out?.proof?.validator ? { ...out.proof.validator, status: out.validation?.status ?? out.proof.validator.status ?? null } : out?.validation ? { errors: out.validation.after?.errors ?? null, warnings: out.validation.after?.warnings ?? null, engine: out.validation.engine || null, status: out.validation.status } : null, acknowledgement: out?.acknowledgement || null }));
  };
  // "Annuler l'application": the version undone on its draft (POST /transform/draft/reopen) — the working copy back to
  // vN-1, the draft reopened holding the change as one retouche (a brief's with its report), so it can be applied again
  // or undone; only while the application is the latest change.
  const undoApplication = async (editId) => {
    if (undoing || !editId) return;
    setUndoing(true);
    const byHand = kindRef.current === "hand";
    try {
      const result = byHand ? null : project?.context?.direct?.result || null;
      const out = await reopenDraft(editId, { title: t("draft.hand.reopened", { n: frozen?.n ?? "" }), direct: result?.report ? { report: result.report, facts: result.facts || null } : null }).catch((err) => {
        setError(humanError(err, t));
        return null;
      });
      if (!out?.draft) return;
      setAppliedLocal(null);
      // The scenario thawed is simulated again: the comparison kept at its application goes with the version.
      onUpdateProject?.((p) => withScenario(withoutAppliedVersion({ ...p, context: { ...(p.context || {}), ...(byHand ? { hand_edits: out.draft.edits || 1 } : {}) } }, { by: rememberedName() || null }), { coherence: null, coherence_id: null }));
      forgetCoherence();
      autoValidated.current = null;
      refresh(planRef.current);
    } finally {
      setUndoing(false);
    }
  };

  // ── The draft's kind and the hand-overs ──
  const projectScenario = activeScenarioOf(project);
  const appliedVersion = projectScenario?.applied_version_id ? (project?.versions || []).find((v) => v.id === projectScenario.applied_version_id) || null : null;
  // Frozen "applied in vN": the project's scenario says it; without a project, this page's own record.
  const appliedEditId = projectScenario?.applied_edit_id ?? null;
  const frozen = useMemo(() => (appliedVersion ? { n: appliedVersion.n, editId: appliedEditId, by: appliedVersion.by, at: appliedVersion.at } : appliedLocal), [appliedVersion, appliedEditId, appliedLocal]);
  frozenRef.current = Boolean(frozen);
  // ── The draft's own session (by hand and with a brief) ──
  // Opened when the draft is (found again after a reload, or brought back as it was left when its session expired),
  // closed when it is applied or abandoned; its retouches counted again after each one.
  const isFrozen = Boolean(frozen);
  const ownSession = kind === "hand" || kind === "brief";
  useEffect(() => {
    if (!ownSession || isFrozen) {
      setDraft(null);
      setDraftPreview(null);
      return undefined;
    }
    let live = true;
    openDraft()
      .then((out) => {
        if (!live) return;
        setDraft(out?.draft || null);
        if (out?.draft?.restored) showToast(t("draft.hand.restored"), "info");
      })
      .catch((err) => {
        if (live) setError(humanError(err, t));
      });
    return () => {
      live = false;
    };
    // The kind and the frozen state lead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, isFrozen]);
  useEffect(() => {
    if (!ownSession || isFrozen || !draftRef.current) return;
    fetchDraft()
      .then((out) => setDraft(out?.draft || null))
      .catch(() => null);
    // Each retouche moves the data version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataVersion]);
  // The decision opened on a draft by hand not compared yet (the address's ?ouvrir=livraison): compared there, the
  // validator with it.
  useEffect(() => {
    if (panelDialog === "apply" && kind === "hand" && !isFrozen && draft?.session && !draftPreview && !previewing && !validating) refreshDraft({ validate: true });
    // The dialog and the draft lead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelDialog, kind, isFrozen, draft?.session]);
  const setKind = (k) => {
    kindRef.current = k || null;
    onUpdateProject?.((p) => ({ ...p, context: { ...(p.context || {}), draft_kind: k } }));
  };
  // A draft of kind `k`: on a version applied, a new scenario starts empty from vN — `carried`, a plan handed over,
  // is its first work.
  const startDraft = (k, carried = null) => {
    if (frozen) {
      setAppliedLocal(null);
      kindRef.current = k;
      onUpdateProject?.((p) => {
        const next = withScenarioFromVersion(p, Date.now(), { empty: true });
        return { ...next, context: { ...(next.context || {}), draft_kind: k } };
      });
      autoValidated.current = null;
      reset();
      if (carried) {
        setPlan(carried);
        refresh(carried);
      }
    } else setKind(k);
  };
  const kindAsked = useRef(null);
  useEffect(() => {
    if (!initialKind) {
      kindAsked.current = null;
      return;
    }
    if (kindAsked.current === initialKind) return;
    kindAsked.current = initialKind;
    if (frozen || !plan.operations.length || kind === initialKind || !kind) startDraft(initialKind);
    // Taken: the host forgets the hand-over, so the next mount never starts the draft again over this one's work.
    onHandoverTaken?.();
    // Asked once per hand-over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKind]);

  // The line the reader was showing, handed over with « Modifier ce réseau »: the reader keeps it in sight.
  useEffect(() => {
    if (initialFocus && !initialBrief) onHandoverTaken?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFocus]);

  // A brief handed over by the assistant: a brief draft's field, never sent on its own (a draft by hand that already
  // holds work keeps it).
  useEffect(() => {
    if (typeof initialBrief !== "string" || !initialBrief.trim()) return;
    onHandoverTaken?.();
    if (kind === "hand" && !frozen && plan.operations.length) return;
    if (kind !== "brief" || frozen) startDraft("brief");
    setHandedBrief(initialBrief);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialBrief]);

  // « Abandonner le brouillon »: its operations go (the browser's and the project's plan), a brief draft's records
  // with it, the network stays as it is, the way is chosen again.
  const [abandoning, setAbandoning] = useState(false);
  // The network's versions: the specialist's, out of the decision.
  const [versionsOpen, setVersionsOpen] = useState(false);
  const abandon = () => {
    setAbandoning(false);
    // The draft's copy goes with it: the working copy is as it was.
    if (kindRef.current === "hand" || kindRef.current === "brief") {
      dropDraft().catch(() => null);
      setDraft(null);
      setDraftPreview(null);
    }
    reset();
    kindRef.current = null;
    onUpdateProject?.((p) => {
      const { direct: _direct, conversation: _conversation, hand_edits: _edits, ...context } = p.context || {}; // eslint-disable-line no-unused-vars
      const active = activeScenarioOf(p);
      const cleared = active && !active.applied_version_id && active.plan ? withScenario(p, { plan: null }) : p;
      // The brief's words stay (the person may choose that way again); its turn, its result and its question go.
      return { ...cleared, context: { ...context, draft_kind: "", ...(_direct?.brief ? { direct: { brief: _direct.brief } } : {}) } };
    });
  };

  // The canonical validator on a stable simulation, by itself: once per preview, never on a blocked one or where no
  // validator answers; a plan restored (a reload, another device) is checked too, never left « pas encore lancé ». The
  // preview it returns carries the validation, so it does not run again.
  useEffect(() => {
    if (previewing || validating || frozenRef.current || kindRef.current === "hand") return undefined;
    const id = preview?.id;
    if (!id || preview.validation || autoValidated.current === id) return undefined;
    const g = gateOf(preview);
    if (!g || g.validation === "unavailable" || g.blocking.some((b) => b.code === "blocked_steps" || b.code === "integrity" || b.code === "validator_unavailable")) return undefined;
    const timer = setTimeout(() => {
      autoValidated.current = id;
      refresh(planRef.current, { validate: true });
    }, AUTO_VALIDATE_MS);
    return () => clearTimeout(timer);
  }, [previewing, validating, preview, refresh]);

  const stepOf = (id) => (preview?.steps || []).find((s) => s.id === id) || null;
  // The questions several operations ask alike: the first card asking each, and how many ask it.
  const shared = { first: new Map(), count: new Map() };
  for (const o of plan.operations) {
    const asking = stepOf(o.id);
    if (Array.isArray(asking?.waiting_for) && asking.waiting_for.length) continue;
    for (const k of new Set((asking?.ambiguities || []).map(sharedKey).filter(Boolean))) {
      if (!shared.first.has(k)) shared.first.set(k, o.id);
      shared.count.set(k, (shared.count.get(k) || 0) + 1);
    }
  }
  // A shared answer also reaches the operations of its kind that have not said it yet (answer): counted with them.
  for (const [k, id] of shared.first) {
    const [code, param] = k.split("|");
    if (!SHARED_QUESTIONS.has(code)) continue;
    const type = plan.operations.find((o) => o.id === id)?.type;
    const unsaid = plan.operations.filter((o) => o.type === type && (o.params || {})[param] == null).length;
    shared.count.set(k, Math.max(shared.count.get(k) || 0, unsaid));
  }
  const status = planStatus({ plan, preview, previewing });

  // ── What the flow knows
  const validatorOff = features?.access?.validator === "unavailable";
  const editLocked = !editing && features?.access?.edit && features.access.edit !== "ok";
  // The note of the applied version: from this simulation, else from what the scenario kept of it (a reload, a member).
  const notePreview = decisionPreview || projectScenario?.note_preview || null;
  // The draft the reader's lens shows (components/reader/ReaderLens): this simulation or the version it was applied
  // as; with a brief, the direct turn's preview (DirectChange's `onPreview`).
  const [directLens, setDirectLens] = useState(null);
  // By hand, and with a brief once its session is open, the reader reads the draft's own session: no lens.
  const lensPreview = kind === "brief" ? (draft?.session ? null : directLens) : kind === "hand" ? null : preview;
  const touchedNow = touchedLinesOf(kind === "hand" ? draftPreview : kind === "brief" ? directLens : lensPreview).map((l) => ({ ...l, label: routes.some((r) => String(r.id) === l.route) ? routeLabelOf(l.route, routes) : l.label }));
  const draftSignature = JSON.stringify([!frozen && lensPreview?.id && !lensPreview.empty ? lensPreview.id : null, kind === "brief" ? 0 : kind === "hand" ? (draft?.edits || 0) + plan.operations.length : plan.operations.length, kind === "hand" ? false : previewing, frozen ? frozen.n : null, touchedNow, ownSession && !frozen ? draft?.session || null : null]);
  useEffect(() => {
    if (!onDraft) return;
    const [previewId, operations, simulating, applied, touched, draftSession] = JSON.parse(draftSignature);
    onDraft({ previewId, operations, touched, simulating, applied, draftSession });
    // The signature says when the draft changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftSignature]);
  // The reader lost the draft it looked at (expired, or the working copy changed since): the change is simulated again.
  useEffect(() => {
    const handler = () => {
      if (frozenRef.current || !planRef.current?.operations?.length) return;
      refresh(planRef.current);
    };
    window.addEventListener(RESIMULATE_EVENT, handler);
    return () => window.removeEventListener(RESIMULATE_EVENT, handler);
  }, [refresh]);
  // What the note of the applied version says of it: the version's own record (vN, when, by whom, the validator's
  // answer at its application, who accepted what stayed open) — never the gate of a simulation.
  const noteApplied = appliedVersion ? appliedNoteOf(appliedVersion, project?.acknowledgements || []) : appliedLocal ? appliedNoteOf(appliedLocal, appliedLocal.acknowledgement ? [appliedLocal.acknowledgement] : []) : null;
  const previewCoherence = useCallback((p) => ({ kind: "preview", previewId: p.id, framing: project?.context || null }), [project?.context]);
  // Before the application consumes the simulation: its comparison, whole, to keep with the frozen scenario (never a
  // reason to hold the application back — past COHERENCE_CAPTURE_MS or on a refusal, nothing is kept and the note says so).
  const captureCoherence = async (p) => {
    appliedCoherenceRef.current = null;
    if (!p?.id || p.empty) return;
    const got = await coherenceForNote(previewCoherence(p), { timeoutMs: COHERENCE_CAPTURE_MS });
    appliedCoherenceRef.current = frozenCoherence(got.report);
  };
  const stuck = status.key === "transform.blocked" || (preview?.steps || []).some((s) => s.status === "blocked" || s.status === "failed");
  // Every operation was already true of the network: nothing to verify, nothing to apply — said, never a delivery
  // that answers « simulez d'abord ».
  const nothingToApply = kind === "hand" ? Boolean(draftPreview?.empty) && !previewing : Boolean(preview?.empty) && plan.operations.length > 0 && !previewing;
  const planKey = useMemo(() => planKeyOf(plan), [plan]);
  const facts = useMemo(
    () => ({
      job: "modify",
      named: Boolean(String(project?.name ?? "").trim()) || !project,
      started: Boolean(overview && !overview.failed),
      design: kind === "hand" ? (draft?.edits ? "ready" : "none") : !plan.operations.length ? "none" : stuck || !preview ? "partial" : "ready",
      delivered: Boolean(frozen),
      locks: { 4: validatorOff ? "step.locked.validator" : null, 5: validatorOff ? "step.locked.validator" : editLocked ? "step.locked.edit" : null },
      verdict: preview?.verdict ?? null,
    }),
    [project, overview, plan.operations.length, stuck, preview, frozen, validatorOff, editLocked, kind, draft?.edits],
  );
  const factsSignature = JSON.stringify(facts);
  useEffect(() => {
    onFacts?.(facts);
    // The signature says when the facts changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factsSignature]);
  // « Appliquer en vN »: the decision opens on the simulation the validator already judged, else on a new one.
  const simulateAndCheck = () => {
    // By hand: the draft compared whole with the working copy, the validator with it — the comparison already made
    // on this very draft (no retouche since) is read again without a second run.
    if (kind === "hand") {
      const fresh = Boolean(draftPreview?.validation && !draftPreview.validation.error && draftPreviewAt === dataVersion);
      if (!fresh) refreshDraft({ validate: true });
      setPanelDialog("apply");
      return;
    }
    // The validator already answered for this very plan (it runs by itself on a stable simulation): the decision
    // reads that simulation — no second run of tens of seconds; a simulation gone stale is simulated again there.
    const validated = Boolean(preview?.id && preview.validation && !preview.validation.error && validatedKey === planKey && !previewing);
    if (!validated) {
      autoValidated.current = preview?.id || null;
      refresh(plan, { validate: true });
    }
    setPanelDialog("apply");
  };

  const notices = <Notices notice={notice} onCloseNotice={() => setNotice(null)} error={error} onCloseError={() => setError(null)} />;

  // In the draft's screen the reader is the other view: shown first, then led to the line.
  const openReader = onOpenReader ? (line) => {
    onView?.("network");
    onOpenReader(line);
  } : null;
  // The line an operation names: said on its card, shown in the reader on a click.
  const lineOfOperation = (op) => {
    const id = routeOfOperation(op, routes);
    return id ? { line: routeLabelOf(id, routes), onFocusLine: openReader ? () => openReader({ route: id }) : null } : {};
  };
  // ── The apply section
  // Before the act only: once applied, the decision shows the version (DecisionScreen).
  const applySection = frozen ? null : (
    <ApplyDialog open compact hand={kind === "hand"} controlRef={applyRef} onState={setApplyState} onClose={() => setPanelDialog(null)} preview={decisionPreview} plan={plan} catalogue={catalogue} editing={editing} enterEditMode={enterEditMode} refresh={kind === "hand" ? () => refreshDraft({ validate: true }) : refresh} commit={kind === "hand" ? applyDraft : null} onApplied={onApplied} beforeCommit={captureCoherence} onNavigate={() => setPanelDialog(null)} />
  );
  // The coherence report (the decision's checks, the note): the simulation before → after; once applied, the
  // comparison kept with the frozen scenario — the network as it now is only when none was kept, said so.
  const frozenReport = frozen ? (projectScenario?.applied_version_id ? projectScenario.coherence || null : appliedLocal?.coherence || null) : null;
  const coherenceSource = frozen ? (frozenReport ? { kind: "static", report: frozenReport } : { kind: "network" }) : decisionPreview?.id && !decisionPreview.empty ? previewCoherence(decisionPreview) : null;
  const coherenceNote = frozen ? (frozenReport ? t("coherence.frozen.kept", { n: frozen.n }) : t("coherence.frozen.fallback", { n: frozen.n })) : null;
  // The note: of the simulation while nothing is applied; once applied, of the version (what the scenario kept of its
  // simulation, read again after a reload, and the version's own record).
  const noteSimulation = frozen ? notePreview : decisionPreview;
  const deliverNote = () => coherenceDownloads.run("note", coherenceSource, (got) => downloadSynthesis({ plan, preview: noteSimulation, applied: frozen ? noteApplied : null, t, language, coherence: noteCoherence(got, t) }), { required: false });
  const deliverCsv = () => coherenceDownloads.run("csv", coherenceSource, (got) => got.report && downloadCoherenceCsv(got.report, t, language));
  // The service-méthode files: the server's, from the simulation it reads again, or — once applied —
  // from the network as it now is (the version), whose header names it; the project's labels printed as they are.
  const reportVersion = latestVersionOf(project);
  const fileSource = coherenceSource?.kind === "static" ? { kind: "network" } : coherenceSource;
  const fileLabels = { network: project?.network?.name || project?.name || null, version: reportVersion ? `v${reportVersion.n}` : null, versionAt: reportVersion?.at ? String(reportVersion.at).slice(0, 10) : null };
  // Once applied, « Tout le paquet », whose manifest records the decision and who took it.
  const packageNote = appliedVersion && kind === "hand" && noteSimulation ? { versionId: appliedVersion.id, build: () => ({ content: buildSynthesisHtml({ plan, preview: noteSimulation, applied: noteApplied, t, language }) }) } : null;
  const deliverables = (
    <>
      <DeliveryList downloads={coherenceDownloads} onNote={deliverNote} noteDisabled={!noteSimulation || Boolean(coherenceDownloads.running)} onCsv={deliverCsv} csvDisabled={!coherenceSource || Boolean(coherenceDownloads.running)} fileSource={fileSource} fileLabels={fileLabels} />
      {frozen && project && <DeliveryPackage note={packageNote} />}
    </>
  );

  // With a brief, at its decision, the header says the reader's side: « Avant » (the working copy) or « Après » (the
  // draft) — once the draft is open, until it is applied.
  const briefSides = kind === "brief" && draft?.session && !frozen ? {
    side: lens?.side || "after",
    onSide: (v) => {
      lens?.onSide?.(v);
      onView?.("network");
    },
  } : {};

  // ── The draft's bar, its drawer and its dialogs ──
  const nextN = frozen ? frozen.n : project ? nextVersionNumber(project) : 1;
  // Delivering exports the working copy: edit mode is the export's own prerequisite, entered quietly here and left once
  // the preflight closes — so no editor writes the version applied outside a draft. The preflight is asked once the
  // delivery button listens (it listens in edit mode).
  const enteredToDeliver = useRef(false);
  const deliverAsked = useRef(false);
  const deliverNow = async () => {
    if (!editing) {
      const entered = await enterEditMode({ quiet: true, overrideHold: true });
      if (!entered?.ok) return;
      enteredToDeliver.current = true;
      deliverAsked.current = true;
      return;
    }
    window.dispatchEvent(new CustomEvent(OPEN_EXPORT_PREFLIGHT_EVENT));
  };
  useEffect(() => {
    if (!editing || !deliverAsked.current) return undefined;
    deliverAsked.current = false;
    const timer = setTimeout(() => window.dispatchEvent(new CustomEvent(OPEN_EXPORT_PREFLIGHT_EVENT)), 0);
    return () => clearTimeout(timer);
  }, [editing]);
  useEffect(() => {
    const closed = () => {
      if (!enteredToDeliver.current) return;
      enteredToDeliver.current = false;
      exitEditMode({ quiet: true });
    };
    window.addEventListener(EXPORT_PREFLIGHT_CLOSED_EVENT, closed);
    return () => window.removeEventListener(EXPORT_PREFLIGHT_CLOSED_EVENT, closed);
  }, [exitEditMode]);
  // « Livrer » or a refusal asked on a draft not applied (it is not a version): its decision opens.
  useEffect(() => {
    const open = () => {
      if (frozenRef.current) return;
      if (kindRef.current === "hand") {
        if (draftRef.current?.edits) simulateAndCheck();
        else setHandOpen(true);
      } else if (kindRef.current === "brief") onView?.("change");
    };
    window.addEventListener(OPEN_DECISION_EVENT, open);
    return () => window.removeEventListener(OPEN_DECISION_EVENT, open);
  });
  const [moreAnchor, setMoreAnchor] = useState(null);
  const [handOpen, setHandOpen] = useState(false);
  // The draft's ONE state, said by the bar or the hand's panel, and its one act « Appliquer en vN ».
  const draftState = draftStateOf(t, { kind, frozen, operations: plan.operations, previewing, preview, status, retouches: kind === "hand" && draft ? draft.edits || 0 : null });
  // By hand: a draft holding retouches, no plan of the assistant still waiting to join it.
  const applyDisabled = kind === "hand" ? !draft || !(draft.edits > 0) || plan.operations.length > 0 || previewing : !plan.operations.length || stuck || previewing || nothingToApply;
  const abandonDialog = (
    <DraftMenus
      moreAnchor={moreAnchor}
      onCloseMore={() => setMoreAnchor(null)}
      onVersions={() => { setMoreAnchor(null); setVersionsOpen(true); }}
      onAbandonAsk={() => { setMoreAnchor(null); setAbandoning(true); }}
      abandonDisabled={Boolean(frozen)}
      versionsOpen={versionsOpen}
      onCloseVersions={() => setVersionsOpen(false)}
      versions={project?.versions || []}
      abandoning={abandoning}
      onCloseAbandon={() => setAbandoning(false)}
      onAbandon={abandon}
    />
  );
  // An operation of the draft, as the hand's panel lists it: read-only once applied.
  const operationCard = (op) => <OperationCard key={op.id} op={op} step={frozen ? null : stepOf(op.id)} def={catalogue.find((c) => c.type === op.type)} index={plan.operations.indexOf(op)} count={plan.operations.length} busy={previewing || Boolean(frozen)} shared={shared} onAnswer={answer} onRemove={removeOp} onMove={moveOp} appliedIn={frozen ? frozen.n : null} {...lineOfOperation(op)} />;
  // By hand, the screen is the reader: the draft is one button in the header that opens its panel beside it.
  const renderHand = () => (
    <HandDraft
      open={handOpen}
      onOpen={() => setHandOpen(true)}
      onClose={() => setHandOpen(false)}
      frozen={frozen}
      operations={plan.operations}
      retouches={draft?.edits || 0}
      retouchesNode={draft ? <DraftRetouches testid="draft-hand-retouches" session={draft.session} withPlans bare edit={retouchEdit} /> : null}
      notices={
        error || mergeAsk ? (
          <>
            {error ? notices : null}
            {mergeAsk && !mergeAsk.accepted && (
              <Alert severity="warning" data-testid="draft-merge-ask" sx={{ fontSize: "0.82rem" }}>
                <Box sx={{ fontWeight: 700, mb: 0.5 }}>{t("draft.hand.mergeAsk.title")}</Box>
                {mergeAsk.codes.map((c) => (
                  <Box key={c} component="div">· {t(`draft.hand.mergeAsk.${c}`)}</Box>
                ))}
                <Box sx={{ display: "flex", gap: 1, mt: 1 }}>
                  <Button size="small" variant="contained" disableElevation onClick={acceptMerge} data-testid="draft-merge-accept" sx={{ textTransform: "none", fontWeight: 700 }}>
                    {t("draft.hand.mergeAsk.accept")}
                  </Button>
                  <Button size="small" onClick={refuseMerge} data-testid="draft-merge-refuse" sx={{ textTransform: "none", fontWeight: 650 }}>
                    {t("draft.hand.mergeAsk.refuse")}
                  </Button>
                </Box>
              </Alert>
            )}
          </>
        ) : null
      }
      renderOperation={operationCard}
      state={draftState}
      onDeliver={deliverNow}
      onApplied={() => setPanelDialog("apply")}
      onApply={simulateAndCheck}
      applyDisabled={applyDisabled}
      nextN={nextN}
      onAbandonAsk={() => setAbandoning(true)}
      onVersions={() => setVersionsOpen(true)}
      onLeave={onLeave}
      onNewDraft={() => startDraft("hand")}
      // The reader's side (« Avant », the working copy; « Après », the draft), said and switched in the button itself.
      side={!frozen && draft?.session ? lens?.side || null : null}
      onSide={lens?.onSide || null}
    />
  );
  // Before a kind is chosen: the bar says so, beside « Quitter ».
  const choiceBar = <DraftBar kind={null} state={draftState} onMore={setMoreAnchor} onLeave={onLeave} variant={headerHost ? "header" : "bar"} />;
  const panelDialogPaper = { sx: { maxHeight: "92vh", borderRadius: "18px", overflow: "hidden", display: "flex", flexDirection: "column" } };
  const panelDialogBody = (node) => (
    <StepFrameInDialog.Provider value>
      <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflowY: "auto", px: 2.5, pb: 1 }}>
        {node}
      </Box>
    </StepFrameInDialog.Provider>
  );
  const panelDialogHead = (title, testid) => (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2.5, py: 1.25, borderBottom: `1px solid ${theme.palette.divider}` }}>
      <Typography component="h2" sx={{ flex: 1, fontSize: "1rem", fontWeight: 700 }}>{title}</Typography>
      <Button onClick={() => setPanelDialog(null)} data-testid={`${testid}-close`} sx={{ textTransform: "none", fontWeight: 650 }}>
        {t("panel.dialog.back")}
      </Button>
    </Box>
  );
  const renderPanel = () => (
    <>
      {kind === "hand" ? (headerHost ? createPortal(renderHand(), headerHost) : renderHand()) : !kind ? (headerHost || barHost ? createPortal(choiceBar, headerHost || barHost) : choiceBar) : null}
      {abandonDialog}
      <Box data-testid="change-panel" data-view={shownView} data-kind={kind || ""} sx={{ flex: 1, minWidth: 0, minHeight: 0, height: "100%", display: "flex" }}>
        {!kind ? (
          <WayChoice onStart={startDraft} onClose={onLeave} networkName={project?.network?.name || null} />
        ) : kind === "brief" ? (
          <DirectChange
            project={project}
            onUpdateProject={onUpdateProject}
            editing={editing}
            enterEditMode={enterEditMode}
            draftSession={draft?.session || null}
            frozen={frozen}
            nextN={nextN}
            routes={routes}
            defaultDate={project?.context?.from_date || (overview?.range?.start ? String(overview.range.start).replace(/^(\d{4})-?(\d{2})-?(\d{2})$/, "$1-$2-$3") : null)}
            retentionDays={retentionDaysOf(features?.workspace || null, signedIn)}
            handedBrief={handedBrief}
            onOpenReader={openReader}
            onPreview={setDirectLens}
            onCommitted={(out, { title }) => onApplied(out, null, { title })}
            onAbandon={() => setAbandoning(true)}
            onOpenApplied={() => setPanelDialog("apply")}
            onNewDraft={() => startDraft("brief")}
            bar={{ host: headerHost || barHost, inHeader: Boolean(headerHost), onMore: setMoreAnchor, onLeave, ...briefSides }}
            sideHost={sideHost}
            onViewWanted={onView}
          />
        ) : null}
      </Box>
      <Dialog open={panelDialog === "apply"} onClose={() => setPanelDialog(null)} fullWidth maxWidth="md" PaperProps={panelDialogPaper} data-testid="panel-apply-dialog">
        {panelDialogHead(frozen ? t("decision.applied.head", { n: frozen.n }) : t("panel.dialog.apply", { n: nextN }), "panel-apply-dialog")}
        {panelDialogBody(panelDialog === "apply" ? renderDecision() : null)}
      </Dialog>
    </>
  );

  // In the decision, Enter applies once everything is accepted (off while a form has the focus).
  const reviewLines = useMemo(() => reviewOf(frozen ? null : decisionPreview).lines, [decisionPreview, frozen]);
  useReviewKeys({ enabled: panelDialog === "apply" && !frozen, lines: [], onApply: () => applyRef.current?.apply(), canApply: Boolean(applyState.canApply) });

  // ── The draft's decision (its dialog) ──
  // One short screen in two times: before, what the change does, the checks at a glance and the act under the
  // person's name (ApplyDialog, compact); after, the version applied and its documents (one undo reverts it all).
  const renderDecision = () => {
    const checksNode = (
      <DecisionChecks
        notices={notices}
        plan={plan}
        preview={decisionPreview}
        recapPreview={frozen ? notePreview : decisionPreview}
        catalogue={catalogue}
        validating={validating}
        seconds={validateSeconds}
        frozen={frozen}
        coherence={{ source: coherenceSource, note: coherenceNote, exportSource: fileSource, labels: fileLabels }}
        onRecover={onRecover}
        retouchEdit={retouchEdit}
        onSimulate={(validate) => (kind === "hand" ? refreshDraft({ validate: Boolean(validate) }) : refresh(planRef.current, validate ? { validate: true } : undefined))}
      />
    );
    return (
      <DecisionScreen
        frozen={frozen}
        undoing={undoing}
        onUndo={() => undoApplication(frozen?.editId)}
        onDownload={() => { setPanelDialog(null); deliverNow(); }}
        deliverables={deliverables}
        preview={decisionPreview}
        validating={validating}
        previewing={previewing}
        validateSeconds={validateSeconds}
        reviewLines={reviewLines}
        plan={plan}
        routes={routes}
        hand={kind === "hand"}
        nextN={nextN}
        // The simulation or the validator refused: said above the act, with the way to run it again.
        error={error && typeof error === "object" ? error : null}
        onResimulate={() => { autoValidated.current = null; if (kind === "hand") refreshDraft({ validate: true }); else refresh(planRef.current, { validate: true }); }}
        checksNode={checksNode}
        applySection={applySection}
      />
    );
  };
  return (
    <>
      {renderPanel()}
      <Snackbar
        open={Boolean(removed)}
        autoHideDuration={8000}
        onClose={(_, reason) => reason !== "clickaway" && setRemoved(null)}
        message={t("transform.removed")}
        action={
          <Button size="small" color="inherit" onClick={undoRemove} data-testid="change-undo-remove" sx={{ fontWeight: 700 }}>
            {t("app.undo")}
          </Button>
        }
        data-testid="change-removed"
      />
    </>
  );
}
