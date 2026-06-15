import React, {
  useState,
  useMemo,
  useRef,
  useEffect,
  useCallback,
} from "react";
import {
  Dialog,
  Box,
  TextField,
  InputAdornment,
  Typography,
  CircularProgress,
  Divider,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import SearchIcon from "@mui/icons-material/Search";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import API_BASE_URL from "../config";
import { fetchWithSession } from "../utils/sessionManager";
import { useLanguage } from "../contexts/LanguageContext";
import { useEditMode } from "../contexts/EditModeContext";
import { useDetailPanel } from "../contexts/DetailPanelContext";
import {
  useKeyboardShortcut,
  formatChord,
  useShortcuts,
} from "../contexts/ShortcutsContext";

/**
 * Command palette — single-keystroke access to every action.
 *
 * Layout follows the VSCode / Linear / Figma convention:
 *   [search field]  --------- filters live
 *   [group: Actions]
 *     ▸ Save current edit          Ctrl+S
 *     ▸ Undo last change           Ctrl+Z
 *     ▸ Export GTFS                Ctrl+E
 *   [group: Navigate]
 *     ▸ Go to stop "ABC"           → opens panel
 *   [group: Entities — top 30 matches from global search]
 *     ▸ Stop   stop_123            Paris gare de Lyon
 *
 * Actions are supplied by the `useAppCommands` hook (below) which sources
 * them from every context the palette has access to, plus the live
 * shortcuts registry so the keyboard hints stay in sync.
 *
 * Typing triggers the /search endpoint for live entity suggestions.
 */

function CommandItem({
  label,
  hint,
  keys,
  selected,
  onClick,
  accentColor,
  badge,
  isMac,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  return (
    <Box
      onMouseEnter={onClick?.preventHover ? undefined : undefined}
      onClick={onClick}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.25,
        px: 1.5,
        py: 1,
        cursor: "pointer",
        borderLeft: `2px solid ${selected ? accentColor || theme.palette.primary.main : "transparent"}`,
        background: selected
          ? isDark
            ? "rgba(99,102,241,0.12)"
            : "rgba(99,102,241,0.08)"
          : "transparent",
        transition: "background 0.12s ease",
        "&:hover": {
          background: isDark
            ? "rgba(255,255,255,0.04)"
            : "rgba(0,0,0,0.03)",
        },
      }}
    >
      {badge && (
        <Box
          sx={{
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            px: 0.6,
            py: 0.25,
            borderRadius: 0.5,
            color: accentColor || theme.palette.primary.main,
            background: `${accentColor || theme.palette.primary.main}1a`,
            minWidth: 38,
            textAlign: "center",
          }}
        >
          {badge}
        </Box>
      )}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          variant="body2"
          sx={{
            fontSize: 13,
            fontWeight: selected ? 600 : 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </Typography>
        {hint && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{
              display: "block",
              fontSize: 11,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: hint.startsWith("/") ? "monospace" : "inherit",
            }}
          >
            {hint}
          </Typography>
        )}
      </Box>
      {keys?.[0] && (
        <Box
          component="kbd"
          sx={{
            fontSize: 10,
            fontWeight: 600,
            fontFamily: "monospace",
            px: 0.75,
            py: 0.25,
            borderRadius: 0.5,
            border: `1px solid ${isDark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.18)"}`,
            background: isDark ? "rgba(255,255,255,0.06)" : "#f7f7f8",
            color: "text.secondary",
          }}
        >
          {formatChord(keys[0], isMac)}
        </Box>
      )}
      {!keys?.[0] && selected && (
        <ArrowForwardIcon sx={{ fontSize: 14, color: "text.secondary" }} />
      )}
    </Box>
  );
}

