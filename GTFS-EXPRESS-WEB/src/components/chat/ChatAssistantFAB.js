/**
 * ChatAssistantFAB — Compact indigo trigger for the chat assistant.
 *
 * Visibility gate:
 *   1. server features.chat.enabled === true  (NL2SQL_CHAT_ENABLED + key)
 *   2. AND a feed has been loaded             (no point asking about nothing)
 *
 * Beta gate (soft, on click):
 *   - If a beta code is present in localStorage → open ChatDrawer directly.
 *   - If no beta code → open AIAccessDialog so the user can enter their code
 *     or request one. The FAB is always visible when a feed is loaded so
 *     curious users can discover the feature rather than see nothing.
 *
 * Visual identity:
 *   - Bottom-left, above the fixed footer (footer ≈ 50px → bottom: 68px sm+).
 *   - Indigo gradient fill (violet→indigo) — same token as the assistant avatar
 *     in chat bubbles and the empty-state hero icon.
 *   - Rounded-square (borderRadius 12px) reads as a toolbar button.
 *   - White icon on gradient — high contrast, no ambiguity about purpose.
 *   - Small β badge regardless of beta status (marks it as early-access).
 */

import React, { useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  ButtonBase,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  Link,
  Stack,
  TextField,
  Tooltip,
  Typography,
  Zoom,
  alpha,
  useTheme,
} from "@mui/material";
import GTFSAIIcon from "./GTFSAIIcon";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import InsightsOutlinedIcon from "@mui/icons-material/InsightsOutlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import MailOutlineIcon from "@mui/icons-material/MailOutline";
import TerminalOutlinedIcon from "@mui/icons-material/TerminalOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useFeatures } from "../../utils/featuresApi";
import { BETA_CODE_STORAGE_KEY } from "../edit/BetaGateDialog";
import ChatDrawer from "./ChatDrawer";

// AI identity colors live in theme.palette.ai (Theme.js) — rule #19.

const SUPPORT_EMAIL = "weylandbinary@gmail.com";

const CHAT_FEATURES = [
  { Icon: ChatBubbleOutlineIcon, key: "beta.featureChat1" },
  { Icon: InsightsOutlinedIcon, key: "beta.featureChat2" },
  { Icon: TerminalOutlinedIcon, key: "beta.featureChat3" },
];

const formatBetaCode = (raw) => {
  if (!raw) return "";
  const stripped = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  return stripped.match(/.{1,4}/g)?.join("-") || "";
};

