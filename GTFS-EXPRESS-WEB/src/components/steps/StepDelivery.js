/**
 * StepDelivery — ⑤ Livraison: accept under one's name, build or apply,
 * deliver (target design §4 A5, §5 B5, D3, D8, D37, D45).
 *
 * The act and the signature are on the same screen (D3): never a dialog,
 * never a step of their own, and a refusal is shown in the section it
 * concerns, with the focus. Modifying (Lot H), the indicators of the checks
 * (`tiles`) open the page — the modify job has no ④ of its own, the result
 * is verified where it is applied — and, since the owner's UX lot 2
 * (2026-10-11: « ⑤, un écran de décision, puis les livrables »), the decision
 * comes first: the act under one's name is section 1, the checks themselves
 * (`checks`, `delivery-checks`) section 2 folded under it (`delivery-checks-fold`,
 * open by the flow — `checksOpen` — while something holds the act, opened by
 * the person otherwise), the deliverables section 3. Four sections at most:
 *
 *   1 ▸ what you accept under your name — the AcknowledgementForm (`ack-form`)
 *       when the engine lists something to accept (a must clause not met or
 *       not measurable, unverified sources, an assumption); validator errors
 *       are never offered, they get fixed
 *   2 ▸ the act — build the version (create: the progress, then the result
 *       `network-result` with "Voir le réseau" `network-open`) or apply it
 *       (modify: the apply section, `change-apply-dialog`, whose confirm is
 *       `change-apply-confirm`; then the result `change-applied` with
 *       "Nouveau scénario sur vN" and "Annuler l'application")
 *   3 ▸ the deliverables (`delivery-list`) — from the version, each named
 *       after the network, the version and the day: the GTFS
 *       (`network-download`, downloaded without edit mode for a network
 *       built here), the summary note…
 *       — then « Tout le paquet » of the project's latest version, its
 *       manifest, « Marquer livrée », the share link and, with accounts,
 *       the approval (DeliveryPackage, WP10)
 *   4 ▸ the versions of the project (`version-list`, `version-row`), each
 *       frozen as a zip with the project (its size; « purgée » once the caps
 *       took it, D49; « zip non conservé » when the server refused it — the
 *       refusal said under the list, `version-refused`, with « Réessayer »
 *       for the latest), the count against the cap, and « Figer en version »
 *       (`version-snapshot`, D38 d): enabled only while retouches stand
 *       after the last version, disabled with its reason otherwise. Each
 *       frozen version can be read and reopened (WP10, D50): « Diff v0 →
 *       vN » (`version-diff`: the explorer's comparison of the two frozen
 *       versions, `version-diff-view`), its coherence report
 *       (`version-coherence`, read from its zip) and « Rouvrir vN comme
 *       copie de travail » (`version-restore`: the version's zip becomes
 *       this tab's working copy, journaled — the version stays frozen;
 *       confirmed first while retouches stand that no version holds)
 *
 * The flow passes each section (the Network Studio or the Change Studio):
 * this page lays them out, numbered, with their headings — in the Network
 * Studio as a StudioSheet: the acts in sequence (accept, build or apply,
 * the deliverables) as the work, the project's versions beside them. `note` is the
 * flow's summary note of its version, packed with « Tout le paquet ».
 */

import React, { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, CircularProgress, Dialog, DialogContent, DialogTitle, IconButton, Typography, alpha, useTheme } from "@mui/material";
import AcUnitOutlinedIcon from "@mui/icons-material/AcUnitOutlined";
import CompareArrowsIcon from "@mui/icons-material/CompareArrows";
import RestoreOutlinedIcon from "@mui/icons-material/RestoreOutlined";
import TableViewOutlinedIcon from "@mui/icons-material/TableViewOutlined";
import CloseIcon from "@mui/icons-material/Close";
import { useLanguage } from "../../contexts/LanguageContext";
import { useFeatures } from "../../utils/featuresApi";
import { formatDateTime, formatNumber } from "../../utils/formatDate";
import { humanError } from "../../utils/humanError";
import { latestVersionOf, remoteEnabled, retryFreeze, snapshotNow, useCurrentProject } from "../../utils/projectStore";
import { can, fetchVersionCoherence, fetchVersionDiff, isFrozen, referenceOf } from "../../utils/deliverablesApi";
import { contractClauses } from "../../utils/coherenceApi";
import RefusalNotice from "../common/RefusalNotice";
import CoherenceReport from "../common/CoherenceReport";
import { DiffReport } from "../diff/FeedDiffPage";
import DeliveryPackage from "./DeliveryPackage";
import StudioSheet, { KpiTiles, SheetCard } from "../studio/StudioSheet";
import { useStepActionsSlot } from "../AppShell";
import StepFrame, { useFillLayout } from "./StepFrame";

