/**
 * A project's versions, each frozen as a zip on the server: read its diff from the reference or its coherence
 * report, or reopen it as the working copy (journaled; the version stays frozen).
 */

import React, { useState } from "react";
import { Alert, Box, Button, CircularProgress, Dialog, DialogContent, DialogTitle, IconButton, Typography } from "@mui/material";
import CompareArrowsIcon from "@mui/icons-material/CompareArrows";
import RestoreOutlinedIcon from "@mui/icons-material/RestoreOutlined";
import TableViewOutlinedIcon from "@mui/icons-material/TableViewOutlined";
import CloseIcon from "@mui/icons-material/Close";
import { useLanguage } from "../../contexts/LanguageContext";
import { formatDateTime, formatNumber } from "../../utils/formatDate";
import { latestVersionOf, remoteEnabled, retryFreeze, useCurrentProject } from "../../utils/projectStore";
import { can, fetchVersionCoherence, fetchVersionDiff, isFrozen, referenceOf } from "../../utils/deliverablesApi";
import RefusalNotice from "../common/RefusalNotice";
import CoherenceReport from "../common/CoherenceReport";
import { DiffReport } from "../diff/FeedDiffPage";

// Any other origin reads "origin not stated": the stored value is never printed as it is.
const SOURCES = new Set(["catalogue", "upload", "sample", "version"]);
export const sourceLabel = (source, t) => t(`version.source.${SOURCES.has(source) ? source : "unknown"}`);

export const sizeLabel = (bytes, language, t) => t("size.mb", { size: formatNumber((bytes || 0) / 1024 / 1024, language, { maximumFractionDigits: 1 }) });

/** "v1 construite · par Nadia Lefèvre · 28 sept. 2026, 15:02 · 0 erreur" */
export const versionLine = (v, t, language) => {
  const head =
    v.kind === "reference"
      ? t("version.reference", { source: sourceLabel(v.source, t), date: formatDateTime(v.at, language) })
      : v.kind === "snapshot"
        ? t("version.snapshotTaken", { n: v.n, reason: t(`version.snapshotReason.${["edits", "idle", "before_expiry", "manual"].includes(v.snapshot_reason) ? v.snapshot_reason : "manual"}`), time: formatDateTime(v.at, language) })
        : t(v.kind === "delivered" ? "version.delivered" : "version.applied", { n: v.n });
  const parts = [head];
  if (v.kind !== "reference" && v.by) parts.push(t("step.version.by", { name: v.by }));
  if (v.kind !== "reference" && v.at) parts.push(formatDateTime(v.at, language));
  if (v.validation && Number.isFinite(Number(v.validation.errors))) parts.push(t("step.version.validation", { errors: formatNumber(v.validation.errors, language), warnings: formatNumber(v.validation.warnings ?? 0, language) }));
  // A version frozen at its delivery already says it in its head ("v2 livrée").
  if ((v.delivered_at || v.delivered) && v.kind !== "delivered") parts.push(t("version.deliveredMark"));
  if (v.zip?.purged_at) parts.push(t("version.purged"));
  else if (v.zip?.bytes) parts.push(sizeLabel(v.zip.bytes, language, t));
  else if (v.zip_refused) parts.push(t("version.zipRefused"));
  return parts.join(" · ");
};

/** The server refused to freeze the latest version: said in place with « Réessayer », never a silent data-frozen="false". */
function RefusedFreeze({ versions }) {
  const current = useCurrentProject();
  const [busy, setBusy] = useState(false);
  const last = latestVersionOf({ versions });
  if (!current?.project || !last?.zip_refused || last.zip?.sha256) return null;
  const refusal = { code: last.zip_refusal?.code || last.zip_refused, status: last.zip_refusal?.status ?? null, message: "", details: last.zip_refusal?.details || {} };
  const retry = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await retryFreeze(current.project.id, last.id);
    } finally {
      setBusy(false);
    }
  };
  return <RefusalNotice refusal={refusal} testid="version-refused" sx={{ mt: 0.5 }} supported={["retry"]} onAction={(id) => (id === "retry" ? retry() : null)} />;
}

