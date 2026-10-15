/**
 * DocumentDrop — the project's documents, in sight where the work is: a drop
 * zone for the brief and its annexes (dragged, or picked with a click), then
 * every document with its state.
 *
 * It answers « à quel moment l'utilisateur peut-il déposer son cahier des
 * charges ? » wherever the work is: the same zone stands in the Network
 * Studio's column (① and ③), at ① of a modify project, and in the Change
 * Studio's column at ③.
 *
 * The list is one list: the project's documents (`records`, what the server
 * keeps — ProjectPage writes them on announceDocument) and, not yet among
 * them, what the host is sending or failed to send (`pending`). The host
 * uploads (`onAttach(files)`: its own attach, which keeps its composer in
 * step) and removes (`onRemove(item)`: an item carries its `id` once sent).
 *
 *   pending  [{ id? | tempId | key, name, status: uploading|ready|error|expired, error?, pages?, kind? }]
 *   records  [{ id, name, pages?, kind?, kept?, keeping?, gone?, expires_at?, sent_to_assistant? }]
 *   notes    { [document name]: words | { text, tone: "warning" } } — what the host did with a document, said on its
 *            row before its state (the modify journey: what it read of a spreadsheet without the assistant, and the
 *            cells it did not understand, in the warning tone; `<testid>-note`, `data-tone`)
 */

import React, { useId, useRef, useState } from "react";
import { Box, ButtonBase, CircularProgress, IconButton, Typography, alpha, useTheme } from "@mui/material";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import PictureAsPdfOutlinedIcon from "@mui/icons-material/PictureAsPdfOutlined";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { formatDateTime } from "../../utils/formatDate";
import { BRIEF_ACCEPT } from "../../utils/networkStudioApi";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days until a date (rounded up, never below 0), or null. */
const daysUntil = (iso, now = Date.now()) => {
  const at = Date.parse(iso || "");
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / DAY_MS)) : null;
};

/**
 * What is known of a document, in words: sent to the assistant or not (the person's choice), then where it
 * is kept — with the project until a date; being kept (the request runs); still in the studios' memory
 * until a time (not kept: the workspace off, or keeping it failed); « à redéposer » only once the server
 * said it is gone (DOCUMENT_NOT_FOUND) or its memory date has passed.
 */
export const documentStateOf = (d, { retentionDays = 30, retentionUntil = null, t, language, now = Date.now() }) => {
  const sent = d.sent_to_assistant === false ? t("documents.notSent") : t("documents.sentToAssistant");
  if (d.kept) {
    const left = daysUntil(d.expires_at || retentionUntil, now);
    return [sent, t("documents.keptWithProject", { days: retentionDays }), left !== null ? t("documents.expiresIn", { duration: t("documents.days", { count: left }) }) : null].filter(Boolean);
  }
  const memoryEnd = Date.parse(d.expires_at || "");
  if (d.gone || (Number.isFinite(memoryEnd) && memoryEnd <= now)) return [sent, t("documents.expired")];
  if (d.keeping) return [sent, t("documents.keeping")];
  return [sent, Number.isFinite(memoryEnd) ? t("documents.inMemory", { time: formatDateTime(d.expires_at, language) }) : t("documents.notKept")];
};

/**
 * The one list: the project's documents first, then what is being sent (or was refused) and is not yet among
 * them. A document the host found gone (the planner's DOCUMENT_NOT_FOUND) is said expired on its record too.
 */
export const documentItemsOf = (pending = [], records = []) => {
  const recorded = (records || []).filter((r) => r && r.id);
  const ids = new Set(recorded.map((r) => r.id));
  const expired = new Set((pending || []).filter((d) => d.id && d.status === "expired").map((d) => d.id));
  return [
    ...recorded.map((r) => ({ id: r.id, name: r.name, pages: r.pages, kind: r.kind, status: expired.has(r.id) || r.gone ? "expired" : "ready", record: r })),
    ...(pending || []).filter((d) => !(d.id && ids.has(d.id))),
  ];
};

const keyOf = (d) => d.id || d.tempId || d.key || d.name;

