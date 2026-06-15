/**
 * ChatHistoryList — Scrollable conversation log with auto-stick-to-bottom.
 *
 * Sticking strategy:
 *  - We track whether the user is currently "near the bottom" (within 80 px).
 *  - When new content arrives and the user is near the bottom, we scroll
 *    them along. If they've scrolled up to read older messages, we leave
 *    them alone — yanking the viewport while they're reading is awful UX.
 *  - On send (new user turn), we always force scroll-to-bottom.
 *
 * Empty state:
 *  - Friendly intro card with 4 example prompts the user can click to send
 *    immediately. Better than a blank canvas.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box, Fade, alpha, useTheme } from "@mui/material";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import GTFSAIIcon from "./GTFSAIIcon";
import { useLanguage } from "../../contexts/LanguageContext";
import MessageBubble from "./MessageBubble";

const STICK_THRESHOLD_PX = 80;

const ExampleChip = ({ label, onClick }) => {
  const theme = useTheme();
  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      sx={{
        all: "unset",
        cursor: "pointer",
        textAlign: "left",
        px: 1.5,
        py: 1,
        borderRadius: 1.5,
        background: alpha(theme.palette.primary.main, 0.04),
        border: `1px solid ${alpha(theme.palette.primary.main, 0.18)}`,
        color: "text.primary",
        fontSize: "0.78rem",
        lineHeight: 1.4,
        transition: "all 140ms",
        "&:hover": {
          background: alpha(theme.palette.primary.main, 0.10),
          borderColor: alpha(theme.palette.primary.main, 0.40),
          transform: "translateY(-1px)",
        },
      }}
    >
      {label}
    </Box>
  );
};

const SuggestionChip = ({ label, onClick }) => {
  const theme = useTheme();
  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      data-testid="chat-suggestion"
      sx={{
        all: "unset",
        cursor: "pointer",
        textAlign: "left",
        px: 1.5,
        py: 1,
        borderRadius: 1.5,
        display: "flex",
        alignItems: "center",
        gap: 0.75,
        background: alpha(theme.palette.warning.main, 0.07),
        border: `1px solid ${alpha(theme.palette.warning.main, 0.35)}`,
        color: "text.primary",
        fontSize: "0.78rem",
        fontWeight: 600,
        lineHeight: 1.4,
        transition: "all 140ms",
        "&:hover": {
          background: alpha(theme.palette.warning.main, 0.14),
          borderColor: theme.palette.warning.main,
          transform: "translateY(-1px)",
        },
      }}
    >
      <AutoFixHighIcon
        sx={{ fontSize: 14, color: theme.palette.warning.dark, flexShrink: 0 }}
      />
      {label}
    </Box>
  );
};

const EmptyState = ({ onPickExample, suggestions = [], onPickSuggestion }) => {
  const { t } = useLanguage();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const aiColor = theme.palette.ai.main;
  const examples = [
    t("chat.empty.example1"),
    t("chat.empty.example2"),
    t("chat.empty.example3"),
    t("chat.empty.example4"),
  ];
  return (
    <Box
      sx={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        px: 3,
        py: 4,
        textAlign: "center",
      }}
    >
      {/* Icon with glow ring */}
      <Box sx={{ position: "relative", mb: 2 }}>
        <Box
          sx={{
            position: "absolute",
            inset: -8,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${alpha(aiColor, isDark ? 0.18 : 0.12)} 0%, transparent 70%)`,
            pointerEvents: "none",
          }}
        />
        <Box
          sx={{
            width: 64,
            height: 64,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart} 0%, ${theme.palette.ai.gradientEnd} 100%)`,
            color: theme.palette.ai.contrastText,
            boxShadow: `0 0 0 6px ${alpha(aiColor, isDark ? 0.12 : 0.09)}, 0 8px 28px ${alpha(aiColor, 0.35)}`,
            position: "relative",
          }}
        >
          <GTFSAIIcon sx={{ fontSize: 32 }} />
        </Box>
      </Box>
      <Box
        sx={{
          fontSize: "1.05rem",
          fontWeight: 700,
          color: "text.primary",
          mb: 0.5,
        }}
      >
        {t("chat.empty.title")}
      </Box>
      <Box
        sx={{
          fontSize: "0.82rem",
          color: "text.secondary",
          maxWidth: 320,
          lineHeight: 1.5,
          mb: 2.5,
        }}
      >
        {t("chat.empty.subtitle")}
      </Box>
      <Box
        sx={{
          width: "100%",
          maxWidth: 360,
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: 0.75,
        }}
      >
        {/* Contextual repair suggestions first — built from the live
            validation findings, one click sends the question. */}
        {suggestions.map((s, i) => (
          <SuggestionChip
            key={`s${i}`}
            label={s.label}
            onClick={() => onPickSuggestion && onPickSuggestion(s.message)}
          />
        ))}
        {examples.map((ex, i) => (
          <ExampleChip key={i} label={ex} onClick={() => onPickExample(ex)} />
        ))}
      </Box>
    </Box>
  );
};

