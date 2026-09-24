/**
 * useAssistantMemory — what the assistant remembers about this session
 * (GET/PUT /assistant/memory), shared by the chat header chip and the
 * Diagnostic panel. Every write broadcasts MEMORY_EVENT so each consumer
 * refreshes; the chat also dispatches it when the assistant's `remember`
 * tool fires.
 */

import { useCallback, useEffect, useState } from "react";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";

export const MEMORY_EVENT = "gtfs:memory-changed";
const EMPTY = { notes: [], ignoredFindings: [], updatedAt: null };

export async function updateAssistantMemory(change) {
  const res = await fetchWithSession(`${API_BASE_URL}/assistant/memory`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(change),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  window.dispatchEvent(new CustomEvent(MEMORY_EVENT, { detail: body }));
  return body;
}

export default function useAssistantMemory({ enabled = true, feedEpoch = 0 } = {}) {
  const [memory, setMemory] = useState(EMPTY);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/assistant/memory`);
      if (res.ok) setMemory(await res.json());
    } catch {
      /* keep the last known memory */
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    refresh();
  }, [refresh, feedEpoch]);

  useEffect(() => {
    const handler = (e) => {
      if (e?.detail && Array.isArray(e.detail.notes)) setMemory(e.detail);
      else refresh();
    };
    window.addEventListener(MEMORY_EVENT, handler);
    return () => window.removeEventListener(MEMORY_EVENT, handler);
  }, [refresh]);

  const update = useCallback(async (change) => {
    const body = await updateAssistantMemory(change);
    setMemory(body);
    return body;
  }, []);

  return { memory, loading, refresh, update };
}
