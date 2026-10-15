/**
 * ModifyMenu — « Modifier » in the reader's toolbar, on every tab: the one way to modify a network (2026-10-13, the
 * owner's one screen). It opens the network's draft — the project already working on it, else a new one — as the
 * reader with its panel « Modifications » beside it, where the change is described, built, retouched, applied and
 * delivered (`gtfs:open-change-studio`, GTFSApp). No menu of two journeys to choose between up front.
 *
 * Under the paid offer without the licence (featuresApi.licenceLockOf) the button wears a lock and opens the offer
 * (openPaywall) instead, the draft opened once the licence runs; its tooltip says what lifts the lock (the licence, its
 * free trial). While edit mode is on (a retouch left open outside a draft), the button is « Terminer l'édition »
 * (`modify-finish`), through the unsaved-changes guard as the status bar's « Quitter l'édition ».
 *
 * AssistantButton — « Assistant » beside it (`toolbar-assistant`): the assistant by name, not only the round button of
 * the screen's corner (CHAT_OPEN_EVENT); in edit mode it applies its fixes to the same working copy. Shown where the
 * server offers the chat.
 */

import React from "react";
import { Badge, Box, Button, ListItemIcon, ListItemText, Menu, MenuItem, Tooltip, alpha, useTheme } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import { useEditMode } from "../../contexts/EditModeContext";
import { useDestructiveGuard } from "../../contexts/DestructiveGuardContext";
import { useLanguage } from "../../contexts/LanguageContext";
import { licenceLockOf, openPaywall, useFeatures } from "../../utils/featuresApi";
import { openModifyProject } from "../../utils/modifyProject";
import { kindToneOf } from "../transform/draftKinds";
import { CHAT_OPEN_EVENT, useAssistantNudge } from "../chat/ChatAssistantFAB";

const buttonSx = { textTransform: "none", fontWeight: 700, borderRadius: "10px", whiteSpace: "nowrap", height: 36 };

