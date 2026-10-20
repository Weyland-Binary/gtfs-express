/**
 * ApplyDialog — writing a previewed change plan into the working copy, under
 * a person's name.
 *
 * Despite its name, the component is the "apply" section of the draft's
 * decision (ChangeStudio → DecisionScreen), rendered in place with the
 * decision around it (`change-apply-dialog` on the section,
 * `change-apply-confirm` on its act). `open` says the section is shown;
 * "Back to the change" (`onClose`) closes the decision. The decision's keys
 * drive the same act (`controlRef.current.apply()`), and `onState` tells the
 * host whether it can act and why not. `beforeCommit(preview)` is
 * awaited right before the commit, which consumes the simulation: the host
 * reads what it keeps of it (the coherence report); its failure never stops
 * the act. `onApplied(answer, simulation)` hands the commit's answer with
 * the simulation it replayed — simulated again on the working copy when
 * edit mode was entered here — so the host keeps that one, never its own.
 *
 * It follows the preview's gate (transform/engine.gateOf, read by ./gate):
 * what BLOCKS is listed and "Apply" stays off — a step waiting for an
 * answer, a plan that would break the feed's integrity, no canonical
 * validator on this server, new errors of the validator (never acceptable:
 * they are fixed in the change). What may be ACCEPTED is the
 * AcknowledgementForm: one item per must clause of the plan not met or not
 * measurable, one for the unverified sources, one for the errors the
 * reference GTFS already carried (baseline_errors: never accepted silently),
 * one for the changes no clause of the plan asks for, the person's name and a
 * note — and "Apply" sends exactly the server's acknowledgement body to POST
 * /transform/commit: `{ by: { name }, clauses, sources?, baseline_errors?,
 * changes?, note? }`. A change made by hand (`hand`) is the person's own act:
 * applied under their name whatever the gate lists, `hand: true` in the body
 * (its name asked here when nothing else is to accept). Nothing is accepted
 * anonymously: an unnamed acknowledgement is refused here the way the server
 * refuses it (400 ACKNOWLEDGEMENT_UNNAMED), the focus on the name.
 *
 * Applying enters edit mode when needed and simulates again on the working
 * copy (the acknowledgement follows the same ids; anything new the server
 * asks for comes back as a 409 with its items highlighted). The server's
 * refusals are rendered in place by RefusalNotice (refusalToAction, with
 * its default branch): 409 CLAUSES_FAILING / CLAUSES_UNKNOWN /
 * SOURCES_UNVERIFIED / BASELINE_ERRORS / CHANGES_NOT_ASKED open and highlight
 * the items still to accept and focus the first; 409 VALIDATION_NEW_ERRORS
 * lists the rules (before → after) and leads back to the change; under the
 * paid offer a refused
 * entry into edit mode (402 / 401 `paid`) opens the offer by itself
 * (`paywall`), nothing more is said here; 503 VALIDATOR_* block with
 * "Try again"; 409 SESSION_NOT_IN_EDIT_MODE ("Edit") enters edit
 * mode again and simulates again, whatever the `editing` prop believes; a
 * failure to enter edit mode keeps the server's code and status. One undo
 * reverts the whole plan.
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, Button, LinearProgress, TextField, Typography, alpha, useTheme } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import { useAccount } from "../../contexts/AccountContext";
import { commitChangePlan } from "../../utils/transformApi";
import { refusalOf } from "../../utils/refusalToAction";
import { requestAccessLink, useFeatures } from "../../utils/featuresApi";
import { soft } from "../network/StudioUI";
import { opTitle, tf } from "./catalogueText";
import { ImpactStrip } from "./ChangePlanParts";
import { blockedSteps, gateIntegrity, gateNewErrors, gateOf, gateValidatorOff } from "./gate";
import AcknowledgementForm, { NAME_OK, allTicked, bodyOf, itemsFromRefusal, itemsOf, mergeItems, missingKeys, rememberName, rememberedName } from "../common/AcknowledgementForm";
import RefusalNotice from "../common/RefusalNotice";

const ACK_CODES = new Set(["CLAUSES_FAILING", "CLAUSES_UNKNOWN", "SOURCES_UNVERIFIED", "BASELINE_ERRORS", "CHANGES_NOT_ASKED"]);
// The actions a refusal may offer here (RefusalNotice shows only these, plus "copy").
const SUPPORTED = ["retry", "focusName", "focusItems", "backToChange", "answer", "editOperation", "resimulate", "enterEdit", "notifyAdmin", "requestAccess"];

/** The preview's gate with what the server said at commit (409 details) folded in. */
const mergeGate = (gate, extra) => {
  if (!gate) return null;
  let { blocking } = gate;
  if (extra.integrity) blocking = [...blocking.filter((x) => x.code !== "integrity"), { code: "integrity", integrity: extra.integrity }];
  if (extra.new_errors) blocking = [...blocking.filter((x) => x.code !== "validation_new_errors"), { code: "validation_new_errors", new_errors: extra.new_errors }];
  return { ...gate, blocking };
};