function CommandPalette() {
  const { t } = useLanguage();
  const theme = useTheme();
  const entityColors = theme.palette.entities;
  const { list: shortcutList, isMac } = useShortcuts();
  const {
    editing,
    pendingEdits,
    undoLast,
    redoLast,
    exitEditMode,
    enterEditMode,
  } = useEditMode();
  const { openPanel, showSqlConsole } = useDetailPanel();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [entityResults, setEntityResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const searchTimer = useRef(null);
  const listRef = useRef(null);

  // ── Open / close shortcut ───────────────────────────────────────────
  useKeyboardShortcut({
    id: "palette.open",
    keys: ["mod+k"],
    description: t("palette.openShortcut"),
    category: "general",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      setOpen((v) => !v);
    },
  });
  useKeyboardShortcut({
    id: "palette.close",
    keys: ["esc"],
    description: "",
    when: () => open,
    handler: () => setOpen(false),
  });

  // ── Live search via /search ─────────────────────────────────────────
  useEffect(() => {
    if (!open) return undefined;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (query.trim().length < 2) {
      setEntityResults(null);
      setSearching(false);
      return undefined;
    }
    setSearching(true);
    const controller = new AbortController();
    searchTimer.current = setTimeout(() => {
      fetchWithSession(
        `${API_BASE_URL}/search?q=${encodeURIComponent(query.trim())}`,
        { signal: controller.signal },
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => setEntityResults(data))
        .catch(() => {})
        .finally(() => setSearching(false));
    }, 120);
    return () => {
      controller.abort();
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query, open]);

  // ── Action commands — static + derived from context ─────────────────
  const actions = useMemo(() => {
    const cmds = [];
    if (!editing) {
      cmds.push({
        id: "edit.enter",
        label: t("palette.action.enterEdit"),
        hint: t("palette.action.enterEditHint"),
        category: "edit",
        run: () => enterEditMode(),
      });
    } else {
      cmds.push(
        {
          id: "edit.undo",
          label: t("palette.action.undo"),
          hint:
            pendingEdits > 0
              ? t("palette.action.undoHint", { n: pendingEdits })
              : t("palette.action.undoHintEmpty"),
          category: "edit",
          keys: ["mod+z"],
          disabled: pendingEdits === 0,
          run: () => undoLast?.(),
        },
        {
          id: "edit.redo",
          label: t("palette.action.redo"),
          hint: t("palette.action.redoHint"),
          category: "edit",
          keys: ["mod+shift+z"],
          run: () => redoLast?.(),
        },
        {
          id: "edit.export",
          label: t("palette.action.export"),
          hint: t("palette.action.exportHint"),
          category: "edit",
          keys: ["mod+e"],
          // Dispatches a custom event so EditModeToggle opens the preflight dialog.
          // Falls back to direct exportGTFS if no listener is registered.
          run: () => window.dispatchEvent(new CustomEvent("gtfs:open-export-preflight")),
        },
        {
          id: "edit.exit",
          label: t("palette.action.exitEdit"),
          hint: t("palette.action.exitEditHint"),
          category: "edit",
          run: () => exitEditMode(),
        },
        {
          id: "edit.history",
          label: t("palette.action.history"),
          hint: t("palette.action.historyHint"),
          category: "navigation",
          keys: ["mod+h"],
          run: () => openPanel("edit_history", "history"),
        },
      );
    }
    // SQL Console — top-level main view (replaces map+grid). Available
    // in both read-only and edit modes; the inline mutator is gated on
    // edit mode by the SqlConsole component itself.
    cmds.push({
      id: "openSqlConsole",
      label: t("palette.action.sqlConsole"),
      hint: t("palette.action.sqlConsoleHint"),
      category: "advanced",
      keys: ["mod+shift+l"],
      run: () => showSqlConsole(),
    });
    // AI repair companion — the FAB listens for this event (beta gate and
    // free-trial routing handled there). Feature-flag gating is implicit:
    // when the chat is disabled the FAB is unmounted and the event is a
    // harmless no-op.
    cmds.push({
      id: "askAi",
      label: t("palette.action.askAi"),
      hint: t("palette.action.askAiHint"),
      category: "advanced",
      run: () => window.dispatchEvent(new CustomEvent("gtfs:chat-open")),
    });
    // Metadata viewers / editors — available in both read-only and edit modes.
    // In read-only the dialogs show data without add/edit/delete controls.
    cmds.push(
      {
        id: "openFeedInfo",
        label: t("feedInfo.paletteTitle"),
        hint: t("feedInfo.paletteDesc"),
        category: "metadata",
        run: () => openPanel("feed_info", "feed_info.txt"),
      },
      {
        id: "openTransfersOverview",
        label: t("transfers.paletteTitle"),
        hint: t("transfers.paletteDesc"),
        category: "metadata",
        run: () => openPanel("transfers", "transfers.txt"),
      },
      {
        id: "openLevelsManager",
        label: t("levels.paletteTitle"),
        hint: t("levels.paletteDesc"),
        category: "metadata",
        run: () => openPanel("levels", "levels.txt"),
      },
      {
        id: "openPathwaysOverview",
        label: t("pathways.paletteTitle"),
        hint: t("pathways.paletteDesc"),
        category: "metadata",
        run: () => openPanel("pathways", "pathways.txt"),
      },
      {
        id: "openTranslationsManager",
        label: t("translations.paletteTitle"),
        hint: t("translations.paletteDesc"),
        category: "metadata",
        run: () => openPanel("translations", "translations.txt"),
      },
      {
        id: "openAttributionsManager",
        label: t("attributions.paletteTitle"),
        hint: t("attributions.paletteDesc"),
        category: "metadata",
        run: () => openPanel("attributions", "attributions.txt"),
      },
    );
    return cmds;
  }, [
    editing,
    pendingEdits,
    enterEditMode,
    exitEditMode,
    undoLast,
    redoLast,
    openPanel,
    showSqlConsole,
    t,
  ]);

  // Surface shortcuts that have user-visible descriptions but no dedicated
  // palette entry. Avoids duplicates by matching on chord equality.
  const extraShortcuts = useMemo(() => {
    const chordsTaken = new Set(
      actions.flatMap((a) => a.keys || []).map((k) => k.toLowerCase()),
    );
    return shortcutList
      .filter(
        (s) =>
          s.description &&
          !s.disabled &&
          (!s.when || s.when()) &&
          s.keys?.some((k) => !chordsTaken.has(k.toLowerCase())),
      )
      .slice(0, 20);
  }, [shortcutList, actions]);

  // ── Filter commands by query ────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (txt) => !q || txt.toLowerCase().includes(q);
    return actions.filter((a) => matches(a.label) || matches(a.hint || ""));
  }, [actions, query]);

  // ── Flatten entities from /search result ────────────────────────────
  const entityFlat = useMemo(() => {
    if (!entityResults) return [];
    const out = [];
    for (const stop of entityResults.stops || []) {
      out.push({
        id: `stop:${stop.stop_id}`,
        label: stop.stop_name || stop.stop_id,
        hint: stop.stop_id,
        badge: "STOP",
        accent: entityColors.stop,
        run: () => openPanel("stop", stop.stop_id),
      });
    }
    for (const route of entityResults.routes || []) {
      out.push({
        id: `route:${route.route_id}`,
        label:
          route.route_short_name || route.route_long_name || route.route_id,
        hint: route.route_long_name || route.route_id,
        badge: "ROUTE",
        accent: entityColors.route,
        run: () => openPanel("route", route.route_id),
      });
    }
    for (const trip of entityResults.trips || []) {
      out.push({
        id: `trip:${trip.trip_id}`,
        label: trip.trip_headsign || trip.trip_id,
        hint: trip.trip_id,
        badge: "TRIP",
        accent: entityColors.trip,
        run: () => openPanel("trip", trip.trip_id),
      });
    }
    for (const shape of entityResults.shapes || []) {
      out.push({
        id: `shape:${shape.shape_id}`,
        label: shape.shape_id,
        hint: t("palette.entity.shape"),
        badge: "SHAPE",
        accent: entityColors.shape,
        run: () => openPanel("shape", shape.shape_id),
      });
    }
    return out;
  }, [entityResults, openPanel, t, entityColors]);

  // Build a flat list of all navigable rows, with section separators kept
  // as non-selectable entries so selectedIdx only advances across items.
  const flatRows = useMemo(() => {
    const rows = [];
    if (filtered.length > 0) {
      rows.push({ section: t("palette.section.actions") });
      rows.push(...filtered.map((a) => ({ kind: "action", ...a })));
    }
    if (extraShortcuts.length > 0) {
      rows.push({ section: t("palette.section.shortcuts") });
      rows.push(
        ...extraShortcuts.map((s) => ({
          kind: "shortcut",
          id: s.id,
          label: s.description,
          keys: s.keys,
          run: () => {
            // Simulate the shortcut by invoking its handler
            const event = new KeyboardEvent("keydown");
            s.handler(event);
          },
        })),
      );
    }
    if (entityFlat.length > 0) {
      rows.push({ section: t("palette.section.entities") });
      rows.push(...entityFlat.map((e) => ({ kind: "entity", ...e })));
    }
    return rows;
  }, [filtered, extraShortcuts, entityFlat, t]);

  const selectableIndices = useMemo(
    () => flatRows.map((r, i) => (r.section ? -1 : i)).filter((i) => i >= 0),
    [flatRows],
  );

  // Reset selection when results change
  useEffect(() => {
    setSelectedIdx(0);
  }, [query, open]);

  // Current selectable row
  const currentAbsIdx = selectableIndices[selectedIdx] ?? -1;

  const move = useCallback(
    (dir) => {
      setSelectedIdx((i) => {
        const next = i + dir;
        if (next < 0) return Math.max(selectableIndices.length - 1, 0);
        if (next >= selectableIndices.length) return 0;
        return next;
      });
    },
    [selectableIndices.length],
  );

  const execute = useCallback(
    (row) => {
      if (!row || row.disabled) return;
      try {
        row.run?.();
      } finally {
        setOpen(false);
        setQuery("");
      }
    },
    [],
  );

  const handleKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = flatRows[currentAbsIdx];
      execute(row);
    }
  };

  // Scroll selected row into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector('[data-selected="true"]');
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIdx]);

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: {
          borderRadius: 2,
          mt: 8,
          alignSelf: "flex-start",
        },
      }}
    >
      <Box sx={{ p: 1.25 }}>
        <TextField
          autoFocus
          fullWidth
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("palette.searchPlaceholder")}
          variant="standard"
          InputProps={{
            disableUnderline: true,
            sx: { fontSize: 16, px: 1 },
            startAdornment: (
              <InputAdornment position="start">
                {searching ? (
                  <CircularProgress size={16} />
                ) : (
                  <SearchIcon fontSize="small" />
                )}
              </InputAdornment>
            ),
          }}
        />
      </Box>
      <Divider />
      <Box ref={listRef} sx={{ maxHeight: 420, overflow: "auto" }}>
        {flatRows.length === 0 ? (
          <Box p={3} textAlign="center">
            <Typography variant="body2" color="text.secondary">
              {query.trim().length >= 2
                ? t("palette.noResults")
                : t("palette.startTyping")}
            </Typography>
          </Box>
        ) : (
          flatRows.map((row, absIdx) =>
            row.section ? (
              <Box
                key={`sec-${absIdx}`}
                sx={{
                  px: 1.5,
                  py: 0.5,
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "text.secondary",
                  background: (theme) =>
                    theme.palette.mode === "dark"
                      ? "rgba(255,255,255,0.02)"
                      : "rgba(0,0,0,0.02)",
                }}
              >
                {row.section}
              </Box>
            ) : (
              <Box
                key={row.id || absIdx}
                data-selected={absIdx === currentAbsIdx}
              >
                <CommandItem
                  label={row.label}
                  hint={row.hint}
                  keys={row.keys}
                  badge={row.badge}
                  accentColor={row.accent}
                  selected={absIdx === currentAbsIdx}
                  onClick={() => execute(row)}
                  isMac={isMac}
                />
              </Box>
            ),
          )
        )}
      </Box>
      <Divider />
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          px: 1.5,
          py: 0.75,
          fontSize: 10,
          color: "text.secondary",
          background: (theme) =>
            theme.palette.mode === "dark"
              ? "rgba(255,255,255,0.02)"
              : "rgba(0,0,0,0.015)",
        }}
      >
        <Box sx={{ display: "flex", gap: 1.5 }}>
          <span>
            <b>↑↓</b> {t("palette.hint.navigate")}
          </span>
          <span>
            <b>⏎</b> {t("palette.hint.run")}
          </span>
          <span>
            <b>Esc</b> {t("palette.hint.close")}
          </span>
        </Box>
        <span>{formatChord("mod+k", isMac)}</span>
      </Box>
    </Dialog>
  );
}

export default CommandPalette;