export default function ChatHistoryList({
  turns,
  onPickExample,
  onRegenerateTurn,
  currentErrorCount = null,
  onRepairOutcome = null,
  suggestions = [],
  onPickSuggestion = null,
}) {
  const { t } = useLanguage();
  const theme = useTheme();
  const scrollRef = useRef(null);
  const stickRef = useRef(true);
  const lastUserTurnIdRef = useRef(null);
  // Mirrors !stickRef for rendering the jump-to-latest pill — refs don't
  // trigger renders, so the scroll handler keeps this state in sync.
  const [awayFromBottom, setAwayFromBottom] = useState(false);

  // Track whether the user is near the bottom (or scrolled up to read).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickRef.current = distanceFromBottom < STICK_THRESHOLD_PX;
      setAwayFromBottom(!stickRef.current);
    };
    el.addEventListener("scroll", handler, { passive: true });
    return () => el.removeEventListener("scroll", handler);
  }, []);

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    setAwayFromBottom(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  // Auto-scroll on new content if the user was near the bottom.
  // useLayoutEffect (not useEffect) so the scroll happens before paint —
  // avoids a one-frame visual jump.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Sending a message always snaps to the bottom — the user's own turn is
    // the one thing they must always see — regardless of scroll position.
    const lastUser = [...turns].reverse().find((tt) => tt.role === "user");
    if (lastUser && lastUser.id !== lastUserTurnIdRef.current) {
      lastUserTurnIdRef.current = lastUser.id;
      stickRef.current = true;
      setAwayFromBottom(false);
    }
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [turns]);

  if (turns.length === 0) {
    return (
      <EmptyState
        onPickExample={onPickExample}
        suggestions={suggestions}
        onPickSuggestion={onPickSuggestion}
      />
    );
  }

  // The last assistant turn is the only one that gets a regenerate action
  // (regenerating an earlier turn would invalidate downstream turns).
  let lastAssistantIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  const lastAssistantTurn = lastAssistantIdx >= 0 ? turns[lastAssistantIdx] : null;
  const lastAssistantIsDone =
    lastAssistantTurn &&
    (lastAssistantTurn.status === "complete" ||
      lastAssistantTurn.status === "blocked" ||
      lastAssistantTurn.status === "error");

  return (
    <Box
      sx={{
        flex: 1,
        position: "relative",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Box
        ref={scrollRef}
        sx={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          px: 1.5,
          py: 1.5,
          display: "flex",
          flexDirection: "column",
          gap: 1.25,
          // Custom scrollbar to match the chat panel theme.
          "&::-webkit-scrollbar": { width: 8 },
          "&::-webkit-scrollbar-thumb": {
            background: (t) => alpha(t.palette.text.primary, 0.18),
            borderRadius: 4,
          },
          "&::-webkit-scrollbar-thumb:hover": {
            background: (t) => alpha(t.palette.text.primary, 0.28),
          },
        }}
      >
        {turns.map((turn, idx) => (
          <MessageBubble
            key={turn.id}
            turn={turn}
            currentErrorCount={currentErrorCount}
            onRepairOutcome={onRepairOutcome}
            onRegenerate={
              idx === lastAssistantIdx && lastAssistantIsDone && onRegenerateTurn
                ? () => onRegenerateTurn(turn.id)
                : null
            }
          />
        ))}
      </Box>

      {/* Jump-to-latest pill — appears the moment the user scrolls up so a
          streaming answer never disappears "below the fold" unnoticed. */}
      <Fade in={awayFromBottom}>
        <Box
          component="button"
          type="button"
          onClick={jumpToBottom}
          aria-label={t("chat.scroll.jump")}
          data-testid="chat-jump-bottom"
          sx={{
            all: "unset",
            cursor: "pointer",
            position: "absolute",
            bottom: 12,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 0.4,
            px: 1.25,
            py: 0.5,
            borderRadius: 99,
            fontSize: "0.72rem",
            fontWeight: 700,
            color: theme.palette.primary.contrastText,
            background: alpha(theme.palette.primary.main, 0.92),
            boxShadow: `0 2px 10px ${alpha(theme.palette.primary.main, 0.45)}`,
            backdropFilter: "blur(4px)",
            transition: "background 120ms, transform 120ms",
            "&:hover": {
              background: theme.palette.primary.dark,
              transform: "translateX(-50%) translateY(-1px)",
            },
          }}
        >
          <KeyboardArrowDownIcon sx={{ fontSize: 15 }} />
          {t("chat.scroll.jump")}
        </Box>
      </Fade>
    </Box>
  );
}
