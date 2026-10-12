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
import { shownStep, stepFor, stepHeading, stepsOf } from "./steps/StepNav";
import { focusScreen } from "./AppShell";
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
 *
 * Inside a project (/p/:id/…) the palette leads with the journey (target
 * design §2.3, §11, WP9): the five steps by name with their state in words,
 * the previous and the next step, "Voir le réseau" (the project's own
 * network, when it is the one open in this tab) or, from the explorer, the
 * way back to the step, and "Livrer…" (⑤). They are the keyboard's way
 * through the steps besides the rail's arrows and the browser's own Back /
 * Forward: no Alt+←/→ shortcut is ever registered (D40).
 */

/**
 * The studios' commands. The ones that change the loaded network need a
 * feed: without one they stay listed but disabled, with the way to get a
 * network in their hint — never a silent no-op.
 */
export const studioCommands = (t, { feedLoaded = false, studioLocked = false } = {}) => {
  const needsFeed = (cmd) => (feedLoaded ? cmd : { ...cmd, disabled: true, hint: t("palette.action.needsFeedHint") });
  // Accounts on and no "studio" entitlement: the hint says so; the command
  // stays enabled so the click shows the notice with "Sign in".
  const needsStudio = (cmd) => (studioLocked && !cmd.disabled ? { ...cmd, hint: t("account.studio.paletteHint") } : cmd);
  return [
    {
      id: "findNetwork",
      label: t("flow.modify.title"),
      hint: t("palette.action.findNetworkHint"),
      category: "advanced",
      run: () => window.dispatchEvent(new CustomEvent("gtfs:find-network")),
    },
    needsStudio({
      id: "createNetwork",
      label: t("flow.create.title"),
      hint: t("palette.action.createNetworkHint"),
      category: "advanced",
      run: () => window.dispatchEvent(new CustomEvent("gtfs:open-network-studio")),
    }),
    needsStudio(
      needsFeed({
        id: "changeStudio",
        label: t("delivery.modifyNetwork"),
        hint: t("palette.action.changeStudioHint"),
        category: "advanced",
        run: () => window.dispatchEvent(new CustomEvent("gtfs:open-change-studio")),
      }),
    ),
    needsFeed({
      id: "networkReport",
      label: t("palette.action.networkReport"),
      hint: t("palette.action.networkReportHint"),
      category: "advanced",
      run: () => window.dispatchEvent(new CustomEvent("gtfs:open-network-report")),
    }),
  ];
};

/**
 * The journey's commands inside a project: the five steps, the previous and
 * the next one, the project's network and the delivery. Pure: `go(path)`
 * navigates. `step` is the step shown (null in the explorer of the
 * project), `ownNetwork` whether the project's network is the one open in
 * this tab. Outside a project: none.
 */
export const journeyCommands = (t, { project = null, step = null, inExplorer = false, ownNetwork = false, go = () => {} } = {}) => {
  if (!project?.id) return [];
  const id = project.id;
  const job = project.job === "modify" ? "modify" : "create";
  // A step the job does not show (a modify ④) reads as the one it opens.
  const at = stepFor(step || project.step || 1, job);
  const stateWords = (n) => {
    const state = project.steps?.[n];
    return state && state !== "todo" ? t(`step.state.${state}`) : null;
  };
  // The job's own steps (modifying, four: its delivery holds the checks), each said as the rail numbers it.
  const steps = stepsOf(job);
  const i = Math.max(0, steps.indexOf(at));
  const prev = i > 0 ? steps[i - 1] : null;
  const next = i < steps.length - 1 ? steps[i + 1] : null;
  const cmds = steps.map((n) => ({
    id: `journey.step.${n}`,
    label: stepHeading(t, n, job),
    hint: [!inExplorer && n === at ? t("palette.journey.current") : null, stateWords(n)].filter(Boolean).join(" · ") || null,
    category: "journey",
    run: () => go(projectPath(id, n)),
  }));
  if (!inExplorer) {
    cmds.push(
      { id: "journey.prev", label: t("shortcuts.stepPrev"), hint: prev ? stepHeading(t, prev, job) : null, category: "journey", disabled: !prev, run: () => go(projectPath(id, prev)) },
      { id: "journey.next", label: t("shortcuts.stepNext"), hint: next ? stepHeading(t, next, job) : null, category: "journey", disabled: !next, run: () => go(projectPath(id, next)) },
    );
  }
  cmds.push(
    inExplorer
      ? { id: "journey.back", label: t("step.backToStep", { n: shownStep(at, job) }).replace(/^←\s*/, ""), category: "journey", run: () => go(projectPath(id, at)) }
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
  // The project this screen belongs to (its steps lead the palette).
  const route = useRoute();
  const navigate = useNavigate();
  const projectId = route.name === "project" || route.name === "projectExplorer" ? route.params.id : null;
  // Read when the palette opens (the page already keeps the project in sync with the server).
  const journey = useMemo(() => {
    const project = open && projectId ? getProject(projectId) : null;
    const handle = getNetworkId();
    return journeyCommands(t, {
      project,
      step: route.name === "project" ? route.params.step : null,
      inExplorer: route.name === "projectExplorer",
      // "Voir le réseau" only once the project's own network is the one open in this tab (as the rail's button).
      ownNetwork: Boolean(feedLoaded && handle && project?.network?.network_id === handle),
      go: (path) => navigate(path),
    });
    // The project is read inside: `open` and `projectId` say when to read it again.
  }, [t, open, projectId, route, feedLoaded, navigate]);
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
        label: t("status.mode.enter"),
        hint: t("palette.action.enterEditHint"),
        category: "edit",
        // Routed through EditModeToggle so the beta-gate dialog opens when
        // the server asks for a code, instead of failing silently here.
        run: () => window.dispatchEvent(new CustomEvent("gtfs:enter-edit-mode")),
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
          // Dispatches a custom event so EditModeToggle opens the preflight dialog.
          // Falls back to direct exportGTFS if no listener is registered.
          run: () => window.dispatchEvent(new CustomEvent("gtfs:open-export-preflight")),
        },
        {
          id: "edit.exit",
          label: t("palette.action.exitEdit"),
          hint: t("palette.action.exitEditHint"),
          category: "edit",
          // Same unsaved-changes guard as the header button (Cancel /
          // Discard / Save & continue) — never discard silently.
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
      id: "pricing",
      label: t("palette.action.pricing"),
      hint: t("palette.action.pricingHint"),
      category: "advanced",
      run: () => window.dispatchEvent(new CustomEvent("gtfs:open-pricing")),
    });
    cmds.push(...studioCommands(t, { feedLoaded, studioLocked }));
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
    // Anything typed can be handed to the assistant, with the screen context
    // (route, direction, date, open panel) attached by the FAB.
    const q = query.trim();
    if (chatEnabled && q.length >= 2) {
      rows.push({ section: t("palette.section.assistant") });
      rows.push({
        kind: "action",
        id: "askAiQuery",
        label: t("palette.action.askAiQuery", { query: q.length > 60 ? `${q.slice(0, 60)}…` : q }),
        hint: t("palette.action.askAiQueryHint"),
        run: () => window.dispatchEvent(new CustomEvent("gtfs:chat-open", { detail: { message: q } })),
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
  }, [filtered, extraShortcuts, entityFlat, t, query, chatEnabled, journey]);

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

  // A step reached from the palette: once the palette is gone, the focus goes
  // to the new step's heading (as from the rail), not back to the element of
  // the step left behind (RGAA 12.8, WCAG 2.4.3).
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

  // Scroll selected row into view
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