// `compact`: inside the draft's decision, which says the change, its impact and the validator itself. `hand`: a change
// made by hand, applied on the person's named act (`hand: true`). `commit`: how the simulation is applied (a draft by
// hand: its own route, transformApi.applyDraft, which writes the working copy itself — no edit mode to enter here).
export default function ApplyDialog({ compact = false, hand = false, open, onClose, preview, plan, catalogue = [], editing, enterEditMode, refresh, onApplied, onNavigate, controlRef = null, onState = null, beforeCommit = null, commit = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const { me } = useAccount();
  const { features } = useFeatures();
  const [ack, setAck] = useState({ checked: [], name: "", note: "" });
  const [extraItems, setExtraItems] = useState([]);
  const [highlight, setHighlight] = useState([]);
  const [nameInvalid, setNameInvalid] = useState(false);
  const [extra, setExtra] = useState({});
  const [phase, setPhase] = useState(null); // entering | previewing | committing
  const [refusal, setRefusal] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef(null);
  const formRef = useRef(null);
  const handNameRef = useRef(null);
  const previewId = preview?.id || null;

  useEffect(() => {
    if (!open) return;
    setAck({ checked: [], name: rememberedName() || me?.display_name || "", note: "" });
    setExtraItems([]);
    setHighlight([]);
    setNameInvalid(false);
    setExtra({});
    setRefusal(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // A new simulation (after a stale preview, or on the working copy) comes with its own gate: what an
  // earlier 409 added or highlighted belongs to the previous one (the server asks again if still due).
  useEffect(() => {
    setExtra({});
    setExtraItems([]);
    setHighlight([]);
  }, [previewId]);
  useEffect(() => {
    if (phase === "committing") {
      const started = Date.now();
      setElapsed(0);
      timer.current = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    }
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [phase]);
  // The focus the refusal asks for: the name (400), the first item still to accept (409).
  useEffect(() => {
    if (!refusal) return;
    if (refusal.code === "ACKNOWLEDGEMENT_UNNAMED") setTimeout(() => focusName(), 0);
    // The refusal leads; the field it focuses is the one shown then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refusal]);

  const gate = mergeGate(gateOf(preview), extra);
  const items = mergeItems(itemsOf(gate), extraItems);
  const stuck = blockedSteps(preview);
  const integrity = gateIntegrity(gate, preview);
  const newErrors = gateNewErrors(gate);
  const validatorOff = gateValidatorOff(gate);
  const blocking = Boolean(gate && gate.blocking.length);
  const busy = Boolean(phase);
  const canApply = Boolean(previewId) && !blocking && allTicked(items, ack) && !busy;
  const opNumber = (id) => {
    const i = (plan?.operations || []).findIndex((o) => o.id === id);
    return i >= 0 ? String(i + 1) : null;
  };
  const stepTitle = (s) => {
    const op = (plan?.operations || []).find((o) => o.id === s.id);
    return opTitle(t, s.type || op?.type, catalogue.find((c) => c.type === (s.type || op?.type)));
  };
  const requestUrl = features?.access?.request_access_url || features?.request_access_url || null;
  // The name: the form's when it lists items, else the hand act's own field.
  const focusName = () => (items.length ? formRef.current?.focusName() : handNameRef.current?.focus());
  // The body sent: what is ticked, and by hand the person's act under their name, items or none.
  const bodyFor = (list) => {
    const body = bodyOf(list, ack);
    return hand ? { ...(body || { by: { name: String(ack.name || "").trim() }, clauses: [] }), hand: true } : body;
  };

  const fail = (err) => {
    const r = refusalOf(err);
    const d = r.details || {};
    if (ACK_CODES.has(r.code)) {
      const keys = missingKeys(r.code, d);
      setExtraItems((x) => mergeItems(x, itemsFromRefusal(r.code, d)));
      setAck((a) => ({ ...a, checked: a.checked.filter((k) => !keys.includes(k)) }));
      setHighlight(keys);
      setTimeout(() => formRef.current?.focusItems(keys), 0);
    } else if (r.code === "ACKNOWLEDGEMENT_UNNAMED") setNameInvalid(true);
    else if (r.code === "VALIDATION_NEW_ERRORS") setExtra((x) => ({ ...x, new_errors: Array.isArray(d.new_errors) ? d.new_errors : newErrors, preexisting: Number(d.preexisting) || 0 }));
    else if (r.code === "INTEGRITY_FAILED") setExtra((x) => ({ ...x, integrity: Array.isArray(d.integrity) ? d.integrity : integrity }));
    setRefusal(r);
    if (r.code === "PREVIEW_STALE" || r.code === "PREVIEW_NOT_FOUND") return refresh(plan);
    return null;
  };

  /**
   * `forceEnter`: the server says it is not in edit mode (409 SESSION_NOT_IN_EDIT_MODE) whatever the
   * `editing` prop believes — enter it again and simulate again, never re-send the same commit.
   */
  const apply = async ({ forceEnter = false } = {}) => {
    if (!previewId || blocking || busy || !allTicked(items, ack)) return;
    setRefusal(null);
    setHighlight([]);
    const draft = bodyFor(items);
    // Nothing is accepted anonymously: the server's rule, said before anything is sent.
    if (draft && !NAME_OK(draft.by.name)) {
      setNameInvalid(true);
      setRefusal({ code: "ACKNOWLEDGEMENT_UNNAMED", status: 400, message: "", details: { required: ["by.name"] } });
      return;
    }
    setNameInvalid(false);
    let p = preview;
    try {
      if (!commit && (forceEnter || !editing)) {
        setPhase("entering");
        // The refusal is rendered here (RefusalNotice), not in a snackbar; the paid offer's opens the offer by itself.
        const result = await enterEditMode({ quiet: true, overrideHold: true });
        if (!result?.ok) {
          if (!result?.paywall) setRefusal(result?.body ? refusalOf(result.body, result.status ?? null) : refusalOf({ error: result?.errorCode || null, message: result?.message || "" }, result?.status ?? null));
          return;
        }
      }
      if (!commit && (forceEnter || !editing)) {
        // Entering edit mode may rebuild the working copy: simulate again on it.
        setPhase("previewing");
        const again = await refresh(plan);
        if (!again?.id) {
          setRefusal({ code: "PREVIEW_STALE", status: 409, message: "", details: {} });
          return;
        }
        p = again;
      }
      setPhase("committing");
      // What the host reads on the simulation before the commit consumes it (the coherence report it keeps); never a refusal.
      if (beforeCommit) await Promise.resolve(beforeCommit(p)).catch(() => null);
      // The same acceptance on the fresh simulation (same ids); anything new is asked by the server (409).
      const body = p === preview ? draft : bodyFor(mergeItems(itemsOf(gateOf(p)), extraItems));
      const out = await (commit || commitChangePlan)(p.id, { acknowledge: body });
      if (body) rememberName(body.by.name);
      // The simulation committed goes with the answer: the host keeps that one (its note, its verdict), not its own.
      onApplied?.(out, p);
    } catch (err) {
      await fail(err);
    } finally {
      setPhase(null);
    }
  };

  // The step's primary action drives the same act; the step learns whether it can act.
  if (controlRef) controlRef.current = { apply: () => apply() };
  const stateSignature = `${canApply}|${busy}|${blocking}|${items.length}`;
  useEffect(() => {
    // `items`: how many things the person accepts under their name here (the delivery's indicator counts them).
    onState?.({ canApply, busy, blocking, toAccept: items.length > 0 && !allTicked(items, ack), items: items.length });
    // The signature says when the state changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateSignature, onState]);

  const onAction = (id) => {
    const go = (where) => {
      onNavigate?.(where);
      onClose();
    };
    if (id === "focusName") focusName();
    else if (id === "focusItems") formRef.current?.focusItems(highlight);
    else if (id === "backToChange" || id === "answer") go("plan");
    else if (id === "editOperation") go("checks");
    else if (id === "resimulate") refresh(plan);
    else if (id === "enterEdit") apply({ forceEnter: true });
    else if (id === "retry") apply();
    else if ((id === "notifyAdmin" || id === "requestAccess") && requestAccessLink(requestUrl)) window.open(requestAccessLink(requestUrl), "_blank", "noopener");
  };

  const validating = phase === "committing" && gate && !["passed"].includes(gate.validation);
  const progress = phase === "entering" ? t("transform.applyDialog.entering") : phase === "previewing" ? t("delivery.apply.phases.simulate") : phase === "committing" ? (validating ? t("delivery.apply.phases.validate", { seconds: elapsed }) : t("delivery.apply.phases.write")) : null;
  const impact = preview?.impact && !preview.impact.error ? preview.impact : null;
  const applied = (preview?.steps || []).filter((s) => s.status === "applied").length;
  const box = (color) => ({ p: 1.25, borderRadius: "12px", background: alpha(color, theme.palette.mode === "dark" ? 0.14 : 0.07) });
  const preexisting = Number(extra.preexisting) || 0;

  if (!open) return null;
  return (
    <Box component="section" aria-label={t("transform.applyDialog.title")} data-testid="change-apply-dialog" sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
        {!compact && (
          <>
            <Typography sx={{ fontSize: "0.8rem", color: "text.secondary" }}>
              {plan?.title ? `${plan.title} — ` : ""}
              {t("transform.applyDialog.summary", { steps: applied, changes: preview?.diff?.items?.length || 0 })}
            </Typography>
            <ImpactStrip impact={impact} />
          </>
        )}

        {blocking && (
          <Box data-testid="change-apply-blocking" sx={box(theme.palette.error.main)}>
            <Typography sx={{ fontSize: "0.8rem", fontWeight: 800, color: "error.main", mb: 0.5 }}>{t("transform.applyDialog.blockedTitle")}</Typography>
            {stuck.map((s) => (
              <Typography key={s.id} sx={{ fontSize: "0.76rem", lineHeight: 1.5 }}>
                • {t(s.status === "failed" ? "transform.applyDialog.stepFailed" : "transform.applyDialog.stepBlocked", { n: (opNumber(s.id) || "?"), title: stepTitle(s) })}
              </Typography>
            ))}
            {!stuck.length && gate.blocking.some((b) => b.code === "blocked_steps") && <Typography sx={{ fontSize: "0.76rem" }}>• {t("transform.applyDialog.stepsGeneric")}</Typography>}
            {integrity.length > 0 && (
              <>
                <Typography sx={{ fontSize: "0.76rem", lineHeight: 1.5, mt: stuck.length ? 0.5 : 0 }}>• {t("transform.applyDialog.integrity")}</Typography>
                {integrity.map((i) => (
                  <Typography key={i.code} sx={{ fontSize: "0.72rem", color: "text.secondary", pl: 1.5 }}>
                    {tf(t, `transform.integrity.${i.code}`, { count: i.count }, `${i.code} ×${i.count}`)}
                  </Typography>
                ))}
              </>
            )}
            {validatorOff && <Typography sx={{ fontSize: "0.76rem", lineHeight: 1.5 }}>• {t("gtfsCheck.unavailable")}</Typography>}
            {newErrors.length > 0 && (
              <Box data-testid="change-apply-errors" sx={{ mt: 0.5 }}>
                <Typography sx={{ fontSize: "0.76rem", lineHeight: 1.5 }}>• {t("gtfsCheck.newErrors", { count: newErrors.length })}</Typography>
                {newErrors.slice(0, 12).map((e) => (
                  <Typography key={e.code} lang="en" sx={{ fontSize: "0.72rem", lineHeight: 1.5, pl: 1.5, fontVariantNumeric: "tabular-nums", fontFamily: "monospace" }}>
                    {e.code} ({e.before} → {e.after})
                  </Typography>
                ))}
                {preexisting > 0 && <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", pl: 1.5 }}>{t("network.reference.preexisting", { count: preexisting })}</Typography>}
              </Box>
            )}
          </Box>
        )}

        {!blocking && items.length > 0 && (
          <Box data-testid="change-apply-clauses">
            <AcknowledgementForm ref={formRef} variant={compact ? "decision" : "box"} items={items} value={ack} onChange={(v) => { setAck(v); if (nameInvalid && NAME_OK(v.name)) setNameInvalid(false); }} highlight={highlight} nameInvalid={nameInvalid} disabled={busy} opNumber={opNumber} />
          </Box>
        )}
        {/* By hand with nothing to accept: the person's name alone, under which the change is applied. */}
        {hand && !blocking && items.length === 0 && (
          <TextField size="small" label={t("ack.name")} value={ack.name || ""} onChange={(e) => { const name = e.target.value.slice(0, 120); setAck((a) => ({ ...a, name })); if (nameInvalid && NAME_OK(name)) setNameInvalid(false); }} disabled={busy} required error={nameInvalid} inputRef={handNameRef} inputProps={{ "data-testid": "decision-hand-name", maxLength: 120, autoComplete: "name", "aria-invalid": nameInvalid ? "true" : "false" }} sx={{ maxWidth: 340 }} />
        )}

        {!blocking && gate && !compact && (
          <Typography data-testid="change-apply-validator" sx={{ fontSize: "0.74rem", color: gate.validation === "passed" ? "success.main" : "text.secondary", lineHeight: 1.5 }}>
            {t(`transform.applyDialog.validator.${["passed", "new_errors"].includes(gate.validation) ? gate.validation : "not_run"}`)}
          </Typography>
        )}
        {!compact && (
          <Box sx={{ p: 1.25, borderRadius: "12px", background: soft(theme) }} data-testid="change-apply-undo">
            <Typography sx={{ fontSize: "0.76rem", lineHeight: 1.55 }}>{editing ? t("transform.applyDialog.undoEditing") : t("transform.applyDialog.undo")}</Typography>
          </Box>
        )}

        {refusal && (
          <Box data-testid="change-apply-error" data-code={refusal.code || "default"}>
            <RefusalNotice refusal={refusal} onAction={onAction} supported={SUPPORTED.filter((id) => !["notifyAdmin", "requestAccess"].includes(id) || requestAccessLink(requestUrl))} manageFocus={!ACK_CODES.has(refusal.code)} />
          </Box>
        )}
        {progress && (
          <Box data-testid="change-apply-progress" role="status">
            <LinearProgress sx={{ borderRadius: 99, mb: 0.75 }} />
            <Typography sx={{ fontSize: "0.76rem", color: "text.secondary" }}>{progress}</Typography>
          </Box>
        )}
      {/* The keyboard's way: Enter applies once everything is accepted (the host's useReviewKeys). */}
      {!blocking && !compact && (
        <Typography data-testid="change-apply-keys" sx={{ fontSize: "0.7rem", color: "text.secondary", textAlign: "right" }}>
          {t("delivery.keys")}
        </Typography>
      )}
      <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1 }}>
        <Button onClick={onClose} disabled={busy} data-testid="change-apply-back" sx={{ textTransform: "none" }}>
          {t("ack.backToChange")}
        </Button>
        <Button variant="contained" disableElevation disabled={!canApply} onClick={() => apply()} data-testid="change-apply-confirm" sx={{ textTransform: "none", fontWeight: 800, borderRadius: 99, px: 2.5 }}>
          {blocking ? t("transform.applyDialog.cannot") : t("step.primary.5.modify")}
        </Button>
      </Box>
    </Box>
  );
}
