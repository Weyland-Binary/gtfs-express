/**
 * PlanChat — the side panel's conversation with the planner: whatever sits
 * above it (the territory, via `header`) scrolls with the messages, the
 * composer stays pinned at the bottom. The brief is typed or dropped as a
 * text file. Each answer of the planner opens with the ENGINE's verdict
 * (common/VerdictCard, from the SSE `verdict` event as emitted: `{ verdict,
 * readiness, prose }`), before and above the model's words: then the steps
 * it took, its prose with the sentences the verdict contradicts struck
 * through (common/ProseWithStrikes: `prose.spans`, `data-contradicts` on
 * the turn; muted and marked "not yet checked" until the event arrives), its questions (answer with chips, free text, or accept the
 * suggested answers) and the design quality report; the same composer then
 * refines the plan. The requirements the planner understood are the
 * contract's, shown by the brief checklist, not in the turn.
 *
 * When the request is to MODIFY a network that already runs, the planner
 * hands it over (SSE `handoff`): the turn shows a HandoffCard that opens
 * the real feed for the Change Studio with the brief. Failures read in
 * plain words (ErrorNotice), the technical text folded. Without the
 * assistant, examples and templates (which only prefill the composer)
 * give way to the manual path, and the verdict of the design as edited by
 * hand (`designVerdict`: POST /network/evaluate's `verdict`, re-measured on
 * each edit by the studio) takes the place of the turns'. The composer
 * stays without the assistant:
 * documents are attached and dropped all the same (kept with the project,
 * never sent to a model), and a text typed or pasted is kept as a document
 * of the project (« Conserver comme document »: a .txt the person cites by
 * hand) instead of a disabled field. `showDocuments`: false when the host
 * lists the documents itself (the Network Studio's column, DocumentDrop):
 * the composer then attaches without listing them a second time; and
 * `showVerdict`: false when the host says the verdict beside the work (the
 * Network Studio's inspector).
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, ButtonBase, Chip, CircularProgress, IconButton, InputBase, TextField, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import ArrowUpwardRoundedIcon from "@mui/icons-material/ArrowUpwardRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import AttachFileRoundedIcon from "@mui/icons-material/AttachFileRounded";
import SubdirectoryArrowRightRoundedIcon from "@mui/icons-material/SubdirectoryArrowRightRounded";
import PlaceOutlinedIcon from "@mui/icons-material/PlaceOutlined";
import RuleOutlinedIcon from "@mui/icons-material/RuleOutlined";
import RouteOutlinedIcon from "@mui/icons-material/RouteOutlined";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import AltRouteOutlinedIcon from "@mui/icons-material/AltRouteOutlined";
import AutoFixHighOutlinedIcon from "@mui/icons-material/AutoFixHighOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import AccountBalanceWalletOutlinedIcon from "@mui/icons-material/AccountBalanceWalletOutlined";
import VerifiedOutlinedIcon from "@mui/icons-material/VerifiedOutlined";
import CloudDownloadOutlinedIcon from "@mui/icons-material/CloudDownloadOutlined";
import PictureAsPdfOutlinedIcon from "@mui/icons-material/PictureAsPdfOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import DrawOutlinedIcon from "@mui/icons-material/DrawOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import MarkdownText from "../chat/MarkdownText";
import GTFSAIIcon from "../chat/GTFSAIIcon";
import { BRIEF_ACCEPT } from "../../utils/networkStudioApi";
import { QualityCard, qualityColor } from "./PlanCards";
import VerdictCard from "../common/VerdictCard";
import ProseWithStrikes from "../common/ProseWithStrikes";
import { SectionHeader, soft } from "./StudioUI";
import HandoffCard from "./HandoffCard";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import { DEMAND_DATA_ACCEPT } from "../../utils/transformApi";
import { DemandSummary, OptimizationSummary, ScenarioTable } from "./DemandCards";
import { estimatedTrips } from "../../utils/ridership";
import ErrorNotice from "../common/ErrorNotice";
import { isTechnical } from "../../utils/humanError";

// Brief templates: a specification skeleton per typical situation, with the blanks to fill.
const TEMPLATES = ["smallTown", "school", "city", "seasonal", "existing"];
const EXAMPLES = ["network.brief.exampleA", "network.brief.exampleB", "network.brief.exampleC"];

const STEP_ICON = { correction: AutoFixHighOutlinedIcon, correctionResolved: VerifiedOutlinedIcon, correctionEscalated: HelpOutlineIcon, geocode: PlaceOutlinedIcon, spec: RuleOutlinedIcon, geometry: RouteOutlinedIcon, questions: HelpOutlineIcon, territory: PlaceOutlinedIcon, requirements: FactCheckOutlinedIcon, corridors: AltRouteOutlinedIcon, refine: AutoFixHighOutlinedIcon, quality: VerifiedOutlinedIcon, feeds: CloudDownloadOutlinedIcon, import: CloudDownloadOutlinedIcon, documents: DescriptionOutlinedIcon, demand: VerifiedOutlinedIcon, optimize: AutoFixHighOutlinedIcon, scenarios: AltRouteOutlinedIcon, adopt_scenario: RouteOutlinedIcon, retry: RefreshOutlinedIcon, budget: AccountBalanceWalletOutlinedIcon };

// The planner's four phases, and what tells us each one has started.
const PHASES = ["understand", "ground", "design", "evaluate"];
const PHASE_OF_TOOL = { set_requirements: 0, ask_user: 0, get_territory: 1, suggest_corridors: 1, find_existing_feeds: 1, import_existing_network: 1, open_existing_network: 1, find_existing_stops: 2, geocode_stops: 2, set_spec: 2, refine_stops: 2, estimate_routes: 2, evaluate_plan: 3, coverage_score: 3 , patch_spec: 2, get_spec: 2, adopt_scenario: 2, generate_scenarios: 2, service_levers: 3, estimate_demand: 3, optimize_service: 3 };
const PHASE_OF_STEP = { documents: 0, requirements: 0, questions: 0, territory: 1, corridors: 1, feeds: 1, import: 1, geocode: 2, spec: 2, refine: 2, geometry: 2, quality: 3 , scenarios: 2, adopt_scenario: 2, demand: 3, optimize: 3 };

/** Live progress of a planner turn: done, current and upcoming phases. */
function PhaseTracker({ steps, pendingTool }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const reached = Math.max(-1, ...steps.map((s) => PHASE_OF_STEP[s.kind] ?? -1), pendingTool && PHASE_OF_TOOL[pendingTool] != null ? PHASE_OF_TOOL[pendingTool] : -1);
  const current = Math.max(0, reached);
  return (
    <Box data-testid="plan-phases" sx={{ display: "flex", alignItems: "center", gap: 0.5, mb: 1 }}>
      {PHASES.map((p, i) => {
        const done = i < current;
        const now = i === current;
        const color = done ? theme.palette.success.main : now ? theme.palette.primary.main : theme.palette.text.disabled;
        return (
          <React.Fragment key={p}>
            {i > 0 && <Box sx={{ flex: 1, minWidth: 8, height: 2, borderRadius: 1, background: i <= current ? alpha(theme.palette.success.main, 0.5) : soft(theme, 2) }} />}
            <Box data-phase={p} data-state={done ? "done" : now ? "current" : "todo"} sx={{ display: "flex", alignItems: "center", gap: 0.5, flexShrink: 0 }}>
              <Box sx={{ width: 16, height: 16, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: done ? alpha(color, 0.16) : now ? alpha(color, 0.14) : "transparent", border: done || now ? "none" : `1.5px solid ${alpha(color, 0.5)}` }}>
                {done ? <CheckRoundedIcon sx={{ fontSize: 12, color }} /> : now ? <CircularProgress size={10} thickness={6} sx={{ color }} /> : null}
              </Box>
              <Typography component="span" sx={{ fontSize: "0.68rem", fontWeight: now ? 700 : 600, color: now ? "text.primary" : "text.secondary" }}>
                {t(`network.phase.${p}`)}
              </Typography>
            </Box>
          </React.Fragment>
        );
      })}
    </Box>
  );
}

const fmtSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** An attached specification document in the composer. */
function DocumentChip({ doc, onRemove }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const isPdf = doc.kind === "pdf" || /\.pdf$/i.test(doc.name);
  const Icon = isPdf ? PictureAsPdfOutlinedIcon : DescriptionOutlinedIcon;
  const failed = doc.status === "error" || doc.status === "expired";
  const meta = doc.status === "uploading" ? t("network.docs.uploading") : doc.status === "expired" ? t("network.docs.expired") : doc.status === "error" ? doc.error : [doc.pages ? t("network.docs.pages", { count: doc.pages }) : null, doc.size ? fmtSize(doc.size) : null].filter(Boolean).join(" · ");
  return (
    <Box data-testid="plan-document" data-status={doc.status} sx={{ display: "flex", alignItems: "center", gap: 0.75, pl: 0.75, pr: 0.25, py: 0.5, borderRadius: "10px", maxWidth: "100%", background: failed ? alpha(theme.palette.error.main, 0.08) : theme.palette.background.paper, boxShadow: failed ? "none" : `0 0 0 1px ${theme.palette.divider}` }}>
      <Box sx={{ width: 26, height: 26, flexShrink: 0, borderRadius: "7px", display: "flex", alignItems: "center", justifyContent: "center", color: isPdf ? "#D32F2F" : theme.palette.primary.main, background: alpha(isPdf ? "#D32F2F" : theme.palette.primary.main, 0.1) }}>
        {doc.status === "uploading" ? <CircularProgress size={13} color="inherit" /> : <Icon sx={{ fontSize: 16 }} />}
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography sx={{ fontSize: "0.74rem", fontWeight: 700, lineHeight: 1.25 }} noWrap title={doc.name}>
          {doc.name}
        </Typography>
        <Typography sx={{ fontSize: "0.66rem", lineHeight: 1.25, color: failed ? "error.main" : "text.secondary" }} noWrap title={meta}>
          {meta}
        </Typography>
      </Box>
      <IconButton size="small" onClick={() => onRemove(doc)} aria-label={t("network.docs.remove")} sx={{ color: "text.secondary", p: 0.5 }}>
        <CloseRoundedIcon sx={{ fontSize: 15 }} />
      </IconButton>
    </Box>
  );
}