function VersionReader({ open, onClose, title, testid, children }) {
  const { t } = useLanguage();
  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth aria-labelledby={`${testid}-title`}>
      <DialogTitle id={`${testid}-title`} sx={{ display: "flex", alignItems: "center", gap: 1, fontSize: "1rem", fontWeight: 800 }}>
        <Box component="span" sx={{ flex: 1 }}>
          {title}
        </Box>
        <IconButton size="small" onClick={onClose} aria-label={t("app.close")} data-testid={`${testid}-close`}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers data-testid={testid}>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export const versionActionsReason = (reasons) => {
  const distinct = [...new Set(reasons.filter(Boolean))];
  return distinct.length ? distinct.join(" · ") : null;
};

/**
 * Each action stays rendered, disabled with its reason written under the row: a disabled button takes no focus,
 * and a tooltip reaches neither a screen reader nor a touch screen.
 */
function VersionActions({ version, reference, onDiff, onCoherence, onRestore, restoring }) {
  const { t } = useLanguage();
  const current = useCurrentProject();
  const frozen = isFrozen(version);
  const role = current?.project?.role || "owner";
  const diffReason = version.n === 0 ? null : !frozen ? t("version.reason.notFrozen") : !isFrozen(reference) ? t("version.reason.noReference") : null;
  const coherenceReason = frozen ? null : t("version.reason.notFrozen");
  const restoreReason = !frozen ? t("version.reason.notFrozen") : !current?.reopen ? t("version.reason.noReopen") : !can(role, "contributor") ? t("version.reason.role") : null;
  const reasonId = `version-actions-reason-${version.id}`;
  const said = versionActionsReason([diffReason, coherenceReason, restoreReason]);
  const button = (id, label, icon, onClick, reason, busy = false) => (
    <Button size="small" onClick={onClick} disabled={Boolean(reason) || busy} aria-describedby={reason ? reasonId : undefined} startIcon={busy ? <CircularProgress size={12} color="inherit" /> : icon} data-testid={id} data-version={version.n} sx={{ textTransform: "none", fontWeight: 700, minWidth: 0, py: 0 }}>
      {label}
    </Button>
  );
  return (
    <>
      <Box sx={{ display: "flex", gap: 0.25, flexWrap: "wrap", ml: -0.75 }}>
        {version.n > 0 && button("version-diff", t("delivery.diff", { n: version.n }), <CompareArrowsIcon />, () => onDiff(version), diffReason)}
        {button("version-coherence", t("version.coherence"), <TableViewOutlinedIcon />, () => onCoherence(version), coherenceReason)}
        {button("version-restore", t("version.restore", { n: version.n }), <RestoreOutlinedIcon />, () => onRestore(version), restoreReason, restoring === version.id)}
      </Box>
      {said && (
        <Typography id={reasonId} data-testid="version-actions-reason" data-version={version.n} sx={{ fontSize: "0.72rem", color: "text.secondary" }}>
          {said}
        </Typography>
      )}
    </>
  );
}

export function VersionList({ versions = [] }) {
  const { t, language } = useLanguage();
  const current = useCurrentProject();
  const [reading, setReading] = useState(null); // { kind: "diff" | "coherence", version, state, data, error }
  const [restore, setRestore] = useState({ confirm: null, busy: null, error: null, done: null });
  if (!versions.length) return <Typography sx={{ fontSize: "0.8rem", color: "text.secondary" }}>{t("step.version.none")}</Typography>;
  const project = current?.project || null;
  const actionable = Boolean(project && remoteEnabled());
  const reference = referenceOf({ versions });

  const read = async (kind, version) => {
    setReading({ kind, version, state: "loading", data: null, error: null });
    try {
      const data = kind === "diff" ? await fetchVersionDiff(project.id, version.id) : await fetchVersionCoherence(project.id, version.id);
      setReading((r) => (r && r.version.id === version.id && r.kind === kind ? { ...r, state: "done", data } : r));
    } catch (err) {
      setReading((r) => (r && r.version.id === version.id && r.kind === kind ? { ...r, state: "error", error: err } : r));
    }
  };
  // Retouches no version holds would be lost from this tab's working copy: confirmed first.
  const askRestore = (version) => (Number(current?.unfrozenEdits) > 0 ? setRestore({ confirm: version, busy: null, error: null, done: null }) : doRestore(version));
  const doRestore = async (version) => {
    setRestore({ confirm: null, busy: version.id, error: null, done: null });
    try {
      await current.reopen(version);
      setRestore({ confirm: null, busy: null, error: null, done: version.n });
    } catch (err) {
      setRestore({ confirm: null, busy: null, error: err, done: null });
    }
  };

  return (
    <>
      <Box component="ul" data-testid="version-list" sx={{ m: 0, pl: 2.25, display: "flex", flexDirection: "column", gap: 0.35 }}>
        {[...versions].sort((a, b) => a.n - b.n).map((v) => (
          <Box component="li" key={v.id} sx={{ fontSize: "0.8rem" }}>
            <Typography component="span" data-testid="version-row" data-kind={v.kind} data-n={v.n} data-frozen={v.zip?.sha256 && !v.zip.purged_at ? "true" : "false"} data-refused={v.zip_refused && !v.zip?.sha256 ? v.zip_refused : undefined} data-delivered={v.delivered_at || v.delivered ? "true" : "false"} sx={{ display: "block", fontSize: "0.8rem", lineHeight: 1.5 }}>
              {versionLine(v, t, language)}
            </Typography>
            {actionable && <VersionActions version={v} reference={reference} onDiff={(x) => read("diff", x)} onCoherence={(x) => read("coherence", x)} onRestore={askRestore} restoring={restore.busy} />}
          </Box>
        ))}
      </Box>
      <RefusedFreeze versions={versions} />
      {restore.confirm && (
        <Alert severity="warning" data-testid="version-restore-confirm" sx={{ fontSize: "0.78rem" }} action={
          <Box sx={{ display: "flex", gap: 0.5 }}>
            <Button color="inherit" size="small" onClick={() => setRestore({ confirm: null, busy: null, error: null, done: null })} data-testid="version-restore-cancel" sx={{ textTransform: "none" }}>
              {t("app.cancel")}
            </Button>
            <Button color="inherit" size="small" variant="outlined" onClick={() => doRestore(restore.confirm)} data-testid="version-restore-go" sx={{ textTransform: "none", fontWeight: 700 }}>
              {t("version.restore", { n: restore.confirm.n })}
            </Button>
          </Box>
        }>
          {t("version.restoreConfirm", { n: restore.confirm.n, count: Number(current?.unfrozenEdits) || 0 })}
        </Alert>
      )}
      {restore.done != null && <Typography data-testid="version-restored" role="status" sx={{ fontSize: "0.76rem", color: "success.dark" }}>{t("version.restored", { n: restore.done })}</Typography>}
      {restore.error && <RefusalNotice refusal={restore.error} testid="version-restore-refusal" />}
      <VersionReader open={reading?.kind === "diff"} onClose={() => setReading(null)} title={reading?.version ? t("version.diffTitle", { n: reading.version.n, from: reading.data?.from?.n ?? 0 }) : ""} testid="version-diff-view">
        {reading?.kind === "diff" && reading.state === "loading" && <CircularProgress size={24} />}
        {reading?.kind === "diff" && reading.state === "error" && <RefusalNotice refusal={reading.error} testid="version-diff-refusal" onAction={(id) => id === "retry" && read("diff", reading.version)} supported={["retry"]} />}
        {reading?.kind === "diff" && reading.state === "done" && <DiffReport diff={reading.data} direction={t("version.diffDirection", { from: reading.data.from?.n ?? 0, to: reading.data.to?.n ?? reading.version.n })} ai={false} />}
      </VersionReader>
      <VersionReader open={reading?.kind === "coherence"} onClose={() => setReading(null)} title={reading?.version ? t("version.coherenceTitle", { n: reading.version.n }) : ""} testid="version-coherence-view">
        {reading?.kind === "coherence" && reading.state === "loading" && <CircularProgress size={24} />}
        {reading?.kind === "coherence" && reading.state === "error" && <RefusalNotice refusal={reading.error} testid="version-coherence-refusal" onAction={(id) => id === "retry" && read("coherence", reading.version)} supported={["retry"]} />}
        {reading?.kind === "coherence" && reading.state === "done" && <CoherenceReport source={{ kind: "static", report: reading.data }} note={t("version.coherenceNote", { n: reading.version.n })} testid="version-coherence-report" />}
      </VersionReader>
    </>
  );
}
