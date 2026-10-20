/**
 * DirectChange — a brief draft: the direct mode's ONE screen, in moments of one action each.
 *
 *   Déposer       one field where the brief is written or pasted, its documents as chips inside it (attached or
 *                 dropped on the field); « Préparer le changement » (or Ctrl+Entrée) runs the turn (POST
 *                 /transform/direct): an agent changes a copy of the network, the engine states the facts, an
 *                 independent reviewer measures each demand on the copy.
 *   Voir avancer  the few stages the turn goes through — the brief read, a copy of the network changed, the
 *                 independent review, the corrections when the review found any (two rounds at most), ready — the
 *                 current one alive, never a log nor the models' words (`stageOf` folds the turn's steps into them);
 *                 the agent's question is ONE card, the screen's focus, its options as buttons (keys 1–9) beside a
 *                 free answer, which resumes the turn (the same brief and documents: that is how the server finds
 *                 the turn it holds).
 *   Décider       the draft's screen shows the network itself, on « Après » (`onViewWanted`: the reader), and the
 *                 report is a panel beside it (`sideHost`; the header's « Compte rendu » opens and closes it): the
 *                 verdict first, the demands as a checklist (DirectReport), the changed lines — each opening its line
 *                 in the reader on a date the change shows on (`onOpenReader`);
 *                 « Appliquer en vN » commits the preview with the person's one decision (acknowledge.direct, by
 *                 name) — confirmed first, naming what is accepted, when a demand is not done or not proven or
 *                 something was changed without being asked; a new error of the canonical validator (or a broken
 *                 integrity) holds it and says why. « Demander une correction » runs the turn again on the brief with
 *                 the correction; « Abandonner » is the draft's own (the studio's confirmation).
 *   Appliqué      the end: the version, who decided, « Livrer vN » (the delivery's dialog: the GTFS and the package)
 *                 and « Nouveau changement ».
 *
 * The commit needs edit mode, and entering it touches the working copy (its data version): it is entered BEFORE the
 * turn, so the preview the turn leaves is the one the commit replays (G6), never stale by the person's own act. The
 * brief and the last result are kept with the project (context.direct): a reload within the preview's life finds the
 * decision where it was left; a brief handed over (`handedBrief`: the Network Studio's) is put in the field, never sent
 * by itself. The draft's bar is drawn here, in the app's header when it offers its slot (DraftBar: the kind and the state,
 * « ⋯ », « Quitter »; the acts are the screen's). Every request goes
 * through fetchWithSession (utils/transformApi), the documents through the studios' upload (utils/networkStudioApi).
 *
 *   direct-change          the screen (`data-moment`: drop | progress | question | decide | applied)
 *   direct-drop            the brief (direct-brief), its documents (direct-documents: direct-document each,
 *                          direct-document-remove, direct-attach), direct-prepare
 *   direct-progress        the stages (direct-stage, `data-stage`, `data-state`: done | current | todo), the current
 *                          one's line direct-progress-line (`data-kind`: the turn's last step); direct-question with
 *                          direct-question-option and direct-question-free / direct-question-send
 *   direct-decide          the report's panel: direct-report (DirectReport), direct-review (the changed lines,
 *                          direct-line each), direct-panel-close, direct-deliver,
 *                          direct-deliver-reason, direct-correct (direct-correction-text, direct-correction-send),
 *                          direct-abandon; direct-confirm (the confirmation: direct-confirm-items, direct-confirm-name,
 *                          direct-confirm-send)
 *   direct-error           a turn or an application refused, in the person's words, with direct-error-retry
 *   direct-applied         once applied: direct-applied-open (the delivery's dialog), direct-new
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Alert, Box, Button, ButtonBase, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, InputBase, TextField, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import AttachFileRoundedIcon from "@mui/icons-material/AttachFileRounded";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import PictureAsPdfOutlinedIcon from "@mui/icons-material/PictureAsPdfOutlined";
import HelpOutlineRoundedIcon from "@mui/icons-material/HelpOutlineRounded";
import ManageSearchRoundedIcon from "@mui/icons-material/ManageSearchRounded";
import EditNoteRoundedIcon from "@mui/icons-material/EditNoteRounded";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import EventOutlinedIcon from "@mui/icons-material/EventOutlined";
import TableChartOutlinedIcon from "@mui/icons-material/TableChartOutlined";
import CompareArrowsRoundedIcon from "@mui/icons-material/CompareArrowsRounded";
import RateReviewOutlinedIcon from "@mui/icons-material/RateReviewOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useAccount } from "../../contexts/AccountContext";
import { applyDraft, commitChangePlan, fetchPreviewDiff, previewDraft, streamDirectChange } from "../../utils/transformApi";
import { BRIEF_ACCEPT, deleteBriefDocument, uploadBriefDocument } from "../../utils/networkStudioApi";
import { announceDocument } from "../../utils/projectStore";
import { formatDateTime } from "../../utils/formatDate";
import { humanError } from "../../utils/humanError";
import { countWords } from "../../utils/countWords";
import { openPaywall } from "../../utils/featuresApi";
import { NAME_OK, rememberName, rememberedName } from "../common/AcknowledgementForm";
import { documentItemsOf, documentStateOf } from "../common/DocumentDrop";
import { reviewOf } from "./changeLines";
import { describeItem } from "./ChangePlanParts";
import DraftBar from "./DraftBar";
import DirectReport, { blockingOf, reportCounts, toAcceptOf } from "./DirectReport";
import { kindTextToneOf, kindToneOf, textToneOf } from "./draftKinds";
import useElapsed from "../common/useElapsed";
import { EMPTY_ACTIVITY, activityOf } from "./directActivity";

const MAX_CORRECTIONS = 2;
const STAGES = ["reading", "changing", "reviewing", "correcting", "ready"];

/**
 * The stage of the turn after one of its steps (`prev` the stage before it): the brief read until the agent first
 * works on the network, then the copy changed, the independent review once the reviewer speaks, the corrections from
 * the first correction round on (the new review of a correction belongs to it). `rounds` counts the correction
 * rounds begun, `documents` the brief's documents the turn read.
 */
export const stageOf = (prev, step) => {
  const was = prev || { stage: "reading", rounds: 0, documents: [] };
  const documents = Array.isArray(step?.documents) && step.documents.length ? step.documents : was.documents;
  if (step?.kind === "correcting") return { stage: "correcting", rounds: Math.max(was.rounds, Number(step.round) || was.rounds + 1), documents, by: "agent" };
  if (was.rounds > 0) return { ...was, documents, by: step?.by === "reviewer" ? "reviewer" : "agent" };
  if (step?.by === "reviewer" || step?.kind === "reviewing") return { stage: "reviewing", rounds: 0, documents, by: "reviewer" };
  if (step?.kind === "reading" && was.stage === "reading") return { stage: "reading", rounds: 0, documents, by: "agent" };
  return { stage: "changing", rounds: 0, documents, by: "agent" };
};

/** The documents of the brief the turn reads: the project's, still on the server and given to the assistant. */
export const documentIdsOf = (project) => (project?.documents || []).filter((d) => d?.id && !d.gone && d.sent_to_assistant !== false && /^[a-f0-9]{24}$/.test(d.id)).map((d) => d.id);

/** What the project keeps of a result: the decision as it was shown, without the facts' examples. */
const keptResult = (done) => ({
  reason: done.reason,
  previewId: done.previewId || null,
  deliverable: Boolean(done.deliverable),
  report: done.report || null,
  facts: done.facts ? { ...done.facts, tables: (done.facts.tables || []).map(({ table, added, removed, changed }) => ({ table, added, removed, changed })) } : null,
  corrections: done.corrections || null,
  at: new Date().toISOString(),
});

/** The brief as the turn reads it: the person's words, with the correction asked after a first result. */
export const briefWithCorrection = (brief, correction, label) => (correction ? `${brief}\n\n${label}\n${correction}` : brief);

// The screen's column: the moments before the decision read in one measure.
const COLUMN = { width: "100%", maxWidth: 760, mx: "auto", px: 3 };

