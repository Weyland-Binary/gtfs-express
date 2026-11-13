/**
 * The Diagnostic: the semantic findings the validator cannot see (GET /quality_audit), read again a moment after each
 * edit, the findings the person chose to ignore set apart (the assistant's memory keeps them).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { licenceLockOf, openPaywall, useFeatures } from "../../utils/featuresApi";
import { CHAT_OPEN_EVENT, NAVIGATE_EVENT } from "../../utils/appEvents";
import useAssistantMemory from "../chat/useAssistantMemory";

export default function useQualityAudit({ enabled = true } = {}) {
  const { t } = useLanguage();
  const { dataVersion } = useEditMode();
  const { features } = useFeatures();
  const chatEnabled = Boolean(features?.chat?.enabled);
  // Repairing is modifying: under the paid offer without the licence, the offer opens instead of the assistant.
  const editLock = licenceLockOf(features?.access);
  const [audit, setAudit] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);
  const [showIgnored, setShowIgnored] = useState(false);
  const { memory, update: updateMemory } = useAssistantMemory({ enabled: true });
  const ignoredSet = useMemo(() => new Set(memory?.ignoredFindings || []), [memory]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/quality_audit`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAudit(await res.json());
    } catch (err) {
      setError(err.message || "error");
    } finally {
      setLoading(false);
    }
  }, []);

  // Several edits in a row make one audit.
  useEffect(() => {
    if (!enabled) return undefined;
    const id = setTimeout(load, dataVersion ? 1200 : 0);
    return () => clearTimeout(id);
  }, [load, dataVersion, enabled]);

  const all = useMemo(() => audit?.findings || [], [audit]);
  const active = useMemo(() => all.filter((f) => !ignoredSet.has(f.code)), [all, ignoredSet]);
  const findings = showIgnored ? all : active;
  const ignoredCount = all.length - active.length;
  const warnings = active.filter((f) => f.severity === "warning").length;
  const infos = active.filter((f) => f.severity === "info").length;
  const clean = Boolean(audit) && active.length === 0;

  const toggleIgnore = useCallback(
    (code, ignore) => {
      updateMemory(ignore ? { ignore: [code] } : { unignore: [code] }).catch(() => {});
    },
    [updateMemory],
  );

  const askAi = useCallback(
    (finding) => {
      const samples = finding.samples
        .slice(0, 5)
        .map((s) => `- ${s.label}${s.detail ? ` — ${s.detail}` : ""}`)
        .join("\n");
      const message = t("audit.aiPrompt", {
        code: finding.code,
        title: t(`audit.code.${finding.code}.title`),
        count: finding.count,
        samples,
      });
      window.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT, { detail: { message } }));
    },
    [t],
  );

  const askAiAll = useCallback(() => {
    const ask = () => window.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT, { detail: { message: t("audit.aiRepairAllPrompt") } }));
    if (editLock) {
      openPaywall("edit", editLock, ask);
      return;
    }
    ask();
  }, [t, editLock]);

  const openStudio = useCallback((finding) => {
    const routeId = finding.samples.find((s) => s.routeId)?.routeId || null;
    window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { target: "shape_studio", routeId } }));
  }, []);

  return { audit, loading, error, load, findings, active, ignoredSet, ignoredCount, showIgnored, setShowIgnored, toggleIgnore, warnings, infos, clean, askAi, askAiAll, openStudio, chatEnabled, editLock };
}
