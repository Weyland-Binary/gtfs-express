import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Global keyboard shortcuts registry.
 *
 * Components register shortcuts via the `useKeyboardShortcut` hook.
 * A single document-level keydown listener dispatches to the matching
 * handler. Shortcuts are scoped by:
 *
 *   - keys: array of chord specifications, e.g. ["mod+k", "?"]
 *       "mod" = Ctrl on PC / Cmd on Mac
 *   - handler(event): called with the native KeyboardEvent
 *   - description: human-readable label shown in the Help dialog
 *   - category: grouping for the Help dialog ("Edit", "Navigation", ...)
 *   - when: optional predicate (e.g. only in edit mode)
 *   - allowInInputs: if true, fires even when focus is in a text input.
 *                   Default false (standard behavior: don't hijack typing).
 *
 * Last-registered wins if two handlers match the same chord — this lets
 * a dialog override a global shortcut while mounted.
 */

// Two contexts on purpose so consumers can subscribe to only what they need:
//   - RegistryCtx  : stable { register, unregister, isMac }. Identity does
//                    NOT change when the registry mutates. This is what
//                    `useKeyboardShortcut` reads, so component effects do
//                    not re-fire when an unrelated component registers a
//                    shortcut.
//   - ListCtx      : the live list of shortcuts. Identity changes on every
//                    register/unregister. Only the Help dialog needs it.
const RegistryCtx = createContext(null);
const ListCtx = createContext([]);

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPod|iPhone|iPad/.test(navigator.platform);

const INPUT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

const isEditableTarget = (target) => {
  if (!target) return false;
  if (INPUT_TAGS.has(target.tagName)) return true;
  if (target.isContentEditable) return true;
  return false;
};

const normalizeChord = (chord) => {
  const parts = chord
    .toLowerCase()
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  const mods = new Set();
  let key = "";
  for (const p of parts) {
    if (p === "mod" || p === "ctrl" || p === "cmd" || p === "meta") {
      mods.add("mod");
    } else if (p === "shift") {
      mods.add("shift");
    } else if (p === "alt" || p === "option") {
      mods.add("alt");
    } else {
      key = p;
    }
  }
  const order = ["mod", "shift", "alt"].filter((m) => mods.has(m));
  return [...order, key].join("+");
};

const eventToChord = (e) => {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");

  let key = e.key;
  if (key === " ") key = "space";
  else if (key === "Escape") key = "esc";
  else if (key === "ArrowUp") key = "up";
  else if (key === "ArrowDown") key = "down";
  else if (key === "ArrowLeft") key = "left";
  else if (key === "ArrowRight") key = "right";
  else key = key.toLowerCase();

  // Avoid treating bare modifier presses as shortcuts
  if (["control", "meta", "shift", "alt"].includes(key)) return null;
  parts.push(key);
  return parts.join("+");
};

export function ShortcutsProvider({ children }) {
  // Registry: Map<id, shortcutDef>. Using ref for mutability + stable read,
  // but we keep a versioned state so the Help dialog re-renders on change.
  const registryRef = useRef(new Map());
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const register = useCallback(
    (id, def) => {
      registryRef.current.set(id, def);
      bump();
    },
    [bump],
  );

  const unregister = useCallback(
    (id) => {
      registryRef.current.delete(id);
      bump();
    },
    [bump],
  );

  useEffect(() => {
    const handler = (e) => {
      const chord = eventToChord(e);
      if (!chord) return;

      const editable = isEditableTarget(document.activeElement);

      // Iterate in reverse registration order: most recent wins.
      const entries = Array.from(registryRef.current.entries()).reverse();
      for (const [, def] of entries) {
        if (def.disabled) continue;
        if (editable && !def.allowInInputs) continue;
        const chords = (def.keys || []).map(normalizeChord);
        if (!chords.includes(chord)) continue;
        if (def.when && !def.when()) continue;
        def.handler(e);
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const list = useMemo(() => {
    // version is read to make this memo invalidate on registry changes
    void version;
    return Array.from(registryRef.current.entries()).map(([id, def]) => ({
      id,
      ...def,
    }));
  }, [version]);

  // Stable: identity does NOT change when the registry mutates. Critical
  // for useKeyboardShortcut to avoid an infinite re-register loop.
  const registryValue = useMemo(
    () => ({ register, unregister, isMac: IS_MAC }),
    [register, unregister],
  );

  return (
    <RegistryCtx.Provider value={registryValue}>
      <ListCtx.Provider value={list}>{children}</ListCtx.Provider>
    </RegistryCtx.Provider>
  );
}

/**
 * Hook for consumers that only need the live list of shortcuts (Help dialog,
 * Command Palette categories). Re-renders the caller when the registry
 * changes. Components that just register a shortcut should use
 * `useKeyboardShortcut` instead — it reads from the stable RegistryCtx.
 */
export function useShortcuts() {
  const reg = useContext(RegistryCtx);
  const list = useContext(ListCtx);
  if (!reg)
    throw new Error("useShortcuts must be used within ShortcutsProvider");
  return { ...reg, list };
}

/**
 * Register a single keyboard shortcut for the lifetime of the component.
 *
 * Example:
 *   useKeyboardShortcut({
 *     id: "save-stop-dialog",
 *     keys: ["mod+s"],
 *     description: "Save current stop",
 *     category: "edit",
 *     handler: (e) => { e.preventDefault(); save(); },
 *   });
 *
 * handler is read through a ref so callers don't need to memoize it.
 */
export function useKeyboardShortcut({
  id,
  keys,
  handler,
  description,
  category = "general",
  when,
  disabled,
  allowInInputs = false,
}) {
  // Reads from the stable RegistryCtx so this effect does NOT re-fire every
  // time another component (re-)registers a shortcut.
  const ctx = useContext(RegistryCtx);

  // Latest-callback refs. `handler` and `when` are typically inline arrow
  // functions whose identity changes every render of the caller; if we
  // depended on them in the effect's dep array, the effect would fire on
  // every render, register/unregister hammering the global keydown listener
  // and (under some conditions) trigger React's "Maximum update depth"
  // warning by feeding a re-render loop through the registry version bump.
  const handlerRef = useRef(handler);
  const whenRef = useRef(when);
  // Update refs synchronously on every render. This is intentionally NOT in
  // a useEffect: refs do not need to commit, and using an effect would mean
  // the registered handler is one render stale during the first paint.
  handlerRef.current = handler;
  whenRef.current = when;

  useEffect(() => {
    if (!ctx || !id || !keys?.length) return undefined;
    ctx.register(id, {
      keys,
      handler: (e) => handlerRef.current?.(e),
      description,
      category,
      // `when` is invoked at dispatch time, so reading from the ref keeps
      // it live without re-registering on every render of the caller.
      when: () => (whenRef.current ? whenRef.current() : true),
      disabled,
      allowInInputs,
    });
    return () => ctx.unregister(id);
    // `when` and `handler` are intentionally NOT in this dep array — they
    // live in refs. Other props (description, category, disabled,
    // allowInInputs) are usually static literals so re-registering when
    // they change is fine and matches user intent.
  }, [
    ctx,
    id,
    JSON.stringify(keys),
    description,
    category,
    disabled,
    allowInInputs,
  ]);
}

export const formatChord = (chord, isMac = IS_MAC) => {
  return normalizeChord(chord)
    .split("+")
    .map((p) => {
      if (p === "mod") return isMac ? "⌘" : "Ctrl";
      if (p === "shift") return isMac ? "⇧" : "Shift";
      if (p === "alt") return isMac ? "⌥" : "Alt";
      if (p === "esc") return "Esc";
      if (p === "space") return "Space";
      if (p === "up") return "↑";
      if (p === "down") return "↓";
      if (p === "left") return "←";
      if (p === "right") return "→";
      if (p === "enter") return "Enter";
      return p.length === 1 ? p.toUpperCase() : p;
    })
    .join(isMac ? "" : "+");
};
