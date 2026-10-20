/**
 * BarParts — what the two top bars share, so that the reader (Header) and a
 * project's steps (StudioTopBar) read as one frame:
 *
 *   WorkIdentity   the network's or the project's name (renamed in place in a
 *                  project) and the state of the work (utils/workState):
 *                  « Réseau source », « Brouillon · n modifications »,
 *                  « Appliqué en vN » — a button where it leads somewhere
 *                  (`work-state`, `data-state`)
 *   SearchTrigger  the one search: the command palette (⌘K / Ctrl K), which
 *                  finds the stops, lines, trips and shapes and every action
 *                  (`bar-search`)
 *   ExpertSwitch   « Expert »: shows the specialist's tools (utils/expertMode,
 *                  `expert-switch`, aria-pressed)
 */

import React, { useState } from "react";
import { Box, ButtonBase, InputBase, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import EditNoteOutlinedIcon from "@mui/icons-material/EditNoteOutlined";
import TaskAltOutlinedIcon from "@mui/icons-material/TaskAltOutlined";
import DriveFileRenameOutlineOutlinedIcon from "@mui/icons-material/DriveFileRenameOutlineOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useExpertMode } from "../../utils/expertMode";
import { workStateWords } from "../../utils/workState";

/** Opens the command palette (CommandPalette listens). */
export const PALETTE_OPEN_EVENT = "gtfs:open-palette";

const isMac = () => {
  try {
    return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || "");
  } catch {
    return false;
  }
};

/** The tone of each state: the source neutral, the draft in progress, a version settled. */
const toneOf = (theme, kind) => {
  const dark = theme.palette.mode === "dark";
  if (kind === "draft") return { color: dark ? theme.palette.warning.light : theme.palette.warning.dark, background: alpha(theme.palette.warning.main, dark ? 0.2 : 0.12), icon: EditNoteOutlinedIcon };
  if (kind === "applied" || kind === "version") return { color: dark ? theme.palette.success.light : theme.palette.success.dark, background: alpha(theme.palette.success.main, dark ? 0.2 : 0.11), icon: TaskAltOutlinedIcon };
  return { color: theme.palette.text.secondary, background: alpha(theme.palette.text.primary, dark ? 0.1 : 0.06), icon: VisibilityOutlinedIcon };
};

