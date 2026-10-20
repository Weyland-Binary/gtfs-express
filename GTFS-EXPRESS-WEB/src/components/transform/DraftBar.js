/**
 * DraftBar — the draft's bar over the studio, and what goes with it: the draft's ONE state (`draftStateOf`), « ⋯ »
 * (its menu: the versions, abandon) and « Quitter » (DraftBar, DraftMenus) — drawn by a brief draft (DirectChange, whose acts are its screen's) and before a kind is chosen; by
 * hand, the screen is the reader and the draft is one button in the header that opens its panel beside it
 * (HandDraft: the state, the retouches and the assistant's operations, the act, abandon, the versions, leave).
 * Every value and handler is the host's, given as props: nothing here reads the project.
 */

import React, { useState } from "react";
import { Box, Button, ButtonBase, CircularProgress, Dialog, Divider, Drawer, IconButton, ListItemIcon, Menu, MenuItem, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import MoreHorizRoundedIcon from "@mui/icons-material/MoreHorizRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import HistoryRoundedIcon from "@mui/icons-material/HistoryRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import TouchAppOutlinedIcon from "@mui/icons-material/TouchAppOutlined";
import TaskAltRoundedIcon from "@mui/icons-material/TaskAltRounded";
import ViewSidebarOutlinedIcon from "@mui/icons-material/ViewSidebarOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { countWords } from "../../utils/countWords";
import SegmentedSwitch from "../common/SegmentedSwitch";
import { VersionList } from "../steps/StepDelivery";
import { tokensOf } from "../studio/studioTheme";
import { kindTextToneOf, kindToneOf, textToneOf } from "./draftKinds";


/**
 * The draft's one state, as the bar and the hand's panel say it: `{ tone, text }`, `busy` while something runs. The
 * order is the order the person meets them: no kind chosen, applied, nothing yet, the count (the retouches, or the
 * modifications when the assistant's operations joined them) while it is simulated and once the simulation is clean,
 * else the plan's status (a step blocked, the validator's errors). A draft by hand states no objective, so no clause
 * verdict stands for its state. A brief draft says its own (DirectChange).
 */
export const draftStateOf = (t, { kind, frozen, operations = [], previewing, preview, status, retouches = null }) => {
  // A draft by hand kept as a session of its own: its retouches are its journal's (`retouches`); an assistant's plan
  // waiting to join it says its own state (a question asked), then joins it.
  if (kind === "hand" && retouches != null && !frozen) {
    if (operations.length && (previewing || !preview)) return { tone: "info", busy: previewing, text: countWords(t, "draft.state.hand", retouches) };
    if (operations.length && status.tone !== "success") return { tone: status.tone === "error" ? "error" : status.tone === "warning" ? "warning" : "info", text: t(status.key, status.params) };
    return retouches ? { tone: "info", text: countWords(t, "draft.state.hand", retouches) } : { tone: "info", text: t("draft.state.handNone") };
  }
  const mixed = operations.some((o) => o?.source?.kind !== "hand");
  const count = countWords(t, mixed ? "draft.state.handMixed" : "draft.state.hand", operations.length);
  return !kind
    ? { tone: "info", text: t("draft.choose.state") }
    : frozen
      ? { tone: "success", text: t("scenario.state.applied", { n: frozen.n }) }
      : !operations.length
        ? { tone: "info", text: t("draft.state.handNone") }
        : previewing || !preview
          ? { tone: "info", busy: previewing, text: count }
          : status.tone === "success"
            ? { tone: "success", text: count }
            : { tone: status.tone === "error" ? "error" : status.tone === "warning" ? "warning" : "info", text: t(status.key, status.params) };
};

/**
 * The reader's side as the draft's header says it: « Avant | Après » in one rounded group (the common
 * SegmentedSwitch). `tone`: the kind's colour.
 */
export function SideSwitch({ options, value, onChange, tone, testid = "draft-lens" }) {
  const { t } = useLanguage();
  const label = { before: t("lens.before"), after: t("lens.after.short") };
  return <SegmentedSwitch options={options.map((o) => ({ value: o, label: label[o] }))} value={value} onChange={onChange} tone={tone} label={t("lens.label")} testid={testid} data-side={value} />;
}

/**
 * The bar: the kind, the one state (`streaming`: the turn running, with « Arrêter »), « ⋯ », « Quitter ». The brief
 * draft's screen (DirectChange) holds its own acts, its end included.
 *
 * `variant="header"`: the same, drawn in the app's header (its draft slot, where « Modifier » stands) rather than as a
 * band over the screen — the kind and the state in one pill, then « ⋯ » and « Quitter »: the screen keeps its height.
 */
export default function DraftBar({ kind = null, state, statusKey = "", streaming = false, onStop, onMore, onLeave = null, variant = "bar", side = null, onSide = null, report = null }) {
  const theme = useTheme();
  const { t } = useLanguage();
  if (variant === "header") return <DraftHeader kind={kind} state={state} statusKey={statusKey} streaming={streaming} onStop={onStop} onMore={onMore} onLeave={onLeave} side={side} onSide={onSide} report={report} />;
  const kindLabel = kind ? (
    // The kind is a label, not a button: its tone and its icon, a rule after it.
    <Box data-testid="draft-kind" data-kind={kind} sx={{ display: "inline-flex", alignItems: "center", gap: 0.75, height: 32, pr: 1.5, mr: 0.25, borderRight: `1px solid ${theme.palette.divider}`, flexShrink: 0, fontSize: "0.88rem", fontWeight: 700, color: kindTextToneOf(theme, kind) }}>
      {kind === "hand" ? <EditOutlinedIcon sx={{ fontSize: 18 }} /> : <DescriptionOutlinedIcon sx={{ fontSize: 18 }} />}
      {t(`draft.kind.${kind}.short`)}
    </Box>
  ) : null;
  const toneMain = theme.palette[state.tone]?.main || theme.palette.info.main;
  const toneText = textToneOf(theme, theme.palette[state.tone] || theme.palette.info);
  return (
    <Box component="nav" aria-label={t("panel.title")} data-testid="draft-bar" data-kind={kind || ""} sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 2, py: 1, minHeight: 52, borderBottom: `1px solid ${theme.palette.divider}`, backgroundColor: theme.palette.background.paper }}>
      {kindLabel}
      <Box sx={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 0.75 }}>
        {/* The live region is the state's words alone: the seconds tick and the button beside it are not announced. */}
        <Box sx={{ minWidth: 0, maxWidth: "100%", fontSize: "0.82rem", fontWeight: 650, color: toneText, display: "inline-flex", alignItems: "center", gap: 0.75, overflow: "hidden", whiteSpace: "nowrap", px: 1.25, py: 0.5, borderRadius: 99, backgroundColor: alpha(toneMain, theme.palette.mode === "dark" ? 0.18 : 0.1), border: `1px solid ${alpha(toneMain, 0.28)}` }}>
          {!state.busy && <Box component="span" aria-hidden sx={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, backgroundColor: toneMain }} />}
          {state.busy && <CircularProgress size={14} sx={{ flexShrink: 0 }} />}
          <Typography component="span" role="status" data-testid="change-status" data-tone={state.tone} data-status={statusKey.replace("transform.", "")} sx={{ minWidth: 0, display: "inline-flex", alignItems: "center", fontSize: "inherit", fontWeight: "inherit", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {state.text}
          </Typography>
          {state.seconds != null && (
            <Box component="span" aria-hidden data-testid="change-status-seconds" sx={{ flexShrink: 0, fontVariantNumeric: "tabular-nums", opacity: 0.8 }}>
              {t("draft.state.seconds", { seconds: state.seconds })}
            </Box>
          )}
        </Box>
        {streaming && (
          <Button size="small" onClick={onStop} data-testid="draft-stop" sx={{ textTransform: "none", fontWeight: 650, flexShrink: 0, minWidth: 0 }}>
            {t("direct.stop")}
          </Button>
        )}
      </Box>
      {kind && (
        <Tooltip title={t("draft.more")}>
          <IconButton size="small" onClick={(e) => onMore(e.currentTarget)} aria-label={t("draft.more")} aria-haspopup="menu" data-testid="draft-more" sx={{ flexShrink: 0 }}>
            <MoreHorizRoundedIcon />
          </IconButton>
        </Tooltip>
      )}
      {onLeave && (
        <Tooltip title={t("panel.leave.hint")}>
          <Button size="small" onClick={onLeave} data-testid="panel-leave" sx={{ textTransform: "none", fontWeight: 650, color: "text.secondary", minWidth: 0, flexShrink: 0 }}>
            {t("panel.leave")}
          </Button>
        </Tooltip>
      )}
    </Box>
  );
}