/** One act of the delivery, numbered in its sequence (the studio's card: its index, its heading, its body). */
function Section({ n = null, title, children, testid }) {
  return (
    <SheetCard index={n} title={title} testid={testid} bodySx={{ gap: 0.75 }}>
      {children}
    </SheetCard>
  );
}

// The origins a reference may have (§2.4), each said by its own key; any other value reads "origin not stated".
const SOURCES = new Set(["catalogue", "upload", "sample", "designed", "version"]);
/** Where a reference comes from, in words — never the stored value printed as it is. */
export const sourceLabel = (source, t) => t(`version.source.${SOURCES.has(source) ? source : "unknown"}`);

/** A size in megabytes with its unit in the interface's language ("1,2 Mo", "1.2 MB"). */
export const sizeLabel = (bytes, language, t) => t("size.mb", { size: formatNumber((bytes || 0) / 1024 / 1024, language, { maximumFractionDigits: 1 }) });

/** One line of the versions: "v1 construite · par Nadia Lefèvre · 28 sept. 2026, 15:02 · 0 erreur". */
export const versionLine = (v, t, language) => {
  const head =
    v.kind === "reference"
      ? t("version.reference", { source: sourceLabel(v.source, t), date: formatDateTime(v.at, language) })
      : v.kind === "snapshot"
        ? t("version.snapshotTaken", { n: v.n, reason: t(`version.snapshotReason.${["edits", "idle", "before_expiry", "manual"].includes(v.snapshot_reason) ? v.snapshot_reason : "manual"}`), time: formatDateTime(v.at, language) })
        : t(v.kind === "applied" ? "version.applied" : v.kind === "delivered" ? "version.delivered" : "version.built", { n: v.n });
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

/**
 * The server refused to freeze the latest version (the caps, its size, the rate): said in place with its
 * refusal and « Réessayer » (the freeze again, from the working copy that holds it) — never a silent
 * data-frozen="false".
 */
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

/** A dialog reading a frozen version: its diff from the reference, or its coherence report (WP10). */
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

/** The reasons the actions of a version cannot act, each said once ("v1 n'est pas gardée · …"), or null. */
export const versionActionsReason = (reasons) => {
  const distinct = [...new Set(reasons.filter(Boolean))];
  return distinct.length ? distinct.join(" · ") : null;
};

/**
 * The actions on one frozen version (D50): « Diff v0 → vN », its coherence report, « Rouvrir vN comme copie de
 * travail ». Rendered once the project is kept on the server (the zips live there); each disabled with its
 * reason when it cannot act (the zip purged, the role, no reference to compare with) — the reason written
 * under the row (`version-actions-reason`, which the disabled buttons are described by: a disabled button
 * takes no focus, and a tooltip reaches neither a screen reader nor a touch screen, §2.2, §11).
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
      const data = kind === "diff" ? await fetchVersionDiff(project.id, version.id) : await fetchVersionCoherence(project.id, version.id, { clauses: contractClauses(project.contract) });
      setReading((r) => (r && r.version.id === version.id && r.kind === kind ? { ...r, state: "done", data } : r));
    } catch (err) {
      setReading((r) => (r && r.version.id === version.id && r.kind === kind ? { ...r, state: "error", error: err } : r));
    }
  };
  // Retouches no version holds would no longer be the working copy of this tab: said, then confirmed.
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

/**
 * Under the versions: their size and count against the project's caps
 * (D49, `version-size`), and « Figer en version » (`version-snapshot`, D38 d):
 * the working copy frozen now as a snapshot — enabled while the project's
 * network is the one open here and retouches stand after the last version
 * (the page's `unfrozenEdits`, the server's count); otherwise disabled with
 * its reason (`version-snapshot-reason`): an identical zip would only count
 * against the caps and push out a version not delivered yet.
 */
export function VersionTools({ versions = [] }) {
  const { t, language } = useLanguage();
  const { features } = useFeatures();
  const current = useCurrentProject();
  const [state, setState] = useState({ busy: false, error: null });
  const project = current?.project || null;
  const workspace = features?.workspace || null;
  if (!project || !workspace?.enabled || !remoteEnabled()) return null;
  const frozen = versions.filter((v) => v.zip?.sha256 && !v.zip.purged_at);
  const bytes = frozen.reduce((sum, v) => sum + (v.zip?.bytes || 0), 0);
  const edits = Number(current?.unfrozenEdits) || 0;
  const reason = !current?.ownNetwork ? t("version.snapshotUnavailable") : edits > 0 ? null : t("version.snapshotNothing");
  const snapshot = async () => {
    setState({ busy: true, error: null });
    try {
      const out = await snapshotNow(project.id, { by: current.actor || null });
      if (out) window.dispatchEvent(new CustomEvent("gtfs:work-frozen"));
      setState({ busy: false, error: out ? null : t("version.snapshotUnavailable") });
    } catch (err) {
      setState({ busy: false, error: humanError(err, t).message });
    }
  };
  return (
    <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1, mt: 0.5 }}>
      <Typography data-testid="version-size" sx={{ fontSize: "0.74rem", color: "text.secondary", flex: 1, minWidth: 200 }}>
        {t("version.size", { size: sizeLabel(bytes, language, t), count: frozen.length, max: workspace.max_versions })}
      </Typography>
      {reason && (
        <Typography id="version-snapshot-reason" data-testid="version-snapshot-reason" sx={{ fontSize: "0.74rem", color: "text.secondary" }}>
          {reason}
        </Typography>
      )}
      <Button size="small" variant="outlined" onClick={snapshot} disabled={state.busy || Boolean(reason)} aria-describedby={reason ? "version-snapshot-reason" : undefined} startIcon={state.busy ? <CircularProgress size={14} /> : <AcUnitOutlinedIcon />} data-testid="version-snapshot" data-edits={edits} sx={{ textTransform: "none", fontWeight: 700 }}>
        {t("version.snapshot")}
      </Button>
      {state.error && (
        <Typography data-testid="version-snapshot-error" sx={{ fontSize: "0.74rem", color: "warning.dark", width: "100%" }}>
          {state.error}
        </Typography>
      )}
    </Box>
  );
}