const useBetaCodePresent = () => {
  const [present, setPresent] = useState(() => {
    try {
      return Boolean(localStorage.getItem(BETA_CODE_STORAGE_KEY));
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const refresh = () => {
      try {
        setPresent(Boolean(localStorage.getItem(BETA_CODE_STORAGE_KEY)));
      } catch {
        setPresent(false);
      }
    };
    window.addEventListener("storage", refresh);
    const id = setInterval(refresh, 4000);
    return () => {
      window.removeEventListener("storage", refresh);
      clearInterval(id);
    };
  }, []);
  return present;
};

// ---------------------------------------------------------------------------
// AIAccessDialog — shown when the FAB is clicked without a beta code.
// Same visual design as BetaGateDialog; difference: stores code locally
// (server validates on the first chat send) instead of calling the API.
// ---------------------------------------------------------------------------
function AIAccessDialog({ open, onClose, onActivated }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [code, setCode] = useState("");
  const inputRef = useRef(null);

  const stripped = code.replace(/-/g, "");
  const canSubmit = stripped.length >= 8;

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 80);
    } else {
      setCode("");
    }
  }, [open]);

  const handleChange = (e) => setCode(formatBetaCode(e.target.value));

  const handleActivate = () => {
    if (!canSubmit) return;
    try {
      localStorage.setItem(BETA_CODE_STORAGE_KEY, code);
    } catch {
      /* storage disabled */
    }
    onActivated();
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && canSubmit) {
      e.preventDefault();
      handleActivate();
    }
  };

  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
    "GTFS Editor — Beta access request",
  )}&body=${encodeURIComponent(
    "Hello,\n\nI would like to request a beta access code for GTFS Editor edit mode.\n\nName / Organization:\nUse case (briefly):\n\nThank you.",
  )}`;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      PaperProps={{ sx: { borderRadius: 2.5, overflow: "hidden" } }}
    >
      {/* Gradient header zone — mirrors BetaGateDialog */}
      <Box
        sx={{
          background: `linear-gradient(160deg, ${alpha(theme.palette.ai.main, 0.10)} 0%, ${alpha(theme.palette.background.paper, 0)} 100%)`,
          borderBottom: `1px solid ${alpha(theme.palette.ai.main, 0.18)}`,
          px: 3,
          pt: 3,
          pb: 2.5,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 1.5,
        }}
      >
        <Box
          sx={{
            width: 60,
            height: 60,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: `linear-gradient(135deg, ${theme.palette.ai.main} 0%, ${theme.palette.ai.dark} 100%)`,
            boxShadow: `0 6px 24px ${alpha(theme.palette.ai.main, 0.40)}`,
          }}
        >
          <LockOutlinedIcon sx={{ fontSize: 30, color: "#fff" }} />
        </Box>
        <Box sx={{ textAlign: "center" }}>
          <Typography variant="h6" fontWeight={700} lineHeight={1.3}>
            {t("beta.title")}
          </Typography>
          <Chip
            label={t("beta.privateBadge")}
            size="small"
            sx={{
              mt: 0.75,
              height: 18,
              fontSize: "0.65rem",
              fontWeight: 700,
              letterSpacing: 0.8,
              textTransform: "uppercase",
              background: alpha(theme.palette.ai.main, 0.10),
              color: theme.palette.ai.dark,
              border: `1px solid ${alpha(theme.palette.ai.main, 0.28)}`,
              "& .MuiChip-label": { px: 1 },
            }}
          />
        </Box>
      </Box>

      <DialogContent sx={{ pt: 2.5, pb: 1 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t("beta.bodyChat")}
        </Typography>

        <Stack spacing={0.75} sx={{ mb: 2.5 }}>
          {CHAT_FEATURES.map(({ Icon, key }) => (
            <Box
              key={key}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1.25,
                px: 1.25,
                py: 0.75,
                borderRadius: 1.5,
                background: alpha(theme.palette.ai.main, 0.07),
              }}
            >
              <Icon sx={{ fontSize: 16, color: theme.palette.ai.main, flexShrink: 0 }} />
              <Typography variant="caption" color="text.primary" lineHeight={1.4}>
                {t(key)}
              </Typography>
            </Box>
          ))}
        </Stack>

        <TextField
          inputRef={inputRef}
          label={t("beta.codeLabel")}
          placeholder="XXXX-XXXX-XXXX"
          value={code}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          fullWidth
          autoComplete="off"
          spellCheck={false}
          inputProps={{
            maxLength: 14,
            style: {
              fontFamily:
                'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
              letterSpacing: 1.5,
              textAlign: "center",
              fontSize: 18,
              fontWeight: 600,
            },
          }}
          sx={{
            "& .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline": {
              borderColor: theme.palette.ai.main,
              borderWidth: 2,
            },
            "& .MuiInputLabel-root.Mui-focused": { color: theme.palette.ai.main },
          }}
        />

        <Box
          sx={{
            mt: 2,
            p: 1.5,
            borderRadius: 1.5,
            background: alpha(theme.palette.ai.main, 0.05),
            border: `1px solid ${alpha(theme.palette.ai.main, 0.18)}`,
            display: "flex",
            alignItems: "flex-start",
            gap: 1,
          }}
        >
          <MailOutlineIcon
            sx={{ fontSize: 15, color: "text.disabled", mt: 0.15, flexShrink: 0 }}
          />
          <Typography variant="caption" color="text.secondary" lineHeight={1.5}>
            {t("beta.requestAccess")}{" "}
            <Link
              href={mailto}
              underline="hover"
              sx={{ fontWeight: 600 }}
              target="_blank"
              rel="noreferrer"
            >
              {SUPPORT_EMAIL}
            </Link>
          </Typography>
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 2, gap: 1 }}>
        <Button onClick={onClose} color="inherit" size="small">
          {t("app.cancel")}
        </Button>
        <Button
          onClick={handleActivate}
          variant="contained"
          disabled={!canSubmit}
          sx={{
            minWidth: 110,
            background: `linear-gradient(135deg, ${theme.palette.ai.main} 0%, ${theme.palette.ai.dark} 100%)`,
            "&:hover": { background: theme.palette.ai.dark },
            "&.Mui-disabled": {
              background: alpha(theme.palette.ai.main, 0.22),
              color: "rgba(255,255,255,0.38)",
            },
          }}
        >
          {t("beta.submit")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

// Custom event other surfaces dispatch to open the assistant with a
// pre-filled, auto-sent message (detail: { message }). Used by the
// validation page's "Ask AI" action — the drawer overlays every view, so
// the user keeps their place while the assistant answers.
export const CHAT_OPEN_EVENT = "gtfs:chat-open";

export default function ChatAssistantFAB({
  feedLoaded,
  feedEpoch,
  language,
  sessionContext = null,
}) {
  const { t } = useLanguage();
  const theme = useTheme();
  const { features, loaded } = useFeatures();
  const betaPresent = useBetaCodePresent();
  const [open, setOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [prefillMessage, setPrefillMessage] = useState(null);
  const isDark = theme.palette.mode === "dark";

  const enabled = loaded && features?.chat?.enabled === true;
  const visible = enabled && feedLoaded;

  // External open requests (validation page "Ask AI"). If the beta code is
  // missing, the access dialog runs first and the message is kept pending.
  useEffect(() => {
    if (!visible) return undefined;
    const handler = (e) => {
      const message = e?.detail?.message;
      if (typeof message === "string" && message.trim().length >= 2) {
        setPrefillMessage(message);
      }
      let hasCode = false;
      try {
        hasCode = Boolean(localStorage.getItem(BETA_CODE_STORAGE_KEY));
      } catch {
        /* storage disabled */
      }
      // With a free-trial allowance, code-less users go straight into the
      // chat — the trial IS the gateway. The access dialog only remains the
      // front door when the operator disabled the free tier.
      if (hasCode || features?.chat?.freeMessages > 0) setOpen(true);
      else setAccessOpen(true);
    };
    window.addEventListener(CHAT_OPEN_EVENT, handler);
    return () => window.removeEventListener(CHAT_OPEN_EVENT, handler);
  }, [visible, features?.chat?.freeMessages]);

  const errorCount = sessionContext?.validation?.errors || 0;
  const showRescueBadge = errorCount > 0 && !open;

  if (!visible) return null;

  const handleFabClick = () => {
    if (betaPresent || features?.chat?.freeMessages > 0) {
      setOpen(true);
    } else {
      setAccessOpen(true);
    }
  };

  return (
    <>
      <Zoom in timeout={240}>
        <Box
          sx={{
            position: "fixed",
            bottom: { xs: 60, sm: 68 },
            left: { xs: 12, sm: 16 },
            zIndex: theme.zIndex.speedDial + 1,
          }}
        >
          <Tooltip
            title={
              showRescueBadge
                ? t("chat.fab.rescueTooltip", { count: errorCount })
                : betaPresent
                  ? t("chat.fab.tooltip")
                  : t("beta.title")
            }
            placement="right"
            arrow
          >
            <ButtonBase
              aria-label={t("chat.fab.tooltip")}
              onClick={handleFabClick}
              sx={{
                width: 40,
                height: 40,
                borderRadius: "12px",
                border: `1px solid ${alpha("#fff", 0.18)}`,
                background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart} 0%, ${theme.palette.ai.gradientEnd} 100%)`,
                boxShadow: isDark
                  ? `0 2px 14px ${alpha(theme.palette.ai.main, 0.50)}, 0 1px 3px rgba(0,0,0,0.35)`
                  : `0 2px 12px ${alpha(theme.palette.ai.main, 0.38)}, 0 1px 3px rgba(0,0,0,0.12)`,
                color: theme.palette.ai.contrastText,
                transition:
                  "transform 160ms ease, box-shadow 160ms ease, filter 160ms ease",
                "&:hover": {
                  filter: "brightness(1.12)",
                  transform: "scale(1.07)",
                  boxShadow: isDark
                    ? `0 4px 22px ${alpha(theme.palette.ai.main, 0.65)}, 0 1px 4px rgba(0,0,0,0.40)`
                    : `0 4px 20px ${alpha(theme.palette.ai.main, 0.52)}, 0 1px 4px rgba(0,0,0,0.15)`,
                },
                "&:active": {
                  transform: "scale(0.96)",
                  filter: "brightness(0.95)",
                },
                "&:focus-visible": {
                  outline: `2px solid ${theme.palette.ai.main}`,
                  outlineOffset: 2,
                },
              }}
            >
              <GTFSAIIcon sx={{ fontSize: 20 }} />
            </ButtonBase>
          </Tooltip>

          {/* Rescue nudge — blocking-error count, invites the user to ask
              the assistant for help fixing the feed */}
          {showRescueBadge && (
            <Box
              aria-hidden
              sx={{
                position: "absolute",
                top: -7,
                left: -7,
                minWidth: 18,
                height: 18,
                px: "4px",
                borderRadius: "9px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: theme.palette.error.main,
                color: theme.palette.error.contrastText,
                fontSize: "0.6rem",
                fontWeight: 700,
                lineHeight: 1,
                pointerEvents: "none",
                userSelect: "none",
                boxShadow: `0 0 0 2px ${theme.palette.background.default}`,
              }}
            >
              {errorCount > 99 ? "99+" : errorCount}
            </Box>
          )}

          {/* β badge */}
          <Box
            aria-hidden
            sx={{
              position: "absolute",
              top: -5,
              right: -5,
              px: "3px",
              py: "1.5px",
              borderRadius: "4px",
              background: alpha("#fff", 0.22),
              color: "#fff",
              fontSize: "0.52rem",
              fontWeight: 700,
              lineHeight: 1,
              letterSpacing: "0.02em",
              pointerEvents: "none",
              userSelect: "none",
            }}
          >
            β
          </Box>
        </Box>
      </Zoom>

      <AIAccessDialog
        open={accessOpen}
        onClose={() => setAccessOpen(false)}
        onActivated={() => {
          setAccessOpen(false);
          // useBetaCodePresent will detect the new localStorage entry within
          // its 4-second polling interval; open the chat immediately.
          setOpen(true);
        }}
      />

      <ChatDrawer
        open={open}
        onClose={() => setOpen(false)}
        feedLoaded={feedLoaded}
        feedEpoch={feedEpoch}
        features={features}
        language={language}
        sessionContext={sessionContext}
        prefillMessage={prefillMessage}
        onPrefillConsumed={() => setPrefillMessage(null)}
      />
    </>
  );
}
