/**
 * ErrorNotice — a failure shown the plain way: one sentence (humanError),
 * a retry when retrying can help, and the technical text folded behind
 * "Details" for whoever has to report it. Never raw JSON on screen.
 */

import React, { useState } from "react";
import { Box, Button, ButtonBase, Collapse, Typography, alpha, useTheme } from "@mui/material";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import ReportGmailerrorredOutlinedIcon from "@mui/icons-material/ReportGmailerrorredOutlined";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { useLanguage } from "../../contexts/LanguageContext";
import { humanError } from "../../utils/humanError";

export default function ErrorNotice({ error = null, human = null, context = null, onRetry = null, retryLabel = null, severity = "error", testid = "error-notice", sx = {} }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const h = human || humanError(error, t, { context });
  if (!h || !h.message) return null;
  const color = severity === "warning" ? theme.palette.warning.main : theme.palette.error.main;
  const Icon = severity === "warning" ? ReportGmailerrorredOutlinedIcon : ErrorOutlineIcon;
  const retry = Boolean(onRetry) && h.retryable !== false;
  return (
    <Box data-testid={testid} data-kind={h.kind || ""} role="alert" sx={{ px: 1.25, py: 0.75, borderRadius: 1.5, background: alpha(color, theme.palette.mode === "dark" ? 0.14 : 0.08), ...sx }}>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.75 }}>
        <Icon sx={{ fontSize: 16, color, mt: 0.2, flexShrink: 0 }} />
        <Typography sx={{ flex: 1, minWidth: 0, fontSize: "0.74rem", lineHeight: 1.45, color: "text.primary" }} data-testid={`${testid}-message`}>
          {h.message}
        </Typography>
        {retry && (
          <Button size="small" variant="text" onClick={onRetry} data-testid={`${testid}-retry`} sx={{ textTransform: "none", fontWeight: 700, fontSize: "0.74rem", lineHeight: 1.3, minWidth: 0, px: 0.75, py: 0.2, mt: -0.2, color: severity === "warning" ? "warning.dark" : "error.main", flexShrink: 0 }}>
            {retryLabel || t("error.human.retry")}
          </Button>
        )}
      </Box>
      {h.detail ? (
        <>
          <ButtonBase onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid={`${testid}-details`} sx={{ ml: 2.9, mt: 0.25, borderRadius: 1, px: 0.25, fontSize: "0.66rem", fontWeight: 600, color: "text.secondary", display: "inline-flex", alignItems: "center", gap: 0.25 }}>
            {t("error.human.details")}
            <ExpandMoreIcon sx={{ fontSize: 14, transform: open ? "rotate(180deg)" : "none", transition: "transform 150ms" }} />
          </ButtonBase>
          <Collapse in={open} unmountOnExit>
            <Box component="pre" data-testid={`${testid}-detail`} sx={{ m: 0, mt: 0.5, ml: 2.9, p: 0.75, borderRadius: 1, fontSize: "0.64rem", lineHeight: 1.4, fontFamily: "monospace", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "text.secondary", background: alpha(theme.palette.text.primary, 0.05), maxHeight: 160, overflowY: "auto" }}>
              {h.detail}
            </Box>
          </Collapse>
        </>
      ) : null}
    </Box>
  );
}