export default function StepDelivery({ job = "create", tiles = null, checks = null, checksOpen = false, prerequisite = null, accept = null, act, deliverables = null, versions = [], nextVersion = 1, primary, back, footer = null, notice = null, note = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const fill = useFillLayout();
  const inBar = Boolean(useStepActionsSlot()) && fill;
  const intro = t(job === "modify" ? "delivery.title.modify" : "delivery.title.create");
  // The fold of the checks: opened by the flow when something holds the act (`checksOpen`), never closed by it — the
  // person folds and unfolds as they please once it is open (a React-controlled `open` would shut it under them when
  // the validator passes).
  const foldRef = useRef(null);
  useEffect(() => {
    if (checksOpen && foldRef.current) foldRef.current.open = true;
  }, [checksOpen]);
  // The sections are numbered as they come: what is accepted (when asked), the act, the checks (modifying, folded
  // under the decision), the deliverables.
  let n = 0;
  const next = () => (n += 1);
  const acceptN = accept !== undefined && accept !== false ? next() : null;
  const actN = next();
  const checksN = checks ? next() : null;
  const deliverablesN = next();
  return (
    <StepFrame step={5} job={job} title={null} intro={intro} notice={notice} primary={primary} back={back} footer={footer} testid="step-delivery" headless>
      <StudioSheet
        testid="delivery-sheet"
        lead={inBar ? intro : null}
        tiles={tiles ? <KpiTiles tiles={tiles.filter(Boolean)} testid="checks-summary" /> : null}
        aside={
          <Section title={t("version.list")} testid="delivery-versions">
            <VersionList versions={versions} />
            <VersionTools versions={versions} />
          </Section>
        }
      >
        {prerequisite && (
          <Box data-testid="delivery-prerequisite" sx={{ p: 1, borderRadius: "10px", background: alpha(theme.palette.info.main, 0.06), fontSize: "0.8rem" }}>
            {prerequisite}
          </Box>
        )}
        {acceptN && (
          <Section n={acceptN} title={t("ack.title")} testid="delivery-accept">
            {accept || <Typography sx={{ fontSize: "0.8rem", color: "text.secondary" }} data-testid="delivery-accept-none">{t("ack.none")}</Typography>}
          </Section>
        )}
        <Section n={actN} title={t(job === "modify" ? "step.delivery.apply" : "step.delivery.build", { n: nextVersion })} testid="delivery-act">
          {act}
        </Section>
        {/* The checks in full, folded under the decision (the indicators above say their outcome): open by the flow
            while something holds the act, by the person otherwise. */}
        {checks && (
          <Section n={checksN} title={t("step.delivery.checks")} testid="delivery-checks">
            <Box component="details" ref={foldRef} data-testid="delivery-checks-fold" data-open={checksOpen ? "true" : "false"} sx={{ "& > summary": { cursor: "pointer", fontSize: "0.8rem", fontWeight: 600, color: "text.secondary", listStyle: "revert" } }}>
              <Box component="summary" data-testid="delivery-checks-toggle">
                {t("step.delivery.checksFold")}
              </Box>
              <Box sx={{ pt: 1 }}>{checks}</Box>
            </Box>
          </Section>
        )}
        <Section n={deliverablesN} title={t("step.delivery.deliverables")} testid="delivery-deliverables">
          {deliverables}
          <DeliveryPackage note={note} />
        </Section>
      </StudioSheet>
    </StepFrame>
  );
}
