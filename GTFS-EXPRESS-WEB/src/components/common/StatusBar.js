/**
 * StatusBar — the one bar that tells the state of the work, everywhere
 * (§3.2, D40), and the separate voice that announces its changes.
 *
 * It is a `<footer>` (the `contentinfo` landmark, "État du travail") of
 * cases in a fixed order — network · version · scenario · mode · saving ·
 * verdict · GTFS validation · deliver · person — each one a visible,
 * labelled button (or plain text when there is nothing to do) leading to
 * where one acts on it. It is NOT a live region: a region that holds
 * focusable widgets is re-announced on every change and breaks the ARIA
 * content model of `status` (RGAA 7.1 / 11). Announcements go through a
 * separate, visually hidden `status-live` element (`aria-live="polite"`,
 * `aria-atomic`) that receives one sentence per change of state and is
 * emptied after five seconds; it says nothing at rest and nothing on the
 * first render.
 *
 * The bar only shows what it knows: outside a project there is no version,
 * scenario nor verdict (those cases arrive with the projects), and a
 * validation still running is not announced until it settles. Times are
 * written in the interface's locale (D47).
 *
 * Props (all optional; a missing case is not rendered):
 *   network          { name } | null ("aucun réseau")
 *   onOpenNetwork    the network case's action (the overview)
 *   version          inside a project, the version in words ("v1 construite",
 *                    "Référence v0 (…)"); onOpenVersion leads to ⑤
 *   scenario         inside a project, the scenario in words ("Scénario A
 *                    (brouillon)"); onOpenScenario leads to ③
 *   mode             "read" | "edit"; modeControls: the EditModeToggle
 *   pendingEdits     edits not yet delivered; savedAt when the work was last
 *                    written; onOpenJournal — in edit mode the saving case is
 *                    always there, the count or "Enregistré 14:32", and opens
 *                    the journal
 *   validation       { state: none|running|ok|stale|unavailable, errors, warnings, at, seconds }
 *   onOpenValidation opens the validation page (the button then carries `validation-report-badge`)
 *   deliver          the DeliverButton
 *   user             { name, role? } | { anonymous: true }; onUser
 *   projectSave      inside a project kept by the server (WP7, §9):
 *                    { state: saved|saving|offline|conflict|local, at } —
 *                    "Enregistré 14:32", "Enregistrement…", "Non enregistré
 *                    (hors ligne)", "Conflit — ouvert ailleurs" (the notice
 *                    of the step says what to do); an unsaved write outranks
 *                    the edit count, the edit count outranks "Enregistré"
 *   session          the working copy's expiry from T-10 min (§3.2):
 *                    { minutes, onExtend } — "Copie de travail : expire dans
 *                    8 min" and "Prolonger" (`status-session-extend`), a
 *                    heartbeat at once
 *
 * What the page knows becomes these cases through pure helpers, so that the
 * bar says after a delivery what the delivery made true (2026-10-07: v1
 * applied with 0 error, packaged, and the bar still said « Validation GTFS :
 * à refaire » and « 1 modification(s) non livrée(s) »):
 *   versionWordsOf(version, t)          "v1 appliquée", "v1 appliquée · livrée" once marked delivered
 *   undeliveredEditsOf({ pendingEdits, unfrozenEdits, inProject })
 *                                       the saving case's count: in a project whose working copy the
 *                                       server binds to its versions, none — the version case says the
 *                                       retouches no version holds yet, and whether the version is delivered
 *   validationCaseOf({ running, summary, stale, at, unavailable, vouched })
 *                                       the validation case: the answer of an act that validated the network
 *                                       as it now is (utils/vouchedValidation) over a report being read again
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, Button, Tooltip } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";

export const LIVE_CLEAR_MS = 5000;

// Visually hidden but read by assistive technologies (the classic clip).
export const visuallyHidden = { position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0 0 0 0)", clipPath: "inset(50%)", whiteSpace: "nowrap", border: 0 };

const caseButton = { textTransform: "none", fontWeight: 600, fontSize: "0.78rem", minWidth: 0, px: 1, py: 0.25, lineHeight: 1.4, whiteSpace: "nowrap", color: "text.primary" };
const caseText = { display: "inline-flex", alignItems: "center", gap: 0.5, fontSize: "0.78rem", px: 1, py: 0.25, whiteSpace: "nowrap" };

/** A clock time in the interface's language (D47): "14:32" in fr, "2:32 PM" in en; "" without a time (new Date(null) is the epoch, not an invalid date). */
export const formatTime = (value, language) => {
  if (value === null || value === undefined || value === "") return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(language || undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  } catch {
    return date.toLocaleTimeString();
  }
};

