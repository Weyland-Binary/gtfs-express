/**
 * DeliveryPackage — the end of ⑤: « Tout le paquet », its manifest, « Marquer
 * livrée », the share link and, with accounts, the approval.
 *
 * Under the flow's own deliverables (the GTFS, the note, the coherence
 * report of the version just built or applied), this block delivers the
 * project's version as ONE package the server builds from the version's
 * frozen zip — validated there by the canonical validator (G1) — with a
 * `manifest.json` that names the network, the version, the author, the
 * date, the validator's engine and the fingerprint of its report, the
 * acknowledgements the version stands on and the SHA-256 of every file
 * (`delivery-manifest`, listed once the package is built), and what the
 * person decided on a change (`delivery-decision`: the review's account or the
 * modification by hand, accepted under a name). The person who
 * delivers is named (`delivery-by`, the name this browser remembers or the
 * account's). « Tout le paquet » is `deliver` (the preflight's `export-confirm`
 * stays the explorer's « Livrer », its alias); « Marquer livrée »
 * (`delivery-mark`) records the delivery on the server — the package's files
 * and its manifest's fingerprint — and protects the version from the purge.
 *
 * The share link (`delivery-share`): the explorer's ShareButton, for the
 * network open here, with « inclure les acceptations nominatives »
 * (`share-include-names`, unticked: the names are removed when the share is
 * created).
 *
 * The approval (`approval-panel`, accounts only): the caller's role,
 * the version's status and its last review; « Soumettre à l'approbation »
 * (`approval-submit`, contributor), « Approuver » / « Refuser »
 * (`approval-approve`, `approval-reject`, approver; a rejection says why,
 * `approval-comment`), named; the members of the project and the form that
 * shares it (`approval-members`). A shared project's version is delivered
 * only approved: « Tout le paquet » and « Marquer livrée » say so while it
 * is not. Every button is rendered, disabled with its reason when it cannot
 * act — never hidden.
 *
 * An approval decided elsewhere (another approver, another tab) reaches this
 * one: the project is read again when the tab comes back (focus, shown
 * again) and every minute while a version awaits its approval; a refusal
 * that says the project moved (INVALID_TRANSITION, ROLE_REQUIRED,
 * NOT_APPROVED) reads it again at once and offers « Recharger » — or
 * « Soumettre à l'approbation » — in place, never a dead end.
 *
 * What the package asks to accept: the
 * errors the reference feed already carried (409 BASELINE_ERRORS) and the
 * edits by hand after the last build or application (409
 * OPEN_ITEMS_UNACCEPTED, kind "retouched") are ticked here under the
 * delivering person's name (`delivery-accept-*`) and sent with the next
 * « Tout le paquet »; anything else left open goes back to the Studio (the
 * refusal says what). The version's proof (`delivery-proof`: the gates it
 * passed, the validator, what stays open and accepted) is said before the
 * package. « Marquer livrée » marks the package built here (409
 * PACKAGE_REQUIRED otherwise): disabled, with its reason, until it is.
 *
 * The note: packed when the flow that made the version can write it here;
 * otherwise `delivery-note-missing` says why before the package is built
 * (the version is a retouch no note describes, or the flow is not open in
 * this browser), and the manifest records it (`note.included: false`).
 */

import React, { useEffect, useState } from "react";
import { Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel, MenuItem, TextField, Typography, alpha, useTheme } from "@mui/material";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import TaskAltOutlinedIcon from "@mui/icons-material/TaskAltOutlined";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useAccount } from "../../contexts/AccountContext";
import { formatDateTime, formatNumber } from "../../utils/formatDate";
import { adoptServerProject, flushProject, refreshProject, remoteEnabled, syncOf, useCurrentProject } from "../../utils/projectStore";
import { refusalOf } from "../../utils/refusalToAction";
import { ROLES, addMember, approvalOf, approvalRequired, buildPackage, can, deliveryTargetOf, downloadPackage, isFrozen, manifestRows, markDelivered, removeMember, reviewVersion, reviewsOf } from "../../utils/deliverablesApi";
import { NAME_OK, rememberName, rememberedName } from "../common/AcknowledgementForm";
import RefusalNotice from "../common/RefusalNotice";
import ShareButton from "../share/ShareButton";
import { openWorks } from "../../utils/works";

