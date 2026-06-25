import React, { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  TextField,
  Alert,
  Link,
  CircularProgress,
  Chip,
  Stack,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import MailOutlineIcon from "@mui/icons-material/MailOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import HistoryOutlinedIcon from "@mui/icons-material/HistoryOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesome";
import InsightsOutlinedIcon from "@mui/icons-material/InsightsOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import TerminalOutlinedIcon from "@mui/icons-material/TerminalOutlined";
import { useLanguage } from "../../contexts/LanguageContext";

const STORAGE_KEY = "gtfs_beta_code";
const SUPPORT_EMAIL = "weylandbinary@gmail.com";

const ACCENT = "#6366f1";
const ACCENT_DARK = "#4f46e5";

const EDIT_FEATURES = [
  { icon: EditOutlinedIcon, key: "beta.featureEdit1" },
  { icon: HistoryOutlinedIcon, key: "beta.featureEdit2" },
  { icon: StorageOutlinedIcon, key: "beta.featureEdit3" },
];

const NL2SQL_FEATURES = [
  { icon: AutoAwesomeOutlinedIcon, key: "beta.featureNl2sql1" },
  { icon: InsightsOutlinedIcon, key: "beta.featureNl2sql2" },
  { icon: VisibilityOutlinedIcon, key: "beta.featureNl2sql3" },
];

const CHAT_FEATURES = [
  { icon: ChatBubbleOutlineIcon, key: "beta.featureChat1" },
  { icon: BoltOutlinedIcon, key: "beta.featureChat2" },
  { icon: TerminalOutlinedIcon, key: "beta.featureChat3" },
];

/**
 * Format a user code typed "on the fly": strip non-alphanumeric,
 * uppercase, then re-insert a hyphen every 4 chars (max 12 → XXXX-XXXX-XXXX).
 * Ex: "abcd 1234 ef" → "ABCD-1234-EF".
 *
 * The server normalises by the same rule (see services/betaGate.js), so the
 * client can be tolerant of any user input.
 */
const formatBetaCode = (raw) => {
  if (!raw) return "";
  const stripped = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
  return stripped.match(/.{1,4}/g)?.join("-") || "";
};

/**
 * Beta gate modal on edit mode entry.
 *
 * Pattern "validate-inside": the modal STAYS OPEN during the
 * `onSubmit(code)` call. If the server responds with 403, we display the error inline
 * without closing the modal (no close→reopen flicker). On success, the
 * parent closes it via `onClose`.
 *
 * Props:
 *   open       — bool, controls visibility
 *   onClose    — () => void, passive close (back/escape/cancel)
 *   onSubmit   — async (code) => { ok, errorCode?, message? }
 *                The parent handles the API call and returns the result.
 *   initialError? — { code, message } to pre-fill the error (case where we
 *                   already tried with a code from localStorage and received 403).
 */
function BetaGateDialog({
  open,
  onClose,
  onSubmit,
  initialError = null,
  bodyKey = "beta.body",
}) {
  const { t } = useLanguage();
  const theme = useTheme();

  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorCode, setErrorCode] = useState(initialError?.code || null);
  const [errorMsg, setErrorMsg] = useState(initialError?.message || null);
  const inputRef = useRef(null);

  // Sync errors when re-opened with a new initialError (e.g. retry after expiry).
  useEffect(() => {
    if (open) {
      setErrorCode(initialError?.code || null);
      setErrorMsg(initialError?.message || null);
      // Focus the input on open to allow direct paste (Cmd+V).
      setTimeout(() => inputRef.current?.focus(), 80);
    } else {
      // Reset on close so a partial input is not kept between two openings
      setCode("");
      setSubmitting(false);
    }
  }, [open, initialError]);

  const handleChange = (e) => {
    setCode(formatBetaCode(e.target.value));
    // Clear error as soon as the user edits the field
    if (errorCode) {
      setErrorCode(null);
      setErrorMsg(null);
    }
  };

  const stripped = code.replace(/-/g, "");
  const canSubmit = stripped.length >= 8 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const result = await onSubmit(code);
      if (result?.ok) {
        // Persist only AFTER successful server validation. Avoids
        // storing an invalid code that would be re-rejected on every retry.
        try {
          localStorage.setItem(STORAGE_KEY, code);
        } catch {
          /* localStorage unavailable (strict incognito mode) → tolerate */
        }
        onClose?.();
      } else {
        setErrorCode(result?.errorCode || "INVALID_BETA_CODE");
        setErrorMsg(result?.message || null);
        // On error we PURGE localStorage: a stored code that becomes
        // invalid must not be silently retried on the next
        // edit mode entry.
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          /* ignore */
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && canSubmit) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const errorText = (() => {
    if (!errorCode) return null;
    switch (errorCode) {
      case "INVALID_BETA_CODE":
        return t("beta.invalid");
      case "BETA_REVOKED":
        return t("beta.revoked");
      case "BETA_CODE_REQUIRED":
        return t("beta.required");
      case "BETA_CONFIG_ERROR":
        return t("beta.configError");
      case "NETWORK_ERROR":
        return t("beta.networkError");
      default:
        return errorMsg || t("beta.invalid");
    }
  })();

  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
    "GTFS Editor — Beta access request",
  )}&body=${encodeURIComponent(
    "Hello,\n\nI would like to request a beta access code for GTFS Editor edit mode.\n\nName / Organization:\nUse case (briefly):\n\nThank you.",
  )}`;

  const features =
    bodyKey === "beta.bodyChat"
      ? CHAT_FEATURES
      : bodyKey === "beta.bodyNl2sql"
        ? NL2SQL_FEATURES
        : EDIT_FEATURES;

  return (
    <Dialog
      open={open}
      onClose={submitting ? undefined : onClose}
      maxWidth="xs"
      fullWidth
      PaperProps={{
        sx: {
          borderRadius: 2.5,
          overflow: "hidden",
        },
      }}
    >
      {/* Gradient header zone — replaces DialogTitle */}
      <Box
        sx={{
          background: `linear-gradient(160deg, ${alpha(ACCENT, 0.10)} 0%, ${alpha(theme.palette.background.paper, 0)} 100%)`,
          borderBottom: `1px solid ${alpha(ACCENT, 0.18)}`,
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
            background: `linear-gradient(135deg, ${ACCENT} 0%, ${ACCENT_DARK} 100%)`,
            boxShadow: `0 6px 24px ${alpha(ACCENT, 0.40)}`,
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
              background: alpha(ACCENT, 0.10),
              color: ACCENT_DARK,
              border: `1px solid ${alpha(ACCENT, 0.28)}`,
              "& .MuiChip-label": { px: 1 },
            }}
          />
        </Box>
      </Box>

      <DialogContent sx={{ pt: 2.5, pb: 1 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t(bodyKey)}
        </Typography>

        <Stack spacing={0.75} sx={{ mb: 2.5 }}>
          {features.map(({ icon: Icon, key }) => (
            <Box
              key={key}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1.25,
                px: 1.25,
                py: 0.75,
                borderRadius: 1.5,
                background: alpha(ACCENT, 0.07),
              }}
            >
              <Icon sx={{ fontSize: 16, color: ACCENT, flexShrink: 0 }} />
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
          disabled={submitting}
          fullWidth
          autoComplete="off"
          spellCheck={false}
          inputProps={{
            // 14 = 12 chars + 2 hyphens. Hard cap to prevent input
            // > 32 chars (server-normalised limit).
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
              borderColor: ACCENT,
              borderWidth: 2,
            },
            "& .MuiInputLabel-root.Mui-focused": {
              color: ACCENT,
            },
          }}
        />

        {errorText && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {errorText}
          </Alert>
        )}

        <Box
          sx={{
            mt: 2,
            p: 1.5,
            borderRadius: 1.5,
            background: alpha(ACCENT, 0.05),
            border: `1px solid ${alpha(ACCENT, 0.18)}`,
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
        <Button
          onClick={onClose}
          color="inherit"
          disabled={submitting}
          size="small"
        >
          {t("app.cancel")}
        </Button>
        <Button
          onClick={handleSubmit}
          variant="contained"
          disabled={!canSubmit}
          startIcon={
            submitting ? <CircularProgress size={14} color="inherit" /> : null
          }
          sx={{
            minWidth: 110,
            background: `linear-gradient(135deg, ${ACCENT} 0%, ${ACCENT_DARK} 100%)`,
            "&:hover": { background: ACCENT_DARK },
            "&.Mui-disabled": {
              background: alpha(ACCENT, 0.22),
              color: "rgba(255,255,255,0.38)",
            },
          }}
        >
          {submitting ? t("beta.submitting") : t("beta.submit")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default BetaGateDialog;
export { STORAGE_KEY as BETA_CODE_STORAGE_KEY };