/** A count in the interface's language (D47). */
const formatCount = (n, language) => {
  try {
    return new Intl.NumberFormat(language || undefined).format(n ?? 0);
  } catch {
    return String(n ?? 0);
  }
};

/** A sentence with an empty "{time}" slot loses its brackets: "0 erreur · 2 avert. ()" reads "0 erreur · 2 avert.". */
const withoutEmptyTime = (text) => String(text).replace(/\s*[(（]\s*[)）]/g, "").trim();

/** The words of the validation case, e.g. "0 erreur · 2 avert. (14:20)". */
export function validationText(validation, t, language) {
  if (!validation) return null;
  switch (validation.state) {
    case "running":
      return t("status.validation.running", { seconds: validation.seconds ?? 0 });
    case "ok": {
      const time = formatTime(validation.at, language);
      const text = t("status.validation.ok", { errors: formatCount(validation.errors, language), warnings: formatCount(validation.warnings, language), time });
      return time ? text : withoutEmptyTime(text);
    }
    case "stale":
      return t("status.validation.stale");
    case "unavailable":
      return t("status.validation.unavailable");
    default:
      return t("status.validation.none");
  }
}

/**
 * The validation case from what the page knows: `vouched` — the counts of an act's own run of the canonical validator
 * on the network as it now is (a change plan applied: the commit validates the feed it leaves) — stands over a run
 * reading the full report again and over a report older than it, until a report read after it (`at`, when the
 * report arrived) and still current says the same network in full; then a run in progress, the session's last report
 * (stale once the network changed after it), no validator on the server, nothing yet.
 * → { state: ok | running | stale | unavailable | none, errors?, warnings?, at? }
 */
export function validationCaseOf({ running = false, summary = null, stale = false, at = null, unavailable = false, vouched = null } = {}) {
  const time = (v) => (v ? new Date(v).getTime() : NaN);
  const reportAfter = Boolean(summary?.validated) && !stale && time(at) >= time(vouched?.at);
  if (vouched && !reportAfter) return { state: "ok", errors: vouched.errors, warnings: vouched.warnings, at: vouched.at || null };
  if (running) return { state: "running" };
  if (summary?.validated) return { state: stale ? "stale" : "ok", errors: summary.errors, warnings: summary.warnings, at };
  return { state: unavailable ? "unavailable" : "none" };
}

/**
 * The version case's words: the version's kind ("v1 appliquée"), and — marked delivered (« Marquer livrée »: its
 * `delivered_at`, or the server's `delivered`) — that it is, as the versions list says it ("v1 appliquée · livrée");
 * a version frozen at its delivery says it in its kind already ("v2 livrée"). null without a version.
 */
export function versionWordsOf(version, t) {
  if (!version) return null;
  if (version.kind === "reference") return t("step.status.reference");
  const head = t(version.kind === "applied" ? "version.applied" : version.kind === "snapshot" ? "home.project.snapshot" : version.kind === "delivered" ? "version.delivered" : "version.built", { n: version.n });
  return (version.delivered_at || version.delivered) && version.kind !== "delivered" ? `${head} · ${t("version.deliveredMark")}` : head;
}

/**
 * How many edits the saving case calls « non livrées ». The undo depth (`pendingEdits`) outside a project; in a
 * project whose working copy the server binds to its versions (D38: `unfrozenEdits`, the server's count of edits
 * since the last version, a number), none: an edit frozen in a version is the project's — the version case says
 * whether that version is delivered and how many retouches no version holds yet ("· 2 retouche(s) non figée(s)").
 */
export function undeliveredEditsOf({ pendingEdits = 0, unfrozenEdits = null, inProject = false } = {}) {
  return inProject && Number.isFinite(unfrozenEdits) ? 0 : Number(pendingEdits) || 0;
}

/**
 * The live region's text: one sentence when one of `phrases` changes to a
 * new, non-empty value (several at once are joined), emptied after
 * LIVE_CLEAR_MS. The first render only records the values.
 */
