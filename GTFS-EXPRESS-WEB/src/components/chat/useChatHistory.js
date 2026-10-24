/**
 * The conversation's turns and its id, kept in sessionStorage under the feed session's id: the chat survives
 * navigation and a reload of the same working copy in the same tab, and clears with the tab or with the feed (the
 * drawer resets it on a new network). Capped at MAX_BYTES (oldest pairs dropped first) to stay within the
 * browser's quota; written debounced, never on every token.
 *
 * A turn: { id, role, content, startedAt, attachment? (user) | status, steps, changes, uiActions, charts, journeys,
 * followups, pendingTool, error?, model? (assistant) }.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getSessionId } from "../../utils/sessionManager";

const STORAGE_KEY = "gtfs.chat.history";
const MAX_BYTES = 300 * 1024;
const PERSIST_DEBOUNCE_MS = 500;

const newId = () => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

// The working copy the chat was about: a history of another feed session is never shown.
const feedSessionId = () => {
  try {
    return getSessionId();
  } catch {
    return null;
  }
};

const loadInitial = () => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { conversationId: newId(), turns: [] };
    const parsed = JSON.parse(raw);
    const session = feedSessionId();
    if (!session || parsed?.sessionId !== session) {
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
    /* corrupt */
  }
  return { conversationId: newId(), turns: [] };
};

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
    const sessionId = feedSessionId();
    if (!sessionId) return;
    let slim = { ...state, turns: state.turns.map(slimTurn), sessionId };
    let payload = JSON.stringify(slim);
    while (payload.length > MAX_BYTES && slim.turns.length > 2) {
      slim = { ...slim, turns: slim.turns.slice(2) };
      payload = JSON.stringify(slim);
    }
    sessionStorage.setItem(STORAGE_KEY, payload);
  } catch {
    /* sessionStorage full or disabled: the chat simply is not kept */
  }
};

/** Assistant turns carry a compact trace of their tools, so the model can refer to "the query above". */
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
        changes: (t.changes || []).map((c) => ({ brief: c.brief })),
        uiActions: (t.uiActions || []).map((a) => ({ label: a.label })),
      });
    }
  }
  return wire;
};

export default function useChatHistory() {
  const [state, setState] = useState(loadInitial);
  // Debounced: a streaming answer updates its turn on every token, and each write serialises up to MAX_BYTES.
  const pendingRef = useRef(null);
  const timerRef = useRef(null);
  useEffect(() => {
    pendingRef.current = state;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (pendingRef.current) persist(pendingRef.current);
      pendingRef.current = null;
    }, PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timerRef.current);
  }, [state]);
  // What is still pending is written before the tab goes (a reload, a close), and on unmount.
  useEffect(() => {
    const flush = () => {
      if (!pendingRef.current) return;
      clearTimeout(timerRef.current);
      timerRef.current = null;
      persist(pendingRef.current);
      pendingRef.current = null;
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

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
      changes: [],
      uiActions: [],
      charts: [],
      journeys: [],
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
    // Nothing pending may write the old turns back after the removal.
    clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingRef.current = null;
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

export { newId as newChatId };
