import React, {
  useState,
  useMemo,
  useRef,
  useEffect,
  useCallback,
  useId,
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
import { useDestructiveGuard } from "../contexts/DestructiveGuardContext";
import { useFeatures } from "../utils/featuresApi";
import { useAccount } from "../contexts/AccountContext";
import { useRoute, useNavigate, projectPath, projectExplorerPath, getNetworkId } from "../utils/routes";
import { getProject } from "../utils/projectStore";
import { STEPS, shownStep, stepFor, stepHeading } from "./steps/StepNav";
import { focusScreen } from "./AppShell";
import {
  useKeyboardShortcut,
  formatChord,
  useShortcuts,
} from "../contexts/ShortcutsContext";
import { CHAT_OPEN_EVENT, ENTER_EDIT_MODE_EVENT, FIND_NETWORK_EVENT, OPEN_CHANGE_STUDIO_EVENT, OPEN_EXPORT_PREFLIGHT_EVENT, PALETTE_OPEN_EVENT, PRICING_EVENT } from "../utils/appEvents";

/**
 * Command palette (mod+k): every action, the live shortcuts and an entity search; inside a project it leads with
 * the journey's steps. No Alt+←/→ shortcut is ever registered: those are the browser's Back / Forward.
 */
/** Commands that change the loaded network stay listed but disabled without a feed, never a silent no-op. */
export const studioCommands = (t, { feedLoaded = false, studioLocked = false } = {}) => {
  const needsFeed = (cmd) => (feedLoaded ? cmd : { ...cmd, disabled: true, hint: t("palette.action.needsFeedHint") });
  // Without the studio entitlement the command stays enabled so the click shows the sign-in notice.
  const needsStudio = (cmd) => (studioLocked && !cmd.disabled ? { ...cmd, hint: t("account.studio.paletteHint") } : cmd);
  return [
    {
      id: "findNetwork",
      label: t("flow.modify.title"),
      hint: t("palette.action.findNetworkHint"),
      category: "advanced",
      run: () => window.dispatchEvent(new CustomEvent(FIND_NETWORK_EVENT)),
    },
    needsStudio(
      needsFeed({
        id: "changeStudio",
        label: t("delivery.modifyNetwork"),
        hint: t("palette.action.changeStudioHint"),
        category: "advanced",
        run: () => window.dispatchEvent(new CustomEvent(OPEN_CHANGE_STUDIO_EVENT)),
      }),
    ),
  ];
};

/** The journey's commands inside a project, none outside one. Pure: `go(path)` navigates; `step` is null in the project's explorer. */
export const journeyCommands = (t, { project = null, step = null, inExplorer = false, ownNetwork = false, go = () => {} } = {}) => {
  if (!project?.id) return [];
  const id = project.id;
  // A step the rail does not show (④) reads as the one it opens.
  const at = stepFor(step || project.step || 1);
  const stateWords = (n) => {
    const state = project.steps?.[n];
    return state && state !== "todo" ? t(`step.state.${state}`) : null;
  };
  const steps = STEPS;
  const i = Math.max(0, steps.indexOf(at));
  const prev = i > 0 ? steps[i - 1] : null;
  const next = i < steps.length - 1 ? steps[i + 1] : null;
  const cmds = steps.map((n) => ({
    id: `journey.step.${n}`,
    label: stepHeading(t, n),
    hint: [!inExplorer && n === at ? t("palette.journey.current") : null, stateWords(n)].filter(Boolean).join(" · ") || null,
    category: "journey",
    run: () => go(projectPath(id, n)),
  }));
  if (!inExplorer) {
    cmds.push(
      { id: "journey.prev", label: t("shortcuts.stepPrev"), hint: prev ? stepHeading(t, prev) : null, category: "journey", disabled: !prev, run: () => go(projectPath(id, prev)) },
      { id: "journey.next", label: t("shortcuts.stepNext"), hint: next ? stepHeading(t, next) : null, category: "journey", disabled: !next, run: () => go(projectPath(id, next)) },
    );
  }
  cmds.push(
    inExplorer
      ? { id: "journey.back", label: t("step.backToStep", { n: shownStep(at) }).replace(/^←\s*/, ""), category: "journey", run: () => go(projectPath(id, at)) }
      : { id: "journey.seeNetwork", label: t("step.seeNetwork"), hint: ownNetwork ? t("palette.journey.seeNetworkHint") : t("palette.journey.needsNetwork"), category: "journey", disabled: !ownNetwork, run: () => go(projectExplorerPath(id)) },
    { id: "journey.deliver", label: t("status.deliver"), hint: t("palette.journey.deliverHint"), category: "journey", run: () => go(projectPath(id, 5)) },
  );
  return cmds;
};

export function CommandItem({
  label,
  hint,
  keys,
  selected,
  onClick,
  accentColor,
  badge,
  isMac,
  disabled = false,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  return (
    <Box
      onClick={onClick}
      // The option around it says it is disabled (aria-disabled): here, the look only.
      data-disabled={disabled ? "true" : undefined}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.25,
        px: 1.5,
        py: 1,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
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

function CommandPalette({ feedLoaded = false }) {
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
  } = useEditMode();
  const { guard } = useDestructiveGuard();
  const { openPanel, showSqlConsole } = useDetailPanel();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { features } = useFeatures();
  const chatEnabled = Boolean(features?.chat?.enabled);
  const { studioLocked } = useAccount();
  const [entityResults, setEntityResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const searchTimer = useRef(null);
  const listboxId = useId();
  const route = useRoute();
  const navigate = useNavigate();
  const projectId = route.name === "project" || route.name === "projectExplorer" ? route.params.id : null;
  // Read when the palette opens: the page keeps the project in sync with the server.
  const journey = useMemo(() => {
    const project = open && projectId ? getProject(projectId) : null;
    const handle = getNetworkId();
    return journeyCommands(t, {
      project,
      step: route.name === "project" ? route.params.step : null,
      inExplorer: route.name === "projectExplorer",
      // Only once the project's own network is the one open in this tab, as on the rail.
      ownNetwork: Boolean(feedLoaded && handle && project?.network?.network_id === handle),
      go: (path) => navigate(path),
    });
    // `open` and `projectId` say when to read the project again.
  }, [t, open, projectId, route, feedLoaded, navigate]);
  const listRef = useRef(null);

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
  // The top bar's search opens the palette.
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(PALETTE_OPEN_EVENT, show);
    return () => window.removeEventListener(PALETTE_OPEN_EVENT, show);
  }, []);
  useKeyboardShortcut({
    id: "palette.close",
    keys: ["esc"],
    description: "",
    when: () => open,
    handler: () => setOpen(false),
  });

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

  const actions = useMemo(() => {
    const cmds = [];
    if (!editing) {
      cmds.push({
        id: "edit.enter",
        label: t("status.mode.enter"),
        hint: t("palette.action.enterEditHint"),
        category: "edit",
        // Through EditModeToggle, so the offer opens when the licence is missing.
        run: () => window.dispatchEvent(new CustomEvent(ENTER_EDIT_MODE_EVENT)),
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
          label: t("status.deliver"),
          hint: t("palette.action.exportHint"),
          category: "edit",
          keys: ["mod+e"],
          // EditModeToggle opens the preflight dialog.
          run: () => window.dispatchEvent(new CustomEvent(OPEN_EXPORT_PREFLIGHT_EVENT)),
        },
        {
          id: "edit.exit",
          label: t("palette.action.exitEdit"),
          hint: t("palette.action.exitEditHint"),
          category: "edit",
          // The header button's unsaved-changes guard: never discard silently.
          run: () => guard(() => exitEditMode(), { reason: "exitEditMode" }),
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
    // Write statements are gated on edit mode by the SqlConsole itself.
    cmds.push({
      id: "openSqlConsole",
      label: t("palette.action.sqlConsole"),
      hint: t("palette.action.sqlConsoleHint"),
      category: "advanced",
      keys: ["mod+shift+l"],
      run: () => showSqlConsole(),
    });
    cmds.push({
      id: "pricing",
      label: t("palette.action.pricing"),
      hint: t("palette.action.pricingHint"),
      category: "advanced",
      run: () => window.dispatchEvent(new CustomEvent(PRICING_EVENT)),
    });
    cmds.push(...studioCommands(t, { feedLoaded, studioLocked }));
    cmds.push({
      id: "askAi",
      label: t("palette.action.askAi"),
      hint: t("palette.action.askAiHint"),
      category: "advanced",
      run: () => window.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT)),
    });
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
    exitEditMode,
    guard,
    undoLast,
    redoLast,
    openPanel,
    showSqlConsole,
    t,
    feedLoaded,
    studioLocked,
  ]);

  // Shortcuts with a description but no palette entry, deduplicated by chord.
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (txt) => !q || txt.toLowerCase().includes(q);
    return actions.filter((a) => matches(a.label) || matches(a.hint || ""));
  }, [actions, query]);

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

  // Section headers stay as non-selectable rows; selectedIdx counts items only.
  const flatRows = useMemo(() => {
    const rows = [];
    // Anything typed can be handed to the assistant, which attaches the screen's context.
    const q = query.trim();
    if (chatEnabled && q.length >= 2) {
      rows.push({ section: t("palette.section.assistant") });
      rows.push({
        kind: "action",
        id: "askAiQuery",
        label: t("palette.action.askAiQuery", { query: q.length > 60 ? `${q.slice(0, 60)}…` : q }),
        hint: t("palette.action.askAiQueryHint"),
        run: () => window.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT, { detail: { message: q } })),
      });
    }
    const q2 = q.toLowerCase();
    const journeyRows = journey.filter((c) => !q2 || c.label.toLowerCase().includes(q2) || (c.hint || "").toLowerCase().includes(q2));
    if (journeyRows.length > 0) {
      rows.push({ section: t("palette.section.journey") });
      rows.push(...journeyRows.map((c) => ({ kind: "action", ...c })));
    }
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
  }, [filtered, extraShortcuts, entityFlat, t, query, chatEnabled, journey]);

  const selectableIndices = useMemo(
    () => flatRows.map((r, i) => (r.section ? -1 : i)).filter((i) => i >= 0),
    [flatRows],
  );

  useEffect(() => {
    setSelectedIdx(0);
  }, [query, open]);

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

  // A step reached from the palette moves the focus to its heading once the palette is gone (RGAA 12.8, WCAG 2.4.3).
  const focusScreenAfterClose = useRef(false);
  const execute = useCallback(
    (row) => {
      if (!row || row.disabled) return;
      focusScreenAfterClose.current = row.category === "journey";
      try {
        row.run?.();
      } finally {
        setOpen(false);
        setQuery("");
      }
    },
    [],
  );
  const onExited = useCallback(() => {
    if (!focusScreenAfterClose.current) return;
    focusScreenAfterClose.current = false;
    focusScreen(document.getElementById("main"));
  }, []);

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

  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector('[data-selected="true"]');
    if (selected) {
      selected.scrollIntoView?.({ block: "nearest" });
    }
  }, [selectedIdx]);

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      TransitionProps={{ onExited }}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        "aria-label": t("palette.title"),
        "data-testid": "command-palette",
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
          // A combobox over the list below: the arrows move the active option, which a screen reader follows (RGAA 7.1).
          inputProps={{
            role: "combobox",
            "aria-label": t("palette.searchPlaceholder"),
            "aria-expanded": flatRows.length > 0,
            "aria-controls": listboxId,
            "aria-autocomplete": "list",
            "aria-activedescendant": currentAbsIdx >= 0 ? `${listboxId}-${currentAbsIdx}` : undefined,
            "data-testid": "command-palette-input",
          }}
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
      <Box ref={listRef} id={listboxId} role={flatRows.length ? "listbox" : undefined} aria-label={flatRows.length ? t("palette.title") : undefined} sx={{ maxHeight: 420, overflow: "auto" }}>
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
              // A visual heading only: every option says what it does; inside a listbox only options are read.
              <Box
                key={`sec-${absIdx}`}
                aria-hidden="true"
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
                id={`${listboxId}-${absIdx}`}
                role="option"
                aria-selected={absIdx === currentAbsIdx}
                aria-disabled={row.disabled ? true : undefined}
                data-testid={row.id ? `palette-${row.id}` : undefined}
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
                  disabled={Boolean(row.disabled)}
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
