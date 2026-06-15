/**
 * ChatInputBar — Sticky bottom input area: multiline textarea, char counter,
 * Send button (during idle) / Stop button (during streaming).
 *
 * Keyboard:
 *  - Enter sends (when not empty)
 *  - Shift+Enter inserts a newline
 *  - Cmd/Ctrl+Enter also sends (power-user habit from chat apps)
 *
 * The component is dumb — all state lives upstream in ChatDrawer.
 */

import React, { useEffect, useRef } from "react";
import {
  Box,
  TextField,
  IconButton,
  Tooltip,
  alpha,
  useTheme,
  CircularProgress,
} from "@mui/material";
import SendIcon from "@mui/icons-material/Send";
import StopIcon from "@mui/icons-material/Stop";
import { useLanguage } from "../../contexts/LanguageContext";

const MAX_CHARS = 2000;
const NEAR_LIMIT_THRESHOLD = 0.85;

export default function ChatInputBar({
  value,
  onChange,
  onSend,
  onStop,
  streaming = false,
  disabled = false,
  placeholderKey = "chat.input.placeholder",
  autoFocus = false,
}) {
  const { t } = useLanguage();
  const theme = useTheme();
  const inputRef = useRef(null);

  useEffect(() => {
    if (autoFocus) {
      // Slight defer so the Drawer transition doesn't steal focus.
      const id = setTimeout(() => inputRef.current?.focus(), 120);
      return () => clearTimeout(id);
    }
  }, [autoFocus]);

  // Chain-questions flow: the instant a response finishes streaming, give
  // the keyboard back to the user — no click needed for the follow-up.
  const prevStreamingRef = useRef(streaming);
  useEffect(() => {
    if (prevStreamingRef.current && !streaming) {
      inputRef.current?.focus();
    }
    prevStreamingRef.current = streaming;
  }, [streaming]);

  const trimmed = value.trim();
  const canSend = !streaming && !disabled && trimmed.length >= 2 && value.length <= MAX_CHARS;

  const handleKeyDown = (e) => {
    if (streaming) {
      // Allow Esc to stop a running stream from the input.
      if (e.key === "Escape" && onStop) {
        e.preventDefault();
        onStop();
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  const charPct = value.length / MAX_CHARS;
  const showCounter = charPct >= NEAR_LIMIT_THRESHOLD;
  const overLimit = value.length > MAX_CHARS;
  const counterColor = overLimit
    ? theme.palette.error.main
    : charPct >= 0.95
      ? theme.palette.warning.main
      : theme.palette.text.disabled;

  return (
    <Box
      sx={{
        borderTop: `1px solid ${alpha(theme.palette.text.primary, 0.10)}`,
        background: alpha(theme.palette.background.paper, 0.95),
        backdropFilter: "blur(8px)",
        px: 1.25,
        pt: 1,
        pb: 1.25,
        display: "flex",
        flexDirection: "column",
        gap: 0.4,
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "flex-end",
          gap: 0.75,
        }}
      >
        <TextField
          inputRef={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t(placeholderKey)}
          multiline
          minRows={1}
          maxRows={6}
          disabled={disabled}
          fullWidth
          variant="outlined"
          size="small"
          inputProps={{
            "aria-label": t(placeholderKey),
            // Don't enforce maxLength at the DOM level — we want to show
            // the over-limit state visually and let the user trim it.
          }}
          sx={{
            "& .MuiOutlinedInput-root": {
              borderRadius: 2,
              fontSize: "0.86rem",
              lineHeight: 1.45,
              background: theme.palette.background.default,
              transition: "box-shadow 140ms",
              "&:hover .MuiOutlinedInput-notchedOutline": {
                borderColor: alpha(theme.palette.primary.main, 0.45),
              },
              "&.Mui-focused": {
                boxShadow: `0 0 0 3px ${alpha(theme.palette.primary.main, 0.12)}`,
              },
              "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
                borderColor: theme.palette.primary.main,
                borderWidth: 1.5,
              },
            },
          }}
        />
        {streaming ? (
          <Tooltip title={t("chat.input.stop")}>
            <IconButton
              onClick={onStop}
              aria-label={t("chat.input.stop")}
              sx={{
                width: 38,
                height: 38,
                background: alpha(theme.palette.error.main, 0.10),
                color: theme.palette.error.main,
                border: `1px solid ${alpha(theme.palette.error.main, 0.30)}`,
                borderRadius: 2,
                "&:hover": {
                  background: alpha(theme.palette.error.main, 0.18),
                },
              }}
            >
              <StopIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip title={canSend ? t("chat.input.send") : t("chat.input.cannotSend")}>
            <Box>
              <IconButton
                onClick={canSend ? onSend : undefined}
                disabled={!canSend}
                aria-label={t("chat.input.send")}
                sx={{
                  width: 38,
                  height: 38,
                  borderRadius: 2,
                  background: canSend
                    ? `linear-gradient(135deg, ${theme.palette.primary.main} 0%, ${theme.palette.primary.dark} 100%)`
                    : alpha(theme.palette.text.primary, 0.08),
                  color: canSend
                    ? theme.palette.primary.contrastText
                    : theme.palette.text.disabled,
                  boxShadow: canSend
                    ? `0 4px 12px ${alpha(theme.palette.primary.main, 0.30)}`
                    : "none",
                  transition: "all 160ms",
                  "&:hover": canSend
                    ? {
                        transform: "translateY(-1px)",
                        boxShadow: `0 6px 16px ${alpha(theme.palette.primary.main, 0.40)}`,
                      }
                    : {},
                  "&.Mui-disabled": {
                    background: alpha(theme.palette.text.primary, 0.06),
                    color: theme.palette.text.disabled,
                  },
                }}
              >
                {disabled ? (
                  <CircularProgress size={16} thickness={5} />
                ) : (
                  <SendIcon sx={{ fontSize: 17 }} />
                )}
              </IconButton>
            </Box>
          </Tooltip>
        )}
      </Box>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          minHeight: 14,
          px: 0.5,
        }}
      >
        <Box
          sx={{
            fontSize: "0.65rem",
            color: theme.palette.text.disabled,
            flex: 1,
          }}
        >
          {streaming ? t("chat.input.streamingHint") : t("chat.input.hint")}
        </Box>
        {showCounter && (
          <Box
            sx={{
              fontSize: "0.65rem",
              fontWeight: 600,
              color: counterColor,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {value.length}/{MAX_CHARS}
          </Box>
        )}
      </Box>
    </Box>
  );
}