/** From scratch: one click to have the assistant design for the analysed territory. */
function ProposeCard({ place, disabled, onPropose }) {
  const { t } = useLanguage();
  const theme = useTheme();
  return (
    <Box data-testid="plan-propose-card" sx={{ p: 1.5, borderRadius: "12px", background: `linear-gradient(135deg, ${alpha(theme.palette.ai.gradientStart, 0.12)}, ${alpha(theme.palette.ai.gradientEnd, 0.1)})`, display: "flex", flexDirection: "column", gap: 0.75 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <AiAvatar size={26} />
        <Typography sx={{ fontSize: "0.88rem", fontWeight: 800, lineHeight: 1.25, minWidth: 0 }}>{t("network.propose.title", { place })}</Typography>
      </Box>
      <Typography sx={{ fontSize: "0.74rem", color: "text.secondary", lineHeight: 1.5 }}>{t("network.propose.hint")}</Typography>
      <Button size="small" variant="contained" disableElevation disabled={disabled} onClick={onPropose} endIcon={<AutoAwesomeIcon sx={{ fontSize: "16px !important" }} />} data-testid="plan-propose" sx={{ alignSelf: "flex-start", textTransform: "none", fontWeight: 700, fontSize: "0.78rem", py: 0.5, px: 1.75, borderRadius: 99, color: theme.palette.ai.contrastText, background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart}, ${theme.palette.ai.gradientEnd})`, "&.Mui-disabled": { background: soft(theme, 2), color: "text.disabled" } }}>
        {t("network.propose.action")}
      </Button>
    </Box>
  );
}

function AiAvatar({ size = 26 }) {
  const theme = useTheme();
  return (
    <Box sx={{ width: size, height: size, flexShrink: 0, borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", color: theme.palette.ai.contrastText, background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart}, ${theme.palette.ai.gradientEnd})` }}>
      <GTFSAIIcon sx={{ fontSize: size * 0.6 }} />
    </Box>
  );
}

function StepChip({ step }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const Icon = STEP_ICON[step.kind] || RuleOutlinedIcon;
  let label = t(`network.step.${step.kind}`);
  let color = theme.palette.text.secondary;
  if (step.kind === "geocode") label = t("network.step.geocodeResult", { found: step.found, total: step.queries });
  if (step.kind === "spec") {
    label = step.ok ? t("network.step.specOk") : t("network.step.specIssues", { count: step.blockers });
    if (!step.ok) color = theme.palette.warning.main;
  }
  if (step.kind === "territory") label = t("network.step.territory", { place: step.place || "" });
  if (step.kind === "corridors") label = t("network.step.corridors", { count: step.corridors ?? 0 });
  if (step.kind === "refine") label = t("network.step.refine", { snapped: step.snapped ?? 0, inserted: step.inserted ?? 0 });
  if (step.kind === "feeds") label = t("network.step.feeds", { count: step.count ?? 0 });
  if (step.kind === "import") label = t("network.step.import", { lines: step.lines ?? 0, stops: step.stops ?? 0 });
  if (step.kind === "documents") {
    label = t("network.step.documents", { count: step.count ?? 0 });
    if (step.missing?.length) color = theme.palette.warning.main;
  }
  if (step.kind === "quality") {
    label = t("network.step.quality", { score: step.score ?? "–" });
    color = qualityColor(step.score, theme);
  }
  // An estimate of no trip at all is none (utils/ridership): said unavailable, never « ≈ 0 voyages/jour ».
  if (step.kind === "demand") {
    const trips = estimatedTrips({ total_boardings_day: step.boardings_day });
    label = trips != null ? t("network.step.demand", { trips: Math.round(trips).toLocaleString(language) }) : t("transform.step.demandUnavailable");
  }
  if (step.kind === "optimize") label = t("network.step.optimize", { count: step.changes ?? 0 });
  if (step.kind === "scenarios") label = t("network.step.scenarios", { count: step.count ?? 0 });
  if (step.kind === "adopt_scenario") label = t("network.step.adopt_scenario", { name: t(`network.scenarios.strategy.${step.id}`) });
  // The self-correction (llm/selfCorrection): an attempt, a turn it settled, or the points it leaves to the person.
  if (step.kind === "correction") {
    label = t("network.step.correction", { attempt: step.attempt ?? 0, max: step.max ?? 0 });
    color = theme.palette.ai.main;
  }
  if (step.kind === "correctionResolved") {
    label = t("network.step.correctionResolved", { attempts: step.attempts ?? 0 });
    color = theme.palette.success.main;
  }
  if (step.kind === "correctionEscalated") {
    label = t("network.step.correctionEscalated", { max: step.max ?? 0 });
    color = theme.palette.warning.main;
  }
  // A round sent again after its stream was cut (llm/streamRound), and a turn closed at its budget (llm/turnBudget).
  if (step.kind === "retry") {
    label = t("network.step.retry", { attempt: step.attempt ?? 1, max: step.max ?? 0 });
    color = theme.palette.ai.main;
  }
  if (step.kind === "budget") {
    label = t("network.step.budget");
    color = theme.palette.warning.main;
  }
  const tinted = color !== theme.palette.text.secondary;
  return (
    <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.4, px: 0.75, py: 0.2, borderRadius: 99, fontSize: "0.66rem", fontWeight: 600, lineHeight: 1.5, color, background: tinted ? alpha(color, theme.palette.mode === "dark" ? 0.18 : 0.1) : soft(theme) }}>
      <Icon sx={{ fontSize: 13 }} />
      {label}
    </Box>
  );
}