/** The state's pill: a button when `onOpen` leads to where the work is done. */
export function WorkStatePill({ state, onOpen = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const words = workStateWords(state, t);
  if (!words) return null;
  const tone = toneOf(theme, state.kind);
  const Icon = tone.icon;
  const sx = { flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 0.5, height: 24, px: 1, borderRadius: 999, fontSize: "0.74rem", fontWeight: 650, whiteSpace: "nowrap", color: tone.color, backgroundColor: tone.background };
  const body = (
    <>
      <Icon aria-hidden sx={{ fontSize: 15 }} />
      {words.label}
    </>
  );
  return (
    <Tooltip title={words.hint}>
      {onOpen ? (
        <ButtonBase onClick={onOpen} data-testid="work-state" data-state={state.kind} sx={{ ...sx, "&:hover": { filter: "brightness(0.97)", boxShadow: `inset 0 0 0 1px ${alpha(tone.color, 0.35)}` }, "&.Mui-focusVisible": { outline: `2px solid ${tone.color}`, outlineOffset: 2 } }}>
          {body}
        </ButtonBase>
      ) : (
        <Box component="span" data-testid="work-state" data-state={state.kind} tabIndex={0} sx={sx}>
          {body}
        </Box>
      )}
    </Tooltip>
  );
}

/**
 * A project's name, renamed in place: it reads as a field (a fine outline, the pencil beside the name) and opens one on a
 * click, the same box and size; Enter or blur keeps, Escape cancels.
 */
export function NameInPlace({ name, onRename = null, fallback, testid, renameTestid, renameLabel, fieldLabel = renameLabel, maxWidth = { xs: 140, lg: 220, xl: 320 } }) {
  const theme = useTheme();
  const [draft, setDraft] = useState(null);
  const sx = { fontSize: "0.86rem", fontWeight: 650, minWidth: 0, maxWidth };
  const keep = () => {
    const next = String(draft ?? "").trim().slice(0, 200);
    if (next && next !== name) onRename(next);
    setDraft(null);
  };
  if (draft !== null) {
    return (
      <InputBase
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={keep}
        onKeyDown={(e) => {
          if (e.key === "Enter") keep();
          else if (e.key === "Escape") setDraft(null);
        }}
        inputProps={{ "data-testid": renameTestid, "aria-label": fieldLabel, maxLength: 200 }}
        sx={{ ...sx, width: maxWidth, px: 1.25, height: 32, borderRadius: "8px", border: `1px solid ${theme.palette.primary.main}`, boxShadow: `0 0 0 3px ${alpha(theme.palette.primary.main, 0.12)}`, backgroundColor: theme.palette.background.paper }}
      />
    );
  }
  const shown = name || fallback;
  if (!onRename) {
    return (
      <Typography component="span" title={name || undefined} data-testid={testid} sx={{ ...sx, color: name ? "text.primary" : "text.secondary", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {shown}
      </Typography>
    );
  }
  return (
    <Tooltip title={renameLabel}>
      <ButtonBase onClick={() => setDraft(name)} data-testid={testid} aria-label={`${shown} — ${renameLabel}`} sx={{ ...sx, display: "inline-flex", alignItems: "center", gap: 0.75, px: 1.25, height: 32, borderRadius: "8px", border: `1px solid ${theme.palette.divider}`, backgroundColor: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.06 : 0.025), color: name ? "text.primary" : "text.secondary", textAlign: "left", transition: "border-color 120ms, background-color 120ms", "& .name-in-place-pencil": { color: "text.disabled", transition: "color 120ms" }, "&:hover": { borderColor: alpha(theme.palette.text.primary, 0.3), backgroundColor: theme.palette.background.paper, "& .name-in-place-pencil": { color: "primary.main" } }, "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 } }}>
        <Box component="span" sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {shown}
        </Box>
        <DriveFileRenameOutlineOutlinedIcon aria-hidden className="name-in-place-pencil" sx={{ fontSize: 16, flexShrink: 0 }} />
      </ButtonBase>
    </Tooltip>
  );
}

/**
 * The work's identity in the bar: its name, then its state. `work`: { name, state, onOpen?, onRename?, renamable }
 * — the network's name in the reader, the project's (renamed in place) in a project.
 */
export function WorkIdentity({ work, nameTestid = "work-name", renameTestid = "work-rename" }) {
  const { t } = useLanguage();
  if (!work || (work.name === undefined && !work.state)) return null;
  return (
    <Box data-testid="work-identity" sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0, flex: "0 1 auto" }}>
      {work.name !== undefined && <NameInPlace name={work.name} onRename={work.onRename || null} fallback={t("studio.untitled")} testid={nameTestid} renameTestid={renameTestid} renameLabel={t("studio.rename")} fieldLabel={t("network.project.name")} />}
      <WorkStatePill state={work.state} onOpen={work.onOpen || null} />
    </Box>
  );
}

/** The one search of the app: opens the command palette. `compact`: the icon and the keys only; `bare`: the icon. */
export function SearchTrigger({ compact = false, bare = false }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const keys = isMac() ? "⌘K" : "Ctrl K";
  return (
    <Tooltip title={compact ? `${t("bar.search")} (${keys})` : ""}>
      <ButtonBase
        onClick={() => window.dispatchEvent(new CustomEvent(PALETTE_OPEN_EVENT))}
        data-testid="bar-search"
        aria-label={t("bar.search")}
        aria-keyshortcuts="Control+K Meta+K"
        sx={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 0.75, height: 34, pl: 1, pr: 0.75, minWidth: compact ? 0 : { lg: 170, xl: 220 }, justifyContent: "flex-start", borderRadius: "10px", border: `1px solid ${theme.palette.divider}`, color: "text.secondary", backgroundColor: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.05 : 0.02), "&:hover": { borderColor: theme.palette.primary.main, color: "text.primary" }, "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 } }}
      >
        <SearchIcon aria-hidden sx={{ fontSize: 18 }} />
        {!compact && <Box component="span" sx={{ flex: 1, textAlign: "left", fontSize: "0.82rem" }}>{t("bar.search")}</Box>}
        {!bare && (
          <Box component="kbd" aria-hidden sx={{ fontFamily: "inherit", fontSize: "0.68rem", fontWeight: 650, px: 0.6, py: 0.1, borderRadius: "5px", border: `1px solid ${theme.palette.divider}`, color: "text.secondary", backgroundColor: theme.palette.background.paper }}>
            {keys}
          </Box>
        )}
      </ButtonBase>
    </Tooltip>
  );
}

/** « Expert »: shows the specialist's tools; a switch, said as pressed or not. */
export function ExpertSwitch() {
  const { t } = useLanguage();
  const theme = useTheme();
  const [on, set] = useExpertMode();
  const accent = theme.palette.primary.main;
  return (
    <Tooltip title={t(on ? "expert.hint.on" : "expert.hint.off")}>
      <ButtonBase
        onClick={() => set(!on)}
        aria-pressed={on}
        data-testid="expert-switch"
        data-on={on ? "true" : "false"}
        sx={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 0.75, height: 32, pl: 1, pr: 1.1, borderRadius: 999, fontSize: "0.78rem", fontWeight: 650, color: on ? accent : "text.secondary", backgroundColor: on ? alpha(accent, theme.palette.mode === "dark" ? 0.2 : 0.1) : "transparent", "&:hover": { backgroundColor: alpha(accent, 0.12), color: on ? accent : "text.primary" }, "&.Mui-focusVisible": { outline: `2px solid ${accent}`, outlineOffset: 2 } }}
      >
        <Box aria-hidden sx={{ position: "relative", width: 26, height: 15, borderRadius: 999, backgroundColor: on ? accent : alpha(theme.palette.text.primary, 0.25), transition: "background-color .15s" }}>
          <Box sx={{ position: "absolute", top: 2, left: on ? 13 : 2, width: 11, height: 11, borderRadius: "50%", backgroundColor: "#fff", transition: "left .15s", "@media (prefers-reduced-motion: reduce)": { transition: "none" } }} />
        </Box>
        {t("expert.label")}
      </ButtonBase>
    </Tooltip>
  );
}