// `draftInProgress`: the kind of the draft already in progress on this network (« hand » | « brief »), else null.
export default function ModifyMenu({ compact = false, draftInProgress = null }) {
  const theme = useTheme();
  const [anchor, setAnchor] = React.useState(null);
  const { t } = useLanguage();
  const { editing, entering, clearError, exitEditMode } = useEditMode();
  const { guard } = useDestructiveGuard();
  const { features } = useFeatures();
  // The licence is wanted (paid offer): the draft would start, the offer opens instead.
  const lock = licenceLockOf(features?.access);
  const trialDays = features?.access?.billing?.trial_days || 0;
  // Without the licence: the offer, and the way chosen carried out once the licence runs.
  const gated = (fn) => (lock ? () => openPaywall("edit", lock, fn) : fn);

  if (editing) {
    return (
      <Button
        variant="contained"
        color="success"
        disableElevation
        startIcon={<CheckRoundedIcon />}
        onClick={() => {
          clearError?.();
          guard(() => exitEditMode(), { reason: "exitEditMode" });
        }}
        data-testid="modify-finish"
        sx={{ ...buttonSx, px: 1.75 }}
      >
        {t("modify.finish")}
      </Button>
    );
  }

  const button = (
    <Tooltip title={lock ? (trialDays > 0 ? t("modify.lockedTrial", { days: trialDays }) : t("modify.locked")) : anchor ? "" : t("modify.open.hint")}>
      <span>
        <Button
          variant="contained"
          disableElevation
          startIcon={compact ? null : lock ? <LockOutlinedIcon /> : <EditOutlinedIcon />}
          endIcon={compact || lock ? null : <ExpandMoreIcon />}
          onClick={lock ? gated(() => openModifyProject()) : (e) => setAnchor(e.currentTarget)}
          disabled={entering}
          aria-haspopup={lock ? undefined : "menu"}
          aria-expanded={anchor ? "true" : undefined}
          data-testid="modify-menu"
          data-locked={lock ? "1" : undefined}
          sx={{ ...buttonSx, px: 1.75 }}
        >
          {t("modify.menu")}
        </Button>
      </span>
    </Tooltip>
  );
  const pick = (kind) => () => {
    setAnchor(null);
    openModifyProject(kind ? { kind } : undefined);
  };
  // The two ways of modifying, kept apart; a draft in progress is resumed in its own way, the other waits for it.
  const way = (kind, Icon, testid) => (
    <MenuItem key={kind} onClick={pick(kind)} disabled={Boolean(draftInProgress) && draftInProgress !== kind} data-testid={testid} sx={{ alignItems: "flex-start", gap: 1.75, py: 1.25, px: 2, maxWidth: 400, "& .MuiListItemIcon-root": { minWidth: 0 } }}>
      <ListItemIcon sx={{ mt: 0.25 }}>
        <Box component="span" aria-hidden sx={{ width: 34, height: 34, borderRadius: "9px", display: "inline-flex", alignItems: "center", justifyContent: "center", color: kindToneOf(theme, kind), backgroundColor: alpha(kindToneOf(theme, kind), 0.12) }}>
          <Icon fontSize="small" />
        </Box>
      </ListItemIcon>
      <ListItemText primary={t(`draft.kind.${kind}`)} secondary={draftInProgress && draftInProgress !== kind ? t("draft.otherBlocked") : t(`draft.kind.${kind}.hint`)} primaryTypographyProps={{ fontWeight: 700, fontSize: "0.9rem" }} secondaryTypographyProps={{ fontSize: "0.78rem", whiteSpace: "normal" }} />
    </MenuItem>
  );
  return (
    <>
      {button}
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: "bottom", horizontal: "right" }} transformOrigin={{ vertical: "top", horizontal: "right" }} data-testid="modify-ways">
        {draftInProgress && (
          <MenuItem onClick={pick(null)} data-testid="modify-resume" sx={{ py: 1.25 }}>
            <ListItemIcon>
              <PlayArrowRoundedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t("draft.resume", { kind: t(`draft.kind.${draftInProgress}`) })} primaryTypographyProps={{ fontWeight: 700, fontSize: "0.9rem" }} />
          </MenuItem>
        )}
        {way("hand", EditOutlinedIcon, "modify-hand")}
        {way("brief", DescriptionOutlinedIcon, "modify-brief")}
      </Menu>
    </>
  );
}

export function AssistantButton({ compact = false }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { features } = useFeatures();
  // What the assistant has to say (ChatAssistantFAB): the sign-in or the offer, a repair plan ready.
  const nudge = useAssistantNudge();
  if (features?.chat?.enabled !== true) return null;
  const ai = theme.palette.ai || {};
  const open = () => window.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT));
  const sx = { ...buttonSx, color: ai.main, borderColor: alpha(ai.main || theme.palette.primary.main, 0.45), "&:hover": { borderColor: ai.main, backgroundColor: alpha(ai.main || theme.palette.primary.main, 0.08) } };
  const icon = <AutoAwesomeIcon sx={{ fontSize: "18px !important" }} />;
  const plan = nudge?.plan || null;
  const button = compact ? (
    <Button variant="outlined" onClick={open} aria-label={t("modify.assistant")} data-testid="toolbar-assistant" sx={{ ...sx, minWidth: 36, px: 0 }}>
      {icon}
    </Button>
  ) : (
    <Button variant="outlined" startIcon={icon} onClick={open} data-testid="toolbar-assistant" sx={{ ...sx, px: 1.5 }}>
      {t("modify.assistant")}
    </Button>
  );
  return (
    <Tooltip title={nudge?.tooltip || t("chat.fab.tooltip")}>
      {plan ? (
        <Badge color={plan.proposals > 0 ? "warning" : "success"} badgeContent={plan.proposals > 0 ? plan.proposals : "✓"} overlap="rectangular" data-testid="toolbar-assistant-plan">
          {button}
        </Badge>
      ) : (
        button
      )}
    </Tooltip>
  );
}