export default function DocumentDrop({ pending = [], records = [], retentionDays = 30, retentionUntil = null, onAttach = null, onRemove = null, disabled = false, title = true, hint = null, notes = null, testid = "document-drop", itemTestid = null, sx = {} }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const inputRef = useRef(null);
  const titleId = useId();
  const [over, setOver] = useState(false);
  const items = documentItemsOf(pending, records);
  const off = disabled || !onAttach;
  const take = (list) => {
    const files = Array.from(list || []);
    if (files.length && !off) onAttach(files);
  };
  // One document's state, in words: sending, refused, gone — else its pages and what the project keeps of it.
  const metaOf = (d) => {
    if (d.status === "uploading") return { text: t("network.docs.uploading"), tone: "text.secondary" };
    if (d.status === "error") return { text: d.error || t("network.docs.unsupported"), tone: "error.main" };
    const pages = d.pages ? t("network.docs.pages", { count: d.pages }) : null;
    if (d.record) {
      const state = documentStateOf(d.status === "expired" ? { ...d.record, gone: true } : d.record, { retentionDays, retentionUntil, t, language });
      return { text: [pages, ...state].filter(Boolean).join(" · "), tone: d.status === "expired" ? "error.main" : "text.secondary" };
    }
    if (d.status === "expired") return { text: t("network.docs.expired"), tone: "error.main" };
    return { text: pages, tone: "text.secondary" };
  };
  const compact = items.length > 0;
  return (
    // Titled, it is a section of its own; untitled, a part of its host's (① gives the panel its heading).
    <Box component={title ? "section" : "div"} aria-labelledby={title ? titleId : undefined} data-testid={testid} data-count={items.length} sx={{ display: "flex", flexDirection: "column", gap: 0.75, ...sx }}>
      {title && (
        <Typography id={titleId} component="h3" sx={{ fontSize: "0.7rem", fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: "text.secondary" }}>
          {t("documents.section")}
        </Typography>
      )}
      {hint && <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", lineHeight: 1.45 }}>{hint}</Typography>}
      {items.length > 0 && (
        <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.5 }}>
          {items.map((d) => {
            const isPdf = d.kind === "pdf" || /\.pdf$/i.test(d.name || "");
            const Icon = isPdf ? PictureAsPdfOutlinedIcon : DescriptionOutlinedIcon;
            const meta = metaOf(d);
            return (
              <Box component="li" key={keyOf(d)} data-testid={itemTestid || `${testid}-item`} data-status={d.status || "ready"} data-kept={d.record?.kept ? "true" : "false"} sx={{ display: "flex", alignItems: "center", gap: 0.75, pl: 0.75, pr: 0.25, py: 0.4, borderRadius: "10px", background: d.status === "error" || d.status === "expired" ? alpha(theme.palette.error.main, 0.06) : theme.palette.background.paper, boxShadow: `0 0 0 1px ${theme.palette.divider}` }}>
                <Box sx={{ width: 24, height: 24, flexShrink: 0, borderRadius: "7px", display: "flex", alignItems: "center", justifyContent: "center", color: isPdf ? theme.palette.error.main : theme.palette.primary.main, background: alpha(isPdf ? theme.palette.error.main : theme.palette.primary.main, 0.1) }}>
                  {d.status === "uploading" ? <CircularProgress size={12} color="inherit" /> : <Icon sx={{ fontSize: 15 }} />}
                </Box>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography noWrap title={d.name} sx={{ fontSize: "0.76rem", fontWeight: 700, lineHeight: 1.3 }}>
                    {d.name}
                  </Typography>
                  {notes?.[d.name] && d.status !== "error" && (
                    // `tone`: success (read, the default), warning (something to do), info (a state, nothing to do),
                    // running (being read now: a spinner beside the words).
                    <Typography data-testid={`${testid}-note`} data-tone={notes[d.name]?.tone || "success"} sx={{ display: "flex", alignItems: "center", gap: 0.5, fontSize: "0.68rem", fontWeight: 600, lineHeight: 1.35, color: notes[d.name]?.tone === "warning" ? "warning.main" : notes[d.name]?.tone === "info" || notes[d.name]?.tone === "running" ? "text.secondary" : "success.main" }}>
                      {notes[d.name]?.tone === "running" && <CircularProgress size={9} color="inherit" />}
                      {typeof notes[d.name] === "string" ? notes[d.name] : notes[d.name].text}
                    </Typography>
                  )}
                  {meta.text && (
                    <Typography title={meta.text} sx={{ fontSize: "0.66rem", lineHeight: 1.3, color: meta.tone, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                      {meta.text}
                    </Typography>
                  )}
                </Box>
                {onRemove && !disabled && d.status !== "uploading" && (
                  <IconButton size="small" onClick={() => onRemove(d)} aria-label={`${t("network.docs.remove")} ${d.name || ""}`.trim()} sx={{ p: 0.5, color: "text.secondary" }}>
                    <CloseRoundedIcon sx={{ fontSize: 15 }} />
                  </IconButton>
                )}
              </Box>
            );
          })}
        </Box>
      )}
      <ButtonBase
        onClick={() => inputRef.current?.click()}
        disabled={off}
        onDragOver={(e) => {
          if (off) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          take(e.dataTransfer?.files);
        }}
        data-testid={`${testid}-zone`}
        sx={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: compact ? "flex-start" : "center",
          flexDirection: compact ? "row" : "column",
          gap: compact ? 0.75 : 0.4,
          px: 1.5,
          py: compact ? 0.6 : 1.25,
          borderRadius: "12px",
          border: `1.5px dashed ${over ? theme.palette.primary.main : alpha(theme.palette.text.primary, 0.22)}`,
          background: over ? alpha(theme.palette.primary.main, 0.08) : alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.06 : 0.03),
          textAlign: compact ? "left" : "center",
          transition: "background 120ms, border-color 120ms",
          "&:hover": { borderColor: theme.palette.primary.main, background: alpha(theme.palette.primary.main, 0.07) },
          "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 },
          "&.Mui-disabled": { opacity: 0.55 },
        }}
      >
        <CloudUploadOutlinedIcon aria-hidden sx={{ fontSize: compact ? 18 : 24, color: "primary.main" }} />
        <Box sx={{ minWidth: 0 }}>
          <Typography component="span" sx={{ display: "block", fontSize: "0.78rem", fontWeight: 800, lineHeight: 1.3, color: compact ? "primary.main" : "text.primary" }}>
            {t(compact ? "documents.add" : "documents.dropTitle")}
          </Typography>
          {!compact && (
            <Typography component="span" sx={{ display: "block", fontSize: "0.68rem", color: "text.secondary", lineHeight: 1.4 }}>
              {t("documents.dropHint")}
            </Typography>
          )}
        </Box>
      </ButtonBase>
      <input ref={inputRef} type="file" hidden multiple accept={BRIEF_ACCEPT} onChange={(e) => { take(e.target.files); e.target.value = ""; }} data-testid={`${testid}-input`} />
    </Box>
  );
}
