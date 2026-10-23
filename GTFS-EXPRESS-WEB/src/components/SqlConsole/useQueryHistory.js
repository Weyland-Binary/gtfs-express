import { useCallback, useMemo, useState } from "react";
import { HISTORY_MAX } from "./constants";
import { PRESET_QUERIES } from "./presetQueries";
import {
  loadHistory,
  saveHistory,
  loadUserPresets,
  saveUserPresets,
} from "./persistence";

/** The queries run (history) and kept (the person's presets), and the built-in presets sorted. */
export default function useQueryHistory({ query, language, showSnack, t }) {
  // Sorted by the translated label, with the interface language's collation.
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
  // A repeat of the latest entry is not recorded.
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