// `quietOnArrival`: phrases said when they change, never when they appear — the project's saving case arrives with a
// project (the network put in its project as edit mode is asked, 2026-10-08): « Enregistré » then would cover the
// sentence that matters, « Mode : Édition ».
export function useLiveAnnouncement(phrases, { quietOnArrival = [] } = {}) {
  const [message, setMessage] = useState("");
  const previous = useRef(null);
  const timer = useRef(null);
  const signature = JSON.stringify(phrases);
  useEffect(() => {
    const current = JSON.parse(signature);
    const before = previous.current;
    previous.current = current;
    if (!before) return;
    const changed = Object.keys(current)
      .filter((key) => current[key] && current[key] !== before[key] && !(quietOnArrival.includes(key) && !before[key]))
      .map((key) => current[key]);
    if (!changed.length) return;
    setMessage(changed.join(". "));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(""), LIVE_CLEAR_MS);
    // The phrases lead (`quietOnArrival` is a constant list of their keys).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return message;
}

/** One case: a labelled button when it leads somewhere, plain text otherwise. */
// A long name (a network, a scenario) is cut with an ellipsis and said whole on hover: the bar stays one line.
const Clip = ({ children }) => (
  <Box component="span" title={typeof children === "string" ? children : undefined} sx={{ display: "inline-block", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", verticalAlign: "bottom" }}>
    {children}
  </Box>
);

function Case({ testid, label, onClick, color, title, sx = null }) {
  if (!label) return null;
  if (onClick) {
    const button = (
      <Button size="small" variant="text" onClick={onClick} data-testid={testid} sx={{ ...caseButton, ...(color ? { color } : {}), ...(sx || {}) }}>
        <Clip>{label}</Clip>
      </Button>
    );
    return title ? <Tooltip title={title}>{button}</Tooltip> : button;
  }
  return (
    <Box component="span" data-testid={testid} sx={{ ...caseText, ...(color ? { color } : {}), ...(sx || {}) }}>
      <Clip>{label}</Clip>
    </Box>
  );
}

/** The saving case's words for a project kept by the server (null when there is nothing to say). */
export const projectSaveText = (save, t, language) => {
  if (!save) return null;
  if (save.state === "conflict") return t("status.conflict");
  if (save.state === "offline") return t("status.offline");
  // Refused by the server (the quota, its size, the workspace off): never "offline" — the step says why, with its action.
  if (save.state === "local") return t("status.local");
  if (save.state === "saving") return t("status.saving");
  if (save.state === "saved" && save.at) return t("status.saved", { time: formatTime(save.at, language) }).trim();
  return null;
};

export default function StatusBar({ network = null, onOpenNetwork, version = null, onOpenVersion, scenario = null, onOpenScenario, mode = null, modeControls = null, pendingEdits = 0, savedAt = null, onOpenJournal, validation = null, onOpenValidation, deliver = null, user = null, onUser, projectSave = null, session = null }) {
  const { t, language } = useLanguage();
  const validationWords = validationText(validation, t, language);
  const validationLabel = validationWords ? t("status.live.validation", { state: validationWords }) : null;
  const modeLabel = mode ? t(mode === "edit" ? "status.mode.edit" : "status.mode.read") : null;
  // In edit mode the saving case is always there and leads to the journal
  // (§3.2): the undelivered count while there is one, else when the work was
  // last written.
  const editSaved = mode !== "edit" ? null : pendingEdits > 0 ? t("status.unsaved", { count: formatCount(pendingEdits, language) }) : t("status.saved", { time: formatTime(savedAt, language) }).trim();
  const projectSaved = projectSaveText(projectSave, t, language);
  // A write the server does not have outranks everything; then the edits not delivered; then "Enregistré".
  const savedLabel = projectSave && ["conflict", "offline", "local", "saving"].includes(projectSave.state) ? projectSaved : editSaved || projectSaved;
  const saveState = projectSave?.state || (mode === "edit" ? "saved" : null);

  const live = useLiveAnnouncement({
    network: network ? t("status.network", { name: network.name }) : null,
    mode: modeLabel ? t("status.live.mode", { mode: modeLabel }) : null,
    // A running validation changes every second: only its outcome is said.
    validation: validation && validation.state !== "running" ? validationLabel : null,
    // The project's saving: said when it is saved or when it is not (never "saving…", which changes all the time).
    saved: projectSave && projectSave.state !== "saving" ? projectSaved : null,
    // Said once when the warning appears, not at every minute it counts down.
    session: session ? t("status.session.soon") : null,
  }, { quietOnArrival: ["saved"] });

  const validationColor = validation?.state === "ok" && validation.errors > 0 ? "error.main" : validation?.state === "unavailable" ? "warning.dark" : undefined;
  const userLabel = user ? (user.anonymous ? `${t("status.user.anonymous")} — ${t("status.user.signIn")}` : user.role ? `${user.name} (${t(`status.role.${user.role}`)})` : user.name) : null;

  return (
    <>
      <Box
        component="footer"
        data-testid="status-bar"
        aria-label={t("status.bar.label")}
        sx={(theme) => ({
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          columnGap: 0.5,
          rowGap: 0.25,
          px: 1.5,
          py: 0.5,
          minHeight: 36,
          borderTop: `1px solid ${theme.palette.divider}`,
          backgroundColor: theme.palette.mode === "dark" ? "#1e1e1e" : "#ffffff",
          flexShrink: 0,
          "& > *:not(:last-child)": { borderInlineEnd: `1px solid ${theme.palette.divider}`, pr: 0.5 },
        })}
      >
        {/* « Réseau Réseau urbain du Grand Albigeois »: a name that already says it is a network is not prefixed again. */}
        {network ? <Case testid="status-network" label={/^r[ée]seau\b/i.test(String(network.name || "")) ? network.name : t("status.network", { name: network.name })} onClick={onOpenNetwork} /> : <Case testid="status-network" label={t("status.network.none")} />}
        <Case testid="status-version" label={version} onClick={onOpenVersion} />
        <Case testid="status-scenario" label={scenario} onClick={onOpenScenario} />
        {mode && (
          <Box component="span" data-testid="status-mode" data-mode={mode} role="group" aria-label={modeLabel} sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, flexWrap: "wrap" }}>
            <Box component="span" sx={{ ...caseText, fontWeight: 700, color: mode === "edit" ? "success.main" : "text.secondary" }}>
              {modeLabel}
            </Box>
            {modeControls}
          </Box>
        )}
        {savedLabel && (
          <Box component="span" data-save-state={saveState || ""} sx={{ display: "inline-flex" }}>
            <Case testid="status-saved" label={savedLabel} onClick={onOpenJournal} color={projectSave?.state === "conflict" || projectSave?.state === "offline" || projectSave?.state === "local" ? "warning.dark" : undefined} />
          </Box>
        )}
        {validationLabel && (
          <Box component="span" data-testid="status-validation" data-state={validation.state} sx={{ display: "inline-flex" }}>
            {onOpenValidation ? (
              <Button size="small" variant="text" onClick={onOpenValidation} data-testid="validation-report-badge" sx={{ ...caseButton, ...(validationColor ? { color: validationColor } : {}) }}>
                {validationLabel}
              </Button>
            ) : (
              <Box component="span" sx={{ ...caseText, ...(validationColor ? { color: validationColor } : {}) }}>
                {validationLabel}
              </Box>
            )}
          </Box>
        )}
        {deliver && (
          <Box component="span" data-testid="status-deliver" sx={{ display: "inline-flex" }}>
            {deliver}
          </Box>
        )}
        {session && (
          <Box component="span" data-testid="status-session" data-minutes={session.minutes} sx={{ display: "inline-flex", alignItems: "center", gap: 0.25 }}>
            <Box component="span" data-testid="session-expiry" sx={{ ...caseText, color: "warning.dark", fontWeight: 700 }}>
              {t("status.session.expiring", { minutes: formatCount(session.minutes, language) })}
            </Box>
            {session.onExtend && (
              <Button size="small" variant="outlined" color="warning" onClick={session.onExtend} data-testid="status-session-extend" sx={{ ...caseButton, color: "warning.dark" }}>
                {t("status.session.extend")}
              </Button>
            )}
          </Box>
        )}
        {/* The header's account button says who is signed in: here only on the widest screens, where the bar has room. */}
        {userLabel && <Case testid="status-user" label={userLabel} onClick={onUser} sx={{ display: { xs: "none", xl: "inline-flex" } }} />}
      </Box>
      <Box data-testid="status-live" className="visually-hidden" aria-live="polite" aria-atomic="true" sx={visuallyHidden}>
        {live}
      </Box>
    </>
  );
}