/** The brief's documents as chips inside the field: sent, sending, refused or gone, each removable. */
function DocumentChips({ items, retentionDays, onRemove }) {
  const theme = useTheme();
  const { t, language } = useLanguage();
  if (!items.length) return null;
  return (
    <Box component="ul" data-testid="direct-documents" aria-label={t("direct.drop.documents")} sx={{ listStyle: "none", m: 0, p: 0, display: "contents" }}>
      {items.map((d) => {
        const bad = d.status === "error" || d.status === "expired";
        const isPdf = d.kind === "pdf" || /\.pdf$/i.test(d.name || "");
        const Icon = isPdf ? PictureAsPdfOutlinedIcon : DescriptionOutlinedIcon;
        const meta = d.status === "uploading" ? t("direct.drop.uploading") : d.status === "error" ? d.error || t("network.docs.unsupported") : d.record ? documentStateOf(d.status === "expired" ? { ...d.record, gone: true } : d.record, { retentionDays, t, language }).join(" · ") : "";
        const tone = bad ? theme.palette.error : theme.palette.primary;
        return (
          <Tooltip key={d.id || d.tempId || d.name} title={meta} placement="top">
            <Box component="li" data-testid="direct-document" data-status={d.status || "ready"} sx={{ display: "inline-flex", alignItems: "center", gap: 0.75, maxWidth: 320, height: 32, pl: 1, pr: 0.25, borderRadius: "8px", border: `1px solid ${bad ? alpha(theme.palette.error.main, 0.5) : theme.palette.divider}`, backgroundColor: bad ? alpha(theme.palette.error.main, 0.06) : alpha(theme.palette.text.primary, 0.03) }}>
              <Box component="span" aria-hidden sx={{ display: "inline-flex", color: textToneOf(theme, tone) }}>
                {d.status === "uploading" ? <CircularProgress size={14} color="inherit" /> : <Icon sx={{ fontSize: 17 }} />}
              </Box>
              <Typography component="span" noWrap sx={{ fontSize: "0.8rem", fontWeight: 600, minWidth: 0 }}>
                {d.name}
              </Typography>
              {bad && (
                <Typography component="span" noWrap sx={{ fontSize: "0.74rem", color: textToneOf(theme, theme.palette.error), flexShrink: 0 }}>
                  {meta}
                </Typography>
              )}
              {d.status !== "uploading" ? (
                <IconButton size="small" onClick={() => onRemove(d)} aria-label={t("direct.drop.remove", { name: d.name || "" })} data-testid="direct-document-remove" sx={{ p: 0.5, color: "text.secondary" }}>
                  <CloseRoundedIcon sx={{ fontSize: 16 }} />
                </IconButton>
              ) : (
                <Box sx={{ width: 6 }} />
              )}
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
}

/** Moment ①: one field for the brief and its documents, one act. */
export function DirectDrop({ brief, onBrief, project = null, retentionDays = 30, onPrepare, disabled = false, busy = false, onBack = null }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const inputRef = useRef(null);
  const fieldRef = useRef(null);
  const [over, setOver] = useState(false);
  const [uploads, setUploads] = useState([]); // being sent, or refused: { tempId, name, status, error? }
  const items = documentItemsOf(uploads, (project?.documents || []).filter((d) => d && d.id));
  const attach = (files) => {
    for (const file of Array.from(files || [])) {
      const tempId = `up-${Math.random().toString(36).slice(2, 10)}`;
      setUploads((u) => [...u, { tempId, name: file.name, status: "uploading" }]);
      uploadBriefDocument(file, { sentToAssistant: true })
        .then((d) => {
          setUploads((u) => u.filter((x) => x.tempId !== tempId));
          announceDocument("added", d);
        })
        .catch((err) => {
          const message = err?.code === "DOCUMENT_TOO_LARGE" ? t("network.docs.tooLarge") : t("network.docs.unsupported");
          setUploads((u) => u.map((x) => (x.tempId === tempId ? { ...x, status: "error", error: message } : x)));
        });
    }
  };
  const remove = (d) => {
    if (!d.id) {
      setUploads((u) => u.filter((x) => x.tempId !== d.tempId));
      return;
    }
    deleteBriefDocument(d.id);
    announceDocument("removed", d.record || d);
  };
  // A document still being sent would be left out of the turn: « Préparer » waits for it.
  const sending = uploads.some((u) => u.status === "uploading");
  const ready = !disabled && !busy && !sending;
  const onKeyDown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (ready) onPrepare();
    }
  };
  const primary = theme.palette.primary.main;
  return (
    <Box data-testid="direct-drop" sx={{ ...COLUMN, display: "flex", flexDirection: "column", gap: 2.5, py: 6 }}>
      <Box>
        <Typography component="h2" sx={{ fontSize: "1.6rem", fontWeight: 750, letterSpacing: "-0.02em", lineHeight: 1.2, m: 0 }}>
          {t("direct.drop.title")}
        </Typography>
        <Typography sx={{ fontSize: "0.92rem", color: "text.secondary", mt: 0.75, lineHeight: 1.5 }}>{t("direct.drop.lead")}</Typography>
      </Box>
      <Box
        ref={fieldRef}
        onDragOver={(e) => {
          if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => {
          if (!fieldRef.current?.contains(e.relatedTarget)) setOver(false);
        }}
        onDrop={(e) => {
          setOver(false);
          // Text dropped into the field is the field's; only files are documents.
          if (!e.dataTransfer?.files?.length) return;
          e.preventDefault();
          attach(e.dataTransfer?.files);
        }}
        data-over={over ? "true" : "false"}
        sx={{
          position: "relative",
          borderRadius: "16px",
          border: `1px solid ${over ? primary : theme.palette.divider}`,
          backgroundColor: theme.palette.background.paper,
          boxShadow: over ? `0 0 0 4px ${alpha(primary, 0.18)}` : `0 1px 2px ${alpha(theme.palette.common.black, theme.palette.mode === "dark" ? 0.4 : 0.05)}`,
          transition: "border-color .15s, box-shadow .15s",
          "&:focus-within": { borderColor: primary, boxShadow: `0 0 0 4px ${alpha(primary, 0.15)}` },
          "@media (prefers-reduced-motion: reduce)": { transition: "none" },
        }}
      >
        <InputBase
          multiline
          minRows={8}
          maxRows={18}
          fullWidth
          value={brief}
          onChange={(e) => onBrief(e.target.value.slice(0, 60000))}
          onKeyDown={onKeyDown}
          placeholder={t("direct.drop.placeholder")}
          inputProps={{ "aria-label": t("direct.drop.label"), "aria-keyshortcuts": "Control+Enter", "data-testid": "direct-brief" }}
          sx={{ px: 2.25, pt: 2, pb: 1, fontSize: "0.95rem", lineHeight: 1.65 }}
        />
        <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1, px: 1.5, pb: 1.5, pt: 0.5 }}>
          <DocumentChips items={items} retentionDays={retentionDays} onRemove={remove} />
          <Tooltip title={t("direct.drop.attachHint")}>
            <Button size="small" startIcon={<AttachFileRoundedIcon sx={{ transform: "rotate(45deg)" }} />} onClick={() => inputRef.current?.click()} data-testid="direct-attach" sx={{ textTransform: "none", fontWeight: 650, borderRadius: "8px", color: "text.secondary", height: 32, px: 1.25 }}>
              {t("direct.drop.attach")}
            </Button>
          </Tooltip>
          <input ref={inputRef} type="file" hidden multiple accept={BRIEF_ACCEPT} onChange={(e) => {
            attach(e.target.files);
            e.target.value = "";
          }} />
        </Box>
        {over && (
          <Box aria-hidden sx={{ position: "absolute", inset: 0, borderRadius: "16px", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: alpha(theme.palette.background.paper, 0.9), pointerEvents: "none" }}>
            <Typography sx={{ fontSize: "1rem", fontWeight: 700, color: textToneOf(theme, theme.palette.primary) }}>{t("direct.drop.dropHere")}</Typography>
          </Box>
        )}
      </Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
        <Button variant="contained" disableElevation size="large" startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <AutoAwesomeRoundedIcon />} disabled={!ready} onClick={onPrepare} aria-keyshortcuts="Control+Enter" data-testid="direct-prepare" sx={{ textTransform: "none", fontWeight: 750, borderRadius: "12px", px: 3, height: 48 }}>
          {t("direct.drop.prepare")}
        </Button>
        <Typography aria-hidden sx={{ fontSize: "0.76rem", color: "text.secondary" }}>
          {sending ? t("direct.drop.waitUploads") : disabled ? t("direct.drop.needBrief") : t("direct.drop.shortcut")}
        </Typography>
        {onBack && (
          <>
            <Box sx={{ flex: 1 }} />
            <Button onClick={onBack} data-testid="direct-back-result" sx={{ textTransform: "none", fontWeight: 650, color: "text.secondary" }}>
              {t("direct.drop.backToResult")}
            </Button>
          </>
        )}
      </Box>
    </Box>
  );
}

/** A stage's mark: done, current (alive, still for a person who asked for less motion) or to come. */
// The motion of the progress screen, each cut when the system asks for less motion.
const STILL = { "@media (prefers-reduced-motion: reduce)": { animation: "none" } };
const MOTION = {
  "@keyframes directBreathe": { "0%": { transform: "scale(0.75)", opacity: 0.9 }, "70%": { transform: "scale(1.55)", opacity: 0 }, "100%": { transform: "scale(1.55)", opacity: 0 } },
  "@keyframes directPop": { "0%": { transform: "scale(0.4)", opacity: 0 }, "60%": { transform: "scale(1.12)", opacity: 1 }, "100%": { transform: "scale(1)", opacity: 1 } },
  "@keyframes directIn": { "0%": { transform: "translateY(10px)", opacity: 0 }, "100%": { transform: "translateY(0)", opacity: 1 } },
  "@keyframes directFlow": { "0%": { backgroundPosition: "0 -100%" }, "100%": { backgroundPosition: "0 200%" } },
  "@keyframes directSweep": { "0%": { transform: "translateX(-100%)" }, "100%": { transform: "translateX(250%)" } },
  "@keyframes directBump": { "0%": { transform: "translateY(4px)", opacity: 0.4 }, "100%": { transform: "translateY(0)", opacity: 1 } },
};

function StageMark({ state }) {
  const theme = useTheme();
  const ai = theme.palette.ai || theme.palette.primary;
  if (state === "done")
    return (
      <Box aria-hidden sx={{ ...MOTION, width: 26, height: 26, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: theme.palette.success.contrastText, backgroundColor: theme.palette.success.main, animation: "directPop 420ms cubic-bezier(.2,.9,.3,1.3) both", ...STILL }}>
        <CheckRoundedIcon sx={{ fontSize: 17 }} />
      </Box>
    );
  if (state === "current")
    return (
      <Box aria-hidden sx={{ ...MOTION, position: "relative", width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Box sx={{ position: "absolute", inset: 0, borderRadius: "50%", backgroundColor: alpha(ai.main, 0.28), animation: "directBreathe 1.8s cubic-bezier(.4,0,.2,1) infinite", ...STILL }} />
        <Box sx={{ position: "absolute", inset: 3, borderRadius: "50%", border: `2px solid ${alpha(ai.main, 0.35)}` }} />
        <Box sx={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: ai.main, boxShadow: `0 0 0 4px ${alpha(ai.main, 0.14)}` }} />
      </Box>
    );
  return <Box aria-hidden sx={{ width: 26, height: 26, borderRadius: "50%", border: `2px solid ${theme.palette.divider}`, transition: "border-color 300ms" }} />;
}

const ACT_ICONS = { brief: DescriptionOutlinedIcon, sheet: TableChartOutlinedIcon, dates: EventOutlinedIcon, query: ManageSearchRoundedIcon, compare: CompareArrowsRoundedIcon, write: EditNoteRoundedIcon, check: FactCheckOutlinedIcon, review: RateReviewOutlinedIcon };
// The acts shown under the current stage: the latest in full, the older ones fading.
const ACTS_SHOWN = 3;

/** The latest acts of the turn, each sliding in as it comes, the same act repeated counted on its line. */
function ActivityFeed({ items }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const ai = theme.palette.ai || theme.palette.primary;
  const shown = items.slice(-ACTS_SHOWN).reverse();
  if (!shown.length) return null;
  return (
    <Box component="ul" data-testid="direct-activity" aria-label={t("direct.activity.label")} sx={{ ...MOTION, listStyle: "none", m: 0, mt: 1.25, p: 0, display: "flex", flexDirection: "column", gap: 0.75 }}>
      {shown.map((it, i) => {
        const Icon = ACT_ICONS[it.icon] || ManageSearchRoundedIcon;
        const text = it.plural ? countWords(t, it.key, it.params?.count || 1, it.params || {}) : t(it.key, it.params || {});
        return (
          <Box
            component="li"
            key={it.id}
            data-testid="direct-act"
            data-key={it.key}
            sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0, opacity: i === 0 ? 1 : i === 1 ? 0.62 : 0.36, transition: "opacity 400ms ease", animation: i === 0 ? "directIn 360ms cubic-bezier(.2,.8,.2,1) both" : "none", ...STILL }}
          >
            <Box aria-hidden sx={{ width: 24, height: 24, borderRadius: "7px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: textToneOf(theme, ai), backgroundColor: alpha(ai.main, i === 0 ? 0.14 : 0.07) }}>
              <Icon sx={{ fontSize: 15 }} />
            </Box>
            <Typography component="span" noWrap sx={{ fontSize: "0.86rem", fontWeight: i === 0 ? 600 : 500, color: i === 0 ? "text.primary" : "text.secondary", minWidth: 0 }}>
              {text}
            </Typography>
            {it.times > 1 && (
              <Box component="span" key={it.times} data-testid="direct-act-times" sx={{ ...MOTION, flexShrink: 0, fontSize: "0.72rem", fontWeight: 700, color: "text.secondary", fontVariantNumeric: "tabular-nums", animation: "directBump 260ms ease-out both", ...STILL }}>
                {t("direct.activity.times", { count: it.times })}
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/** The turn's counts and its time, under the stages: each figure eases in as it changes. */
function ActivityCounts({ counts, seconds }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const time = seconds >= 60 ? t("direct.activity.elapsed.m", { m: Math.floor(seconds / 60), s: String(seconds % 60).padStart(2, "0") }) : t("direct.activity.elapsed.s", { s: seconds });
  const figure = (key, n) => (
    <Box component="span" data-testid={`direct-count-${key}`} sx={{ display: "inline-flex", alignItems: "baseline", gap: 0.5 }}>
      <Box component="span" key={n} sx={{ ...MOTION, fontWeight: 700, color: "text.primary", fontVariantNumeric: "tabular-nums", display: "inline-block", animation: n ? "directBump 260ms ease-out both" : "none", ...STILL }}>
        {n}
      </Box>
      {t(`direct.activity.counts.${key}.${n === 1 ? "one" : "many"}`)}
    </Box>
  );
  return (
    <Box data-testid="direct-counts" sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2.5, pt: 2, borderTop: `1px solid ${theme.palette.divider}`, fontSize: "0.8rem", color: "text.secondary" }}>
      {figure("reads", counts.reads)}
      {figure("writes", counts.writes)}
      {figure("checks", counts.checks)}
      <Box sx={{ flex: 1 }} />
      <Box component="span" data-testid="direct-elapsed" sx={{ fontVariantNumeric: "tabular-nums" }}>
        {time}
      </Box>
    </Box>
  );
}

/** The agent's question: the screen's one card, its options as buttons (keys 1–9), a free answer beside. */
export function DirectQuestion({ question, onAnswer, answering = false, onBack = null }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const [free, setFree] = useState("");
  const firstRef = useRef(null);
  const options = Array.isArray(question?.options) ? question.options.filter((o) => typeof o === "string" && o.trim()) : [];
  useEffect(() => {
    setFree("");
    firstRef.current?.focus();
  }, [question]);
  const send = (text) => {
    const value = String(text || "").trim();
    if (value && !answering) onAnswer?.(value);
  };
  // 1–9 pick an option, wherever the focus is but the free answer.
  const onKeyDown = (e) => {
    if (e.target?.tagName === "TEXTAREA" || e.target?.tagName === "INPUT" || e.ctrlKey || e.metaKey || e.altKey) return;
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      e.preventDefault();
      send(options[n - 1]);
    }
  };
  const ai = theme.palette.ai || theme.palette.primary;
  return (
    <Box component="section" aria-labelledby="direct-question-text" data-testid="direct-question" onKeyDown={onKeyDown} sx={{ display: "flex", flexDirection: "column", gap: 2, p: 3, borderRadius: "18px", border: `1px solid ${alpha(ai.main, 0.35)}`, backgroundColor: theme.palette.background.paper, boxShadow: `0 12px 32px ${alpha(theme.palette.common.black, theme.palette.mode === "dark" ? 0.35 : 0.07)}` }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, color: textToneOf(theme, ai) }}>
        <HelpOutlineRoundedIcon aria-hidden sx={{ fontSize: 20 }} />
        <Typography sx={{ fontSize: "0.84rem", fontWeight: 700 }}>{t("direct.question.title")}</Typography>
      </Box>
      <Box>
        <Typography id="direct-question-text" component="h2" sx={{ fontSize: "1.2rem", fontWeight: 700, lineHeight: 1.45, letterSpacing: "-0.01em", m: 0, whiteSpace: "pre-line" }}>
          {question.question}
        </Typography>
        {question.why && <Typography sx={{ fontSize: "0.88rem", color: "text.secondary", lineHeight: 1.55, mt: 0.75 }}>{question.why}</Typography>}
      </Box>
      {options.length > 0 && (
        <Box role="group" aria-label={t("direct.question.options")} sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {options.map((o, i) => (
            <ButtonBase
              key={o}
              ref={i === 0 ? firstRef : null}
              disabled={answering}
              onClick={() => send(o)}
              aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
              data-testid="direct-question-option"
              sx={{ justifyContent: "flex-start", gap: 1.5, textAlign: "left", borderRadius: "12px", px: 1.75, py: 1.5, border: `1px solid ${theme.palette.divider}`, fontSize: "0.95rem", fontWeight: 600, lineHeight: 1.4, transition: "border-color .12s, background-color .12s", "&:hover": { borderColor: ai.main, backgroundColor: alpha(ai.main, 0.06) }, "&.Mui-focusVisible": { borderColor: ai.main, boxShadow: `0 0 0 3px ${alpha(ai.main, 0.25)}` }, "@media (prefers-reduced-motion: reduce)": { transition: "none" } }}
            >
              {i < 9 && (
                <Box component="span" aria-hidden sx={{ flexShrink: 0, width: 24, height: 24, borderRadius: "7px", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "0.76rem", fontWeight: 750, color: textToneOf(theme, ai), backgroundColor: alpha(ai.main, 0.12) }}>
                  {i + 1}
                </Box>
              )}
              <Box component="span" sx={{ minWidth: 0 }}>{o}</Box>
            </ButtonBase>
          ))}
        </Box>
      )}
      <Box component="form" onSubmit={(e) => { e.preventDefault(); send(free); }} sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}>
        <TextField
          size="small"
          fullWidth
          multiline
          maxRows={5}
          value={free}
          onChange={(e) => setFree(e.target.value.slice(0, 2000))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(free);
            }
          }}
          placeholder={t(options.length ? "direct.question.free" : "direct.question.freeOnly")}
          disabled={answering}
          inputRef={options.length ? null : firstRef}
          inputProps={{ "aria-label": t(options.length ? "direct.question.free" : "direct.question.freeOnly"), "data-testid": "direct-question-free" }}
          sx={{ "& .MuiOutlinedInput-root": { borderRadius: "12px" } }}
        />
        <Button type="submit" variant="contained" disableElevation disabled={answering || !free.trim()} data-testid="direct-question-send" sx={{ textTransform: "none", fontWeight: 700, borderRadius: "12px", flexShrink: 0, height: 40 }}>
          {t("direct.question.send")}
        </Button>
      </Box>
      {onBack && (
        <Button onClick={onBack} disabled={answering} data-testid="direct-question-back" sx={{ alignSelf: "flex-start", textTransform: "none", fontWeight: 650, color: "text.secondary", px: 0.5 }}>
          {t("direct.question.back")}
        </Button>
      )}
    </Box>
  );
}

/** Moment ②: the turn's stages, or the agent's one question. */
export function DirectProgress({ brief = "", progress = null, step = null, question = null, onAnswer, answering = false, activity = EMPTY_ACTIVITY, seconds = 0, onBackToBrief = null }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const at = progress || { stage: "reading", rounds: 0, documents: [] };
  const shown = STAGES.filter((s) => s !== "correcting" || at.rounds > 0);
  const index = shown.indexOf(at.stage);
  const nowText = (stage) => {
    if (stage === "reading") return at.documents?.length ? at.documents.join(" · ") : null;
    if (stage === "correcting") return t(at.by === "reviewer" ? "direct.stage.correcting.review" : "direct.stage.correcting.now");
    return stage === "ready" ? null : t(`direct.stage.${stage}.now`);
  };
  const ai = theme.palette.ai || theme.palette.primary;
  return (
    <Box data-testid="direct-progress" sx={{ ...COLUMN, display: "flex", flexDirection: "column", gap: 3, py: 6 }}>
      {question ? (
        <DirectQuestion question={question} onAnswer={onAnswer} answering={answering} onBack={onBackToBrief} />
      ) : (
        <>
          <Box>
            <Typography component="h2" sx={{ fontSize: "1.35rem", fontWeight: 750, letterSpacing: "-0.015em", m: 0 }}>
              {t("direct.progress.title")}
            </Typography>
            {/* The work goes on: a light sweeps the rule under the title. */}
            <Box aria-hidden sx={{ ...MOTION, position: "relative", height: 3, mt: 1.25, borderRadius: 2, overflow: "hidden", backgroundColor: alpha(ai.main, 0.12) }}>
              <Box sx={{ position: "absolute", top: 0, bottom: 0, width: "40%", borderRadius: 2, background: `linear-gradient(90deg, ${alpha(ai.main, 0)}, ${ai.main}, ${alpha(ai.main, 0)})`, animation: "directSweep 1.9s cubic-bezier(.4,0,.2,1) infinite", ...STILL }} />
            </Box>
            {brief && (
              <Typography data-testid="direct-progress-brief" title={brief} sx={{ fontSize: "0.86rem", color: "text.secondary", lineHeight: 1.55, mt: 0.75, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                {brief.replace(/\s*\n+\s*/g, " · ")}
              </Typography>
            )}
          </Box>
          {/* One live region, the stage said as it changes (the list's marks are not announced). */}
          <Box role="status" className="visually-hidden">
            {at.stage === "correcting" ? t("direct.stage.correcting.round", { n: Math.min(at.rounds, MAX_CORRECTIONS), max: MAX_CORRECTIONS }) : t(`direct.stage.${at.stage}`)}
          </Box>
          <Box component="ol" aria-label={t("direct.progress.stages")} sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column" }}>
            {shown.map((stage, i) => {
              const state = i < index ? "done" : i === index ? "current" : "todo";
              const last = i === shown.length - 1;
              const now = state === "current" ? nowText(stage) : null;
              const label = stage === "correcting" ? t("direct.stage.correcting.round", { n: Math.min(at.rounds, MAX_CORRECTIONS), max: MAX_CORRECTIONS }) : t(`direct.stage.${stage}`);
              return (
                <Box component="li" key={stage} data-testid="direct-stage" data-stage={stage} data-state={state} aria-current={state === "current" ? "step" : undefined} sx={{ display: "flex", gap: 2 }}>
                  <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                    <StageMark state={state} />
                    {!last && (
                      <Box
                        aria-hidden
                        sx={{
                          ...MOTION,
                          width: 2,
                          flex: 1,
                          minHeight: 18,
                          my: 0.5,
                          borderRadius: 1,
                          transition: "background-color 400ms",
                          backgroundColor: state === "done" ? alpha(theme.palette.success.main, 0.5) : theme.palette.divider,
                          // From the current stage, the line flows towards the next one.
                          ...(state === "current" ? { backgroundImage: `linear-gradient(180deg, ${alpha(ai.main, 0)}, ${ai.main}, ${alpha(ai.main, 0)})`, backgroundSize: "100% 50%", backgroundRepeat: "no-repeat", animation: "directFlow 1.4s linear infinite", ...STILL } : {}),
                        }}
                      />
                    )}
                  </Box>
                  <Box sx={{ pb: last ? 0 : 2.25, pt: 0.25, minWidth: 0 }}>
                    {state === "current" ? (
                      <Typography data-testid="direct-progress-line" data-kind={step?.kind || "reading"} sx={{ fontSize: "1rem", fontWeight: 700, color: textToneOf(theme, ai) }}>
                        {label}
                      </Typography>
                    ) : (
                      <Typography sx={{ fontSize: "0.95rem", fontWeight: state === "done" ? 600 : 500, color: state === "done" ? "text.primary" : "text.secondary" }}>{label}</Typography>
                    )}
                    {now && <Typography sx={{ fontSize: "0.82rem", color: "text.secondary", mt: 0.25, lineHeight: 1.5 }}>{now}</Typography>}
                    {state === "current" && <ActivityFeed items={activity.items} />}
                  </Box>
                </Box>
              );
            })}
          </Box>
          <ActivityCounts counts={activity.counts} seconds={seconds} />
        </>
      )}
    </Box>
  );
}

/** The end: the version applied, who decided, the delivery's door and a new change. */
export function DirectApplied({ frozen, onOpenApplied = null, onNewDraft = null, compact = false }) {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const openRef = useRef(null);
  useEffect(() => {
    openRef.current?.focus();
  }, []);
  return (
    <Box data-testid="direct-applied" sx={compact ? { display: "flex", justifyContent: "center", pt: 1 } : { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", p: 4 }}>
      <Box sx={{ maxWidth: 440, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 1.5 }}>
        <Box aria-hidden sx={{ width: 64, height: 64, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: alpha(theme.palette.success.main, 0.14), color: theme.palette.success.main, mb: 1 }}>
          <CheckCircleRoundedIcon sx={{ fontSize: 40 }} />
        </Box>
        <Typography component="h2" sx={{ fontSize: "1.5rem", fontWeight: 750, letterSpacing: "-0.015em", m: 0 }}>
          {t("direct.applied.title", { n: frozen.n })}
        </Typography>
        <Typography sx={{ fontSize: "0.92rem", color: "text.secondary", lineHeight: 1.55 }}>
          {t("direct.applied.lead", { n: frozen.n })}
          {frozen.by ? ` ${t("direct.applied.by", { name: frozen.by, date: frozen.at ? formatDateTime(frozen.at, language) : "" })}` : ""}
        </Typography>
        <Box sx={{ display: "flex", gap: 1, mt: 2, flexWrap: "wrap", justifyContent: "center" }}>
          <Button ref={openRef} variant="contained" disableElevation size="large" onClick={onOpenApplied} data-testid="direct-applied-open" sx={{ textTransform: "none", fontWeight: 750, borderRadius: "12px", px: 3 }}>
            {t("direct.applied.open", { n: frozen.n })}
          </Button>
          <Button size="large" onClick={onNewDraft} data-testid="direct-new" sx={{ textTransform: "none", fontWeight: 650, borderRadius: "12px", px: 2 }}>
            {t("direct.applied.new")}
          </Button>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * The report, a panel beside the reader (the draft's screen shows the network on « Après »; the header's « Compte
 * rendu » opens and closes it): the verdict and the demands (DirectReport), the changed lines — each opening its line
 * in the reader, on a date the change shows on —, then the acts: « Appliquer en vN », « Demander une correction »,
 * « Modifier le cahier des charges », « Abandonner ». Applied, the version and its ways on.
 */
export function DirectDecision({ result, diff = null, diffError = null, nextN = 1, onOpenLine = null, onLocate = null, onDeliver, delivering = false, correcting = false, onCorrect, onRevise = null, onPrepareAgain = null, onAbandon, frozen = null, onOpenApplied = null, onNewDraft = null, onClose = null, notice = null }) {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correction, setCorrection] = useState("");
  const blocking = blockingOf(result?.facts);
  const noChange = !result?.previewId;
  const reason = noChange ? t("direct.decide.noChange") : blocking.validator ? countWords(t, "direct.decide.validatorBlocks", blocking.validator) : blocking.integrity ? t("direct.decide.integrityBlocks") : !result?.deliverable ? t("direct.decide.blocked") : null;
  const sendCorrection = () => {
    const text = correction.trim();
    if (!text) return;
    onCorrect?.(text);
    setCorrection("");
    setCorrectionOpen(false);
  };
  const { lines, network } = reviewOf(diff ? { diff: diff.diff } : null);
  const briefTone = kindToneOf(theme, "brief");
  const lineButton = (line) => (
    <ButtonBase
      key={`${line.route || line.label}`}
      onClick={onOpenLine && line.route ? () => onOpenLine({ route: line.route, date: line.date || null }) : undefined}
      disabled={!onOpenLine || !line.route}
      data-testid="direct-line"
      data-route={line.route || ""}
      sx={{ width: "100%", justifyContent: "flex-start", alignItems: "flex-start", gap: 1.25, textAlign: "left", px: 1.25, py: 1, borderRadius: "10px", border: `1px solid ${theme.palette.divider}`, transition: "border-color .12s, background-color .12s", "&:hover": { borderColor: alpha(briefTone, 0.6), backgroundColor: alpha(briefTone, 0.05) }, "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 1 } }}
    >
      <Box component="span" sx={{ flexShrink: 0, minWidth: 34, px: 0.75, py: 0.25, borderRadius: "6px", fontSize: "0.78rem", fontWeight: 800, textAlign: "center", color: theme.palette.getContrastText(theme.palette.primary.main), backgroundColor: theme.palette.primary.main }}>
        {line.label}
      </Box>
      <Box component="span" sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 0.25 }}>
        {line.items.slice(0, 2).map((it, i) => (
          <Typography key={i} component="span" sx={{ fontSize: "0.8rem", lineHeight: 1.45, color: "text.primary" }}>
            {describeItem(t, it, language)}
          </Typography>
        ))}
        {line.items.length > 2 && <Typography component="span" sx={{ fontSize: "0.74rem", color: "text.secondary" }}>{countWords(t, "direct.lines.more", line.items.length - 2)}</Typography>}
      </Box>
      {onOpenLine && line.route && <ChevronRightRoundedIcon aria-hidden sx={{ fontSize: 18, color: "text.secondary", alignSelf: "center" }} />}
    </ButtonBase>
  );
  return (
    <Box component="aside" aria-labelledby="direct-panel-title" data-testid="direct-decide" sx={{ width: 440, maxWidth: "100%", height: "100%", minHeight: 0, flexShrink: 0, display: "flex", flexDirection: "column", borderLeft: `1px solid ${theme.palette.divider}`, backgroundColor: theme.palette.background.paper }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, px: 2.5, pt: 2, pb: 1.5, borderBottom: `1px solid ${theme.palette.divider}` }}>
        <Box aria-hidden sx={{ width: 34, height: 34, flexShrink: 0, borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center", color: kindTextToneOf(theme, "brief"), backgroundColor: alpha(briefTone, theme.palette.mode === "dark" ? 0.2 : 0.12) }}>
          <DescriptionOutlinedIcon sx={{ fontSize: 19 }} />
        </Box>
        <Typography id="direct-panel-title" component="h2" sx={{ flex: 1, fontSize: "1rem", fontWeight: 750, m: 0 }}>
          {t("draft.view.report")}
        </Typography>
        {onClose && (
          <Tooltip title={t("app.close")}>
            <IconButton size="small" onClick={onClose} aria-label={t("app.close")} data-testid="direct-panel-close" sx={{ width: 34, height: 34, borderRadius: "10px", color: "text.secondary" }}>
              <CloseRoundedIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 2.5, py: 2, display: "flex", flexDirection: "column", gap: 2.5 }}>
        {notice}
        {frozen && <DirectApplied compact frozen={frozen} onOpenApplied={onOpenApplied} onNewDraft={onNewDraft} />}
        {diffError && !frozen && (
          <Alert
            severity="info"
            data-testid="direct-review-gone"
            action={
              onPrepareAgain ? (
                <Button color="inherit" size="small" onClick={onPrepareAgain} data-testid="direct-prepare-again" sx={{ textTransform: "none", fontWeight: 700 }}>
                  {t("direct.review.prepareAgain")}
                </Button>
              ) : null
            }
          >
            {diffError}
          </Alert>
        )}
        <DirectReport report={result?.report} facts={result?.facts} diffItems={diff?.diff?.items || null} onLocate={frozen ? null : onLocate} applied={Boolean(frozen)} />
        {(lines.length > 0 || network.length > 0) && (
          <Box component="section" aria-labelledby="direct-lines-title" data-testid="direct-review" sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
            <Typography id="direct-lines-title" component="h3" sx={{ fontSize: "0.8rem", fontWeight: 700, color: "text.secondary", m: 0 }}>
              {t("direct.lines.title")}
            </Typography>
            {lines.map(lineButton)}
            {network.length > 0 && (
              <Box data-testid="direct-network-changes" sx={{ px: 1.25, py: 1, borderRadius: "10px", border: `1px dashed ${theme.palette.divider}`, display: "flex", flexDirection: "column", gap: 0.25 }}>
                <Typography sx={{ fontSize: "0.78rem", fontWeight: 700 }}>{t("direct.lines.network")}</Typography>
                {network.slice(0, 4).map((it, i) => (
                  <Typography key={i} sx={{ fontSize: "0.78rem", color: "text.secondary", lineHeight: 1.45 }}>
                    {describeItem(t, it, language)}
                  </Typography>
                ))}
                {network.length > 4 && <Typography sx={{ fontSize: "0.74rem", color: "text.secondary" }}>{countWords(t, "direct.lines.more", network.length - 4)}</Typography>}
              </Box>
            )}
          </Box>
        )}
      </Box>
      {!frozen && (
        <Box component="footer" sx={{ flexShrink: 0, borderTop: `1px solid ${theme.palette.divider}`, px: 2.5, py: 1.75, display: "flex", flexDirection: "column", gap: 1.25 }}>
          {correctionOpen && (
            <Box component="form" aria-labelledby="direct-correct-title" onSubmit={(e) => { e.preventDefault(); sendCorrection(); }} sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <Typography id="direct-correct-title" component="h3" sx={{ fontSize: "0.9rem", fontWeight: 700, m: 0 }}>
                {t("direct.correct.title")}
              </Typography>
              <TextField
                size="small"
                fullWidth
                multiline
                minRows={3}
                maxRows={8}
                autoFocus
                value={correction}
                onChange={(e) => setCorrection(e.target.value.slice(0, 4000))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    sendCorrection();
                  } else if (e.key === "Escape") setCorrectionOpen(false);
                }}
                placeholder={t("direct.correct.placeholder")}
                inputProps={{ "aria-label": t("direct.correct.label"), "aria-keyshortcuts": "Control+Enter", "data-testid": "direct-correction-text" }}
                sx={{ "& .MuiOutlinedInput-root": { borderRadius: "12px" } }}
              />
              <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1 }}>
                <Button onClick={() => setCorrectionOpen(false)} sx={{ textTransform: "none", color: "text.secondary" }}>
                  {t("app.cancel")}
                </Button>
                <Button type="submit" variant="contained" disableElevation disabled={!correction.trim() || correcting} data-testid="direct-correction-send" sx={{ textTransform: "none", fontWeight: 700, borderRadius: "10px" }}>
                  {t("direct.correct.send")}
                </Button>
              </Box>
            </Box>
          )}
          {reason && (
            <Typography data-testid="direct-deliver-reason" sx={{ fontSize: "0.82rem", color: blocking.validator || blocking.integrity ? textToneOf(theme, theme.palette.error) : "text.secondary", fontWeight: 650 }}>
              {reason}
            </Typography>
          )}
          {!correctionOpen && (
            <Box sx={{ display: "flex", gap: 1 }}>
              <Button variant="outlined" onClick={() => setCorrectionOpen(true)} disabled={delivering} data-testid="direct-correct" sx={{ height: 42, textTransform: "none", fontWeight: 650, borderRadius: "11px", whiteSpace: "nowrap" }}>
                {t("direct.decide.correct")}
              </Button>
              <Button variant="contained" disableElevation onClick={onDeliver} disabled={Boolean(reason) || delivering} data-testid="direct-deliver" startIcon={delivering ? <CircularProgress size={16} color="inherit" /> : null} sx={{ flex: 1, height: 42, textTransform: "none", fontWeight: 750, borderRadius: "11px" }}>
                {t("direct.decide.deliver", { n: nextN })}
              </Button>
            </Box>
          )}
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            {onRevise && (
              <Button size="small" onClick={onRevise} disabled={delivering} data-testid="direct-revise" sx={{ textTransform: "none", fontWeight: 600, color: "text.secondary" }}>
                {t("direct.decide.revise")}
              </Button>
            )}
            <Box sx={{ flex: 1 }} />
            <Button size="small" onClick={onAbandon} data-testid="direct-abandon" sx={{ textTransform: "none", fontWeight: 600, color: "text.secondary" }}>
              {t("direct.decide.abandon")}
            </Button>
          </Box>
        </Box>
      )}
    </Box>
  );
}

/** The application's one confirmation: what the person accepts by applying, named, and the name it is recorded under. */
export function DirectConfirm({ open, report, nextN = 1, name, onName, onClose, onConfirm, busy = false }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const c = reportCounts(report);
  const demands = Array.isArray(report?.demands) ? report.demands : [];
  const tag = (label, palette) => (
    <Box component="span" sx={{ flexShrink: 0, px: 0.75, py: 0.1, borderRadius: "6px", fontSize: "0.72rem", fontWeight: 750, color: textToneOf(theme, palette), backgroundColor: alpha(palette.main, theme.palette.mode === "dark" ? 0.2 : 0.1) }}>
      {label}
    </Box>
  );
  const items = [
    ...demands.filter((d) => d?.status === "not_done").map((d) => ({ key: `n-${d.quote}`, tag: tag(t("direct.report.status.not_done"), theme.palette.error), text: d.quote })),
    ...demands.filter((d) => d?.status !== "done" && d?.status !== "not_done").map((d) => ({ key: `u-${d.quote}`, tag: tag(t("direct.report.status.unproven"), theme.palette.warning), text: d.quote })),
    ...(Array.isArray(report?.not_asked) ? report.not_asked : []).map((x) => ({ key: `a-${x.what}`, tag: tag(t("direct.confirm.notAsked"), theme.palette.warning), text: x.what })),
    ...(c.incomplete ? [{ key: "incomplete", tag: tag(t("direct.report.status.unproven"), theme.palette.warning), text: t("direct.confirm.incomplete") }] : []),
  ];
  const ok = NAME_OK(name || "");
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth data-testid="direct-confirm" aria-labelledby="direct-confirm-title" PaperProps={{ sx: { borderRadius: "18px" } }}>
      <DialogTitle id="direct-confirm-title" sx={{ fontSize: "1.15rem", fontWeight: 750, pb: 1 }}>{t("direct.confirm.title", { n: nextN })}</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {items.length > 0 && (
          <Box>
            <Typography sx={{ fontSize: "0.9rem", lineHeight: 1.5, mb: 1 }}>{t("direct.confirm.lead")}</Typography>
            <Box component="ul" data-testid="direct-confirm-items" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.75 }}>
              {items.map((x) => (
                <Box component="li" key={x.key} sx={{ display: "flex", alignItems: "baseline", gap: 1, fontSize: "0.88rem", lineHeight: 1.45 }}>
                  {x.tag}
                  <Box component="span" sx={{ minWidth: 0 }}>{x.text}</Box>
                </Box>
              ))}
            </Box>
          </Box>
        )}
        <TextField
          size="small"
          label={t("direct.confirm.name")}
          value={name || ""}
          autoFocus={!ok}
          onChange={(e) => onName(e.target.value.slice(0, 120))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ok && !busy) {
              e.preventDefault();
              onConfirm();
            }
          }}
          inputProps={{ "data-testid": "direct-confirm-name", maxLength: 120, autoComplete: "name" }}
          helperText={t("direct.confirm.nameHint")}
          sx={{ mt: 0.5, "& .MuiOutlinedInput-root": { borderRadius: "10px" } }}
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} disabled={busy} sx={{ textTransform: "none", fontWeight: 600 }}>
          {t("app.cancel")}
        </Button>
        <Button variant="contained" disableElevation autoFocus={ok} disabled={!ok || busy} onClick={onConfirm} data-testid="direct-confirm-send" startIcon={busy ? <CircularProgress size={16} color="inherit" /> : null} sx={{ textTransform: "none", fontWeight: 750, borderRadius: "12px", px: 2.5 }}>
          {t(items.length ? "direct.confirm.acceptDeliver" : "direct.confirm.deliver", { n: nextN })}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function DirectChange({ project = null, onUpdateProject = null, editing = false, enterEditMode = null, draftSession = null, frozen = null, nextN = 1, routes = [], retentionDays = 30, handedBrief = null, onOpenReader = null, onPreview = null, onCommitted = null, onAbandon = null, onOpenApplied = null, onNewDraft = null, bar = null, sideHost = null, onViewWanted = null }) {
  const { t, language } = useLanguage();
  const { me } = useAccount();
  const kept = project?.context?.direct || null;
  const [brief, setBrief] = useState(() => kept?.brief || "");
  const [result, setResult] = useState(() => kept?.result || null);
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState(null);
  const [progress, setProgress] = useState(null);
  const [activity, setActivity] = useState(EMPTY_ACTIVITY);
  const [question, setQuestion] = useState(() => kept?.question || null);
  const [sent, setSent] = useState(() => kept?.sent || null); // the turn's brief and documents, as the server keys it
  // { message, retry: "turn" | "deliver" | "lost" | null, offer }: a turn the page left while it ran is said on return.
  const [error, setError] = useState(() => (kept?.running ? { message: t("direct.lost"), retry: "lost" } : null));
  // The brief opened again after a result (« Modifier le cahier des charges »): the result stays until a new turn ends.
  const [revising, setRevising] = useState(false);
  const [diff, setDiff] = useState(null);
  const [diffError, setDiffError] = useState(null);
  // The report's panel beside the reader: open when a result arrives, closed and opened again from the header.
  const [reportOpen, setReportOpen] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [name, setName] = useState("");
  const [delivering, setDelivering] = useState(false);
  const abortRef = useRef(null);
  const lastRun = useRef(null);
  const seconds = useElapsed(running);
  const documentIds = documentIdsOf(project);

  // What the project keeps of the direct draft: the brief, the turn's words and its last result.
  const keep = useCallback((change) => onUpdateProject?.((p) => ({ ...p, context: { ...(p.context || {}), direct: { ...(p.context?.direct || {}), ...change } } })), [onUpdateProject]);
  // The brief typed, kept a moment after the last key (one write per pause, never per character).
  useEffect(() => {
    if ((kept?.brief || "") === brief) return undefined;
    const timer = setTimeout(() => keep({ brief }), 600);
    return () => clearTimeout(timer);
    // `kept` is read when the timer fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brief]);

  // A brief handed over takes the field (the person reads it, then prepares the change).
  useEffect(() => {
    if (typeof handedBrief === "string" && handedBrief.trim()) setBrief(handedBrief.slice(0, 60000));
  }, [handedBrief]);

  // The changed lines of the result, as the reader reads them: the stored preview's diff and geometry.
  const previewId = frozen ? null : result?.previewId || null;
  useEffect(() => {
    setDiff(null);
    setDiffError(null);
    if (!previewId) return undefined;
    let live = true;
    fetchPreviewDiff(previewId).then(
      (d) => live && setDiff(d),
      async (err) => {
        const gone = err?.code === "PREVIEW_NOT_FOUND" || err?.code === "PREVIEW_STALE";
        // The draft compared again (it expired with time, or a reload): the same change, the report it was reviewed
        // with still its decision — the result follows the new comparison.
        if (gone && draftSession) {
          const again = await previewDraft({ validate: false, language }).catch(() => null);
          if (!live) return;
          if (again?.id && again.direct) {
            const next = { ...result, previewId: again.id, deliverable: Boolean(again.gate?.can_commit) };
            setResult(next);
            keep({ result: next });
            return;
          }
        }
        if (live) setDiffError(gone ? t("direct.review.gone") : humanError(err, t)?.message || t("direct.review.gone"));
      },
    );
    return () => {
      live = false;
    };
    // The preview says it all.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewId]);
  const lens = useMemo(() => (previewId && diff ? { id: previewId, diff: diff.diff, geo: diff.geo, empty: Boolean(diff.diff?.empty) } : null), [previewId, diff]);
  // The reader's lens (« Pleine largeur ») shows the draft the decision is about.
  useEffect(() => {
    onPreview?.(lens);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lens]);
  useEffect(() => () => abortRef.current?.abort(), []);

  // A refusal in the person's words, and the way on (`retry`: the act to run again).
  // The AI allowance used up, the trial's limit: the offer, never « Réessayer ».
  const failure = (err, fallback, retry) => {
    const h = humanError(err, t);
    setError({ message: h?.message || t(fallback), retry: h?.offer ? "offer" : h && h.kind === "aborted" ? null : retry });
  };
  // Leaving the page while the turn runs loses it: the browser asks first.
  useEffect(() => {
    if (!running) return undefined;
    const hold = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", hold);
    return () => window.removeEventListener("beforeunload", hold);
  }, [running]);

  const run = async ({ text, ids, answer = null }) => {
    lastRun.current = { text, ids, answer };
    setError(null);
    setQuestion(null);
    setStep({ kind: "reading", by: "agent" });
    setProgress(stageOf(null, { kind: "reading", by: "agent" }));
    setActivity(EMPTY_ACTIVITY);
    setRunning(true);
    // On the draft's own session the turn needs no edit mode (its change joins the draft); without one, the commit's.
    if (!draftSession && !editing && enterEditMode) {
      const entered = await enterEditMode({ quiet: true, overrideHold: true });
      if (!entered?.ok) {
        setRunning(false);
        if (!entered?.paywall) failure({ code: entered?.errorCode || null, status: entered?.status || null, message: entered?.message || null }, "direct.error.turn", "turn");
        return;
      }
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setSent({ brief: text, documentIds: ids });
    // Kept while it runs: a page left mid-turn says so on return (the turn's cost is spent, its result is not).
    keep({ running: { brief: text, at: new Date().toISOString() } });
    let done = null;
    let failed = null;
    try {
      await streamDirectChange({
        brief: text,
        documentIds: ids,
        answer,
        language,
        session: draftSession,
        signal: controller.signal,
        onEvent: (event, data) => {
          if (event === "step") {
            setStep(data);
            setProgress((p) => stageOf(p, data));
            setActivity((a) => activityOf(a, data));
          } else if (event === "question") setQuestion(data);
          else if (event === "error") failed = data;
          else if (event === "done") done = data;
        },
      });
    } catch (err) {
      setRunning(false);
      keep({ running: null });
      if (err?.code !== "ABORTED") failure(err, "direct.error.turn", "turn");
      return;
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
    keep({ running: null });
    setRunning(false);
    if (!done || done.reason === "error") {
      failure(failed ? { code: failed.code, status: failed.status, message: failed.message } : null, "direct.error.turn", "turn");
      return;
    }
    if (done.reason === "aborted") return;
    if (done.reason === "asked") {
      setQuestion(done.question || null);
      keep({ sent: { brief: text, documentIds: ids }, question: done.question || null });
      return;
    }
    const next = keptResult(done);
    setResult(next);
    setRevising(false);
    setReportOpen(true);
    keep({ result: next, sent: { brief: text, documentIds: ids }, question: null });
  };

  // The version undone: its draft reopened on the change with its report (POST /transform/draft/reopen) — the result
  // comes back, compared again once the draft is open, to be applied again or abandoned. Without a draft of its own
  // (or its report), nothing of it can be applied again.
  const wasFrozen = useRef(Boolean(frozen));
  const [reopened, setReopened] = useState(false);
  useEffect(() => {
    if (wasFrozen.current && !frozen) {
      if (result?.report) setReopened(true);
      else {
        setResult(null);
        keep({ result: null, sent: null, question: null });
      }
    }
    wasFrozen.current = Boolean(frozen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frozen]);
  useEffect(() => {
    if (!reopened || !draftSession) return undefined;
    let live = true;
    previewDraft({ validate: false, language })
      .then((again) => {
        if (!live) return;
        setReopened(false);
        const next = again?.id && again.direct ? { ...result, previewId: again.id, deliverable: Boolean(again.gate?.can_commit) } : null;
        setResult(next);
        keep({ result: next, ...(next ? {} : { sent: null, question: null }) });
      })
      .catch(() => {
        if (live) setReopened(false);
      });
    return () => {
      live = false;
    };
    // The draft reopened leads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reopened, draftSession]);
  // « Nouveau changement »: an empty brief on the version just applied.
  const newDraft = () => {
    setBrief("");
    setResult(null);
    keep({ brief: "", result: null, sent: null, question: null });
    onNewDraft?.();
  };

  const defaultBrief = t("direct.drop.defaultBrief");
  const prepare = () => {
    const text = brief.trim().length >= 3 ? brief.trim() : documentIds.length ? defaultBrief : "";
    if (!text) return;
    setRevising(false);
    // The brief as the turn reads it, kept at once (the typing is kept a moment after the last key).
    keep({ brief });
    run({ text, ids: documentIds });
  };
  const answerQuestion = (text) => {
    if (!sent) return;
    run({ text: sent.brief, ids: sent.documentIds, answer: { question: question?.question || "", text } });
  };
  // A correction: the brief again, with what the person asks to correct (the agent works again from the network).
  const correct = (text) => {
    const base = brief.trim().length >= 3 ? brief.trim() : defaultBrief;
    run({ text: briefWithCorrection(base, text, t("direct.correct.heading")), ids: documentIds });
  };
  const stop = () => abortRef.current?.abort();
  // Back from the agent's question to the brief: the question set aside (the brief is prepared again from the start).
  const backToBrief = () => {
    setQuestion(null);
    keep({ question: null });
  };

  const commit = async (who) => {
    if (!result?.previewId || !NAME_OK(who || "")) return;
    setDelivering(true);
    setError(null);
    try {
      const acknowledge = { by: { name: who.trim() }, direct: true };
      let out;
      if (draftSession) {
        // The draft applied (its comparison with the working copy, the report its decision); compared again once
        // when the comparison expired or the draft moved.
        out = await applyDraft(result.previewId, { acknowledge }).catch(async (err) => {
          if (err?.code !== "PREVIEW_NOT_FOUND" && err?.code !== "PREVIEW_STALE") throw err;
          const again = await previewDraft({ validate: false, language });
          if (!again?.id) throw err;
          return applyDraft(again.id, { acknowledge });
        });
      } else {
        if (!editing && enterEditMode) await enterEditMode({ quiet: true, overrideHold: true });
        out = await commitChangePlan(result.previewId, { acknowledge });
      }
      rememberName(who);
      setConfirming(false);
      onCommitted?.(out, { title: (brief.trim() || defaultBrief).split("\n")[0].slice(0, 120) });
    } catch (err) {
      setConfirming(false);
      failure(err, "direct.error.deliver", "deliver");
    } finally {
      setDelivering(false);
    }
  };
  const deliver = () => {
    const known = rememberedName() || me?.display_name || "";
    // Nothing to accept and a name known: the act itself. Else one confirmation, naming what is accepted.
    if (!toAcceptOf(result?.report) && NAME_OK(known)) return commit(known);
    setName(known);
    setConfirming(true);
    return undefined;
  };
  const retry = () => {
    if (error?.retry === "deliver") deliver();
    else if (error?.retry === "turn" && lastRun.current) run(lastRun.current);
    else if (error?.retry === "lost") {
      setError(null);
      keep({ running: null });
      prepare();
    } else if (error?.retry === "offer") openPaywall("edit");
  };
  const dismissError = () => {
    if (error?.retry === "lost") keep({ running: null });
    setError(null);
  };
  // A line of the change, or a demand placed in the network: its line opened in the reader, on « Après », on its date.
  const openLine = onOpenReader ? (line) => onOpenReader(line) : null;
  const locate = (where) => {
    const label = String(where?.line || "");
    const route = routes.find((r) => String(r.id) === label || String(r.short_name || "") === label || String(r.long_name || "") === label);
    const items = lens?.diff?.items || [];
    const inDiff = items.find((it) => String(it.route) === label || String(it.label) === label);
    const id = route ? String(route.id) : inDiff?.route ? String(inDiff.route) : null;
    if (id && openLine) openLine({ route: id, date: where?.date || inDiff?.date || null });
  };

  const moment = frozen ? "applied" : running ? "progress" : question ? "question" : result && !revising ? "decide" : "drop";
  // The decision reads the network itself (the reader on « Après », the report beside it); the brief, its turn and its
  // question have the screen to themselves.
  const reading = moment === "decide" || moment === "applied";
  useEffect(() => {
    onViewWanted?.(reading ? "network" : "change");
    if (reading) bar?.onSide?.("after");
    // The moment leads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reading]);
  const blocking = blockingOf(result?.facts);
  const toAccept = toAcceptOf(result?.report);
  const state = frozen
    ? { tone: "success", text: t("direct.state.applied", { n: frozen.n }) }
    : running
      ? { tone: "info", busy: true, text: t("direct.state.running"), seconds }
      : question
        ? { tone: "warning", text: t("direct.state.question") }
        : result
          ? !result.previewId
            ? { tone: "warning", text: t("direct.state.noChange") }
            : blocking.validator || blocking.integrity
              ? { tone: "error", text: t("direct.state.blocked") }
              : toAccept
                ? { tone: "warning", text: countWords(t, "direct.state.toCheck", toAccept) }
                : { tone: "success", text: t("direct.state.ready") }
          : error
            ? { tone: "error", text: t("direct.state.failed") }
            : { tone: "info", text: t("direct.state.drop") };
  const barNode = <DraftBar kind="brief" state={state} statusKey="" streaming={running} onStop={stop} onMore={bar?.onMore || (() => {})} onLeave={bar?.onLeave || null} variant={bar?.inHeader ? "header" : "bar"} side={reading ? bar?.side || null : null} onSide={reading ? bar?.onSide || null : null} report={reading ? { open: reportOpen, onToggle: () => setReportOpen((o) => !o) } : null} />;
  const floatingError = false;
  const errorNode = error ? (
    <Alert
      severity="error"
      data-testid="direct-error"
      onClose={dismissError}
      action={
        error.retry ? (
          <Button color="inherit" size="small" onClick={retry} data-testid="direct-error-retry" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t(error.retry === "offer" ? "access.seeOffers" : error.retry === "lost" ? "direct.lost.again" : "direct.error.retry")}
          </Button>
        ) : null
      }
      // At the decision the screen is full: the refusal floats over its top, the panes keep their place.
      sx={floatingError ? { position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 1200, width: "calc(100% - 48px)", maxWidth: 712, borderRadius: "12px", alignItems: "center", boxShadow: 6 } : { mx: "auto", mt: 3, width: "calc(100% - 48px)", maxWidth: 712, borderRadius: "12px", alignItems: "center" }}
    >
      {error.message}
    </Alert>
  ) : null;

  return (
    <Box data-testid="direct-change" data-moment={moment} sx={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0, height: "100%", display: "flex", flexDirection: "column" }}>
      {bar?.host ? createPortal(barNode, bar.host) : barNode}
      {reading ? (
        reportOpen ? (
          (() => {
            const decision = <DirectDecision result={result} diff={diff} diffError={diffError} nextN={nextN} onOpenLine={openLine} onLocate={locate} onDeliver={deliver} delivering={delivering} correcting={running} onCorrect={correct} onRevise={() => setRevising(true)} onPrepareAgain={prepare} onAbandon={onAbandon} frozen={frozen} onOpenApplied={onOpenApplied} onNewDraft={newDraft} onClose={sideHost ? () => setReportOpen(false) : null} notice={errorNode} />;
            return sideHost ? createPortal(decision, sideHost) : decision;
          })()
        ) : null
      ) : (
        <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {errorNode}
          {moment === "drop" ? (
            <DirectDrop brief={brief} onBrief={setBrief} project={project} retentionDays={retentionDays} onPrepare={prepare} disabled={brief.trim().length < 3 && !documentIds.length} onBack={revising && result ? () => setRevising(false) : null} />
          ) : (
            <DirectProgress brief={(sent?.brief || brief).trim()} progress={progress} step={step} question={moment === "question" ? question : null} onAnswer={answerQuestion} answering={running} activity={activity} seconds={seconds} onBackToBrief={backToBrief} />
          )}
        </Box>
      )}
      <DirectConfirm open={confirming} report={result?.report} nextN={nextN} name={name} onName={setName} onClose={() => setConfirming(false)} onConfirm={() => commit(name)} busy={delivering} />
    </Box>
  );
}
