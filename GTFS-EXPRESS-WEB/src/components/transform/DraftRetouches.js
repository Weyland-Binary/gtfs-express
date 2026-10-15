/**
 * DraftRetouches — the retouches of the draft: what changed the working copy
 * since its last version outside the change's plan — by hand in the editors,
 * by SQL, a correction of the validation, the assistant's cards — listed
 * beside the plan (③) and the change list (⑤), so that the draft's
 * modifications read as one list: the operations of the change, then these.
 *
 * Read from the edit journal (GET /edit/history: the edits newer than the
 * version, `since_edit_id`, not undone, the plan's own application left to
 * the plan), each with where it came from, what it did, who made it and when.
 * In edit mode the latest one is undone in place (« Annuler »), and the
 * draft can be taken back to just after any of them (« Revenir ici »); read,
 * the list only says them. A working copy without retouches shows nothing.
 * `edit`: the edit mode's state and acts, from the studio ({ editing,
 * dataVersion, undoLast, jumpToHistory }); without it the list only reads.
 */

import React, { useCallback, useEffect, useState } from "react";
import { Box, Button, Chip, Typography, alpha, useTheme } from "@mui/material";
import UndoIcon from "@mui/icons-material/Undo";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { formatTime } from "../../utils/formatDate";

/** Where a retouch came from, in the journal's own fields: SQL, a correction of the validation, or by hand. */
export const retouchSourceOf = (entry) => (entry?.reason === "sql" ? "sql" : entry?.action === "quick_fix" ? "fix" : "hand");

// The journal's actions, said in the interface's language; an action without words keeps the journal's own line.
const ACTION_WORDS = {
  create: (t) => t("retouches.action.create"),
  update: (t) => t("retouches.action.update"),
  delete: (t) => t("retouches.action.delete"),
  merge: (t) => t("retouches.action.merge"),
  shift_times: (t) => t("retouches.action.shift_times"),
  stop_times_batch: (t) => t("retouches.action.stop_times_batch"),
  bulk_update: (t) => t("retouches.action.bulk_update"),
  sql_mutation: (t) => t("retouches.action.sql_mutation"),
  quick_fix: (t) => t("retouches.action.quick_fix"),
  insert: (t) => t("retouches.action.insert"),
  upsert: (t) => t("retouches.action.upsert"),
  fork: (t) => t("retouches.action.fork"),
};
const ACTIONS = new Set(Object.keys(ACTION_WORDS));

// The objects a retouche touches, in the person's words (retouches.entity.*); another entity keeps its own name.
const ENTITIES = new Set(["stop", "route", "trip", "stop_time", "shape", "calendar", "calendar_dates", "agency", "frequency", "transfer", "level", "pathway", "translation", "attribution", "feed_info"]);
/** The object a journal line names: « horaire · course T1, arrêt n° 4 », « arrêt BRY ». */
const objectOf = (entry, t) => {
  if (!entry?.entity || entry.entity === "sql_console" || entry.entity === "mixed") return "";
  const noun = ENTITIES.has(entry.entity) ? t(`retouches.entity.${entry.entity}`) : entry.entity;
  const id = entry.entity_id == null ? "" : String(entry.entity_id);
  if (entry.entity === "stop_time" && /^[^:]+:\d+$/.test(id)) {
    const [trip, seq] = id.split(":");
    return `${noun} · ${t("retouches.stopTime.where", { trip, seq })}`;
  }
  return id ? `${noun} ${id}` : noun;
};

/** What a retouch did, in words: its action, then the object it touched, named as the network names it. */
export const retouchWordsOf = (entry, t) => {
  if (!entry || !ACTIONS.has(entry.action)) return entry?.description || entry?.entity || "—";
  const object = objectOf(entry, t);
  const word = ACTION_WORDS[entry.action](t);
  return object ? `${word} · ${object}` : word;
};

/** The retouches of the draft from the journal: newer than the version, standing, the plan's application excluded. */
export const draftRetouchesOf = (history = [], since = null) =>
  (Array.isArray(history) ? history : []).filter((e) => e && !e.undone && e.reason !== "plan" && (since == null || Number(e.id) > Number(since)));

export default function DraftRetouches({ testid = "draft-retouches", edit = null }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const { editing = false, dataVersion = 0, undoLast = null, jumpToHistory = null } = edit || {};
  const [state, setState] = useState({ history: [], since: null, loaded: false });

  const load = useCallback(async () => {
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/history`, { cache: "no-store" });
      if (!res.ok) return;
      const body = await res.json();
      setState({ history: body.history || [], since: body.since_edit_id ?? null, loaded: true });
    } catch {
      /* the list waits for the next change */
    }
  }, []);
  useEffect(() => {
    load();
  }, [load, dataVersion, editing]);

  const retouches = draftRetouchesOf(state.history, state.since);
  if (!state.loaded || !retouches.length) return null;
  const latest = retouches[0]?.id;
  return (
    <Box component="section" aria-labelledby={`${testid}-title`} data-testid={testid} sx={{ mt: 2, pt: 1.5, borderTop: `1px solid ${theme.palette.divider}` }}>
      <Typography id={`${testid}-title`} component="h3" sx={{ fontSize: "0.82rem", fontWeight: 650, mb: 0.75 }}>
        {t("retouches.title")}
        <Box component="span" sx={{ color: "text.secondary", fontWeight: 500 }}>{` · ${retouches.length}`}</Box>
      </Typography>
      <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.5 }}>
        {retouches.map((entry) => {
          const source = retouchSourceOf(entry);
          const tone = source === "sql" ? theme.palette.info.main : source === "fix" ? theme.palette.success.main : theme.palette.warning.main;
          const when = entry.ts ? formatTime(entry.ts, language) : "";
          return (
            <Box component="li" key={entry.id} data-testid="draft-retouch" data-source={source} data-entry-id={entry.id} sx={{ display: "flex", alignItems: "flex-start", gap: 0.75, px: 1, py: 0.6, borderRadius: "8px", border: `1px solid ${theme.palette.divider}` }}>
              <Chip size="small" label={t(`retouches.source.${source}`)} sx={{ flexShrink: 0, height: 20, fontSize: "0.68rem", fontWeight: 650, color: tone, backgroundColor: alpha(tone, 0.12) }} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography title={entry.description || undefined} sx={{ fontSize: "0.78rem", lineHeight: 1.4, overflowWrap: "anywhere" }}>{retouchWordsOf(entry, t)}</Typography>
                <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }}>{[entry.actor_name, when].filter(Boolean).join(" · ")}</Typography>
              </Box>
              {editing &&
                (entry.id === latest ? (
                  <Button size="small" startIcon={<UndoIcon sx={{ fontSize: "15px !important" }} />} onClick={() => undoLast?.(entry.id)} data-testid="draft-retouch-undo" sx={{ flexShrink: 0, textTransform: "none", fontWeight: 650, minWidth: 0, px: 1 }}>
                    {t("retouches.undo")}
                  </Button>
                ) : (
                  <Button size="small" onClick={() => jumpToHistory?.(entry.id)} data-testid="draft-retouch-back" sx={{ flexShrink: 0, textTransform: "none", fontWeight: 600, minWidth: 0, px: 1, color: "text.secondary" }}>
                    {t("retouches.backHere")}
                  </Button>
                ))}
            </Box>
          );
        })}
      </Box>
      {!editing && (
        <Typography data-testid="draft-retouches-read" sx={{ mt: 0.75, fontSize: "0.72rem", color: "text.secondary" }}>
          {t("retouches.readOnly")}
        </Typography>
      )}
    </Box>
  );
}
