/**
 * The retouches of a draft (or of a working copy since its version), read from the edit journal (GET /edit/history).
 * With `edit` the latest is undone in place and the draft taken back to any of them; without it the list only reads.
 * On a draft's own `session` every journal line is a retouche, the assistant's joined plans included (`withPlans`).
 */

import React, { useCallback, useEffect, useState } from "react";
import { Box, Button, Chip, Typography, alpha, useTheme } from "@mui/material";
import UndoIcon from "@mui/icons-material/Undo";
import UndoRoundedIcon from "@mui/icons-material/UndoRounded";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import TerminalRoundedIcon from "@mui/icons-material/TerminalRounded";
import AutoFixHighRoundedIcon from "@mui/icons-material/AutoFixHighRounded";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { formatClockTime } from "../../utils/formatDate";

// Each origin's mark on the draft's timeline.
const SOURCE_ICONS = { hand: EditOutlinedIcon, sql: TerminalRoundedIcon, fix: AutoFixHighRoundedIcon, plan: AutoAwesomeOutlinedIcon };

/** Where a retouch came from, in the journal's own fields: SQL, a correction of the validation, a plan, or by hand. */
export const retouchSourceOf = (entry) => (entry?.reason === "sql" ? "sql" : entry?.action === "quick_fix" ? "fix" : entry?.reason === "plan" ? "plan" : "hand");

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
export const draftRetouchesOf = (history = [], since = null, { withPlans = false } = {}) =>
  (Array.isArray(history) ? history : []).filter((e) => e && !e.undone && (withPlans || e.reason !== "plan") && (since == null || Number(e.id) > Number(since)));

export default function DraftRetouches({ testid = "draft-retouches", edit = null, session = null, withPlans = false, bare = false }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const { editing = false, dataVersion = 0, undoLast = null, jumpToHistory = null } = edit || {};
  const [state, setState] = useState({ history: [], since: null, loaded: false });

  const load = useCallback(async () => {
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/history`, { cache: "no-store", ...(session ? { headers: { "X-Session-ID": session } } : {}) });
      if (!res.ok) return;
      const body = await res.json();
      setState({ history: body.history || [], since: body.since_edit_id ?? null, loaded: true });
    } catch {
      /* the list waits for the next change */
    }
  }, [session]);
  useEffect(() => {
    load();
  }, [load, dataVersion, editing]);

  const retouches = draftRetouchesOf(state.history, state.since, { withPlans });
  if (!state.loaded || !retouches.length) return null;
  const latest = retouches[0]?.id;
  const toneOf = (source) => (source === "sql" ? theme.palette.info.main : source === "fix" ? theme.palette.success.main : source === "plan" ? theme.palette.ai?.main || theme.palette.secondary.main : theme.palette.warning.main);
  if (bare) {
    // The draft's own panel: a timeline, newest first; « Revenir ici » shows under the pointer or the keyboard's focus.
    return (
      <Box component="ol" data-testid={testid} sx={{ listStyle: "none", m: 0, p: 0 }}>
        {retouches.map((entry, i) => {
          const source = retouchSourceOf(entry);
          const tone = toneOf(source);
          const Icon = SOURCE_ICONS[source];
          const when = entry.ts ? formatClockTime(entry.ts, language) : "";
          const last = i === retouches.length - 1;
          return (
            <Box component="li" key={entry.id} data-testid="draft-retouch" data-source={source} data-entry-id={entry.id} sx={{ position: "relative", display: "flex", alignItems: "flex-start", gap: 1.25, pb: last ? 0 : 1.75, "&:hover .retouch-back, &:focus-within .retouch-back": { opacity: 1 } }}>
              {!last && <Box aria-hidden sx={{ position: "absolute", left: 13, top: 30, bottom: 2, width: "2px", borderRadius: 1, backgroundColor: theme.palette.divider }} />}
              <Box aria-hidden sx={{ width: 28, height: 28, flexShrink: 0, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: tone, backgroundColor: alpha(tone, theme.palette.mode === "dark" ? 0.2 : 0.12) }}>
                <Icon sx={{ fontSize: 15 }} />
              </Box>
              <Box sx={{ flex: 1, minWidth: 0, pt: "3px" }}>
                <Typography title={entry.description || undefined} sx={{ fontSize: "0.84rem", fontWeight: 600, lineHeight: 1.4, overflowWrap: "anywhere" }}>{retouchWordsOf(entry, t)}</Typography>
                <Typography sx={{ mt: 0.2, fontSize: "0.72rem", color: "text.secondary" }}>{[t(`retouches.source.${source}`), when].filter(Boolean).join(" · ")}</Typography>
              </Box>
              {editing &&
                (entry.id === latest ? (
                  <Button size="small" startIcon={<UndoRoundedIcon sx={{ fontSize: "16px !important" }} />} onClick={() => undoLast?.(entry.id)} data-testid="draft-retouch-undo" sx={{ flexShrink: 0, height: 28, px: 1.1, minWidth: 0, borderRadius: "8px", textTransform: "none", fontWeight: 650, fontSize: "0.78rem", backgroundColor: alpha(theme.palette.primary.main, 0.08), "&:hover": { backgroundColor: alpha(theme.palette.primary.main, 0.14) } }}>
                    {t("retouches.undo")}
                  </Button>
                ) : (
                  <Button size="small" className="retouch-back" onClick={() => jumpToHistory?.(entry.id)} data-testid="draft-retouch-back" sx={{ flexShrink: 0, height: 28, px: 1, minWidth: 0, borderRadius: "8px", textTransform: "none", fontWeight: 600, fontSize: "0.76rem", color: "text.secondary", opacity: 0, transition: "opacity 120ms", "&.Mui-focusVisible": { opacity: 1 } }}>
                    {t("retouches.backHere")}
                  </Button>
                ))}
            </Box>
          );
        })}
      </Box>
    );
  }
  return (
    <Box component="section" aria-labelledby={bare ? undefined : `${testid}-title`} data-testid={testid} sx={bare ? {} : { mt: 2, pt: 1.5, borderTop: `1px solid ${theme.palette.divider}` }}>
      {!bare && (
        <Typography id={`${testid}-title`} component="h3" sx={{ fontSize: "0.82rem", fontWeight: 650, mb: 0.75 }}>
          {t("retouches.title")}
          <Box component="span" sx={{ color: "text.secondary", fontWeight: 500 }}>{` · ${retouches.length}`}</Box>
        </Typography>
      )}
      <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.5 }}>
        {retouches.map((entry) => {
          const source = retouchSourceOf(entry);
          const tone = toneOf(source);
          const when = entry.ts ? formatClockTime(entry.ts, language) : "";
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
      {!editing && !bare && (
        <Typography data-testid="draft-retouches-read" sx={{ mt: 0.75, fontSize: "0.72rem", color: "text.secondary" }}>
          {t("retouches.readOnly")}
        </Typography>
      )}
    </Box>
  );
}
