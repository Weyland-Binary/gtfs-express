/**
 * ModifyMenu — « Modifier ▾ » in the reader's toolbar, on every tab (the owner's go of 2026-10-08: the ways to modify
 * a network made visible again, as ways to work on the same network, in the same project — never two journeys to
 * choose between up front):
 *
 *   Retoucher à la main      (`modify-by-hand`) edit mode, here: the timetables' grid, the shapes (their tab appears),
 *                            the stops, the SQL console in writing — each retouch undoable. Through the same path as the
 *                            status bar's « Éditer » (`gtfs:enter-edit-mode`: the network put in its project first).
 *   Préparer un changement   (`modify-change`) the Change Studio: the brief, the objectives, operations simulated and
 *                            checked, the delivery (`gtfs:open-change-studio`, which joins the project already working on
 *                            the network).
 *
 * Both stay in one project (its journal, its versions, its one delivery), said under them. While editing, the button is
 * « Terminer l'édition » (`modify-finish`), through the unsaved-changes guard as the status bar's « Quitter l'édition ».
 * Held (the reader shows a simulated draft), retouching by hand is not offered: the item says why.
 *
 * Under the paid offer without the licence (featuresApi.paidLockOf "edit"), both ways stay listed — what they are is
 * part of the offer — with a lock, and each opens the offer (openPaywall) instead of starting; the menu's head says
 * what lifts the lock (the licence, its free trial).
 *
 * AssistantButton — « Assistant » beside it (`toolbar-assistant`): the assistant by name, not only the round button of
 * the screen's corner (CHAT_OPEN_EVENT); in edit mode it applies its fixes to the same working copy. Shown where the
 * server offers the chat.
 */

