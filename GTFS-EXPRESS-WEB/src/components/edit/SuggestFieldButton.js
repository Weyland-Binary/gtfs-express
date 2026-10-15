/**
 * SuggestFieldButton — the sparkle at the end of a form field: asks the
 * assistant for a value that fits the feed (POST /ai/suggest-field), fills
 * the field and shows why. Hidden when the assistant is disabled. The user
 * still saves the form: nothing is written by the suggestion itself.
 */

import React, { useCallback, useState } from "react";
import { CircularProgress, IconButton, InputAdornment, Tooltip, useTheme } from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { useFeatures } from "../../utils/featuresApi";

export async function requestFieldSuggestion({ entity, field, form, id, language }) {
  const res = await fetchWithSession(`${API_BASE_URL}/ai/suggest-field`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entity, field, form, id: id || undefined, language }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
  return body;
}

export default function SuggestFieldButton({ entity, field, form, id = null, onSuggest }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const { features } = useFeatures();
  const [loading, setLoading] = useState(false);
  const [reason, setReason] = useState(null);
  const [error, setError] = useState(null);

  const suggest = useCallback(
    async (e) => {
      e.preventDefault();
      if (loading) return;
      setLoading(true);
      setError(null);
      try {
        const body = await requestFieldSuggestion({ entity, field, form, id, language });
        if (body.value) {
          onSuggest(body.value, body.reason || "");
          setReason(body.reason || t("suggest.applied"));
        } else {
          setError(body.reason || t("suggest.nothing"));
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [loading, entity, field, form, id, language, onSuggest, t],
  );

  if (!features?.chat?.enabled) return null;

  const title = error ? error : reason ? reason : t("suggest.tooltip");
  return (
    <InputAdornment position="end">
      <Tooltip title={title} placement="top" arrow>
        <span>
          <IconButton
            size="small"
            edge="end"
            onClick={suggest}
            disabled={loading}
            aria-label={t("suggest.tooltip")}
            data-testid={`suggest-${field}`}
            sx={{
              color: error ? theme.palette.error.main : reason ? theme.palette.success.main : theme.palette.ai.main,
              "&:hover": { background: `${theme.palette.ai.main}14` },
            }}
          >
            {loading ? <CircularProgress size={14} color="inherit" /> : <AutoAwesomeIcon sx={{ fontSize: 16 }} />}
          </IconButton>
        </span>
      </Tooltip>
    </InputAdornment>
  );
}