/** A file's size in the interface's unit: kilobytes under a megabyte, else megabytes ("12 ko", "1,4 Mo"). */
export const fileSize = (bytes, language, t) => {
  const n = Number(bytes) || 0;
  return n < 1024 * 1024 ? t("size.kb", { size: formatNumber(Math.max(1, Math.round(n / 1024)), language) }) : t("size.mb", { size: formatNumber(n / 1024 / 1024, language, { maximumFractionDigits: 1 }) });
};

// The refusals that say the project moved elsewhere (another approver decided, a role changed, the approval went):
// the project is read again at once, and the notice offers « Recharger ».
const STALE_CODES = new Set(["INVALID_TRANSITION", "ROLE_REQUIRED", "NOT_APPROVED", "VERSION_FROZEN"]);
const isStale = (err) => STALE_CODES.has(refusalOf(err).code);
// While an approval is awaited, the project is read again this often (another tab, another person decides).
export const APPROVAL_POLL_MS = 60 * 1000;

/**
 * Why the package carries no note, or null when it carries one: the version is a retouch no note describes (a
 * snapshot, a delivery from edit mode, a copy reopened) — "retouched" — or the flow that wrote it is not open here
 * (another browser, the build's working copy gone) — "unavailable". Said in place and recorded in the manifest.
 */
export const noteOmissionOf = (target, note) => {
  if (!target) return null;
  if (note && note.versionId === target.id && typeof note.build === "function") return null;
  return target.kind === "snapshot" || target.kind === "delivered" ? "retouched" : "unavailable";
};

/** Why « Tout le paquet » / « Marquer livrée » cannot act now, in words — or null. */
export const deliverReason = ({ project, target, serverKept, name, role, t }) => {
  if (!serverKept) return t("delivery.package.local");
  if (!target) return t("delivery.package.none");
  if (!can(role, "contributor")) return t("delivery.package.role");
  if (!isFrozen(target)) return t("delivery.package.notFrozen", { n: target.n });
  if (approvalRequired(project) && approvalOf(project, target.id) !== "approved") return t("delivery.package.needsApproval", { n: target.n });
  if (!NAME_OK(name)) return t("delivery.package.needsName");
  return null;
};

function Reason({ id, children }) {
  return children ? (
    <Typography id={id} data-testid={id} sx={{ fontSize: "0.74rem", color: "text.secondary" }}>
      {children}
    </Typography>
  ) : null;
}

/** The manifest of the package built: each file, its size and fingerprint; the manifest's own fingerprint. */
export function ManifestList({ built }) {
  const { t, language } = useLanguage();
  if (!built?.manifest) return null;
  const m = built.manifest;
  return (
    <Box data-testid="delivery-manifest-files" sx={{ display: "flex", flexDirection: "column", gap: 0.25, mt: 0.5 }}>
      <Typography sx={{ fontSize: "0.74rem" }}>
        {t("delivery.manifest.stamp", { network: m.network?.name || "", version: m.version?.label || "", author: m.author?.name || "", date: formatDateTime(m.generated_at, language), engine: m.validator?.engine || "—", errors: formatNumber(m.validator?.errors ?? 0, language), warnings: formatNumber(m.validator?.warnings ?? 0, language) })}
      </Typography>
      {/* The acknowledgements the version stands on: counted here (their ids are the manifest's, not prose). */}
      {(m.acknowledgements || []).length > 0 && <Typography data-testid="delivery-manifest-acks" sx={{ fontSize: "0.72rem", color: "text.secondary" }}>{t("delivery.manifest.acksCount", { count: m.acknowledgements.length })}</Typography>}
      <Box component="ul" sx={{ m: 0, pl: 2.25 }}>
        {manifestRows(m).map((f) => (
          <Typography component="li" key={f.name} data-testid="delivery-manifest-file" data-role={f.role} data-sha256={f.sha256} title={f.sha256} sx={{ fontSize: "0.72rem", fontFamily: "monospace", wordBreak: "break-all" }}>
            {f.name} · {fileSize(f.bytes, language, t)} · {t("delivery.manifest.sha", { sha: f.short })}
          </Typography>
        ))}
      </Box>
      <Typography data-testid="delivery-manifest-sha" data-sha256={built.manifest_sha256} title={built.manifest_sha256} sx={{ fontSize: "0.72rem", color: "text.secondary", fontFamily: "monospace" }}>
        manifest.json · {t("delivery.manifest.sha", { sha: built.manifest_sha256 })}
      </Typography>
    </Box>
  );
}