import React, { useState } from "react";
import { Box, Button, Divider, ListItemIcon, Menu, MenuItem, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import AutoFixHighOutlinedIcon from "@mui/icons-material/AutoFixHighOutlined";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import FolderSpecialOutlinedIcon from "@mui/icons-material/FolderSpecialOutlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import { useEditMode } from "../../contexts/EditModeContext";
import { useDestructiveGuard } from "../../contexts/DestructiveGuardContext";
import { useLanguage } from "../../contexts/LanguageContext";
import { openPaywall, paidLockOf, useFeatures } from "../../utils/featuresApi";
import { openModifyProject } from "../HomeNextStep";
import { CHAT_OPEN_EVENT } from "../chat/ChatAssistantFAB";

const buttonSx = { textTransform: "none", fontWeight: 700, borderRadius: "10px", whiteSpace: "nowrap", height: 36 };

export default function ModifyMenu({ compact = false }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { editing, entering, clearError, exitEditMode, editHold = null } = useEditMode();
  const { guard } = useDestructiveGuard();
  const { features } = useFeatures();
  const [anchor, setAnchor] = useState(null);
  // The licence is wanted (paid offer): what each way would start opens the offer instead.
  const lock = paidLockOf(features?.access, "edit");
  const trialDays = features?.access?.billing?.trial_days || 0;
  const gated = (fn) => (lock ? () => openPaywall("edit", lock) : fn);

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

  const close = () => setAnchor(null);
  const item = (testid, Icon, color, title, body, onClick, disabledWhy = null) => (
      <MenuItem
        data-testid={testid}
        data-locked={lock ? "1" : undefined}
        disabled={Boolean(disabledWhy)}
        onClick={() => {
          close();
          onClick();
        }}
        sx={{ alignItems: "flex-start", gap: 1.25, py: 1.25, px: 2, whiteSpace: "normal" }}
      >
        <ListItemIcon sx={{ minWidth: 0, mt: "2px" }}>
          <Box sx={{ width: 32, height: 32, borderRadius: "9px", display: "flex", alignItems: "center", justifyContent: "center", color, backgroundColor: alpha(color, theme.palette.mode === "dark" ? 0.2 : 0.1) }}>
            <Icon sx={{ fontSize: 18 }} />
          </Box>
        </ListItemIcon>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: "0.88rem", fontWeight: 700, lineHeight: 1.35, display: "flex", alignItems: "center", gap: 0.5 }}>
            {title}
            {lock && <LockOutlinedIcon sx={{ fontSize: 14, color: "text.secondary" }} />}
          </Typography>
          <Typography sx={{ fontSize: "0.76rem", color: "text.secondary", lineHeight: 1.45 }}>{disabledWhy || body}</Typography>
        </Box>
      </MenuItem>
  );

  return (
    <>
      <Button
        variant="contained"
        disableElevation
        startIcon={compact ? null : lock ? <LockOutlinedIcon /> : <EditOutlinedIcon />}
        endIcon={<ExpandMoreRoundedIcon sx={{ transform: anchor ? "rotate(180deg)" : "none", transition: "transform 160ms" }} />}
        onClick={(e) => setAnchor(e.currentTarget)}
        disabled={entering}
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        aria-controls={anchor ? "modify-menu-list" : undefined}
        data-testid="modify-menu"
        data-locked={lock ? "1" : undefined}
        sx={{ ...buttonSx, px: 1.75 }}
      >
        {t("modify.menu")}
      </Button>
      <Menu
        id="modify-menu-list"
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={close}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { mt: 0.75, width: 380, maxWidth: "calc(100vw - 24px)", borderRadius: "12px", border: `1px solid ${theme.palette.divider}`, boxShadow: `0 18px 40px ${alpha("#000", theme.palette.mode === "dark" ? 0.45 : 0.12)}` } } }}
      >
        {lock && (
          <Box data-testid="modify-locked" sx={{ px: 2, pt: 1, pb: 1.25, display: "flex", gap: 1, alignItems: "flex-start" }}>
            <LockOutlinedIcon sx={{ fontSize: 16, mt: "2px", color: "primary.main" }} />
            <Typography sx={{ fontSize: "0.76rem", lineHeight: 1.45 }}>{trialDays > 0 ? t("modify.lockedTrial", { days: trialDays }) : t("modify.locked")}</Typography>
          </Box>
        )}
        {item("modify-by-hand", EditOutlinedIcon, theme.palette.warning.main, t("modify.byHand"), t("modify.byHandBody"), gated(() => window.dispatchEvent(new CustomEvent("gtfs:enter-edit-mode"))), editHold ? t(editHold) : null)}
        {item("modify-change", AutoFixHighOutlinedIcon, theme.palette.ai?.main || theme.palette.primary.main, t("modify.change"), t("modify.changeBody"), gated(() => openModifyProject()))}
        <Divider sx={{ my: 0.5 }} />
        <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, px: 2, py: 1 }}>
          <FolderSpecialOutlinedIcon sx={{ fontSize: 16, mt: "2px", color: "text.secondary" }} />
          <Typography sx={{ fontSize: "0.74rem", color: "text.secondary", lineHeight: 1.45 }}>{t("modify.sameProject")}</Typography>
        </Box>
      </Menu>
    </>
  );
}

export function AssistantButton({ compact = false }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { features } = useFeatures();
  if (features?.chat?.enabled !== true) return null;
  const ai = theme.palette.ai || {};
  const open = () => window.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT));
  const sx = { ...buttonSx, color: ai.main, borderColor: alpha(ai.main || theme.palette.primary.main, 0.45), "&:hover": { borderColor: ai.main, backgroundColor: alpha(ai.main || theme.palette.primary.main, 0.08) } };
  const icon = <AutoAwesomeIcon sx={{ fontSize: "18px !important" }} />;
  return compact ? (
    <Tooltip title={t("chat.fab.tooltip")}>
      <Button variant="outlined" onClick={open} aria-label={t("modify.assistant")} data-testid="toolbar-assistant" sx={{ ...sx, minWidth: 36, px: 0 }}>
        {icon}
      </Button>
    </Tooltip>
  ) : (
    <Tooltip title={t("chat.fab.tooltip")}>
      <Button variant="outlined" startIcon={icon} onClick={open} data-testid="toolbar-assistant" sx={{ ...sx, px: 1.5 }}>
        {t("modify.assistant")}
      </Button>
    </Tooltip>
  );
}
