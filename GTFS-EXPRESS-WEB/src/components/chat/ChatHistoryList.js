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
 * Empty state: what the assistant can do, as three groups of one-click
 * prompts (explore, diagnose, repair) plus the live repair suggestions
 * built from the validation findings.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box, Fade, alpha, useTheme } from "@mui/material";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import TravelExploreIcon from "@mui/icons-material/TravelExplore";
import HealthAndSafetyOutlinedIcon from "@mui/icons-material/HealthAndSafetyOutlined";
import BuildCircleOutlinedIcon from "@mui/icons-material/BuildCircleOutlined";
import GTFSAIIcon from "./GTFSAIIcon";
import { useLanguage } from "../../contexts/LanguageContext";
import MessageBubble from "./MessageBubble";

const STICK_THRESHOLD_PX = 80;

const PromptChip = ({ label, onClick, accent = false }) => {
  const theme = useTheme();
  const color = accent ? theme.palette.warning.main : theme.palette.primary.main;
  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      data-testid={accent ? "chat-suggestion" : "chat-example"}
      sx={{
        all: "unset",
        cursor: "pointer",
        textAlign: "left",
        px: 1.25,
        py: 0.8,
        borderRadius: 1.5,
        display: "flex",
        alignItems: "center",
        gap: 0.75,
        background: alpha(color, accent ? 0.07 : 0.04),
        border: `1px solid ${alpha(color, accent ? 0.35 : 0.18)}`,
        color: "text.primary",
        fontSize: "0.78rem",
        fontWeight: accent ? 600 : 500,
        lineHeight: 1.4,
        transition: "all 140ms",
        "&:hover": {
          background: alpha(color, accent ? 0.14 : 0.1),
          borderColor: alpha(color, accent ? 1 : 0.4),
          transform: "translateY(-1px)",
        },
      }}
    >
      {accent && <AutoFixHighIcon sx={{ fontSize: 14, color: theme.palette.warning.dark, flexShrink: 0 }} />}
      {label}
    </Box>
  );
};

const Group = ({ Icon, title, children }) => {
  const theme = useTheme();
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.6 }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.6,
          fontSize: "0.68rem",
          fontWeight: 700,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          color: "text.secondary",
        }}
      >
        <Icon sx={{ fontSize: 14, color: theme.palette.ai.main }} />
        {title}
      </Box>
      {children}
    </Box>
  );
};

const EmptyState = ({ onPickExample, suggestions = [], onPickSuggestion }) => {
  const { t } = useLanguage();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const aiColor = theme.palette.ai.main;
  const groups = [
    {
      Icon: TravelExploreIcon,
      title: t("chat.empty.groupExplore"),
      items: [t("chat.empty.exploreA"), t("chat.empty.exploreB")],
    },
    {
      Icon: HealthAndSafetyOutlinedIcon,
      title: t("chat.empty.groupDiagnose"),
      items: [t("chat.empty.diagnoseA"), t("chat.empty.diagnoseB")],
    },
    {
      Icon: BuildCircleOutlinedIcon,
      title: t("chat.empty.groupRepair"),
      items: [t("chat.empty.repairA"), t("chat.empty.repairB")],
    },
  ];
  return (
    <Box
      sx={{
        flex: 1,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        px: 3,
        py: 3,
        textAlign: "center",
      }}
    >
      <Box sx={{ position: "relative", mb: 1.5, mt: 1 }}>
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
            width: 56,
            height: 56,
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
          <GTFSAIIcon sx={{ fontSize: 28 }} />
        </Box>
      </Box>
      <Box sx={{ fontSize: "1.02rem", fontWeight: 700, color: "text.primary", mb: 0.4 }}>
        {t("chat.empty.title")}
      </Box>
      <Box sx={{ fontSize: "0.8rem", color: "text.secondary", maxWidth: 380, lineHeight: 1.5, mb: 2 }}>
        {t("chat.empty.subtitle")}
      </Box>
      <Box sx={{ width: "100%", maxWidth: 420, display: "flex", flexDirection: "column", gap: 1.5, textAlign: "left" }}>
        {suggestions.length > 0 && (
          <Group Icon={AutoFixHighIcon} title={t("chat.empty.groupNow")}>
            {suggestions.map((s, i) => (
              <PromptChip key={`s${i}`} accent label={s.label} onClick={() => onPickSuggestion && onPickSuggestion(s.message)} />
            ))}
          </Group>
        )}
        {groups.map((g) => (
          <Group key={g.title} Icon={g.Icon} title={g.title}>
            {g.items.map((ex, i) => (
              <PromptChip key={i} label={ex} onClick={() => onPickExample(ex)} />
            ))}
          </Group>
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
  onProposalOutcome = null,
  onPickFollowup = null,
  onReplayAction = null,
  suggestions = [],
  onPickSuggestion = null,
}) {
  const { t } = useLanguage();
  const theme = useTheme();
  const scrollRef = useRef(null);
  const stickRef = useRef(true);
  const lastUserTurnIdRef = useRef(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false);

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

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
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
    return <EmptyState onPickExample={onPickExample} suggestions={suggestions} onPickSuggestion={onPickSuggestion} />;
  }

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
      lastAssistantTurn.status === "error" ||
      lastAssistantTurn.status === "aborted");

  return (
    <Box sx={{ flex: 1, position: "relative", minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Box
        ref={scrollRef}
        data-testid="chat-history"
        sx={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          px: 1.5,
          py: 1.5,
          display: "flex",
          flexDirection: "column",
          gap: 1.25,
          "&::-webkit-scrollbar": { width: 8 },
          "&::-webkit-scrollbar-thumb": {
            background: (th) => alpha(th.palette.text.primary, 0.18),
            borderRadius: 4,
          },
          "&::-webkit-scrollbar-thumb:hover": {
            background: (th) => alpha(th.palette.text.primary, 0.28),
          },
        }}
      >
        {turns.map((turn, idx) => (
          <MessageBubble
            key={turn.id}
            turn={turn}
            currentErrorCount={currentErrorCount}
            onProposalOutcome={onProposalOutcome}
            onPickFollowup={onPickFollowup}
            onReplayAction={onReplayAction}
            showFollowups={idx === lastAssistantIdx}
            onRegenerate={
              idx === lastAssistantIdx && lastAssistantIsDone && onRegenerateTurn
                ? () => onRegenerateTurn(turn.id)
                : null
            }
          />
        ))}
      </Box>

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
