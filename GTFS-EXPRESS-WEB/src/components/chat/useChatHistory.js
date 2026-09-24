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
 *     content:      string                — user: the prompt; assistant: the
 *                                            markdown answer
 *     // user-only field:
 *     attachment?:  { table, filename, rowCount } — tabular file the turn
 *                                            was asked against (chip in bubble)
 *     // assistant-only fields:
 *     status?:      "streaming" | "complete" | "error" | "aborted"
 *     steps?:       [{ stepId, kind, sql, purpose, status, rowCount, columns,
 *                      rowsPreview, truncated, durationMs, error }]
 *     proposals?:   [{ proposalId, title, rationale, sql, preview, outcome? }]
 *     uiActions?:   [{ actionId, target, id, routeId, agencyId, label }]
 *     charts?:      [{ chartId, stepId, chartType, x, y, title, rows }]
 *     followups?:   string[]
 *     pendingTool?: string | null   — tool announced but not finished
 *     error?:       { message, code? }
 *     model?:       string
 *     startedAt:    number  (Date.now())
 *   }
 *
 * Persistence: sessionStorage key `gtfs.chat.history`. Capped at 300 KB
 * (rolling drop oldest pair) to avoid exceeding browser quotas on long
 * sessions; chart rows and result previews are trimmed before writing.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "gtfs.chat.history";
const MAX_BYTES = 300 * 1024;

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
        // A turn interrupted by a reload can never finish streaming.
        turns: parsed.turns.map((t) =>
          t.role === "assistant" && t.status === "streaming"
            ? { ...t, status: "aborted", pendingTool: null }
            : t,
        ),
      };
    }
  } catch {
    /* corrupt — fall through */
  }
  return { conversationId: newId(), turns: [] };
};

// Storage-friendly copy of a turn (previews and chart rows are trimmed).
const slimTurn = (t) => {
  if (t.role !== "assistant") return t;
  return {
    ...t,
    steps: (t.steps || []).map((s) => ({
      ...s,
      rowsPreview: Array.isArray(s.rowsPreview) ? s.rowsPreview.slice(0, 20) : [],
    })),
    charts: (t.charts || []).map((c) => ({
      ...c,
      rows: Array.isArray(c.rows) ? c.rows.slice(0, 100) : [],
    })),
  };
};

const persist = (state) => {
  try {
    let slim = { ...state, turns: state.turns.map(slimTurn), appLaunchId: APP_LAUNCH_ID };
    let payload = JSON.stringify(slim);
    // If too large, drop oldest pairs until under MAX_BYTES.
    while (payload.length > MAX_BYTES && slim.turns.length > 2) {
      slim = { ...slim, turns: slim.turns.slice(2) };
      payload = JSON.stringify(slim);
    }
    sessionStorage.setItem(STORAGE_KEY, payload);
  } catch {
    /* sessionStorage full or disabled — silently drop persistence */
  }
};

/**
 * Build the trimmed message array sent to the backend. Each turn becomes
 * one message; assistant turns carry a compact trace of the tools they used
 * so the model keeps continuity ("the query above", "apply the second fix").
 */
export const turnsToWireMessages = (turns) => {
  const wire = [];
  for (const t of turns) {
    if (t.role === "user" && t.content) {
      wire.push({ role: "user", content: t.content });
    } else if (t.role === "assistant") {
      wire.push({
        role: "assistant",
        content: t.content || "",
        steps: (t.steps || [])
          .filter((s) => s.kind === "sql" && s.sql)
          .map((s) => ({
            kind: "sql",
            sql: s.sql,
            rowCount: typeof s.rowCount === "number" ? s.rowCount : null,
            error: s.error || null,
          })),
        proposals: (t.proposals || []).map((p) => ({
          title: p.title,
          sql: p.sql,
          outcome: p.outcome || null,
        })),
        uiActions: (t.uiActions || []).map((a) => ({ label: a.label })),
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

  const appendUser = useCallback((content, extra = {}) => {
    const turn = {
      id: newId(),
      role: "user",
      content,
      startedAt: Date.now(),
      ...extra,
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
      steps: [],
      proposals: [],
      uiActions: [],
      charts: [],
      followups: [],
      pendingTool: null,
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
