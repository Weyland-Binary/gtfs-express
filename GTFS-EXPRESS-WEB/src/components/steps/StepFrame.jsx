/**
 * The frame of every step page: its heading (focused on every change of step, RGAA 9.1), the notices that ask for
 * an action, the body and ONE primary action, always rendered: disabled, it says why next to it. On a desktop screen
 * the foot moves into the studio's bar (<StepActions>). The frame holds no state of the journey.
 * `primary.alias`: the step's own test id for its primary action, on a wrapper (one test id per node).
 */

import React, { createContext, useContext, useId, useState } from "react";

/** Inside a dialog, which says what it holds: the step's heading is for screen readers only. */
export const StepFrameInDialog = createContext(false);
import { Alert, Box, Button, CircularProgress, IconButton, Tooltip, Typography, useMediaQuery, useTheme } from "@mui/material";
import ArrowBackIosNewRoundedIcon from "@mui/icons-material/ArrowBackIosNewRounded";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { formatDateTime } from "../../utils/formatDate";
import { conflictOf, resolveConflict, retryLocal, useCurrentProject, useProjectSync } from "../../utils/projectStore";
import RefusalNotice from "../common/RefusalNotice";
import { StepActions, useStepActionsSlot } from "../AppShell";
import { stepHeading } from "./StepNav";
import { openWorks } from "../../utils/works";

/** On a desktop screen the step fills the window and its body scrolls inside; below that the page scrolls as a whole. */
export const FILL_QUERY = "(min-width:900px) and (min-height:600px)";
export const useFillLayout = () => useMediaQuery(FILL_QUERY, { noSsr: true });

// What « Recharger » would lose, in the words of the steps that hold the fields.
const FIELD_KEYS = { name: "network.project.name", network: "step.1.title", documents: "documents.title", context: "network.context", scenarios: "step.3.modify.title", versions: "version.list", acknowledgements: "ack.title", journal: "journal.title", delivery: "step.5.title" };

/** 409 AUTOSAVE_CONFLICT, in place: « Recharger » or « Garder ma copie », never a silent overwrite. */
function ConflictNotice({ projectId, actor = null }) {
  const { t } = useLanguage();
  const sync = useProjectSync(projectId);
  const [busy, setBusy] = useState(false);
  // « Réessayer » repeats the choice that failed: a failed reload is never retried as an overwrite.
  const [failed, setFailed] = useState(null); // { err, choice }
  if (sync?.state !== "conflict") return null;
  const conflict = conflictOf(projectId);
  const fields = (conflict?.fields || []).filter((f) => FIELD_KEYS[f]).map((f) => t(FIELD_KEYS[f]));
  const choose = async (choice) => {
    setBusy(true);
    setFailed(null);
    try {
      await resolveConflict(projectId, choice, { actor });
    } catch (err) {
      setFailed({ err, choice });
    } finally {
      setBusy(false);
    }
  };
  const onAction = (id) => {
    if (busy) return null;
    if (id === "reload") return choose("reload");
    if (id === "keepMine") return choose("keep");
    if (id === "retry" && failed) return choose(failed.choice);
    return null;
  };
  return (
    <RefusalNotice
      refusal={failed?.err || { code: "AUTOSAVE_CONFLICT", status: 409, message: "", details: {} }}
      testid="autosave-conflict"
      sx={{ mb: 1 }}
      supported={failed ? ["retry", "reload", "keepMine"] : ["reload", "keepMine"]}
      onAction={onAction}
    >
      {!failed && fields.length > 0 && (
        <Typography data-testid="autosave-conflict-fields" sx={{ fontSize: "0.76rem", mt: 0.5 }}>
          {t("refusal.AUTOSAVE_CONFLICT.lost", { fields: fields.join(", ") })}
        </Typography>
      )}
    </RefusalNotice>
  );
}

