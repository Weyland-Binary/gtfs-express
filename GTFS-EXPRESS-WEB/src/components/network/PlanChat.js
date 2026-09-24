/**
 * PlanChat — the conversation with the planner: the brief (typed or
 * dropped as a text file), the planner's answers (markdown), the tool steps
 * it took, the requirements it understood (correctable), its questions
 * (answer with chips, free text, or accept the suggested answers), the
 * design quality report, and a composer to refine ("add a line to the
 * hospital", "every 10 minutes at peak").
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, Chip, CircularProgress, IconButton, TextField, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import SendRoundedIcon from "@mui/icons-material/SendRounded";
import StopCircleOutlinedIcon from "@mui/icons-material/StopCircleOutlined";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import PlaceOutlinedIcon from "@mui/icons-material/PlaceOutlined";
import RuleOutlinedIcon from "@mui/icons-material/RuleOutlined";
import RouteOutlinedIcon from "@mui/icons-material/RouteOutlined";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import AltRouteOutlinedIcon from "@mui/icons-material/AltRouteOutlined";
import AutoFixHighOutlinedIcon from "@mui/icons-material/AutoFixHighOutlined";
import VerifiedOutlinedIcon from "@mui/icons-material/VerifiedOutlined";
import CloudDownloadOutlinedIcon from "@mui/icons-material/CloudDownloadOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import MarkdownText from "../chat/MarkdownText";
import GTFSAIIcon from "../chat/GTFSAIIcon";
import { readBriefFile } from "../../utils/networkStudioApi";
import { RequirementsCard, QualityCard, qualityColor } from "./PlanCards";

// Brief templates: a specification skeleton per typical situation, with the blanks to fill.
const TEMPLATES = ["smallTown", "school", "city", "seasonal", "existing"];

const STEP_ICON = { geocode: PlaceOutlinedIcon, spec: RuleOutlinedIcon, geometry: RouteOutlinedIcon, questions: HelpOutlineIcon, territory: PlaceOutlinedIcon, requirements: FactCheckOutlinedIcon, corridors: AltRouteOutlinedIcon, refine: AutoFixHighOutlinedIcon, quality: VerifiedOutlinedIcon, feeds: CloudDownloadOutlinedIcon, import: CloudDownloadOutlinedIcon };

function StepChip({ step }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const Icon = STEP_ICON[step.kind] || RuleOutlinedIcon;
  let label = t(`network.step.${step.kind}`);
  let sx = {};
  if (step.kind === "geocode") label = t("network.step.geocodeResult", { found: step.found, total: step.queries });
  if (step.kind === "spec") label = step.ok ? t("network.step.specOk") : t("network.step.specIssues", { count: step.blockers });
  if (step.kind === "territory") label = t("network.step.territory", { place: step.place || "" });
  if (step.kind === "corridors") label = t("network.step.corridors", { count: step.corridors ?? 0 });
  if (step.kind === "refine") label = t("network.step.refine", { snapped: step.snapped ?? 0, inserted: step.inserted ?? 0 });
  if (step.kind === "feeds") label = t("network.step.feeds", { count: step.count ?? 0 });
  if (step.kind === "import") label = t("network.step.import", { lines: step.lines ?? 0, stops: step.stops ?? 0 });
  if (step.kind === "quality") {
    label = t("network.step.quality", { score: step.score ?? "–" });
    sx = { color: qualityColor(step.score, theme), borderColor: alpha(qualityColor(step.score, theme), 0.6) };
  }
  return <Chip size="small" icon={<Icon sx={{ fontSize: 13, color: sx.color ? `${sx.color} !important` : undefined }} />} label={label} color={step.kind === "spec" && !step.ok ? "warning" : "default"} variant="outlined" sx={{ height: 20, fontSize: "0.64rem", fontWeight: 600, ...sx }} />;
}

function Questions({ questions, onAnswer, disabled }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [answers, setAnswers] = useState({});
  const complete = questions.every((q) => (answers[q.id] || "").trim().length > 0);
  const hasDefaults = questions.some((q) => q.default);
  const send = (values) => onAnswer(questions.map((q) => `${q.question} → ${values[q.id]}`).join("\n"));
  return (
    <Box data-testid="plan-questions" sx={{ mt: 1, borderRadius: 1.5, border: `1px solid ${alpha(theme.palette.warning.main, 0.5)}`, background: alpha(theme.palette.warning.main, 0.05), p: 1.25, display: "flex", flexDirection: "column", gap: 1 }}>
      {questions.map((q) => (
        <Box key={q.id}>
          <Typography sx={{ fontSize: "0.8rem", fontWeight: 700, mb: 0.25 }}>{q.question}</Typography>
          {q.why && <Typography sx={{ fontSize: "0.7rem", color: "text.secondary", mb: 0.5 }}>{q.why}</Typography>}
          {q.options && q.options.length > 0 && (
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mb: 0.5 }}>
              {q.options.map((o) => (
                <Chip key={o} size="small" label={o} color={answers[q.id] === o ? "primary" : "default"} variant={!answers[q.id] && q.default === o ? "outlined" : "filled"} onClick={() => setAnswers((a) => ({ ...a, [q.id]: o }))} sx={{ height: 24, fontSize: "0.72rem", ...(q.default === o && !answers[q.id] ? { borderColor: theme.palette.primary.main, fontWeight: 700 } : {}) }} />
              ))}
            </Box>
          )}
          <TextField size="small" fullWidth placeholder={q.default ? t("network.questions.suggested", { value: q.default }) : t("network.answerPlaceholder")} value={answers[q.id] || ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} inputProps={{ "data-testid": `plan-answer-${q.id}` }} />
        </Box>
      ))}
      <Box sx={{ display: "flex", gap: 0.75, justifyContent: "flex-end", flexWrap: "wrap" }}>
        {hasDefaults && (
          <Button size="small" variant="outlined" disabled={disabled} onClick={() => send(Object.fromEntries(questions.map((q) => [q.id, (answers[q.id] || "").trim() || q.default || "—"])))} data-testid="plan-answers-defaults" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("network.questions.useDefaults")}
          </Button>
        )}
        <Button size="small" variant="contained" disableElevation disabled={!complete || disabled} onClick={() => send(answers)} data-testid="plan-answers-send" sx={{ textTransform: "none", fontWeight: 700 }}>
          {t("network.sendAnswers")}
        </Button>
      </Box>
    </Box>
  );
}

export default function PlanChat({ turns, streaming, pendingTool, onSend, onStop, canPlan, disabledReason = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [draft, setDraft] = useState("");
  const [fileError, setFileError] = useState(null);
  const fileRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const empty = turns.length === 0;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, streaming]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (text.length < 3 || streaming || !canPlan) return;
    onSend(text);
    setDraft("");
  }, [draft, streaming, canPlan, onSend]);

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

  const onFile = async (file) => {
    if (!file) return;
    setFileError(null);
    try {
      const text = await readBriefFile(file);
      setDraft((d) => (d ? `${d}\n\n${text}` : text));
    } catch (err) {
      setFileError(err.code === "UNSUPPORTED_FILE" ? t("network.brief.unsupported") : err.code === "FILE_TOO_LARGE" ? t("network.brief.tooLarge") : err.message);
    }
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Box ref={listRef} sx={{ flex: 1, overflowY: "auto", px: 2, py: 1.5, display: "flex", flexDirection: "column", gap: 1.25 }} data-testid="plan-chat">
        {empty && (
          <Box sx={{ mt: 1 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.75 }}>
              <Box sx={{ width: 34, height: 34, borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart}, ${theme.palette.ai.gradientEnd})`, color: theme.palette.ai.contrastText }}>
                <GTFSAIIcon sx={{ fontSize: 20 }} />
              </Box>
              <Typography sx={{ fontWeight: 800, fontSize: "1rem" }}>{t("network.brief.title")}</Typography>
            </Box>
            <Typography sx={{ fontSize: "0.82rem", color: "text.secondary", lineHeight: 1.55, mb: 1 }}>{t("network.brief.intro")}</Typography>
            <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
              {["network.brief.exampleA", "network.brief.exampleB", "network.brief.exampleC"].map((k) => (
                <Box key={k} component="button" type="button" onClick={() => setDraft(t(k))} data-testid="plan-example" sx={{ all: "unset", cursor: "pointer", fontSize: "0.76rem", lineHeight: 1.45, px: 1.25, py: 0.8, borderRadius: 1.5, border: `1px solid ${alpha(theme.palette.ai.main, 0.25)}`, background: alpha(theme.palette.ai.main, 0.04), "&:hover": { background: alpha(theme.palette.ai.main, 0.1) } }}>
                  {t(k)}
                </Box>
              ))}
            </Box>
            <Typography sx={{ fontSize: "0.7rem", fontWeight: 700, color: "text.secondary", textTransform: "uppercase", letterSpacing: 0.3, mt: 1.25, mb: 0.5 }}>{t("network.templates.title")}</Typography>
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
              {TEMPLATES.map((k) => (
                <Chip key={k} size="small" label={t(`network.templates.${k}.label`)} onClick={() => prefill(t(`network.templates.${k}.brief`))} data-testid="plan-template" variant="outlined" sx={{ height: 24, fontSize: "0.7rem", fontWeight: 600 }} />
              ))}
            </Box>
          </Box>
        )}
        {turns.map((turn) => (
          <Box key={turn.id} sx={{ alignSelf: turn.role === "user" ? "flex-end" : "stretch", maxWidth: turn.role === "user" ? "88%" : "100%" }}>
            {turn.role === "user" ? (
              <Box data-testid="plan-turn-user" sx={{ px: 1.5, py: 1, borderRadius: 2, background: alpha(theme.palette.primary.main, 0.1), fontSize: "0.82rem", whiteSpace: "pre-wrap", lineHeight: 1.5, maxHeight: 220, overflowY: "auto" }}>
                {turn.content}
              </Box>
            ) : (
              <Box data-testid="plan-turn-assistant" sx={{ px: 1.5, py: 1, borderRadius: 2, border: `1px solid ${alpha(theme.palette.ai.main, 0.25)}`, background: alpha(theme.palette.ai.main, 0.03) }}>
                {turn.steps && turn.steps.length > 0 && (
                  <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mb: turn.content ? 0.75 : 0 }}>
                    {turn.steps.map((s, i) => (
                      <StepChip key={i} step={s} />
                    ))}
                  </Box>
                )}
                {turn.requirements && <RequirementsCard requirements={turn.requirements} onCorrect={canPlan && !streaming ? prefill : null} />}
                {turn.content ? (
                  <Box sx={{ fontSize: "0.82rem", mt: turn.requirements ? 1 : 0 }}>
                    <MarkdownText text={turn.content} />
                  </Box>
                ) : turn.status === "streaming" ? (
                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, fontSize: "0.76rem", color: "text.secondary", mt: turn.requirements ? 1 : 0 }}>
                    <CircularProgress size={12} />
                    {pendingTool ? t(`network.working.${pendingTool}`, {}) : t("network.working.thinking")}
                  </Box>
                ) : null}
                {turn.quality && turn.status !== "streaming" && <QualityCard quality={turn.quality} />}
                {turn.error && <Typography sx={{ fontSize: "0.76rem", color: "error.main", mt: 0.5 }}>{turn.error}</Typography>}
                {turn.questions && turn.questions.length > 0 && turn.status !== "streaming" && !turn.answered && <Questions questions={turn.questions} disabled={streaming} onAnswer={(text) => onSend(text, { answersFor: turn.id })} />}
              </Box>
            )}
          </Box>
        ))}
      </Box>
      <Box sx={{ borderTop: `1px solid ${alpha(theme.palette.divider, 1)}`, p: 1.25, display: "flex", flexDirection: "column", gap: 0.75 }}>
        {disabledReason && <Typography sx={{ fontSize: "0.74rem", color: "warning.dark" }}>{disabledReason}</Typography>}
        <TextField
          multiline
          minRows={empty ? 5 : 2}
          maxRows={10}
          fullWidth
          size="small"
          placeholder={empty ? t("network.brief.placeholder") : t("network.refinePlaceholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, 60000))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          inputRef={inputRef}
          inputProps={{ "data-testid": "plan-brief" }}
          disabled={!canPlan}
        />
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
          <input ref={fileRef} type="file" accept=".txt,.md,.markdown,.csv,.json,.tsv,text/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
          <Tooltip title={t("network.brief.attach")}>
            <span>
              <IconButton size="small" onClick={() => fileRef.current?.click()} disabled={!canPlan} aria-label={t("network.brief.attach")}>
                <UploadFileOutlinedIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </span>
          </Tooltip>
          {fileError && <Typography sx={{ fontSize: "0.72rem", color: "error.main" }}>{fileError}</Typography>}
          <Box sx={{ flex: 1 }} />
          {streaming ? (
            <Button size="small" variant="outlined" color="inherit" startIcon={<StopCircleOutlinedIcon />} onClick={onStop} sx={{ textTransform: "none" }}>
              {t("network.stop")}
            </Button>
          ) : (
            <Button size="small" variant="contained" disableElevation startIcon={empty ? <AutoAwesomeIcon /> : <SendRoundedIcon />} disabled={draft.trim().length < 3 || !canPlan} onClick={send} data-testid="plan-send" sx={{ textTransform: "none", fontWeight: 700, background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart}, ${theme.palette.ai.gradientEnd})` }}>
              {empty ? t("network.plan") : t("network.refine")}
            </Button>
          )}
        </Box>
      </Box>
    </Box>
  );
}
