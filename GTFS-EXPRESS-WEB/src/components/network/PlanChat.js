/**
 * PlanChat — the side panel's conversation with the planner: whatever sits
 * above it (the territory, via `header`) scrolls with the messages, the
 * composer stays pinned at the bottom. The brief is typed or dropped as a
 * text file; the planner answers in markdown with the steps it took, the
 * requirements it understood (correctable), its questions (answer with
 * chips, free text, or accept the suggested answers) and the design quality
 * report; the same composer then refines the plan.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, ButtonBase, Chip, CircularProgress, IconButton, InputBase, TextField, Tooltip, Typography, alpha, useTheme } from "@mui/material";
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
import VerifiedOutlinedIcon from "@mui/icons-material/VerifiedOutlined";
import CloudDownloadOutlinedIcon from "@mui/icons-material/CloudDownloadOutlined";
import PictureAsPdfOutlinedIcon from "@mui/icons-material/PictureAsPdfOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import MarkdownText from "../chat/MarkdownText";
import GTFSAIIcon from "../chat/GTFSAIIcon";
import { BRIEF_ACCEPT } from "../../utils/networkStudioApi";
import { RequirementsCard, QualityCard, qualityColor } from "./PlanCards";
import { SectionHeader, soft } from "./StudioUI";

// Brief templates: a specification skeleton per typical situation, with the blanks to fill.
const TEMPLATES = ["smallTown", "school", "city", "seasonal", "existing"];
const EXAMPLES = ["network.brief.exampleA", "network.brief.exampleB", "network.brief.exampleC"];

const STEP_ICON = { geocode: PlaceOutlinedIcon, spec: RuleOutlinedIcon, geometry: RouteOutlinedIcon, questions: HelpOutlineIcon, territory: PlaceOutlinedIcon, requirements: FactCheckOutlinedIcon, corridors: AltRouteOutlinedIcon, refine: AutoFixHighOutlinedIcon, quality: VerifiedOutlinedIcon, feeds: CloudDownloadOutlinedIcon, import: CloudDownloadOutlinedIcon, documents: DescriptionOutlinedIcon };

// The planner's four phases, and what tells us each one has started.
const PHASES = ["understand", "ground", "design", "evaluate"];
const PHASE_OF_TOOL = { set_requirements: 0, ask_user: 0, get_territory: 1, suggest_corridors: 1, find_existing_feeds: 1, import_existing_network: 1, find_existing_stops: 2, geocode_stops: 2, set_spec: 2, refine_stops: 2, estimate_routes: 2, evaluate_plan: 3, coverage_score: 3 };
const PHASE_OF_STEP = { documents: 0, requirements: 0, questions: 0, territory: 1, corridors: 1, feeds: 1, import: 1, geocode: 2, spec: 2, refine: 2, geometry: 2, quality: 3 };

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
  const { t } = useLanguage();
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
        <Box key={q.id}>
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

function EmptyState({ onExample, onTemplate, propose = null, onPropose = null, canPropose = false }) {
  const { t } = useLanguage();
  const theme = useTheme();
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

export default function PlanChat({ turns, streaming, pendingTool, onSend, onStop, canPlan, disabledReason = null, header = null, documents = [], onAttach = null, onRemoveDocument = null, propose = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState(0);
  const fileRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);
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
  const send = useCallback(() => {
    if (!canSend) return;
    const text = draft.trim() || t("network.docs.defaultBrief");
    onSend(text);
    setDraft("");
  }, [canSend, draft, onSend, t]);

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
          if (canPlan) attach(e.dataTransfer?.files);
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
          {empty && <EmptyState onExample={prefill} onTemplate={prefill} propose={propose} canPropose={canPlan && !streaming && !uploading} onPropose={propose ? () => onSend(t("network.propose.brief", { place: propose.place })) : null} />}
          {!empty && <SectionHeader label={t("network.assistant.section")} />}
          {turns.map((turn) =>
            turn.role === "user" ? (
              <Box key={turn.id} data-testid="plan-turn-user" sx={{ alignSelf: "flex-end", maxWidth: "88%", px: 1.5, py: 1, borderRadius: "14px 14px 4px 14px", background: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.2 : 0.09), fontSize: "0.8rem", whiteSpace: "pre-wrap", lineHeight: 1.5, maxHeight: 220, overflowY: "auto" }}>
                {turn.content}
              </Box>
            ) : (
              <Box key={turn.id} data-testid="plan-turn-assistant" sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}>
                <AiAvatar size={24} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  {turn.status === "streaming" && <PhaseTracker steps={turn.steps || []} pendingTool={pendingTool} />}
                  {turn.steps && turn.steps.length > 0 && (
                    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mb: turn.content || turn.requirements ? 1 : 0 }}>
                      {turn.steps.map((s, i) => (
                        <StepChip key={i} step={s} />
                      ))}
                    </Box>
                  )}
                  {turn.requirements && <RequirementsCard requirements={turn.requirements} onCorrect={canPlan && !streaming ? prefill : null} />}
                  {turn.content ? (
                    <Box sx={{ fontSize: "0.8rem", lineHeight: 1.55, mt: turn.requirements ? 1 : 0 }}>
                      <MarkdownText text={turn.content} />
                    </Box>
                  ) : turn.status === "streaming" ? (
                    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, fontSize: "0.76rem", color: "text.secondary", mt: turn.requirements ? 1 : 0.25 }}>
                      <CircularProgress size={12} />
                      {pendingTool ? t(`network.working.${pendingTool}`, {}) : t("network.working.thinking")}
                    </Box>
                  ) : null}
                  {turn.quality && turn.status !== "streaming" && <QualityCard quality={turn.quality} />}
                  {turn.error && <Typography sx={{ fontSize: "0.76rem", color: "error.main", mt: 0.5 }}>{turn.error}</Typography>}
                  {turn.questions && turn.questions.length > 0 && turn.status !== "streaming" && !turn.answered && <Questions questions={turn.questions} disabled={streaming} onAnswer={(text) => onSend(text, { answersFor: turn.id })} />}
                </Box>
              </Box>
            ),
          )}
        </Box>
      </Box>

      {/* Composer */}
      <Box sx={{ px: 1.5, pt: 1, pb: 1.5, borderTop: `1px solid ${theme.palette.divider}` }}>
        {disabledReason && <Typography sx={{ fontSize: "0.74rem", color: "warning.dark", mb: 0.75, px: 0.5 }}>{disabledReason}</Typography>}
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
          {documents.length > 0 && (
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
            placeholder={readyDocs.length && !draft ? t("network.docs.placeholder") : empty ? t("network.brief.placeholder") : t("network.refinePlaceholder")}
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
            disabled={!canPlan}
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
                <IconButton size="small" onClick={() => fileRef.current?.click()} disabled={!canPlan || !onAttach} aria-label={t("network.docs.attach")} data-testid="plan-attach" sx={{ ml: -0.75, color: "text.secondary" }}>
                  <AttachFileRoundedIcon sx={{ fontSize: 18, transform: "rotate(45deg)" }} />
                </IconButton>
              </span>
            </Tooltip>
            {!documents.length && <Typography sx={{ fontSize: "0.68rem", color: "text.disabled" }} noWrap>{t("network.docs.hint")}</Typography>}
            <Box sx={{ flex: 1 }} />
            {streaming ? (
              <Button size="small" variant="text" color="inherit" startIcon={<StopRoundedIcon />} onClick={onStop} sx={{ textTransform: "none", fontWeight: 600, py: 0.4, px: 1.25, borderRadius: 99 }}>
                {t("network.stop")}
              </Button>
            ) : (
              <Tooltip title={t("network.sendHint")}>
                <span>
                  <Button
                    size="small"
                    variant="contained"
                    disableElevation
                    endIcon={empty ? <AutoAwesomeIcon sx={{ fontSize: "16px !important" }} /> : <ArrowUpwardRoundedIcon sx={{ fontSize: "16px !important" }} />}
                    disabled={!canSend}
                    onClick={send}
                    data-testid="plan-send"
                    sx={{ textTransform: "none", fontWeight: 700, fontSize: "0.78rem", py: 0.5, px: 1.5, borderRadius: 99, flexShrink: 0, color: theme.palette.ai.contrastText, background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart}, ${theme.palette.ai.gradientEnd})`, "&.Mui-disabled": { background: soft(theme, 2), color: "text.disabled" } }}
                  >
                    {empty ? t("network.plan") : t("network.refine")}
                  </Button>
                </span>
              </Tooltip>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
