/**
 * « Modifier » in the reader's toolbar: the two ways of modifying the network, by hand or with a brief, each opening
 * the network's draft in its modify project (`gtfs:open-change-studio`). One way per draft: a draft in progress is
 * resumed in its own way, the other waits until it is applied or abandoned. Without the licence the button wears a
 * lock and opens the offer, the draft opened once the licence runs. While edit mode is on outside a draft it is
 * « Terminer l'édition » (`modify-finish`), through the unsaved-changes guard.
 *
 * AssistantButton: « Assistant » beside it opens or closes the reader's assistant panel where the server offers it.
 */

import React from "react";
import { Box, Button, ListItemIcon, ListItemText, Menu, MenuItem, Tooltip, alpha, useTheme } from "@mui/material";
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
import { trackUi } from "../../utils/uiTelemetry";
import { openModifyProject } from "../../utils/modifyProject";
import { kindToneOf } from "../transform/draftKinds";
import { useAssistantNudge } from "../chat/ChatAssistantFAB";
import { CHAT_CLOSE_EVENT, CHAT_OPEN_EVENT } from "../../utils/appEvents";

const buttonSx = { textTransform: "none", fontWeight: 700, borderRadius: "10px", whiteSpace: "nowrap", height: 36 };

// `draftInProgress`: the kind of the draft already in progress on this network (« hand » | « brief »), else null.
export default function ModifyMenu({ compact = false, draftInProgress = null }) {
  const theme = useTheme();
  const [anchor, setAnchor] = React.useState(null);
  const { t } = useLanguage();
  const { editing, entering, clearError, exitEditMode } = useEditMode();
  const { guard } = useDestructiveGuard();
  const { features } = useFeatures();
  const lock = licenceLockOf(features?.access);
  const trialDays = features?.access?.billing?.trial_days || 0;
  // Without the licence the offer opens, and the way chosen is carried out once the licence runs.
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
          onClick={(e) => {
            trackUi("modify.click", "reader");
            if (lock) gated(() => openModifyProject())();
            else setAnchor(e.currentTarget);
          }}
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
  // Its tooltip (the sign-in or the offer when closed to this person) and whether its panel is open.
  const nudge = useAssistantNudge();
  if (features?.chat?.enabled !== true) return null;
  const ai = theme.palette.ai || {};
  const shown = Boolean(nudge?.open);
  const open = () => window.dispatchEvent(new CustomEvent(shown ? CHAT_CLOSE_EVENT : CHAT_OPEN_EVENT));
  const tone = ai.main || theme.palette.primary.main;
  const sx = { ...buttonSx, color: ai.main, borderColor: alpha(tone, shown ? 0.9 : 0.45), backgroundColor: shown ? alpha(tone, 0.12) : "transparent", transition: "background-color .2s, border-color .2s", "&:hover": { borderColor: ai.main, backgroundColor: alpha(tone, shown ? 0.16 : 0.08) } };
  const icon = <AutoAwesomeIcon sx={{ fontSize: "18px !important" }} />;
  const button = compact ? (
    <Button variant="outlined" onClick={open} aria-label={t("modify.assistant")} aria-pressed={shown} data-testid="toolbar-assistant" sx={{ ...sx, minWidth: 36, px: 0 }}>
      {icon}
    </Button>
  ) : (
    <Button variant="outlined" startIcon={icon} onClick={open} aria-pressed={shown} data-testid="toolbar-assistant" sx={{ ...sx, px: 1.5 }}>
      {t("modify.assistant")}
    </Button>
  );
  return (
    <Tooltip title={shown ? t("chat.action.close") : nudge?.tooltip || t("chat.fab.tooltip")}>{button}</Tooltip>
  );
}