function Questions({ questions, onAnswer, disabled }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [answers, setAnswers] = useState({});
  const complete = questions.every((q) => (answers[q.id] || "").trim().length > 0);
  const hasDefaults = questions.some((q) => q.default);
  const send = (values) => onAnswer(questions.map((q) => `${q.question} → ${values[q.id]}`).join("\n"));
  return (
    <Box data-testid="plan-questions" sx={{ mt: 1, borderRadius: "12px", background: alpha(theme.palette.warning.main, theme.palette.mode === "dark" ? 0.1 : 0.07), p: 1.5, display: "flex", flexDirection: "column", gap: 1.25 }}>
      {questions.map((q) => (
        <Box key={q.id} data-origin={q.origin || undefined}>
          {q.origin === "engine" && (
            <Typography component="span" data-testid="plan-question-engine" sx={{ display: "inline-block", fontSize: "0.64rem", fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", color: "warning.main", mb: 0.25 }}>
              {t("planner.question.engine")}
            </Typography>
          )}
          <Typography sx={{ fontSize: "0.8rem", fontWeight: 700, mb: 0.25 }}>{q.question}</Typography>
          {q.why && <Typography sx={{ fontSize: "0.7rem", color: "text.secondary", mb: 0.5 }}>{q.why}</Typography>}
          {q.options && q.options.length > 0 && (
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mb: 0.75 }}>
              {q.options.map((o) => {
                const selected = answers[q.id] === o;
                const suggested = !answers[q.id] && q.default === o;
                return <Chip key={o} size="small" label={o} color={selected ? "primary" : "default"} onClick={() => setAnswers((a) => ({ ...a, [q.id]: o }))} sx={{ height: 26, fontSize: "0.72rem", fontWeight: suggested || selected ? 700 : 500, ...(selected ? {} : { background: theme.palette.background.paper }), ...(suggested ? { boxShadow: `inset 0 0 0 1.5px ${theme.palette.primary.main}` } : {}) }} />;
              })}
            </Box>
          )}
          <TextField size="small" fullWidth placeholder={q.default ? t("network.questions.suggested", { value: q.default }) : t("network.answerPlaceholder")} value={answers[q.id] || ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} inputProps={{ "data-testid": `plan-answer-${q.id}` }} sx={{ "& .MuiOutlinedInput-root": { background: theme.palette.background.paper, fontSize: "0.8rem" } }} />
        </Box>
      ))}
      <Box sx={{ display: "flex", gap: 0.75, justifyContent: "flex-end", flexWrap: "wrap" }}>
        {hasDefaults && (
          <Button size="small" variant="text" disabled={disabled} onClick={() => send(Object.fromEntries(questions.map((q) => [q.id, (answers[q.id] || "").trim() || q.default || "—"])))} data-testid="plan-answers-defaults" sx={{ textTransform: "none", fontWeight: 700, py: 0.5, px: 1.25 }}>
            {t("network.questions.useDefaults")}
          </Button>
        )}
        <Button size="small" variant="contained" disableElevation disabled={!complete || disabled} onClick={() => send(answers)} data-testid="plan-answers-send" sx={{ textTransform: "none", fontWeight: 700, py: 0.5, px: 1.5 }}>
          {t("network.sendAnswers")}
        </Button>
      </Box>
    </Box>
  );
}