/** The bar in the header: one pill (the kind's icon and name, a rule, the state), « Arrêter » while a turn runs, « ⋯ », « Quitter ». */
function DraftHeader({ kind, state, statusKey, streaming, onStop, onMore, onLeave, side = null, onSide = null, report = null }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const toneMain = theme.palette[state.tone]?.main || theme.palette.info.main;
  const toneText = textToneOf(theme, theme.palette[state.tone] || theme.palette.info);
  const kindTone = kind ? kindTextToneOf(theme, kind) : theme.palette.text.secondary;
  return (
    <Box component="nav" aria-label={t("panel.title")} data-testid="draft-bar" data-kind={kind || ""} data-variant="header" sx={{ display: "flex", alignItems: "center", gap: 0.5, minWidth: 0 }}>
      <Box sx={{ display: "inline-flex", alignItems: "center", height: 36, minWidth: 0, maxWidth: 420, borderRadius: "10px", border: `1px solid ${alpha(toneMain, 0.3)}`, backgroundColor: alpha(toneMain, theme.palette.mode === "dark" ? 0.14 : 0.07), overflow: "hidden" }}>
        {kind ? (
          <Box data-testid="draft-kind" data-kind={kind} sx={{ display: "inline-flex", alignItems: "center", gap: 0.6, pl: 1.25, pr: 1, height: "100%", flexShrink: 0, fontSize: "0.84rem", fontWeight: 700, color: kindTone, borderRight: `1px solid ${alpha(toneMain, 0.25)}` }}>
            {kind === "hand" ? <EditOutlinedIcon sx={{ fontSize: 17 }} /> : <DescriptionOutlinedIcon sx={{ fontSize: 17 }} />}
            {t(`draft.kind.${kind}.short`)}
          </Box>
        ) : null}
        <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.75, px: 1.25, minWidth: 0, fontSize: "0.82rem", fontWeight: 650, color: toneText }}>
          {state.busy ? <CircularProgress size={13} sx={{ flexShrink: 0 }} /> : <Box component="span" aria-hidden sx={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, backgroundColor: toneMain }} />}
          <Typography component="span" role="status" data-testid="change-status" data-tone={state.tone} data-status={statusKey.replace("transform.", "")} sx={{ minWidth: 0, fontSize: "inherit", fontWeight: "inherit", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {state.text}
          </Typography>
          {state.seconds != null && (
            <Box component="span" aria-hidden data-testid="change-status-seconds" sx={{ flexShrink: 0, fontVariantNumeric: "tabular-nums", opacity: 0.8 }}>
              {t("draft.state.seconds", { seconds: state.seconds })}
            </Box>
          )}
        </Box>
      </Box>
      {/* The reader's side, and the report's panel beside it (the brief's draft at its decision). */}
      {side && onSide && <SideSwitch options={["before", "after"]} value={side} onChange={onSide} tone={kindTextToneOf(theme, kind || "brief")} />}
      {report && (
        <Tooltip title={t(report.open ? "draft.report.hide" : "draft.report.show")}>
          <ButtonBase onClick={report.onToggle} aria-pressed={report.open ? "true" : "false"} data-testid="draft-report-toggle" sx={{ height: 32, px: 1.25, gap: 0.6, flexShrink: 0, borderRadius: "9px", fontSize: "0.8rem", fontWeight: 700, whiteSpace: "nowrap", color: report.open ? kindTone : "text.secondary", backgroundColor: report.open ? alpha(kindTone, theme.palette.mode === "dark" ? 0.18 : 0.1) : "transparent", border: `1px solid ${report.open ? alpha(kindTone, 0.35) : theme.palette.divider}`, "&:hover": { backgroundColor: alpha(kindTone, 0.12) }, "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 1 } }}>
            <ViewSidebarOutlinedIcon sx={{ fontSize: 17 }} />
            {t("draft.view.report")}
          </ButtonBase>
        </Tooltip>
      )}
      {streaming && (
        <Button size="small" onClick={onStop} data-testid="draft-stop" sx={{ textTransform: "none", fontWeight: 650, flexShrink: 0, minWidth: 0 }}>
          {t("direct.stop")}
        </Button>
      )}
      {kind && (
        <Tooltip title={t("draft.more")}>
          <IconButton size="small" onClick={(e) => onMore(e.currentTarget)} aria-label={t("draft.more")} aria-haspopup="menu" data-testid="draft-more" sx={{ flexShrink: 0, width: 36, height: 36, borderRadius: "10px" }}>
            <MoreHorizRoundedIcon />
          </IconButton>
        </Tooltip>
      )}
      {onLeave && (
        <Tooltip title={t("panel.leave.hint")}>
          <Button size="small" variant="outlined" color="inherit" onClick={onLeave} data-testid="panel-leave" sx={{ textTransform: "none", fontWeight: 650, color: "text.secondary", borderColor: theme.palette.divider, borderRadius: "10px", height: 36, minWidth: 0, px: 1.5, flexShrink: 0 }}>
            {t("panel.leave")}
          </Button>
        </Tooltip>
      )}
    </Box>
  );
}

/** « ⋯ »'s menu (the versions, abandon), the versions' dialog and the abandon's confirmation. */
export function DraftMenus({ moreAnchor = null, onCloseMore, onVersions, onAbandonAsk, abandonDisabled = false, versionsOpen = false, onCloseVersions, versions = [], abandoning = false, onCloseAbandon, onAbandon }) {
  const theme = useTheme();
  const { t } = useLanguage();
  return (
    <>
      <Menu anchorEl={moreAnchor} open={Boolean(moreAnchor)} onClose={onCloseMore} anchorOrigin={{ vertical: "bottom", horizontal: "right" }} transformOrigin={{ vertical: "top", horizontal: "right" }}>
        <MenuItem onClick={onVersions} data-testid="draft-versions" sx={{ fontSize: "0.88rem" }}>
          {t("decision.versions")}
        </MenuItem>
        <MenuItem onClick={onAbandonAsk} disabled={abandonDisabled} data-testid="draft-abandon" sx={{ color: "error.main", fontSize: "0.88rem" }}>
          {t("draft.abandon")}
        </MenuItem>
      </Menu>
      <Dialog open={versionsOpen} onClose={onCloseVersions} fullWidth maxWidth="sm" data-testid="draft-versions-dialog" PaperProps={{ sx: { borderRadius: "16px" } }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2.5, py: 1.5, borderBottom: `1px solid ${theme.palette.divider}` }}>
          <Typography component="h2" sx={{ flex: 1, fontSize: "1rem", fontWeight: 700 }}>{t("decision.versions")}</Typography>
          <Button onClick={onCloseVersions} data-testid="draft-versions-close" sx={{ textTransform: "none", fontWeight: 650 }}>
            {t("app.close")}
          </Button>
        </Box>
        <Box sx={{ px: 2.5, py: 2 }}>
          <VersionList versions={versions} />
        </Box>
      </Dialog>
      <Dialog open={abandoning} onClose={onCloseAbandon} maxWidth="xs" fullWidth data-testid="draft-abandon-dialog" PaperProps={{ sx: { borderRadius: "14px", p: 2.5, display: "flex", flexDirection: "column", gap: 2 } }}>
        <Typography sx={{ fontSize: "0.92rem", lineHeight: 1.5 }}>{t("draft.abandon.confirm")}</Typography>
        <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1 }}>
          <Button onClick={onCloseAbandon} data-testid="draft-abandon-no" sx={{ textTransform: "none", fontWeight: 650 }}>
            {t("app.cancel")}
          </Button>
          <Button variant="contained" color="error" disableElevation onClick={onAbandon} data-testid="draft-abandon-yes" sx={{ textTransform: "none", fontWeight: 700, borderRadius: "10px" }}>
            {t("draft.abandon")}
          </Button>
        </Box>
      </Dialog>
    </>
  );
}

