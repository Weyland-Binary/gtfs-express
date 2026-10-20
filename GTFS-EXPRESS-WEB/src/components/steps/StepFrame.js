/**
 * StepFrame — the frame of every step page: the
 * step's heading, the notice that asks for an action, the body, and the
 * step's foot with ONE primary action.
 *
 *   <h1>          "Étape 3 sur 5 : Changement" — the screen's one heading,
 *                 which the shell focuses on every change of step (RGAA 9.1)
 *   step-notice   a banner in place for what asks for an action here (a
 *                 refusal, a lock, a copy of the network to reload…), never a
 *                 snackbar — the host passes it, e.g. a RefusalNotice
 *   body          the step itself
 *   step-footer   step-back ("Étape précédente", from step 2 on), what the
 *                 host adds to the foot (the design's estimate and
 *                 `network-build`, the change's status line), and the primary
 *                 action `step-primary` — always rendered, never hidden:
 *                 disabled, it says why in text next to it
 *                 (`step-primary-reason`, the button described by it)
 *
 * The frame holds no state of the journey: the flow (the Network Studio or
 * the Change Studio) decides the label, the action and its reason. What
 * concerns the project itself, at every step, comes from the page
 * (ProjectContext) and is said first in the notice area:
 *
 *   autosave-conflict   the project changed elsewhere since this tab read
 *                       it (409 AUTOSAVE_CONFLICT): "Recharger" (the other
 *                       copy; the fields this tab would lose are listed) or
 *                       "Garder ma copie" (written over it, journaled with
 *                       the person's name) — never a silent overwrite;
 *                       a choice that failed is offered again as itself
 *                       (« Réessayer » never turns a failed reload into an
 *                       overwrite)
 *   project-not-kept    the server refused to keep the project (the quota,
 *                       its size, the workspace off): the refusal with its
 *                       action — « Mes travaux » (delete one there) and
 *                       « Réessayer » — never "offline" when it is not
 *   session-expired     the working copy expired (or the network is open in
 *                       another tab): "Reprendre" (`session-resume`) brings
 *                       the project's last frozen version back from its zip,
 *                       never a new download; the project is intact
 *   draft-restored      once it is back: « Brouillon restauré (date) », the
 *                       version the working copy now holds, until closed
 *
 *   primary = { label, onClick, disabled, reason, busy, alias? } — `alias`: the step's own test id for its
 *             primary action (② `contract-proceed`), on a wrapper around `step-primary` (one test id per node)
 *   back    = { onClick } (label: step.back) | null
 *
 * In the Network Studio on a desktop screen the foot moves into the studio's
 * bar (AppShell's actions slot, <StepActions>): the same back, extras, reason
 * and primary action, at the top right, and the work below has the whole
 * height. `headless`: the step's heading is said to screen readers only (the
 * bar's steps and the workbench's panels say where the person is); the
 * workbench then runs edge to edge.
 */

import React, { createContext, useContext, useId, useState } from "react";

/**
 * A step's page shown inside the panel « Modifications »'s dialogs (the draft's one screen, 2026-10-13): the dialog
 * says what it holds, so the step's « Étape n sur N » heading is said to screen readers only.
 */
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

/**
 * A business application, not a long document: on a desktop screen the step fills the window — its heading and
 * its foot stay where they are, its body takes the height left and scrolls inside it (the workbenches, the
 * Network Studio and the Change Studio, fill that height and scroll their own panes). Below it (a phone, a
 * short window) the page scrolls as a whole.
 */
export const FILL_QUERY = "(min-width:900px) and (min-height:600px)";
export const useFillLayout = () => useMediaQuery(FILL_QUERY, { noSsr: true });

// The project's fields, in the words of the steps that hold them (what "Recharger" would lose).
const FIELD_KEYS = { name: "network.project.name", network: "step.1.title", documents: "documents.title", context: "network.context", deliverables_wanted: "deliverables.wanted", contract: "step.2.title", scenarios: "step.3.create.title", versions: "version.list", acknowledgements: "ack.title", journal: "journal.title", delivery: "step.5.title" };