/** The server refused to keep the project (the quota, its size, the workspace off). */
function NotKeptNotice({ projectId }) {
  const sync = useProjectSync(projectId);
  if (sync?.state !== "local" || !sync.error) return null;
  const refusal = { code: sync.refusal?.code || sync.error, status: sync.refusal?.status ?? null, message: "", details: sync.refusal?.details || {} };
  return <RefusalNotice refusal={refusal} testid="project-not-kept" sx={{ mb: 1 }} supported={["myWork", "retry"]} onAction={(id) => (id === "myWork" ? openWorks() : id === "retry" ? retryLocal(projectId) : null)} />;
}

/** While the version comes back (by itself on a new tab, or after « Reprendre »), the notice says so as information. */
function SessionNotice({ resume }) {
  const { t } = useLanguage();
  if (!resume) return null;
  if (resume.busy && resume.version) {
    return (
      <Alert severity="info" icon={<CircularProgress size={18} />} data-testid="session-expired" data-state="reopening" sx={{ mb: 1 }}>
        {t("recovery.reopening", { n: resume.version.n })}
      </Alert>
    );
  }
  return (
    <Alert
      severity="warning"
      data-testid="session-expired"
      sx={{ mb: 1 }}
      action={
        resume.version ? (
          <Button color="inherit" size="small" onClick={resume.onResume} disabled={resume.busy} startIcon={resume.busy ? <CircularProgress size={14} color="inherit" /> : null} data-testid="session-resume" sx={{ textTransform: "none", fontWeight: 800, whiteSpace: "nowrap" }}>
            {t("recovery.resume")}
          </Button>
        ) : null
      }
    >
      <strong>{t("recovery.title")}</strong> — {t(resume.version ? "recovery.bodyVersion" : "recovery.body", { n: resume.version?.n ?? "" })}
      {resume.error && (
        <Typography data-testid="session-resume-error" sx={{ fontSize: "0.76rem", mt: 0.5 }}>
          {resume.error}
        </Typography>
      )}
    </Alert>
  );
}

function RestoredNotice({ restored, onClose }) {
  const { t, language } = useLanguage();
  if (!restored) return null;
  return (
    <Alert severity="success" data-testid="draft-restored" data-version={restored.n} onClose={onClose || undefined} sx={{ mb: 1, fontSize: "0.8rem" }}>
      {t("draft.restored", { date: restored.at ? formatDateTime(restored.at, language) : `v${restored.n}` })}
    </Alert>
  );
}

