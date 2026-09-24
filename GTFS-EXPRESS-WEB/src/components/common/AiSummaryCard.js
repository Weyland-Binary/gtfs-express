/**
 * AiSummaryCard — a one-shot AI reading of structured data (release notes
 * from the edit log, explanation of a feed diff): generate, read as
 * markdown, copy, regenerate. The request goes to POST /ai/summarize, gated
 * like the chat; the card hides itself when the assistant is disabled.
 */

import React, { useCallback, useState } from "react";
import { Box, Button, CircularProgress, IconButton, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import RefreshIcon from "@mui/icons-material/Refresh";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { useFeatures } from "../../utils/featuresApi";
import MarkdownText from "../chat/MarkdownText";

export async function requestAiSummary({ kind, language, payload }) {
  const res = await fetchWithSession(`${API_BASE_URL}/ai/summarize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, language, payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || body.error || `HTTP ${res.status}`);
    err.code = body.error || null;
    err.status = res.status;
    throw err;
  }
  return body;
}

export default function AiSummaryCard({
  kind,
  payload = null,
  title,
  description,
  generateLabel,
  onGenerated = null,
  dense = false,
  testId = "ai-summary",
}) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const { features } = useFeatures();
  const [phase, setPhase] = useState("idle"); // idle | loading | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  const generate = useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const body = await requestAiSummary({ kind, language, payload });
      setResult(body);
      setPhase("done");
      if (onGenerated) onGenerated(body);
    } catch (err) {
      setError(err.code === "NO_EDITS" ? t("ai.summary.noEdits") : err.message);
      setPhase("error");
    }
  }, [kind, language, payload, onGenerated, t]);

  const copy = useCallback(async () => {
    if (!result?.markdown) return;
    try {
      await navigator.clipboard.writeText(result.markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  }, [result]);

  if (!features?.chat?.enabled) return null;

  return (
    <Box
      data-testid={testId}
      sx={{
        borderRadius: 2.5,
        border: `1px solid ${alpha(theme.palette.ai.main, 0.3)}`,
        background: `linear-gradient(160deg, ${alpha(theme.palette.ai.main, 0.07)} 0%, ${alpha(theme.palette.background.paper, 0.6)} 60%)`,
        p: dense ? 1.5 : 2,
        display: "flex",
        flexDirection: "column",
        gap: 1,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Box
          sx={{
            width: 30,
            height: 30,
            borderRadius: "9px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart} 0%, ${theme.palette.ai.gradientEnd} 100%)`,
            color: theme.palette.ai.contrastText,
            flexShrink: 0,
          }}
        >
          <AutoAwesomeIcon sx={{ fontSize: 17 }} />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 800, fontSize: "0.9rem", lineHeight: 1.2 }}>{title}</Typography>
          {phase !== "done" && description && (
            <Typography sx={{ fontSize: "0.74rem", color: "text.secondary", lineHeight: 1.4 }}>{description}</Typography>
          )}
        </Box>
        {phase === "done" && (
          <>
            <Tooltip title={copied ? t("ai.summary.copied") : t("ai.summary.copy")}>
              <IconButton size="small" onClick={copy} data-testid={`${testId}-copy`} aria-label={t("ai.summary.copy")}>
                {copied ? <CheckIcon sx={{ fontSize: 17, color: "success.main" }} /> : <ContentCopyIcon sx={{ fontSize: 17 }} />}
              </IconButton>
            </Tooltip>
            <Tooltip title={t("ai.summary.regenerate")}>
              <IconButton size="small" onClick={generate} aria-label={t("ai.summary.regenerate")}>
                <RefreshIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>
          </>
        )}
      </Box>

      {phase === "idle" || phase === "error" ? (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
          <Button
            size="small"
            variant="contained"
            disableElevation
            startIcon={<AutoAwesomeIcon sx={{ fontSize: 15 }} />}
            onClick={generate}
            data-testid={`${testId}-generate`}
            sx={{ textTransform: "none", fontWeight: 700, background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart}, ${theme.palette.ai.gradientEnd})` }}
          >
            {generateLabel || t("ai.summary.generate")}
          </Button>
          {error && <Typography sx={{ fontSize: "0.76rem", color: "error.main" }}>{error}</Typography>}
        </Box>
      ) : phase === "loading" ? (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.5 }}>
          <CircularProgress size={16} />
          <Typography sx={{ fontSize: "0.78rem", color: "text.secondary" }}>{t("ai.summary.loading")}</Typography>
        </Box>
      ) : (
        <Box
          data-testid={`${testId}-markdown`}
          sx={{
            maxHeight: dense ? 260 : 420,
            overflowY: "auto",
            fontSize: "0.82rem",
            px: 1.25,
            py: 0.75,
            borderRadius: 1.5,
            background: alpha(theme.palette.background.paper, 0.7),
            border: `1px solid ${alpha(theme.palette.divider, 0.8)}`,
          }}
        >
          <MarkdownText text={result.markdown} />
          <Typography sx={{ fontSize: "0.66rem", color: "text.disabled", mt: 0.75 }}>{t("ai.summary.disclaimer")}</Typography>
        </Box>
      )}
    </Box>
  );
}
