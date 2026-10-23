/**
 * Natural language to SQL, a Popover opened from the console's toolbar (`anchorEl`, null when closed). Only the
 * button submits, so Ctrl+Enter keeps running the editor's query. The SQL is never run: it goes into the editor.
 * A 402 or a paid 401 opens the offer through fetchWithSession (PAYWALL_EVENT). `currentMode` ("read" | "edit")
 * tells the backend whether writes are allowed.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  InputAdornment,
  Popover,
  TextField,
  Tooltip,
  Typography,
  Alert,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CloseIcon from "@mui/icons-material/Close";
import LightbulbOutlinedIcon from "@mui/icons-material/LightbulbOutlined";
import EditNoteIcon from "@mui/icons-material/EditNote";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { MONO_FONT, NL2SQL_PREFILL_KEY } from "./constants";

// sessionStorage, not localStorage, for privacy: the request survives a close and a tab switch, not the browser session.
const NL_REQUEST_KEY = "gtfs_nl2sql_last_request";

const PROMPT_SUGGESTION_KEYS = [
  "nl2sql.suggestion.busiestStops",
  "nl2sql.suggestion.routesWithoutTrips",
  "nl2sql.suggestion.servicesActiveMonday",
  "nl2sql.suggestion.tripsAfterMidnight",
];

function NL2SQLPanel({ anchorEl, onClose, onInsertSql, currentMode = "read" }) {
  const { t, language } = useLanguage();
  const theme = useTheme();

  const open = Boolean(anchorEl);

  const [request, setRequest] = useState(() => {
    try {
      return sessionStorage.getItem(NL_REQUEST_KEY) || "";
    } catch {
      return "";
    }
  });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const textareaRef = useRef(null);

  // Only the request is kept, never the SQL.
  useEffect(() => {
    try {
      if (request) sessionStorage.setItem(NL_REQUEST_KEY, request);
    } catch {
      /* ignore */
    }
  }, [request]);

  // After the entry transition: focusing during it breaks Safari's scroll-into-view.
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => textareaRef.current?.focus(), 120);
    return () => clearTimeout(id);
  }, [open]);

  // A question parked by another screen (« Ask AI to fix »), cleared on read.
  useEffect(() => {
    if (!open) return;
    try {
      const prefill = sessionStorage.getItem(NL2SQL_PREFILL_KEY);
      if (prefill) {
        sessionStorage.removeItem(NL2SQL_PREFILL_KEY);
        setRequest(prefill);
        setResult(null);
        setError(null);
      }
    } catch {
      /* sessionStorage unavailable: nothing to prefill */
    }
  }, [open]);

  const generate = useCallback(
    async () => {
      const trimmed = request.trim();
      if (trimmed.length < 3) {
        setError({
          code: "INVALID_INPUT",
          message: t("nl2sql.error.tooShort"),
        });
        return;
      }
      setSubmitting(true);
      setError(null);
      setResult(null);
      try {
        const res = await fetchWithSession(`${API_BASE_URL}/sql/nl2sql`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            naturalLanguage: trimmed,
            mode: currentMode === "edit" ? "edit" : "read",
            language,
          }),
        });
        const body = await res.json().catch(() => ({}));

        // The offer is already open (PAYWALL_EVENT).
        if (res.status === 402 || (res.status === 401 && body.paid === true)) {
          return { ok: false, errorCode: body.error, paywall: true };
        }
        if (!res.ok) {
          // The AI cost guard's refusals in the person's language; other errors fall back to body.message.
          const localised = {
            RATE_LIMITED: t("nl2sql.error.rateLimited"),
            DAILY_LIMIT_REACHED: t("nl2sql.error.dailyLimit"),
            BUDGET_EXHAUSTED: t("nl2sql.error.budgetExhausted"),
          }[body.error];
          setError({
            code: body.error || "UPSTREAM_ERROR",
            message:
              localised || body.message || t("nl2sql.error.generic"),
          });
          return { ok: false, errorCode: body.error };
        }

        setResult({
          sql: body.sql || "",
          explanation: body.explanation || "",
          model: body.model || "",
        });
        return { ok: true };
      } catch (err) {
        setError({
          code: "NETWORK_ERROR",
          message: err?.message || t("nl2sql.error.network"),
        });
        return { ok: false, errorCode: "NETWORK_ERROR" };
      } finally {
        setSubmitting(false);
      }
    },
    [request, currentMode, language, t],
  );

  const handleInsert = useCallback(() => {
    if (!result?.sql) return;
    onInsertSql?.(result.sql);
    onClose?.();
  }, [result, onInsertSql, onClose]);

  const handleCopy = useCallback(async () => {
    if (!result?.sql) return;
    try {
      await navigator.clipboard.writeText(result.sql);
    } catch {
      /* clipboard API unavailable */
    }
  }, [result]);

  const handleClear = useCallback(() => {
    setRequest("");
    setResult(null);
    setError(null);
    try {
      sessionStorage.removeItem(NL_REQUEST_KEY);
    } catch {
      /* ignore */
    }
    textareaRef.current?.focus();
  }, []);

  const onSuggestionClick = useCallback((suggestionText) => {
    setRequest(suggestionText);
    textareaRef.current?.focus();
  }, []);

  return (
    <>
      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={onClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: {
            elevation: 4,
            sx: {
              width: 640,
              maxWidth: "90vw",
              borderRadius: 2,
              mt: 0.5,
            },
          },
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 1.5,
            py: 1,
            borderBottom: `1px solid ${theme.palette.divider}`,
            background: alpha("#C9A84C", 0.06),
          }}
        >
          <AutoAwesomeIcon sx={{ fontSize: 18, color: "#C9A84C" }} />
          <Typography variant="body2" fontWeight={700}>
            {t("nl2sql.title")}
          </Typography>
          <Chip
            size="small"
            label={t("nl2sql.betaTag")}
            sx={{
              height: 18,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.5,
              background: theme.palette.warning.main,
              color: theme.palette.warning.contrastText,
            }}
          />
          <Chip
            size="small"
            variant="outlined"
            label={
              currentMode === "edit"
                ? t("nl2sql.modeEdit")
                : t("nl2sql.modeRead")
            }
            sx={{ fontSize: 10, height: 20 }}
          />
          <Box sx={{ flex: 1 }} />
          <Tooltip title={t("app.close") || ""}>
            <IconButton
              size="small"
              onClick={onClose}
              aria-label={t("app.close") || "Close"}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>

        <Box sx={{ px: 1.5, pb: 1.5, pt: 1.25 }}>
          <TextField
            inputRef={textareaRef}
            multiline
            minRows={2}
            maxRows={6}
            fullWidth
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder={t("nl2sql.placeholder")}
            disabled={submitting}
            slotProps={{
              htmlInput: {
                spellCheck: true,
                "aria-label": t("nl2sql.title"),
                maxLength: 2000,
              },
              input: {
                endAdornment: request ? (
                  <InputAdornment
                    position="end"
                    sx={{ alignSelf: "flex-start", mt: 0.5 }}
                  >
                    <Tooltip title={t("app.clear")}>
                      <IconButton
                        size="small"
                        onClick={handleClear}
                        disabled={submitting}
                        aria-label={t("app.clear")}
                      >
                        <EditNoteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </InputAdornment>
                ) : null,
              },
            }}
            sx={{
              "& .MuiOutlinedInput-root": {
                background: theme.palette.background.paper,
                fontSize: 14,
              },
            }}
          />

          {!request && (
            <Box
              sx={{
                display: "flex",
                flexWrap: "wrap",
                gap: 0.5,
                mt: 0.75,
                alignItems: "center",
              }}
            >
              <LightbulbOutlinedIcon
                sx={{ fontSize: 14, color: "text.secondary", mr: 0.25 }}
              />
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ mr: 0.5 }}
              >
                {t("nl2sql.tryLabel")}
              </Typography>
              {PROMPT_SUGGESTION_KEYS.map((key) => {
                const text = t(key);
                return (
                  <Chip
                    key={key}
                    label={text}
                    size="small"
                    variant="outlined"
                    onClick={() => onSuggestionClick(text)}
                    sx={{
                      fontSize: 11,
                      height: 22,
                      cursor: "pointer",
                    }}
                  />
                );
              })}
            </Box>
          )}

          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              mt: 1,
              flexWrap: "wrap",
            }}
          >
            <Button
              variant="contained"
              size="small"
              disabled={submitting || request.trim().length < 3}
              onClick={() => generate()}
              startIcon={
                submitting ? (
                  <CircularProgress size={14} color="inherit" />
                ) : (
                  <AutoAwesomeIcon fontSize="small" />
                )
              }
              sx={{
                textTransform: "none",
                fontWeight: 700,
                background: "#C9A84C",
                color: "#fff",
                "&:hover": { background: "#b8973e" },
                "&.Mui-disabled": {
                  background: alpha("#C9A84C", 0.3),
                  color: "rgba(255,255,255,0.5)",
                },
              }}
            >
              {submitting ? t("nl2sql.generating") : t("nl2sql.generate")}
            </Button>
          </Box>

          {error && (
            <Alert
              severity={error.code === "NL2SQL_DISABLED" ? "info" : "error"}
              sx={{ mt: 1, fontSize: 13 }}
              variant="outlined"
            >
              <strong>{error.code}</strong>
              {error.message ? ` — ${error.message}` : null}
            </Alert>
          )}

          {result?.sql && (
            <Box
              sx={{
                mt: 1.25,
                border: `1px solid ${theme.palette.divider}`,
                borderRadius: 1.5,
                background: theme.palette.background.paper,
                overflow: "hidden",
              }}
            >
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.75,
                  px: 1.25,
                  py: 0.5,
                  background: alpha(theme.palette.info.main, 0.08),
                  borderBottom: `1px solid ${theme.palette.divider}`,
                }}
              >
                <Typography variant="caption" fontWeight={700} sx={{ flex: 1 }}>
                  {t("nl2sql.generatedSql")}
                </Typography>
                {result.model && (
                  <Chip
                    size="small"
                    label={result.model}
                    variant="outlined"
                    sx={{ fontSize: 10, height: 18, fontFamily: MONO_FONT }}
                  />
                )}
                <Tooltip title={t("nl2sql.copy")}>
                  <IconButton
                    size="small"
                    onClick={handleCopy}
                    aria-label={t("nl2sql.copy")}
                  >
                    <ContentCopyIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </Tooltip>
              </Box>
              <Box
                component="pre"
                sx={{
                  m: 0,
                  px: 1.25,
                  py: 1,
                  fontFamily: MONO_FONT,
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  color: theme.palette.text.primary,
                  maxHeight: 240,
                  overflow: "auto",
                }}
              >
                {result.sql}
              </Box>
              {result.explanation && (
                <Box
                  sx={{
                    px: 1.25,
                    py: 0.75,
                    borderTop: `1px solid ${theme.palette.divider}`,
                    background: alpha(theme.palette.info.main, 0.04),
                  }}
                >
                  <Typography variant="caption" color="text.secondary">
                    <strong>{t("nl2sql.explanation")}</strong>
                    {" — "}
                    {result.explanation}
                  </Typography>
                </Box>
              )}
              <Box
                sx={{
                  display: "flex",
                  gap: 1,
                  px: 1.25,
                  py: 0.75,
                  borderTop: `1px solid ${theme.palette.divider}`,
                }}
              >
                <Button
                  variant="contained"
                  size="small"
                  onClick={handleInsert}
                  sx={{ textTransform: "none", fontWeight: 700 }}
                >
                  {t("nl2sql.insertIntoEditor")}
                </Button>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ alignSelf: "center" }}
                >
                  {t("nl2sql.notExecuted")}
                </Typography>
              </Box>
            </Box>
          )}
        </Box>
      </Popover>
    </>
  );
}

export default NL2SQLPanel;