/** The approval of the version ⑤ delivers (accounts only). */
export function ApprovalPanel({ project, target, onProject }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const { enabled, me, openAccountDialog } = useAccount();
  const [comment, setComment] = useState("");
  const [state, setState] = useState({ busy: null, error: null });
  const [member, setMember] = useState({ email: "", role: "approver" });
  if (!enabled) return null;
  const role = project?.role || "owner";
  const attached = Boolean(project?.owner?.user_id) || project?.owner?.via === "member" || project?.owner?.via === "account";
  const status = target ? approvalOf(project, target.id) : "none";
  const last = target ? reviewsOf(project, target.id)[0] || null : null;
  const blocked = !me ? t("approval.reason.signIn") : !attached ? t("approval.reason.attach") : !target ? t("approval.reason.none") : null;
  const act = async (action) => {
    if (!target) return;
    setState({ busy: action, error: null });
    try {
      // Named by the server after the account that acts: no name is sent.
      const out = await reviewVersion(project.id, target.id, action, { comment: comment.trim() || null });
      if (out?.project) onProject(out.project);
      setComment("");
      setState({ busy: null, error: null });
    } catch (err) {
      setState({ busy: null, error: err });
      // Decided elsewhere meanwhile (another approver, another tab): the project read again shows where it stands.
      if (isStale(err)) refreshProject(project.id);
    }
  };
  const share = async () => {
    setState({ busy: "member", error: null });
    try {
      const out = await addMember(project.id, member.email.trim(), member.role);
      if (out?.project) onProject(out.project);
      setMember({ email: "", role: member.role });
      setState({ busy: null, error: null });
    } catch (err) {
      setState({ busy: null, error: err });
    }
  };
  const unshare = async (userId) => {
    setState({ busy: "member", error: null });
    try {
      const out = await removeMember(project.id, userId);
      if (out?.project) onProject(out.project);
      setState({ busy: null, error: null });
    } catch (err) {
      setState({ busy: null, error: err });
    }
  };
  const submitReason = blocked || (!can(role, "contributor") ? t("approval.reason.role", { role: t(`status.role.${role}`) }) : !["none", "rejected"].includes(status) ? t(`approval.reason.status.${status}`) : null);
  const decideReason = blocked || (!can(role, "approver") ? t("approval.reason.approver") : status !== "in_review" ? t("approval.reason.notInReview") : null);
  const rejectReason = decideReason || (!comment.trim() ? t("approval.reason.comment") : null);
  const button = (id, action, label, reason, variant = "outlined") => (
    <Button size="small" variant={variant} disableElevation onClick={() => act(action)} disabled={Boolean(reason) || Boolean(state.busy)} aria-describedby={reason ? `${id}-reason` : undefined} data-testid={id} startIcon={state.busy === action ? <CircularProgress size={12} color="inherit" /> : null} sx={{ textTransform: "none", fontWeight: 700 }}>
      {label}
    </Button>
  );
  return (
    <Box data-testid="approval-panel" data-status={status} data-role={role} sx={{ display: "flex", flexDirection: "column", gap: 0.75, p: 1.25, borderRadius: "10px", border: `1px dashed ${theme.palette.divider}`, background: alpha(theme.palette.primary.main, 0.03) }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
        <FactCheckOutlinedIcon sx={{ fontSize: 18, color: "primary.main" }} />
        <Typography component="h3" sx={{ fontSize: "0.82rem", fontWeight: 800 }}>
          {t("approval.title")}
        </Typography>
        <Typography data-testid="approval-role" sx={{ fontSize: "0.74rem", color: "text.secondary" }}>
          {t("approval.role", { role: t(`status.role.${role}`) })}
        </Typography>
      </Box>
      <Typography data-testid="approval-status" data-status={status} sx={{ fontSize: "0.78rem" }}>
        {target ? t(`approval.status.${status}`, { n: target.n }) : blocked ? null : t("approval.reason.none")}
        {last ? ` — ${t("approval.last", { name: last.by?.name || "", date: formatDateTime(last.at, language) })}${last.comment ? ` : « ${last.comment} »` : ""}` : ""}
      </Typography>
      {blocked && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
          <Reason id="approval-blocked">{blocked}</Reason>
          {!me && (
            <Button size="small" onClick={() => openAccountDialog({ tab: "signin" })} data-testid="approval-signin" sx={{ textTransform: "none", fontWeight: 700 }}>
              {t("status.user.signIn")}
            </Button>
          )}
        </Box>
      )}
      <TextField size="small" label={t("approval.comment")} value={comment} onChange={(e) => setComment(e.target.value.slice(0, 2000))} disabled={Boolean(blocked)} multiline minRows={1} inputProps={{ "data-testid": "approval-comment", maxLength: 2000 }} sx={{ maxWidth: 560 }} />
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center" }}>
        {button("approval-submit", "submit", t("approval.submit"), submitReason, "contained")}
        {button("approval-approve", "approve", t("approval.approve"), decideReason)}
        {button("approval-reject", "reject", t("approval.reject"), rejectReason)}
      </Box>
      {!blocked && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
          <Reason id="approval-submit-reason">{submitReason}</Reason>
          {submitReason !== decideReason && <Reason id="approval-approve-reason">{decideReason}</Reason>}
          {rejectReason !== decideReason && <Reason id="approval-reject-reason">{rejectReason}</Reason>}
        </Box>
      )}
      {state.error && (
        <RefusalNotice
          refusal={state.error}
          testid="approval-refusal"
          onAction={(id) => {
            if (id === "signIn") openAccountDialog({ tab: "signin" });
            else if (id === "myWork") openWorks();
            else if (id === "reload") refreshProject(project.id).then(() => setState({ busy: null, error: null }));
            else if (id === "submitApproval") act("submit");
          }}
          supported={["signIn", "myWork", "reload", "submitApproval"]}
        />
      )}
      {attached && me && (
        <Box data-testid="approval-members" sx={{ display: "flex", flexDirection: "column", gap: 0.5, mt: 0.5 }}>
          <Typography sx={{ fontSize: "0.76rem", fontWeight: 700 }}>{t("approval.members")}</Typography>
          {(project.members || []).length === 0 && <Typography sx={{ fontSize: "0.74rem", color: "text.secondary" }}>{t("approval.members.none")}</Typography>}
          {(project.members || []).map((m) => (
            <Box key={m.user_id} data-testid="approval-member" data-role={m.role} sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
              <Typography sx={{ fontSize: "0.76rem" }}>
                {m.name || m.email} · {t(`status.role.${m.role}`)}
              </Typography>
              {can(role, "approver") && (
                <Button size="small" onClick={() => unshare(m.user_id)} disabled={Boolean(state.busy)} data-testid="approval-member-remove" sx={{ textTransform: "none", minWidth: 0 }}>
                  {t("approval.members.remove")}
                </Button>
              )}
            </Box>
          ))}
          {can(role, "approver") && (
            <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center" }}>
              <TextField size="small" type="email" label={t("approval.members.email")} value={member.email} onChange={(e) => setMember((x) => ({ ...x, email: e.target.value }))} inputProps={{ "data-testid": "approval-member-email" }} sx={{ minWidth: 220 }} />
              <TextField size="small" select label={t("approval.members.role")} value={member.role} onChange={(e) => setMember((x) => ({ ...x, role: e.target.value }))} SelectProps={{ inputProps: { "data-testid": "approval-member-role" } }} sx={{ minWidth: 160 }}>
                {ROLES.map((r) => (
                  <MenuItem key={r} value={r}>
                    {t(`status.role.${r}`)}
                  </MenuItem>
                ))}
              </TextField>
              <Button size="small" variant="outlined" onClick={share} disabled={!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(member.email.trim()) || Boolean(state.busy)} data-testid="approval-member-add" sx={{ textTransform: "none", fontWeight: 700 }}>
                {t("approval.members.add")}
              </Button>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

/**
 * « Tout le paquet », « Marquer livrée », the share link and the approval of
 * the version ⑤ delivers (see the header). `note`: the flow's summary note
 * of its version ({ versionId, build: () => ({ content }) }), packed when the
 * version delivered is that one.
 */
export default function DeliveryPackage({ note = null }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const { me } = useAccount();
  const current = useCurrentProject();
  const project = current?.project || null;
  const [name, setName] = useState(() => rememberedName() || me?.display_name || "");
  const [state, setState] = useState({ busy: null, error: null, built: null, saved: null });
  // What the person delivering accepts under their name, asked by the package's refusals (and ticked here).
  const [accept, setAccept] = useState({ baseline_errors: false, retouched: false });
  const [asked, setAsked] = useState({ baseline: null, retouched: null }); // { errors, rules } · { edits }
  // The account's name once it is known (signed in after the page opened); never over what the person typed.
  useEffect(() => {
    if (me?.display_name) setName((n) => n || me.display_name);
  }, [me]);
  const projectId = project?.id || null;
  const awaiting = Boolean(project && approvalRequired(project) && deliveryTargetOf(project) && approvalOf(project, deliveryTargetOf(project).id) !== "approved");
  // An approval happens in another tab or another browser: the project is read again when the person comes back to
  // this one (focus, the tab shown again) and, while a version awaits its approval, every minute.
  useEffect(() => {
    if (!projectId || !remoteEnabled()) return undefined;
    const again = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      // A write of this tab on its way: its answer brings the server's fields (the approval) — never read over it.
      const meta = syncOf(projectId);
      if (meta?.dirty || meta?.state === "saving" || meta?.state === "conflict") return;
      refreshProject(projectId);
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    const timer = awaiting ? setInterval(again, APPROVAL_POLL_MS) : null;
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
      if (timer) clearInterval(timer);
    };
  }, [projectId, awaiting]);
  if (!project) return null;
  const serverKept = remoteEnabled();
  const target = deliveryTargetOf(project);
  const role = project.role || "owner";
  const reason = deliverReason({ project, target, serverKept, name, role, t });
  const noteOmitted = noteOmissionOf(target, note);
  const built = state.built && state.built.package?.version_id === target?.id ? state.built : null;
  const delivered = target?.delivered_at || target?.delivered ? target : null;
  const adopt = (server) => {
    if (server) adoptServerProject(server);
  };

  const deliver = async () => {
    if (reason || !target) return;
    rememberName(name);
    setState((s) => ({ ...s, busy: "deliver", error: null }));
    try {
      const pack = noteOmitted ? null : note.build();
      const out = await buildPackage(project.id, target.id, { by: name.trim(), lang: language, note: pack, noteOmitted: pack?.content ? null : noteOmitted || "unavailable", ...(accept.baseline_errors || accept.retouched ? { accept } : {}) });
      const saved = await downloadPackage(project.id, out.package);
      setState({ busy: null, error: null, built: out, saved });
    } catch (err) {
      setState((s) => ({ ...s, busy: null, error: err }));
      // What the refusal asks to accept is offered in place, unticked: the person ticks it, then builds again.
      const r = refusalOf(err);
      if (r.code === "BASELINE_ERRORS") setAsked((a) => ({ ...a, baseline: { errors: r.details?.errors ?? 0, rules: r.details?.rules || {} } }));
      if (r.code === "OPEN_ITEMS_UNACCEPTED") {
        const retouched = (r.details?.items || []).find((i) => i && i.kind === "retouched");
        if (retouched) setAsked((a) => ({ ...a, retouched: { edits: retouched.edits ?? 0 } }));
      }
      if (isStale(err)) refreshProject(project.id);
    }
  };
  // The open items the package still refuses once the acceptable ones are ticked: back to the Studio.
  const refusedItems = (() => {
    const r = state.error ? refusalOf(state.error) : null;
    return r?.code === "OPEN_ITEMS_UNACCEPTED" ? (r.details?.items || []).filter((i) => i && i.kind !== "retouched") : [];
  })();
  const markReason = reason || (built ? null : t("delivery.mark.needsPackage"));
  // « Soumettre à l'approbation » from a package refused NOT_APPROVED: the approval panel, its submit button.
  const toApproval = () => {
    const panel = typeof document !== "undefined" ? document.querySelector('[data-testid="approval-panel"]') : null;
    panel?.scrollIntoView?.({ block: "center" });
    const submit = panel?.querySelector('[data-testid="approval-submit"]');
    if (submit && !submit.disabled) submit.focus();
  };
  const onRefusalAction = (id) => {
    if (id === "retry") deliver();
    else if (id === "reload") refreshProject(project.id).then(() => setState((s) => ({ ...s, error: null })));
    else if (id === "submitApproval") toApproval();
  };
  const mark = async () => {
    if (markReason || !target) return;
    rememberName(name);
    setState((s) => ({ ...s, busy: "mark", error: null }));
    try {
      await flushProject(project.id);
      const out = await markDelivered(project.id, target.id, { by: name.trim(), packageId: built?.package?.id || null });
      adopt(out?.project);
      setState((s) => ({ ...s, busy: null, error: null }));
    } catch (err) {
      setState((s) => ({ ...s, busy: null, error: err }));
      if (isStale(err)) refreshProject(project.id);
    }
  };

  return (
    <Box data-testid="delivery-package" data-version={target?.n ?? ""} sx={{ display: "flex", flexDirection: "column", gap: 1, mt: 1, pt: 1, borderTop: `1px solid ${theme.palette.divider}` }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
        <Inventory2OutlinedIcon sx={{ fontSize: 18, color: "primary.main" }} />
        <Typography component="h3" sx={{ fontSize: "0.84rem", fontWeight: 800 }}>
          {target ? t("delivery.package.title", { n: target.n }) : t("delivery.package")}
        </Typography>
      </Box>
      <Box data-testid="delivery-manifest" data-built={built ? "true" : "false"} sx={{ px: 1, py: 0.75, borderRadius: "8px", background: alpha(theme.palette.info.main, 0.05) }}>
        <Typography sx={{ fontSize: "0.76rem" }}>{t("delivery.manifest")}</Typography>
        {noteOmitted && (
          <Typography data-testid="delivery-note-missing" data-reason={noteOmitted} sx={{ fontSize: "0.74rem", color: "text.secondary" }}>
            {t("delivery.note.missing", { reason: t(`delivery.note.reason.${noteOmitted}`, { n: target.n }) })}
          </Typography>
        )}
        <ManifestList built={built} />
      </Box>
      {target?.proof && (
        // What the version stands on, as the server keeps it (deliveryProof.summaryOf: counts, no name).
        <Typography data-testid="delivery-proof" data-unaccepted={target.proof.unaccepted ?? 0} sx={{ fontSize: "0.74rem", color: target.proof.unaccepted ? "warning.dark" : "text.secondary" }}>
          {t("delivery.proof.summary", { gates: (target.proof.gates || []).length, errors: formatNumber(target.proof.validator?.errors ?? 0, language), warnings: formatNumber(target.proof.validator?.warnings ?? 0, language), open: target.proof.open_items ?? 0, unaccepted: target.proof.unaccepted ?? 0, edits: target.proof.retouched_edits ?? 0 })}
        </Typography>
      )}
      {/* What the person decided on a change, as the server recorded it with the version (its manifest says who). */}
      {["direct", "hand"].includes(target?.proof?.decision) && (
        <Typography data-testid="delivery-decision" data-kind={target.proof.decision} sx={{ fontSize: "0.74rem", color: "text.secondary" }}>
          {t(target.proof.decision === "direct" ? "delivery.proof.decision.direct" : "delivery.proof.decision.hand")}
        </Typography>
      )}
      {(asked.baseline || asked.retouched) && (
        <Box data-testid="delivery-accept" sx={{ display: "flex", flexDirection: "column", gap: 0.25, px: 1, py: 0.75, borderRadius: "8px", background: alpha(theme.palette.warning.main, theme.palette.mode === "dark" ? 0.12 : 0.06), border: `1px solid ${alpha(theme.palette.warning.main, 0.3)}` }}>
          <Typography sx={{ fontSize: "0.78rem", fontWeight: 700 }}>{t("delivery.accept.title")}</Typography>
          {asked.baseline && (
            <FormControlLabel
              sx={{ m: 0, alignItems: "flex-start", "& .MuiFormControlLabel-label": { fontSize: "0.76rem", lineHeight: 1.5, pt: 0.9 } }}
              control={<Checkbox size="small" checked={accept.baseline_errors} onChange={(e) => setAccept((a) => ({ ...a, baseline_errors: e.target.checked }))} inputProps={{ "data-testid": "delivery-accept-baseline" }} />}
              label={t("ack.baselineErrors", { count: asked.baseline.errors, rules: Object.entries(asked.baseline.rules || {}).map(([code, n]) => `${code} ×${n}`).join(", ") || "—" })}
            />
          )}
          {asked.retouched && (
            <FormControlLabel
              sx={{ m: 0, alignItems: "flex-start", "& .MuiFormControlLabel-label": { fontSize: "0.76rem", lineHeight: 1.5, pt: 0.9 } }}
              control={<Checkbox size="small" checked={accept.retouched} onChange={(e) => setAccept((a) => ({ ...a, retouched: e.target.checked }))} inputProps={{ "data-testid": "delivery-accept-retouched" }} />}
              label={t("delivery.accept.retouched", { count: asked.retouched.edits })}
            />
          )}
          <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }}>{t("delivery.accept.byName", { name: name.trim() || "—" })}</Typography>
        </Box>
      )}
      <ApprovalPanel project={project} target={target} onProject={adopt} />
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        <TextField size="small" label={t("delivery.by")} value={name} onChange={(e) => setName(e.target.value.slice(0, 120))} inputProps={{ "data-testid": "delivery-by", maxLength: 120, autoComplete: "name" }} sx={{ flex: "1 1 220px", maxWidth: 360 }} />
        <Button size="small" variant="contained" disableElevation onClick={deliver} disabled={Boolean(reason) || Boolean(state.busy)} aria-describedby={reason ? "delivery-package-reason" : undefined} startIcon={state.busy === "deliver" ? <CircularProgress size={12} color="inherit" /> : <Inventory2OutlinedIcon />} data-testid="deliver" sx={{ textTransform: "none", fontWeight: 800 }}>
          {t("delivery.package.go")}
        </Button>
        <Button size="small" variant="outlined" onClick={mark} disabled={Boolean(markReason) || Boolean(state.busy)} aria-describedby={markReason ? (reason ? "delivery-package-reason" : "delivery-mark-reason") : undefined} startIcon={state.busy === "mark" ? <CircularProgress size={12} color="inherit" /> : <TaskAltOutlinedIcon />} data-testid="delivery-mark" sx={{ textTransform: "none", fontWeight: 700 }}>
          {t("delivery.markDelivered")}
        </Button>
      </Box>
      <Reason id="delivery-package-reason">{reason}</Reason>
      {!reason && <Reason id="delivery-mark-reason">{markReason}</Reason>}
      {state.busy === "deliver" && <Typography data-testid="delivery-package-running" role="status" sx={{ fontSize: "0.74rem", color: "text.secondary" }}>{t("delivery.package.running")}</Typography>}
      {state.saved && built && <Typography data-testid="delivery-package-done" sx={{ fontSize: "0.76rem", color: "success.dark" }}>{t("delivery.package.done", { name: state.saved.name })}</Typography>}
      {delivered && (
        <Alert severity="success" data-testid="delivery-marked" data-version={delivered.n} sx={{ fontSize: "0.78rem", py: 0 }}>
          {t("delivery.marked", { n: delivered.n, name: delivered.delivered_by || project.delivery?.by || "", date: formatDateTime(delivered.delivered_at || project.delivery?.at, language) })}
        </Alert>
      )}
      {state.error && <RefusalNotice refusal={state.error} testid="delivery-package-refusal" onAction={onRefusalAction} supported={["retry", "reload", "submitApproval"]} />}
      {refusedItems.length > 0 && (
        <Typography data-testid="delivery-open-items" sx={{ fontSize: "0.74rem", color: "warning.dark" }}>
          {/* Each open item by its words (the clause's text, the brief's quote), else by what its kind is — never « clause c-12 ». */}
          {t("delivery.accept.backToStudio", { items: refusedItems.map((i) => i.text || i.quote || t(`delivery.accept.item.${["baseline_errors", "retouched", "changes_not_asked", "clause", "assumption"].includes(i.kind) ? i.kind : "clause"}`)).join(", ") })}
        </Typography>
      )}
      <Box data-testid="delivery-share" sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        <Typography sx={{ fontSize: "0.8rem", fontWeight: 700 }}>{t("delivery.share")}</Typography>
        <Typography sx={{ fontSize: "0.74rem", color: "text.secondary", flex: 1, minWidth: 200 }}>{current?.ownNetwork ? t("delivery.share.hint") : t("delivery.share.unavailable")}</Typography>
        {current?.ownNetwork && <ShareButton onShared={(share) => current.update?.((p) => ({ ...p, delivery: { ...(p.delivery || {}), share: { token: share.token, expires_at: share.expiresAt || null, includes_names: Boolean(share.includesNames) } } }))} />}
      </Box>
    </Box>
  );
}
