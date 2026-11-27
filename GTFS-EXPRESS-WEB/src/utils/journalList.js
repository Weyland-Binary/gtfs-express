/**
 * The edit journal as a screen lists it (GET /edit/history): its latest entries first, the older ones read by pages,
 * and the question asked before going back in it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import API_BASE_URL from "../config";
import { fetchWithSession } from "./sessionManager";
import { useGuard } from "../contexts/DestructiveGuardContext";

const readPage = async (session, before = null) => {
  const res = await fetchWithSession(`${API_BASE_URL}/edit/history${before == null ? "" : `?before=${before}`}`, { cache: "no-store", ...(session ? { headers: { "X-Session-ID": session } } : {}) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/**
 * The journal of `session` (the screen's own when null), read again whenever `version` moves and `enabled` holds:
 * `{ history, total, since, loaded, error, hasMore, more }` (`error`: the first page could not be read). `more()`
 * adds the page older than the last entry listed; a new read starts from the first page again.
 */
export function useJournalList({ session = null, enabled = true, version = 0 } = {}) {
  const [state, setState] = useState({ history: [], total: 0, since: null, loaded: false, error: null });
  // Each read of the first page starts a new list: a page asked for the list before it is dropped.
  const listRef = useRef(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const list = ++listRef.current;
    readPage(session)
      .then((body) => {
        if (listRef.current !== list) return;
        const history = Array.isArray(body.history) ? body.history : [];
        setState({ history, total: Number.isInteger(body.total) ? body.total : history.length, since: body.since_edit_id ?? null, loaded: true, error: null });
      })
      .catch((error) => {
        if (listRef.current === list) setState((s) => ({ ...s, loaded: true, error }));
      });
    return () => {
      if (listRef.current === list) listRef.current += 1;
    };
  }, [session, enabled, version]);

  const oldest = state.history.length ? state.history[state.history.length - 1].id : null;
  const more = useCallback(async () => {
    if (oldest == null) return;
    const list = listRef.current;
    try {
      const body = await readPage(session, oldest);
      if (listRef.current !== list) return;
      const older = Array.isArray(body.history) ? body.history : [];
      setState((s) => ({ ...s, history: [...s.history, ...older], total: Number.isInteger(body.total) ? body.total : s.total }));
    } catch {
      /* the page stays to be asked again */
    }
  }, [session, oldest]);

  return { ...state, hasMore: state.history.length < state.total, more };
}

/** How many standing edits a jump to `targetId` undoes, in a journal listed newest first. */
export const undoneByJump = (history, targetId) => (Array.isArray(history) ? history : []).filter((e) => e && !e.undone && Number(e.id) > Number(targetId)).length;

/**
 * `jump(targetId)` for a journal listed as `history`: a jump that undoes edits asks first, naming how many (the next
 * edit drops them for good); one that undoes none goes at once.
 */
export function useJournalJump(history, jumpToHistory) {
  const guard = useGuard();
  return useCallback(
    (targetId) => {
      if (targetId == null || !jumpToHistory) return undefined;
      const count = undoneByJump(history, targetId);
      if (count === 0) return jumpToHistory(targetId);
      return guard(() => jumpToHistory(targetId), { ask: { count, titleKey: "editHistory.back.title", labelKey: "editHistory.back.count", acceptKey: "editHistory.jumpTooltip" }, reasonKey: "editHistory.back.reason" });
    },
    [guard, history, jumpToHistory],
  );
}