/**
 * By hand, the screen is the reader: no bar over it. The draft is one button in the header (its kind in its colour,
 * its count of retouches) that opens its panel beside the reader. The panel reads top to bottom as the person works:
 * its name with its one state under it, « ⋯ » (the versions, abandon) and close; the retouches as a timeline, the
 * newest first (`retouchesNode`: the draft's journal, the latest undone in place, the draft taken back to any other),
 * or what to do when there are none; the assistant's plan waiting to join the draft (its operations, a question
 * asked, drawn by `renderOperation`); at its foot the one act (« Appliquer en vN », then « Livrer ») beside « Quitter ».
 */
export function HandDraft({ open = false, onOpen, onClose, frozen = null, operations = [], retouches: retouchCount = 0, retouchesNode = null, notices = null, renderOperation, state, onDeliver, onApplied, onApply, applyDisabled = false, nextN = 1, onAbandonAsk, onVersions, onLeave = null, side = null, onSide = null, onNewDraft = null }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const k = tokensOf(theme);
  const dark = theme.palette.mode === "dark";
  const handTone = kindToneOf(theme, "hand");
  const handText = kindTextToneOf(theme, "hand");
  const [menuAnchor, setMenuAnchor] = useState(null);
  // An applied draft lists what it was applied with (an older draft's operations); a draft at work, its journal.
  const retouches = frozen ? operations.filter((op) => op?.source?.kind === "hand") : [];
  const joined = frozen ? operations.filter((op) => op?.source?.kind !== "hand") : operations;
  const shownCount = frozen ? 0 : retouchCount + joined.length;
  const hasRetouches = frozen ? retouches.length > 0 : retouchCount > 0;
  // « Avant | Après » beside the draft's name: the reader's side, no band over it.
  const switcher = side && onSide ? <SideSwitch options={["before", "after"]} value={side} onChange={onSide} tone={handTone} /> : null;
  // The state under the name: a plain count stays quiet, a question, a warning or an error takes its colour.
  const stateMain = theme.palette[state.tone]?.main || theme.palette.info.main;
  const stateText = state.tone === "info" ? theme.palette.text.secondary : textToneOf(theme, theme.palette[state.tone]);
  const closeAnd = (act) => () => {
    setMenuAnchor(null);
    onClose();
    act?.();
  };
  const overline = (text, testid, count = null) => (
    <Typography component="h3" data-testid={testid} sx={{ display: "flex", alignItems: "center", gap: 0.75, mb: 1.25, fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "text.secondary" }}>
      {text}
      {count != null && (
        <Box component="span" sx={{ minWidth: 18, height: 18, px: 0.5, borderRadius: 99, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "0.68rem", letterSpacing: 0, color: "text.primary", backgroundColor: alpha(theme.palette.text.primary, dark ? 0.12 : 0.07) }}>
          {count}
        </Box>
      )}
    </Typography>
  );
  return (
    <>
      <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.75 }}>
      <Tooltip title={t("draft.hand.open")}>
        <ButtonBase onClick={onOpen} aria-haspopup="dialog" aria-expanded={open ? "true" : "false"} data-testid="draft-hand-button" data-kind="hand" sx={{ height: 36, px: 1.5, gap: 0.75, borderRadius: "10px", fontSize: "0.86rem", fontWeight: 700, color: handTone, backgroundColor: alpha(handTone, dark ? 0.18 : 0.1), border: `1px solid ${alpha(handTone, 0.35)}`, whiteSpace: "nowrap", "&:hover": { backgroundColor: alpha(handTone, 0.18) } }}>
          <EditOutlinedIcon sx={{ fontSize: 18 }} />
          {frozen ? t("panel.applied", { n: frozen.n }) : t("draft.kind.hand.short")}
          {shownCount > 0 && (
            <Box component="span" data-testid="draft-hand-count" sx={{ minWidth: 20, height: 20, px: 0.5, borderRadius: 99, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "0.72rem", color: theme.palette.getContrastText(handTone), backgroundColor: handTone }}>
              {shownCount}
            </Box>
          )}
        </ButtonBase>
      </Tooltip>
      {switcher}
      </Box>
      <Drawer anchor="right" open={open} onClose={onClose} PaperProps={{ sx: { width: 400, maxWidth: "100vw", display: "flex", flexDirection: "column", backgroundImage: "none", borderLeft: `1px solid ${theme.palette.divider}`, boxShadow: `-12px 0 32px ${alpha(theme.palette.common.black, dark ? 0.4 : 0.1)}` } }} data-testid="draft-hand-panel">
        {/* The head: the way's mark, its name and its one state, « ⋯ », close. */}
        <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1.5, px: 2.5, pt: 2.25, pb: 2, borderBottom: `1px solid ${theme.palette.divider}` }}>
          <Box aria-hidden sx={{ width: 40, height: 40, flexShrink: 0, borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", color: handText, backgroundColor: alpha(handTone, dark ? 0.2 : 0.12) }}>
            <EditOutlinedIcon sx={{ fontSize: 20 }} />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0, pt: "1px" }}>
            <Typography component="h2" sx={{ fontSize: "1.02rem", fontWeight: 750, lineHeight: 1.3 }}>
              {t("draft.hand.panel")}
            </Typography>
            <Box sx={{ mt: 0.4, display: "flex", alignItems: "center", gap: 0.75, minWidth: 0, fontSize: "0.8rem", fontWeight: 600, color: stateText }}>
              {state.busy ? <CircularProgress size={12} sx={{ flexShrink: 0 }} /> : <Box component="span" aria-hidden sx={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, backgroundColor: state.tone === "info" ? handTone : stateMain }} />}
              <Typography component="span" role="status" data-testid="change-status" data-tone={state.tone} sx={{ minWidth: 0, fontSize: "inherit", fontWeight: "inherit", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {state.text}
              </Typography>
              {state.seconds != null && <Box component="span" aria-hidden data-testid="change-status-seconds" sx={{ flexShrink: 0, fontVariantNumeric: "tabular-nums", opacity: 0.8 }}>{t("draft.state.seconds", { seconds: state.seconds })}</Box>}
            </Box>
          </Box>
          <Tooltip title={t("draft.more")}>
            <IconButton size="small" onClick={(e) => setMenuAnchor(e.currentTarget)} aria-label={t("draft.more")} aria-haspopup="menu" data-testid="draft-hand-more" sx={{ width: 34, height: 34, borderRadius: "10px", color: "text.secondary" }}>
              <MoreHorizRoundedIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title={t("panel.dialog.back")}>
            <IconButton size="small" onClick={onClose} aria-label={t("panel.dialog.back")} data-testid="draft-hand-close" sx={{ width: 34, height: 34, borderRadius: "10px", color: "text.secondary" }}>
              <CloseRoundedIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </Tooltip>
        </Box>
        <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)} anchorOrigin={{ vertical: "bottom", horizontal: "right" }} transformOrigin={{ vertical: "top", horizontal: "right" }} PaperProps={{ sx: { minWidth: 220, borderRadius: "12px" } }}>
          <MenuItem onClick={closeAnd(onVersions)} data-testid="draft-hand-versions" sx={{ fontSize: "0.88rem" }}>
            <ListItemIcon><HistoryRoundedIcon fontSize="small" /></ListItemIcon>
            {t("decision.versions")}
          </MenuItem>
          {!frozen && <Divider />}
          {!frozen && (
            <MenuItem onClick={closeAnd(onAbandonAsk)} data-testid="draft-abandon" sx={{ fontSize: "0.88rem", color: "error.main" }}>
              <ListItemIcon sx={{ color: "inherit" }}><DeleteOutlineRoundedIcon fontSize="small" /></ListItemIcon>
              {t("draft.abandon")}
            </MenuItem>
          )}
        </Menu>
        <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 2.5, py: 2, display: "flex", flexDirection: "column", gap: 2.5 }}>
          {notices}
          {hasRetouches && (
            <Box component="section">
              {overline(t("draft.hand.section"), "draft-hand-retouches-title")}
              {frozen ? <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>{retouches.map((op) => renderOperation(op))}</Box> : retouchesNode}
            </Box>
          )}
          {/* Applied: the version it became, and the next change from it. */}
          {frozen && (
            <Box data-testid="draft-hand-applied" sx={{ mt: hasRetouches ? 0 : 4, mx: "auto", maxWidth: 300, display: "flex", flexDirection: "column", alignItems: "center", gap: 1, textAlign: "center" }}>
              <Box aria-hidden sx={{ width: 56, height: 56, mb: 0.5, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: textToneOf(theme, theme.palette.success), backgroundColor: alpha(theme.palette.success.main, dark ? 0.18 : 0.12) }}>
                <TaskAltRoundedIcon sx={{ fontSize: 28 }} />
              </Box>
              <Typography sx={{ fontSize: "0.95rem", fontWeight: 700 }}>{t("panel.applied", { n: frozen.n })}</Typography>
              <Typography sx={{ fontSize: "0.82rem", color: "text.secondary", lineHeight: 1.55 }}>{t("draft.hand.appliedHint")}</Typography>
              {onNewDraft && (
                <Button variant="outlined" onClick={closeAnd(onNewDraft)} data-testid="draft-hand-new" sx={{ mt: 1, textTransform: "none", fontWeight: 650, borderRadius: "10px" }}>
                  {t("direct.applied.new")}
                </Button>
              )}
            </Box>
          )}
          {/* Nothing yet: what to do, once, where the retouches will be. */}
          {!frozen && !hasRetouches && !joined.length && (
            <Box data-testid="draft-hand-empty" sx={{ mt: 4, mx: "auto", maxWidth: 300, display: "flex", flexDirection: "column", alignItems: "center", gap: 1, textAlign: "center" }}>
              <Box aria-hidden sx={{ width: 56, height: 56, mb: 0.5, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: handText, backgroundColor: alpha(handTone, dark ? 0.16 : 0.1) }}>
                <TouchAppOutlinedIcon sx={{ fontSize: 28 }} />
              </Box>
              <Typography sx={{ fontSize: "0.95rem", fontWeight: 700 }}>{t("draft.hand.emptyTitle")}</Typography>
              <Typography sx={{ fontSize: "0.82rem", color: "text.secondary", lineHeight: 1.55 }}>{t("draft.hand.emptyHint")}</Typography>
            </Box>
          )}
          {joined.length > 0 && (
            <Box component="section" sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
              {overline(t("draft.hand.assistant"), "draft-hand-assistant", joined.length)}
              {joined.map((op) => renderOperation(op))}
            </Box>
          )}
        </Box>
        {/* The foot: « Quitter » beside the one act. */}
        <Box sx={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 1, px: 2.5, py: 1.75, borderTop: `1px solid ${theme.palette.divider}`, backgroundColor: k.subtle }}>
          {onLeave && (
            <Tooltip title={t("panel.leave.hint")}>
              <Button onClick={onLeave} data-testid="panel-leave" sx={{ height: 42, px: 1.75, textTransform: "none", fontWeight: 650, color: "text.secondary", borderRadius: "11px", flexShrink: 0 }}>
                {t("panel.leave")}
              </Button>
            </Tooltip>
          )}
          {frozen ? (
            <>
              <Button variant="outlined" onClick={closeAnd(onApplied)} data-testid="panel-applied" sx={{ height: 42, textTransform: "none", fontWeight: 650, borderRadius: "11px", whiteSpace: "nowrap", flexShrink: 0 }}>
                {t("panel.applied", { n: frozen.n })}
              </Button>
              <Button variant="contained" disableElevation onClick={closeAnd(onDeliver)} data-testid="panel-deliver" sx={{ flex: 1, height: 42, textTransform: "none", fontWeight: 700, borderRadius: "11px" }}>
                {t("delivery.deliver")}
              </Button>
            </>
          ) : (
            <Button variant="contained" disableElevation onClick={closeAnd(onApply)} disabled={applyDisabled} data-testid="panel-apply" sx={{ flex: 1, height: 42, textTransform: "none", fontWeight: 700, fontSize: "0.92rem", borderRadius: "11px" }}>
              {t("panel.apply", { n: nextN })}
            </Button>
          )}
        </Box>
      </Drawer>
    </>
  );
}