export default function StepFrame({ step, title = null, intro = null, notice = null, primary = null, back = null, footer = null, children, bodySx = {}, testid = null, headless = false }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const headingId = useId();
  const reasonId = useId();
  const headingText = stepHeading(t, step, title);
  const disabled = Boolean(primary?.disabled || primary?.busy);
  const fill = useFillLayout();
  // On a desktop screen the studio's bar holds the step's actions; its main area runs edge to edge.
  const actionsSlot = useStepActionsSlot();
  const inBar = Boolean(actionsSlot) && fill;
  const studio = Boolean(actionsSlot);
  const inDialog = useContext(StepFrameInDialog);
  const quiet = (headless && inBar) || inDialog;
  const current = useCurrentProject();
  const projectNotices = current ? (
    <>
      <ConflictNotice projectId={current.project?.id || null} actor={current.actor || null} />
      <NotKeptNotice projectId={current.project?.id || null} />
      <SessionNotice resume={current.resume || null} />
      <RestoredNotice restored={current.restored || null} onClose={current.onRestoredSeen || null} />
    </>
  ) : null;
  const reasonNode = primary?.disabled && primary.reason ? (
    <Typography id={reasonId} data-testid="step-primary-reason" sx={{ fontSize: inBar ? "0.72rem" : "0.78rem", color: "text.secondary", maxWidth: inBar ? 220 : 420, textAlign: "right", lineHeight: inBar ? 1.3 : 1.4, ...(inBar ? { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } : {}) }}>
      {primary.reason}
    </Typography>
  ) : null;
  const primaryNode = primary ? (
    <Box component="span" data-testid={primary.alias || undefined} data-disabled={primary.alias ? String(disabled) : undefined} sx={{ display: "inline-flex" }}>
      <Button variant="contained" disableElevation disabled={disabled} onClick={primary.onClick} aria-describedby={primary.disabled && primary.reason ? reasonId : undefined} endIcon={primary.busy ? <CircularProgress size={14} color="inherit" /> : primary.arrow === false ? null : <ArrowForwardRoundedIcon />} data-testid="step-primary" sx={inBar ? { whiteSpace: "nowrap" } : { textTransform: "none", fontWeight: 800, borderRadius: 99, px: 2.25 }}>
        {primary.label}
      </Button>
    </Box>
  ) : null;
  const heading = (
    <Box sx={{ pt: 1, pb: 0.75, display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: 1.5, rowGap: 0.25, flexShrink: 0 }}>
      <Typography component="h1" id={headingId} tabIndex={-1} sx={{ fontSize: "1.08rem", fontWeight: 800, lineHeight: 1.25, outline: "none" }}>
        {headingText}
      </Typography>
      {intro && <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", lineHeight: 1.45, minWidth: 0 }}>{intro}</Typography>}
    </Box>
  );
  return (
    // Filling the window, the body scrolls between a heading and a foot that stay; otherwise the frame is never
    // smaller than its content and the page scrolls, nothing sliding under the sticky footer.
    <Box component="section" aria-labelledby={headingId} data-testid={testid || "step-frame"} data-step={step} data-fill={fill ? "true" : "false"} sx={{ flex: 1, minHeight: fill ? 0 : "auto", display: "flex", flexDirection: "column", ...(studio && !quiet ? { px: 2 } : {}) }}>
      {quiet ? (
        <Typography component="h1" id={headingId} tabIndex={-1} className="visually-hidden">
          {headingText}
        </Typography>
      ) : (
        heading
      )}
      <Box sx={{ flexShrink: 0, ...(quiet ? { px: 1.5, "&:not(:empty)": { pt: 1.25 } } : {}) }}>{projectNotices}</Box>
      {notice && (
        <Box data-testid="step-notice" sx={{ mb: 1, flexShrink: 0, ...(quiet ? { px: 1.5, pt: 1.25, mb: 0 } : {}) }}>
          {notice}
        </Box>
      )}
      {/* The scrolling body is the containing block of its absolutely positioned descendants (visually hidden labels
          and inputs): otherwise they made the whole page scroll too, and a focus moved the page under the cursor. */}
      <Box data-testid="step-body" sx={{ flex: 1, minHeight: fill ? 0 : "auto", display: "flex", flexDirection: "column", ...(fill ? { overflowY: "auto", overflowX: "hidden", position: "relative" } : {}), ...(studio && !quiet ? { pb: 1.5 } : {}), ...bodySx }}>
        {children}
      </Box>
      {inBar ? (
        <StepActions>
          <Box data-testid="step-footer" data-place="bar" sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
            {back && (
              <Tooltip title={back.label || t("step.back")}>
                <IconButton size="small" onClick={back.onClick} aria-label={back.label || t("step.back")} data-testid="step-back">
                  <ArrowBackIosNewRoundedIcon sx={{ fontSize: 15 }} />
                </IconButton>
              </Tooltip>
            )}
            {footer}
            {reasonNode}
            {primaryNode}
          </Box>
        </StepActions>
      ) : (
        <Box data-testid="step-footer" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1, py: 0.75, mt: 0.5, flexShrink: 0, borderTop: `1px solid ${theme.palette.divider}`, background: theme.palette.background.default, position: "sticky", bottom: 0, zIndex: 2 }}>
          {back && (
            <Button size="small" startIcon={<ArrowBackIosNewRoundedIcon sx={{ fontSize: "0.8rem !important" }} />} onClick={back.onClick} data-testid="step-back" sx={{ textTransform: "none", fontWeight: 600 }}>
              {back.label || t("step.back")}
            </Button>
          )}
          <Box sx={{ flex: 1 }} />
          {footer}
          {reasonNode}
          {primaryNode}
        </Box>
      )}
    </Box>
  );
}
