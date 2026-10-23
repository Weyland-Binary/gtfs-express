/**
 * The conversation log: new content scrolls the view along only while the person is near the bottom, never while
 * they read older messages; a new question always scrolls to the bottom.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box, Fade, alpha, useTheme } from "@mui/material";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import TravelExploreIcon from "@mui/icons-material/TravelExplore";
import HealthAndSafetyOutlinedIcon from "@mui/icons-material/HealthAndSafetyOutlined";
import EditNoteRoundedIcon from "@mui/icons-material/EditNoteRounded";
import CenterFocusStrongRoundedIcon from "@mui/icons-material/CenterFocusStrongRounded";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import GTFSAIIcon from "./GTFSAIIcon";
import { useLanguage } from "../../contexts/LanguageContext";
import MessageBubble from "./MessageBubble";

const STICK_THRESHOLD_PX = 80;

const MOTION = {
  "@keyframes chatRise": { "0%": { transform: "translateY(10px)", opacity: 0 }, "100%": { transform: "none", opacity: 1 } },
  "@keyframes chatGlow": { "0%, 100%": { transform: "scale(1)", opacity: 0.75 }, "50%": { transform: "scale(1.14)", opacity: 1 } },
  "@keyframes chatOrbit": { "0%": { transform: "rotate(0deg)" }, "100%": { transform: "rotate(360deg)" } },
  "@media (prefers-reduced-motion: reduce)": { "&, & *": { animation: "none !important", transition: "none !important" } },
};

const rise = (i) => ({ animation: "chatRise 420ms cubic-bezier(.2,.8,.2,1) both", animationDelay: `${120 + i * 45}ms` });

const PromptChip = ({ label, onClick, index, accent = false }) => {
  const theme = useTheme();
  const color = accent ? theme.palette.ai.main : theme.palette.primary.main;
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
        px: 1.4,
        py: 0.95,
        borderRadius: "10px",
        display: "flex",
        alignItems: "center",
        gap: 1,
        background: alpha(color, accent ? 0.07 : 0.035),
        border: `1px solid ${alpha(color, accent ? 0.32 : 0.16)}`,
        color: "text.primary",
        fontSize: "0.8rem",
        fontWeight: accent ? 600 : 500,
        lineHeight: 1.4,
        transition: "background 160ms, border-color 160ms, transform 160ms",
        ...rise(index),
        "& .chip-go": { opacity: 0, transform: "translateX(-4px)", transition: "opacity 160ms, transform 160ms" },
        "&:hover, &:focus-visible": {
          background: alpha(color, accent ? 0.13 : 0.08),
          borderColor: alpha(color, 0.5),
          transform: "translateX(2px)",
          "& .chip-go": { opacity: 1, transform: "none" },
        },
        "&:focus-visible": { outline: `2px solid ${color}`, outlineOffset: 2 },
      }}
    >
      <Box component="span" sx={{ flex: 1 }}>{label}</Box>
      <ArrowForwardRoundedIcon className="chip-go" sx={{ fontSize: 15, color }} />
    </Box>
  );
};

const Group = ({ Icon, title, index, children }) => {
  const theme = useTheme();
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.65 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.6, fontSize: "0.68rem", fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: "text.secondary", ...rise(index) }}>
        <Icon sx={{ fontSize: 14, color: theme.palette.ai.main }} />
        {title}
      </Box>
      {children}
    </Box>
  );
};

/** What the person is looking at gives the first suggestions: the line on screen, the validation's findings. */
const contextualSuggestions = (context, t) => {
  const out = [];
  const route = context?.focus?.routeName || null;
  if (route) out.push(t("chat.suggest.route", { route }));
  const errors = context?.validation?.errors || 0;
  const top = context?.validation?.topRules?.[0] || null;
  if (top?.code) out.push(t("chat.suggest.rule", { code: top.code, count: top.count }));
  else if (errors > 0) out.push(t("chat.suggest.errors", { count: errors }));
  return out;
};

const EmptyState = ({ onPickExample, context = null }) => {
  const { t } = useLanguage();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const aiColor = theme.palette.ai.main;
  const now = contextualSuggestions(context, t);
  const route = context?.focus?.routeName || null;
  const groups = [
    ...(now.length ? [{ Icon: CenterFocusStrongRoundedIcon, title: t("chat.empty.groupNow"), items: now, accent: true }] : []),
    { Icon: TravelExploreIcon, title: t("chat.empty.groupExplore"), items: [t("chat.empty.exploreA"), t("chat.empty.exploreB")] },
    { Icon: HealthAndSafetyOutlinedIcon, title: t("chat.empty.groupDiagnose"), items: [t("chat.empty.diagnoseA"), t("chat.empty.diagnoseB")] },
    { Icon: EditNoteRoundedIcon, title: t("chat.empty.groupChange"), items: [route ? t("chat.empty.changeRoute", { route }) : t("chat.empty.changeA")] },
  ];
  let n = 0;
  return (
    <Box data-testid="chat-empty" sx={{ ...MOTION, flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", alignItems: "center", px: 3, py: 3 }}>
      <Box sx={{ position: "relative", mb: 1.75, mt: 1.5, animation: "chatRise 480ms cubic-bezier(.2,.8,.2,1) both" }}>
        <Box aria-hidden sx={{ position: "absolute", inset: -14, borderRadius: "50%", background: `radial-gradient(circle, ${alpha(aiColor, isDark ? 0.26 : 0.18)} 0%, transparent 70%)`, animation: "chatGlow 3.6s ease-in-out infinite", pointerEvents: "none" }} />
        <Box aria-hidden sx={{ position: "absolute", inset: -7, borderRadius: "50%", border: `1.5px dashed ${alpha(aiColor, 0.35)}`, animation: "chatOrbit 18s linear infinite", pointerEvents: "none" }} />
        <Box sx={{ width: 60, height: 60, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart} 0%, ${theme.palette.ai.gradientEnd} 100%)`, color: theme.palette.ai.contrastText, boxShadow: `0 8px 28px ${alpha(aiColor, 0.35)}`, position: "relative" }}>
          <GTFSAIIcon sx={{ fontSize: 30 }} />
        </Box>
      </Box>
      <Box component="h3" sx={{ m: 0, fontSize: "1.06rem", fontWeight: 750, color: "text.primary", mb: 0.5, textAlign: "center", ...rise(0) }}>
        {t("chat.empty.title")}
      </Box>
      <Box sx={{ fontSize: "0.8rem", color: "text.secondary", maxWidth: 380, lineHeight: 1.55, mb: 2.25, textAlign: "center", ...rise(1) }}>
        {t("chat.empty.subtitle")}
      </Box>
      <Box sx={{ width: "100%", maxWidth: 440, display: "flex", flexDirection: "column", gap: 1.75 }}>
        {groups.map((g) => (
          <Group key={g.title} Icon={g.Icon} title={g.title} index={n++}>
            {g.items.map((ex) => (
              <PromptChip key={ex} label={ex} accent={g.accent} index={n++} onClick={() => onPickExample(ex)} />
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
  onPickFollowup = null,
  onReplayAction = null,
  context = null,
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
    return <EmptyState onPickExample={onPickExample} context={context} />;
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
