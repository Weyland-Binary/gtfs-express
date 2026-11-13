import { useEffect, useState } from "react";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";

/** In edit mode, the rules a quick fix can repair now (GET /edit/quickfix): Map<ruleCode, { count, titleKey }>. */
export default function useQuickFixes() {
  const { editing, dataVersion } = useEditMode();
  const [map, setMap] = useState(null);
  useEffect(() => {
    if (!editing) {
      setMap(null);
      return undefined;
    }
    let cancelled = false;
    fetchWithSession(`${API_BASE_URL}/edit/quickfix`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        const next = new Map();
        for (const r of data.rules || []) next.set(r.ruleCode, { count: r.count, titleKey: r.titleKey });
        setMap(next);
      })
      .catch(() => {
        if (!cancelled) setMap(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [editing, dataVersion]);
  return map;
}