/** Without the assistant: the plan is filled by hand, in the lines and stops editors. */
function ManualCard({ onManual }) {
  const { t } = useLanguage();
  const theme = useTheme();
  return (
    <Box data-testid="plan-manual" sx={{ mt: 0.75, p: 1.5, borderRadius: "12px", background: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.12 : 0.06), display: "flex", flexDirection: "column", gap: 0.75 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Box sx={{ width: 26, height: 26, flexShrink: 0, borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", color: "primary.main", background: alpha(theme.palette.primary.main, 0.14) }}>
          <DrawOutlinedIcon sx={{ fontSize: 16 }} />
        </Box>
        <Typography sx={{ fontSize: "0.88rem", fontWeight: 800, lineHeight: 1.25 }}>{t("network.manual.title")}</Typography>
      </Box>
      <Typography sx={{ fontSize: "0.74rem", color: "text.secondary", lineHeight: 1.5 }}>{t("network.manual.text")}</Typography>
      {onManual && (
        <Button size="small" variant="contained" disableElevation onClick={onManual} data-testid="plan-manual-start" sx={{ alignSelf: "flex-start", textTransform: "none", fontWeight: 700, fontSize: "0.78rem", borderRadius: 99, px: 1.75 }}>
          {t("network.manual.action")}
        </Button>
      )}
    </Box>
  );
}

function EmptyState({ onExample, onTemplate, propose = null, onPropose = null, canPropose = false, canPlan = true, onManual = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  // Examples and templates only prefill the composer: without the assistant they would be dead clicks.
  if (!canPlan) {
    return (
      <Box>
        <SectionHeader label={t("network.assistant.section")} />
        <ManualCard onManual={onManual} />
      </Box>
    );
  }
  return (
    <Box>
      <SectionHeader label={t("network.assistant.section")} />
      {propose && onPropose && (
        <Box sx={{ mt: 0.75, mb: 1.75 }}>
          <ProposeCard place={propose.place} disabled={!canPropose} onPropose={onPropose} />
        </Box>
      )}
      <Box sx={{ display: "flex", gap: 1.25, alignItems: "flex-start", mt: 0.75 }}>
        <AiAvatar size={30} />
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontWeight: 800, fontSize: "0.92rem", lineHeight: 1.3 }}>{t("network.brief.title")}</Typography>
          <Typography sx={{ fontSize: "0.76rem", color: "text.secondary", lineHeight: 1.55, mt: 0.25 }}>{t("network.brief.intro")}</Typography>
        </Box>
      </Box>
      <Typography sx={{ fontSize: "0.72rem", fontWeight: 700, color: "text.secondary", mt: 1.75, mb: 0.25 }}>{t("network.brief.examples")}</Typography>
      <Box sx={{ display: "flex", flexDirection: "column" }}>
        {EXAMPLES.map((k) => (
          <ButtonBase key={k} onClick={() => onExample(t(k))} data-testid="plan-example" sx={{ justifyContent: "flex-start", alignItems: "flex-start", textAlign: "left", gap: 0.75, px: 1, py: 0.75, mx: -1, borderRadius: 1.5, fontSize: "0.76rem", lineHeight: 1.45, color: "text.primary", transition: "background 120ms", "&:hover": { background: soft(theme) } }}>
            <SubdirectoryArrowRightRoundedIcon sx={{ fontSize: 15, mt: 0.2, color: "text.disabled", flexShrink: 0 }} />
            <Box component="span" sx={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
              {t(k)}
            </Box>
          </ButtonBase>
        ))}
      </Box>
      <Typography sx={{ fontSize: "0.72rem", fontWeight: 700, color: "text.secondary", mt: 1.5, mb: 0.75 }}>{t("network.templates.title")}</Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
        {TEMPLATES.map((k) => (
          <Chip key={k} size="small" label={t(`network.templates.${k}.label`)} onClick={() => onTemplate(t(`network.templates.${k}.brief`))} data-testid="plan-template" sx={{ height: 26, fontSize: "0.72rem", fontWeight: 600, background: soft(theme, 1.3), "&:hover": { background: soft(theme, 2.2) } }} />
        ))}
      </Box>
    </Box>
  );
}

/** A turn's error: a plain message the studio wrote, or a failure to put in plain words. */
function TurnError({ error }) {
  if (!error) return null;
  if (typeof error === "string" && !isTechnical(error)) return <ErrorNotice human={{ message: error }} severity="warning" testid="plan-turn-error" sx={{ mt: 0.75 }} />;
  if (error.plain) return <ErrorNotice human={{ message: error.message }} severity="warning" testid="plan-turn-error" sx={{ mt: 0.75 }} />;
  return <ErrorNotice error={error} context="assistant" testid="plan-turn-error" sx={{ mt: 0.75 }} />;
}

export default function PlanChat({ turns, streaming, pendingTool, onSend, onStop, canPlan, disabledReason = null, header = null, documents = [], showDocuments = true, onAttach = null, onRemoveDocument = null, propose = null, onManual = null, onOpenFeed = null, place = null, onAdoptScenario = null, demandData = [], onAttachData = null, onRemoveData = null, designVerdict = null, showVerdict = true, controlRef = null, onOpenContract = null, contractLocked = false, composerHint = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState(0);
  const fileRef = useRef(null);
  const dataRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  // What the host may do from outside, by ref (never a query on a testid): focus the brief, pick a document.
  if (controlRef) controlRef.current = { focusBrief: () => inputRef.current?.focus(), pickFile: () => fileRef.current?.click() };
  const empty = turns.length === 0;
  const readyDocs = documents.filter((d) => d.status === "ready");
  const uploading = documents.some((d) => d.status === "uploading");

  // Follow the conversation, not the panel above it.
  useEffect(() => {
    const el = listRef.current;
    if (el && turns.length) el.scrollTop = el.scrollHeight;
  }, [turns, streaming]);

  // A document alone is a brief: the assistant designs what it describes.
  const canSend = canPlan && !streaming && !uploading && (draft.trim().length >= 3 || readyDocs.length > 0);
  // Without the assistant the composer keeps what is typed as a document of the project (documents never need it).
  const keeps = !canPlan && Boolean(onAttach);
  const canKeep = keeps && !uploading && draft.trim().length >= 3;
  const send = useCallback(() => {
    if (keeps) {
      if (!canKeep) return;
      onAttach([new File([draft.trim()], `${t("composer.pastedName")}.txt`, { type: "text/plain" })]);
      setDraft("");
      return;
    }
    if (!canSend) return;
    const text = draft.trim() || t("network.docs.defaultBrief");
    onSend(text);
    setDraft("");
  }, [keeps, canKeep, onAttach, canSend, draft, onSend, t]);

  const attach = (files) => {
    const list = Array.from(files || []).filter(Boolean);
    if (list.length && onAttach) onAttach(list);
  };
  const dragHandlers = onAttach
    ? {
        onDragEnter: (e) => {
          if (!Array.from(e.dataTransfer?.types || []).includes("Files")) return;
          e.preventDefault();
          setDragging((n) => n + 1);
        },
        onDragOver: (e) => {
          if (Array.from(e.dataTransfer?.types || []).includes("Files")) e.preventDefault();
        },
        onDragLeave: () => setDragging((n) => Math.max(0, n - 1)),
        onDrop: (e) => {
          e.preventDefault();
          setDragging(0);
          attach(e.dataTransfer?.files);
        },
      }
    : {};

  const prefill = useCallback((text) => {
    setDraft(text);
    setTimeout(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }, 0);
  }, []);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, position: "relative" }} {...dragHandlers}>
      {dragging > 0 && (
        <Box data-testid="plan-dropzone" sx={{ position: "absolute", inset: 8, zIndex: 5, borderRadius: "14px", border: `2px dashed ${theme.palette.primary.main}`, background: alpha(theme.palette.background.paper, 0.94), display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 0.75, pointerEvents: "none", textAlign: "center", px: 3 }}>
          <CloudUploadOutlinedIcon sx={{ fontSize: 36, color: "primary.main" }} />
          <Typography sx={{ fontSize: "0.92rem", fontWeight: 800 }}>{t("network.docs.drop")}</Typography>
          <Typography sx={{ fontSize: "0.74rem", color: "text.secondary" }}>{t("network.docs.dropHint")}</Typography>
        </Box>
      )}
      <Box ref={listRef} sx={{ flex: 1, minHeight: 0, overflowY: "auto" }} data-testid="plan-chat">
        {header}
        <Box sx={{ px: 2, pt: header ? 1.5 : 2, pb: 2, display: "flex", flexDirection: "column", gap: 1.75, borderTop: header ? `1px solid ${theme.palette.divider}` : "none" }}>
          {empty && <EmptyState onExample={prefill} onTemplate={prefill} propose={propose} canPropose={canPlan && !streaming && !uploading} onPropose={propose ? () => onSend(t("network.propose.brief", { place: propose.place })) : null} canPlan={canPlan} onManual={onManual} />}
          {!empty && <SectionHeader label={t("network.assistant.section")} />}
          {/* By hand: the engine's verdict on the design as it stands (re-measured on each edit). */}
          {!canPlan && showVerdict && <VerdictCard payload={designVerdict} design measured={Boolean(designVerdict)} />}
          {turns.map((turn) =>
            turn.role === "user" ? (
              <Box key={turn.id} data-testid="plan-turn-user" sx={{ alignSelf: "flex-end", maxWidth: "88%", px: 1.5, py: 1, borderRadius: "14px 14px 4px 14px", background: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.2 : 0.09), fontSize: "0.8rem", whiteSpace: "pre-wrap", lineHeight: 1.5, maxHeight: 220, overflowY: "auto" }}>
                {turn.content}
              </Box>
            ) : (
              <Box key={turn.id} data-testid="plan-turn-assistant" data-contradicts={turn.verdict?.prose?.contradicts ? "true" : "false"} sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}>
                <AiAvatar size={24} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  {/* The engine's verdict first, never the model's words: "not measured yet" until the event arrives. */}
                  <VerdictCard payload={turn.verdict || null} variant="turn" sx={{ mb: 1 }} />
                  {turn.status === "streaming" && <PhaseTracker steps={turn.steps || []} pendingTool={pendingTool} />}
                  {turn.steps && turn.steps.length > 0 && (
                    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mb: turn.content ? 1 : 0 }}>
                      {turn.steps.map((s, i) => (
                        <StepChip key={i} step={s} />
                      ))}
                    </Box>
                  )}
                  {(turn.superseded || []).length > 0 && (
                    <Box component="details" data-testid="plan-turn-superseded" sx={{ mb: 1, fontSize: "0.74rem", color: "text.secondary", "& summary": { cursor: "pointer", fontWeight: 600 } }}>
                      <summary>{t("planner.correction.superseded")}</summary>
                      {turn.superseded.map((text, i) => (
                        <Box key={i} sx={{ mt: 0.5, pl: 1, borderLeft: `2px solid ${theme.palette.divider}`, opacity: 0.75, whiteSpace: "pre-wrap" }}>
                          {text}
                        </Box>
                      ))}
                    </Box>
                  )}
                  {turn.content ? (
                    <Box sx={{ fontSize: "0.8rem", lineHeight: 1.55 }}>
                      {/* Before the verdict the words are the model's unchecked claim (muted, said so); the spans describe the finished text: struck once the turn is over. */}
                      {!turn.verdict ? <ProseWithStrikes text={turn.content} unchecked /> : turn.status === "streaming" ? <MarkdownText text={turn.content} /> : <ProseWithStrikes text={turn.content} prose={turn.verdict.prose || null} />}
                    </Box>
                  ) : turn.status === "streaming" ? (
                    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, fontSize: "0.76rem", color: "text.secondary", mt: 0.25 }}>
                      <CircularProgress size={12} />
                      {pendingTool ? t(`network.working.${pendingTool}`, {}) : t("network.working.thinking")}
                    </Box>
                  ) : null}
                  {turn.quality && turn.status !== "streaming" && <QualityCard quality={turn.quality} />}
                  {turn.demand && turn.status !== "streaming" && <DemandSummary demand={turn.demand} />}
                  {turn.optimization && turn.status !== "streaming" && <OptimizationSummary optimization={turn.optimization} />}
                  {turn.scenarios && turn.status !== "streaming" && <ScenarioTable scenarios={turn.scenarios} onAdopt={onAdoptScenario} disabled={streaming} />}
                  {turn.handoff && <HandoffCard handoff={turn.handoff} place={place} disabled={streaming} onOpened={(r, feed, brief) => onOpenFeed && onOpenFeed(r, feed, brief)} />}
                  {/* The first turn is the extraction: the contract it proposes, decided at ②, nothing designed. */}
                  {turn.extracted && (
                    <Box data-testid="plan-contract-extracted" sx={{ mt: 1, p: 1.25, borderRadius: "12px", background: alpha(theme.palette.primary.main, 0.06), display: "flex", flexDirection: "column", gap: 0.5 }}>
                      <Typography sx={{ fontSize: "0.8rem", fontWeight: 700 }}>{t("contract.extracted.turn", { clauses: turn.extracted.clauses, wishes: turn.extracted.wishes, uncovered: turn.extracted.uncovered })}</Typography>
                      {onOpenContract && (
                        <Button size="small" variant="outlined" onClick={onOpenContract} data-testid="plan-contract-open" sx={{ alignSelf: "flex-start", textTransform: "none", fontWeight: 700 }}>
                          {t("contract.open")}
                        </Button>
                      )}
                    </Box>
                  )}
                  {turn.stopped && <Typography sx={{ fontSize: "0.74rem", color: "text.secondary", mt: 0.5 }}>{t("network.stopped")}</Typography>}
                  {turn.trial && turn.status !== "streaming" && (
                    <Typography data-testid="plan-turn-trial" sx={{ fontSize: "0.72rem", color: "text.secondary", mt: 0.5, fontStyle: "italic" }}>
                      {t("network.plan.trialModel")}
                    </Typography>
                  )}
                  <TurnError error={turn.error} />
                  {turn.questions && turn.questions.length > 0 && turn.status !== "streaming" && !turn.answered && <Questions questions={turn.questions} disabled={streaming} onAnswer={(text) => onSend(text, { answersFor: turn.id })} />}
                </Box>
              </Box>
            ),
          )}
        </Box>
      </Box>

      {/* Composer */}
      <Box sx={{ px: 1.5, pt: 1, pb: 1.5, borderTop: `1px solid ${theme.palette.divider}` }}>
        {disabledReason &&
          (contractLocked ? (
            // The contract first: the lock says why, and the way to ② is right here.
            <Alert severity="info" data-testid="plan-contract-lock" action={onOpenContract ? <Button color="inherit" size="small" onClick={onOpenContract} data-testid="plan-contract-lock-open" sx={{ textTransform: "none", fontWeight: 700 }}>{t("contract.open")}</Button> : null} sx={{ mb: 0.75, py: 0, fontSize: "0.74rem", alignItems: "center" }}>
              {disabledReason}
            </Alert>
          ) : (
            <Typography sx={{ fontSize: "0.74rem", color: "warning.dark", mb: 0.75, px: 0.5 }}>{disabledReason}</Typography>
          ))}
        <Box
          sx={{
            borderRadius: "14px",
            px: 1.5,
            pt: 1.1,
            pb: 0.6,
            background: soft(theme, 1.2),
            border: "1px solid transparent",
            transition: "background 120ms, border-color 120ms, box-shadow 120ms",
            "&:focus-within": { background: theme.palette.background.paper, borderColor: alpha(theme.palette.primary.main, 0.5), boxShadow: `0 0 0 3px ${alpha(theme.palette.primary.main, 0.1)}` },
          }}
        >
          {demandData.length > 0 && (
            <Box data-testid="plan-data" sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mb: 1 }}>
              {demandData.map((d) => (
                <Chip
                  key={d.key}
                  size="small"
                  icon={d.status === "uploading" ? <CircularProgress size={11} /> : <UploadFileOutlinedIcon sx={{ fontSize: 14 }} />}
                  color={d.status === "error" ? "error" : "default"}
                  label={d.status === "error" ? t("transform.demand.uploadFailed", { message: d.error || "" }) : d.status === "ready" ? t("transform.demand.dataset", { name: d.name, rows: d.rows ?? "?", kind: t(`transform.demand.kind.${d.kind}`) }) : d.name}
                  onDelete={onRemoveData ? () => onRemoveData(d) : undefined}
                  data-testid="plan-data-item"
                  sx={{ maxWidth: "100%", fontSize: "0.68rem" }}
                />
              ))}
            </Box>
          )}
          {showDocuments && documents.length > 0 && (
            <Box data-testid="plan-documents" sx={{ display: "grid", gridTemplateColumns: documents.length > 1 ? "1fr 1fr" : "1fr", gap: 0.75, mb: 1 }}>
              {documents.map((d) => (
                <DocumentChip key={d.id || d.name} doc={d} onRemove={(doc) => onRemoveDocument && onRemoveDocument(doc)} />
              ))}
            </Box>
          )}
          <InputBase
            multiline
            minRows={empty ? 3 : 1}
            maxRows={10}
            fullWidth
            placeholder={keeps ? t("composer.keepPlaceholder") : readyDocs.length && !draft ? t("network.docs.placeholder") : empty ? t("network.brief.placeholder") : t("network.refinePlaceholder")}
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, 60000))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
            inputRef={inputRef}
            inputProps={{ "data-testid": "plan-brief", "aria-label": t("network.brief.placeholder") }}
            disabled={!canPlan && !keeps}
            sx={{ fontSize: "0.84rem", lineHeight: 1.5, alignItems: "flex-start" }}
          />
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mt: 0.5 }}>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={BRIEF_ACCEPT}
              hidden
              data-testid="plan-file"
              onChange={(e) => {
                attach(e.target.files);
                e.target.value = "";
              }}
            />
            <Tooltip title={`${t("network.docs.attach")} — ${t("network.docs.dropHint")}`}>
              <span>
                <IconButton size="small" onClick={() => fileRef.current?.click()} disabled={!onAttach} aria-label={t("network.docs.attach")} data-testid="plan-attach" sx={{ ml: -0.75, color: "text.secondary" }}>
                  <AttachFileRoundedIcon sx={{ fontSize: 18, transform: "rotate(45deg)" }} />
                </IconButton>
              </span>
            </Tooltip>
            {onAttachData && (
              <>
                <input
                  ref={dataRef}
                  type="file"
                  multiple
                  accept={DEMAND_DATA_ACCEPT}
                  hidden
                  data-testid="plan-data-file"
                  onChange={(e) => {
                    onAttachData(e.target.files);
                    e.target.value = "";
                  }}
                />
                <Tooltip title={`${t("transform.demand.import")} — ${t("transform.demand.importHint")}`}>
                  <span>
                    <IconButton size="small" onClick={() => dataRef.current?.click()} disabled={!canPlan} aria-label={t("transform.demand.import")} data-testid="plan-data-attach" sx={{ color: "text.secondary" }}>
                      <UploadFileOutlinedIcon sx={{ fontSize: 18 }} />
                    </IconButton>
                  </span>
                </Tooltip>
              </>
            )}
            {!documents.length && <Typography sx={{ fontSize: "0.68rem", color: "text.secondary" }} noWrap>{t("network.docs.hint")}</Typography>}
            <Box sx={{ flex: 1 }} />
            {streaming ? (
              <Button size="small" variant="text" color="inherit" startIcon={<StopRoundedIcon />} onClick={onStop} sx={{ textTransform: "none", fontWeight: 600, py: 0.4, px: 1.25, borderRadius: 99 }}>
                {t("network.stop")}
              </Button>
            ) : (
              <Tooltip title={keeps ? t("composer.keepHint") : t("network.sendHint")}>
                <span>
                  <Button
                    size="small"
                    variant="contained"
                    disableElevation
                    endIcon={keeps ? <DescriptionOutlinedIcon sx={{ fontSize: "16px !important" }} /> : empty ? <AutoAwesomeIcon sx={{ fontSize: "16px !important" }} /> : <ArrowUpwardRoundedIcon sx={{ fontSize: "16px !important" }} />}
                    disabled={keeps ? !canKeep : !canSend}
                    onClick={send}
                    data-testid="plan-send"
                    sx={{ textTransform: "none", fontWeight: 700, fontSize: "0.78rem", py: 0.5, px: 1.5, borderRadius: 99, flexShrink: 0, color: theme.palette.ai.contrastText, background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart}, ${theme.palette.ai.gradientEnd})`, "&.Mui-disabled": { background: soft(theme, 2), color: "text.disabled" } }}
                  >
                    {keeps ? t("composer.keepAsDocument") : empty ? t("network.plan") : t("network.refine")}
                  </Button>
                </span>
              </Tooltip>
            )}
          </Box>
        </Box>
        {/* The contract first, said before the first message: it extracts the contract, it designs nothing. */}
        {composerHint && (
          <Typography data-testid="plan-first-extracts" sx={{ fontSize: "0.72rem", color: "text.secondary", mt: 0.5, px: 0.5 }}>
            {composerHint}
          </Typography>
        )}
      </Box>
    </Box>
  );
}
