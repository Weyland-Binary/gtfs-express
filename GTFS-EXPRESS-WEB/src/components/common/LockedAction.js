/**
 * LockedAction — a button that cannot be used here, with why and what to do.
 *
 * The lock is said before the click, next to the button (never a snackbar
 * after it), and stays until it is lifted. The button is rendered disabled
 * (never hidden: the person sees what exists), described by the reason
 * (`aria-describedby`), and the action that lifts the lock — sign in, see
 * the plans, request an access, continue by hand — sits right after it.
 *
 *   <LockedAction lock={{ reason, action: { label, onClick } }} startIcon={…}>Design with the assistant</LockedAction>
 *   lock = null → the plain button, enabled (`onClick`)
 *
 * The reason comes from the server's `access` object through the caller
 * (AccountContext.studioLock): this component never decides a
 * lock by itself.
 */

import React, { useId } from "react";
import { Box, Button, Typography } from "@mui/material";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import { useLanguage } from "../../contexts/LanguageContext";

export default function LockedAction({ lock = null, children, onClick = null, startIcon = null, variant = "contained", size = "small", testid = "locked-action", buttonTestid = null, sx = {} }) {
  const { t } = useLanguage();
  const reasonId = useId();
  if (!lock) {
    return (
      <Button variant={variant} size={size} disableElevation startIcon={startIcon} onClick={onClick} data-testid={buttonTestid || undefined} sx={{ textTransform: "none", fontWeight: 700, ...sx }}>
        {children}
      </Button>
    );
  }
  const action = lock.action || null;
  return (
    <Box data-testid={testid} sx={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 0.5, ...sx }}>
      <Button variant={variant} size={size} disableElevation disabled startIcon={<LockOutlinedIcon sx={{ fontSize: 16 }} />} aria-describedby={reasonId} title={t("locked.reason", { reason: lock.reason, action: action?.label || "" })} data-testid={buttonTestid || undefined} sx={{ textTransform: "none", fontWeight: 700 }}>
        {children}
      </Button>
      <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 0.5 }}>
        <Typography id={reasonId} component="span" sx={{ fontSize: "0.74rem", color: "text.secondary", lineHeight: 1.45 }} data-testid={`${testid}-reason`}>
          {lock.reason}
        </Typography>
        {action && (
          <Button size="small" variant="text" onClick={action.onClick} href={action.href || undefined} target={action.href ? "_blank" : undefined} rel={action.href ? "noreferrer" : undefined} data-testid={`${testid}-action`} sx={{ textTransform: "none", fontWeight: 700, fontSize: "0.74rem", minWidth: 0, px: 0.75, py: 0 }}>
            {action.label}
          </Button>
        )}
      </Box>
    </Box>
  );
}