/** 409 AUTOSAVE_CONFLICT, in place: « Recharger » or « Garder ma copie ». */
function ConflictNotice({ projectId, actor = null }) {
  const { t } = useLanguage();
  const sync = useProjectSync(projectId);
  const [busy, setBusy] = useState(false);
  // The choice that failed and why: « Réessayer » repeats THAT choice — a failed reload is never retried as an overwrite.
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

/** The server refused to keep the project: its refusal, in place, with « Mes travaux » (delete one there) and « Réessayer ». */
function NotKeptNotice({ projectId }) {
  const sync = useProjectSync(projectId);
  if (sync?.state !== "local" || !sync.error) return null;
  const refusal = { code: sync.refusal?.code || sync.error, status: sync.refusal?.status ?? null, message: "", details: sync.refusal?.details || {} };
  return <RefusalNotice refusal={refusal} testid="project-not-kept" sx={{ mb: 1 }} supported={["myWork", "retry"]} onAction={(id) => (id === "myWork" ? openWorks() : id === "retry" ? retryLocal(projectId) : null)} />;
}

/**
 * The project's network is not open here: « Reprendre » rematerialises its last frozen version. While it
 * comes back (by itself on a new tab, or after the click) the notice says so, in plain information.
 */
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

/** The working copy brought back from its frozen zip (« Reprendre »): said once, until closed. */
function RestoredNotice({ restored, onClose }) {
  const { t, language } = useLanguage();
  if (!restored) return null;
  return (
    <Alert severity="success" data-testid="draft-restored" data-version={restored.n} onClose={onClose || undefined} sx={{ mb: 1, fontSize: "0.8rem" }}>
      {t("draft.restored", { date: restored.at ? formatDateTime(restored.at, language) : `v${restored.n}` })}
    </Alert>
  );
}

export default function StepFrame({ step, job = "create", title = null, intro = null, notice = null, primary = null, back = null, footer = null, children, bodySx = {}, testid = null, headless = false }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const headingId = useId();
  const reasonId = useId();
  const headingText = stepHeading(t, step, job, title);
  const disabled = Boolean(primary?.disabled || primary?.busy);
  const fill = useFillLayout();
  // The studio's bar holds the step's actions on a desktop screen; its main area runs edge to edge (the step pads itself).
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
    // The heading and the step's one-line purpose on one row: the height goes to the work.
    <Box sx={{ pt: 1, pb: 0.75, display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: 1.5, rowGap: 0.25, flexShrink: 0 }}>
      <Typography component="h1" id={headingId} tabIndex={-1} sx={{ fontSize: "1.08rem", fontWeight: 800, lineHeight: 1.25, outline: "none" }}>
        {headingText}
      </Typography>
      {intro && <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", lineHeight: 1.45, minWidth: 0 }}>{intro}</Typography>}
    </Box>
  );
  return (
    // Filling the window (useFillLayout), the frame is the window's height and its body scrolls inside, between a
    // heading and a foot that stay. Otherwise never smaller than its content (min-height auto): the page scrolls,
    // and nothing slides under the sticky footer — a long contract on a phone stays reachable.
    <Box component="section" aria-labelledby={headingId} data-testid={testid || "step-frame"} data-step={step} data-job={job} data-fill={fill ? "true" : "false"} sx={{ flex: 1, minHeight: fill ? 0 : "auto", display: "flex", flexDirection: "column", ...(studio && !quiet ? { px: 2 } : {}) }}>
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
      {/* Scrolling inside, the body is the containing block of what it positions absolutely (the visually hidden
          labels and inputs of its content): placed down the scrolled content, they made the whole page scroll too —
          two scrollbars, and a click lost when focusing a button moved the page under the cursor. */}
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
