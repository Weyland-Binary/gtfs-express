/**
 * useChatHistory — Conversation state for the chat assistant.
 *
 * Owns the array of turns + a stable conversationId, persisted to
 * sessionStorage so the chat survives navigation but clears on tab close
 * (matches the user's likely mental model — chat is ephemeral, not saved).
 *
 * Turn shape:
 *   {
 *     id:           string (uuid)        — react key
 *     role:         "user" | "assistant"
 *     content:      string                — for "user": the prompt; for
 *                                            "assistant": the preamble + summary
 *     // assistant-only fields:
 *     status?:      "streaming" | "complete" | "blocked" | "error" | "aborted"
 *     preamble?:    string
 *     sql?:         string
 *     summary?:     string
 *     blocked?:     { reason, message, draftSql }
 *     result?:      { rowCount, columns, rowsPreview, truncated, durationMs }
 *     resultSummary?: string  — short "N rows" hint sent in subsequent turns
 *     error?:       { message, code? }
 *     model?:       string
 *     startedAt:    number  (Date.now())
 *   }
 *
 * Persistence: sessionStorage key `gtfs.chat.history`. Capped at 200 KB
 * (rolling drop oldest pair) to avoid exceeding browser quotas on long
 * sessions.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "gtfs.chat.history";
const MAX_BYTES = 200 * 1024;

const newId = () => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

// Fresh UUID per page load — lets us detect stale sessionStorage written by a
// previous load so we never show history from a different feed after a reload.
const APP_LAUNCH_ID = newId();

const loadInitial = () => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { conversationId: newId(), turns: [] };
    const parsed = JSON.parse(raw);
    // Written by a different page load → belongs to a different feed session.
    if (parsed?.appLaunchId !== APP_LAUNCH_ID) {
      return { conversationId: newId(), turns: [] };
    }
    if (parsed && Array.isArray(parsed.turns)) {
      return {
        conversationId:
          typeof parsed.conversationId === "string"
            ? parsed.conversationId
            : newId(),
        turns: parsed.turns,
      };
    }
  } catch {
    /* corrupt — fall through */
  }
  return { conversationId: newId(), turns: [] };
};

const persist = (state) => {
  try {
    let payload = JSON.stringify({ ...state, appLaunchId: APP_LAUNCH_ID });
    // If too large, drop oldest pairs until under MAX_BYTES.
    while (payload.length > MAX_BYTES && state.turns.length > 2) {
      state = { ...state, turns: state.turns.slice(2) };
      payload = JSON.stringify({ ...state, appLaunchId: APP_LAUNCH_ID });
    }
    sessionStorage.setItem(STORAGE_KEY, payload);
  } catch {
    /* sessionStorage full or disabled — silently drop persistence */
  }
};

/**
 * Build the trimmed message array sent to the backend. Each turn becomes
 * one Anthropic message — assistants are flattened to text the model can
 * re-parse if needed (server then re-trims to MAX_TURNS).
 */
export const turnsToWireMessages = (turns) => {
  const wire = [];
  for (const t of turns) {
    if (t.role === "user" && t.content) {
      wire.push({ role: "user", content: t.content });
    } else if (t.role === "assistant") {
      wire.push({
        role: "assistant",
        content: t.summary || t.preamble || "",
        preamble: t.preamble,
        sql: t.sql,
        summary: t.summary,
        blocked: t.blocked,
        resultSummary:
          t.result && typeof t.result.rowCount === "number"
            ? `${t.result.rowCount} rows`
            : null,
      });
    }
  }
  return wire;
};

export default function useChatHistory() {
  const [state, setState] = useState(loadInitial);
  // Persist on every change. Synchronous — sessionStorage writes are fast.
  const persistRef = useRef(persist);
  useEffect(() => {
    persistRef.current(state);
  }, [state]);

  const appendUser = useCallback((content) => {
    const turn = {
      id: newId(),
      role: "user",
      content,
      startedAt: Date.now(),
    };
    setState((prev) => ({ ...prev, turns: [...prev.turns, turn] }));
    return turn;
  }, []);

  const appendAssistant = useCallback((init = {}) => {
    const turn = {
      id: newId(),
      role: "assistant",
      content: "",
      status: "streaming",
      preamble: "",
      sql: "",
      summary: "",
      startedAt: Date.now(),
      ...init,
    };
    setState((prev) => ({ ...prev, turns: [...prev.turns, turn] }));
    return turn;
  }, []);

  const updateTurn = useCallback((id, patch) => {
    setState((prev) => ({
      ...prev,
      turns: prev.turns.map((t) =>
        t.id === id
          ? typeof patch === "function"
            ? { ...t, ...patch(t) }
            : { ...t, ...patch }
          : t,
      ),
    }));
  }, []);

  const removeTurn = useCallback((id) => {
    setState((prev) => ({
      ...prev,
      turns: prev.turns.filter((t) => t.id !== id),
    }));
  }, []);

  const reset = useCallback(() => {
    const fresh = { conversationId: newId(), turns: [] };
    setState(fresh);
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  return {
    conversationId: state.conversationId,
    turns: state.turns,
    appendUser,
    appendAssistant,
    updateTurn,
    removeTurn,
    reset,
  };
}

export { STORAGE_KEY as CHAT_HISTORY_STORAGE_KEY, newId as newChatId };
