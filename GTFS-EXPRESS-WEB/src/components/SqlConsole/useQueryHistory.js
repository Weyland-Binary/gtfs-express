import { useCallback, useMemo, useState } from "react";
import { HISTORY_MAX } from "./constants";
import { PRESET_QUERIES } from "./presetQueries";
import {
  loadHistory,
  saveHistory,
  loadUserPresets,
  saveUserPresets,
} from "./persistence";

/**
 * useQueryHistory — the queries run and the queries kept: the history
 * (latest first, HISTORY_MAX entries, a repeat of the latest not recorded,
 * persisted through persistence.js), the person's saved presets (named from
 * the editor's text, deleted one by one), the anchors of the history menu and
 * the save dialog, and the built-in preset groups sorted by their label in
 * the interface's language. The caller's runner records each run with
 * `pushHistory`; the menus and the dialog render from the state returned.
 */
export default function useQueryHistory({ query, language, showSnack, t }) {
  // Sort each preset group's items alphabetically by their localized label.
  // Sorting on the resolved label (via `t(labelKey)`) gives the user an
  // alphabetical list in their own language. We use Intl.Collator with the
  // current `language` so accented and non-Latin scripts sort correctly
  // (Chinese, Hindi, etc.). The memo is keyed on `language` because `t` is
  // stable across renders within the same language but the sort outcome
  // changes when the user switches languages.
  const presetGroups = useMemo(() => {
    const collator = new Intl.Collator(language || undefined, {
      sensitivity: "base",
      numeric: true,
    });
    return PRESET_QUERIES.map((group) => ({
      ...group,
      items: [...group.items].sort((a, b) =>
        collator.compare(t(a.labelKey), t(b.labelKey)),
      ),
    }));
  }, [language, t]);
  const [history, setHistory] = useState(() => loadHistory());
  // The query just run goes on top of the history once (a repeat of the
  // latest entry is not recorded), capped at HISTORY_MAX and persisted.
  const pushHistory = useCallback((trimmed) => {
    setHistory((prev) => {
      if (prev.length > 0 && prev[0].query === trimmed) return prev;
      const next = [{ query: trimmed, ts: Date.now() }, ...prev].slice(
        0,
        HISTORY_MAX,
      );
      saveHistory(next);
      return next;
    });
  }, []);
  const [userPresets, setUserPresets] = useState(() => loadUserPresets());
  const [historyAnchor, setHistoryAnchor] = useState(null);
  const [savePresetOpen, setSavePresetOpen] = useState(false);
  const [savePresetName, setSavePresetName] = useState("");
  const handleSavePreset = useCallback(() => {
    const name = savePresetName.trim();
    if (!name) return;
    const next = [
      ...userPresets,
      { id: `user-${Date.now()}`, name, sql: query, ts: Date.now() },
    ];
    setUserPresets(next);
    saveUserPresets(next);
    setSavePresetOpen(false);
    setSavePresetName("");
    showSnack(t("sqlConsole.presetSaved", { name }));
  }, [savePresetName, userPresets, query, showSnack, t]);

  const handleDeleteUserPreset = useCallback(
    (id) => {
      const next = userPresets.filter((p) => p.id !== id);
      setUserPresets(next);
      saveUserPresets(next);
    },
    [userPresets],
  );

  const handleClearHistory = useCallback(() => {
    setHistory([]);
    saveHistory([]);
    setHistoryAnchor(null);
  }, []);
  return {
    presetGroups,
    history,
    pushHistory,
    userPresets,
    historyAnchor,
    setHistoryAnchor,
    savePresetOpen,
    setSavePresetOpen,
    savePresetName,
    setSavePresetName,
    handleSavePreset,
    handleDeleteUserPreset,
    handleClearHistory,
  };
}
