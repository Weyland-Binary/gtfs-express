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
 * Global keyboard shortcuts: one keydown listener dispatches to the registered handlers ("mod" is Ctrl, or Cmd
 * on a Mac). The last registered wins, so a mounted dialog overrides a global shortcut. Alt+←/→ stay the
 * browser's Back and Forward: never registered, never dispatched.
 */

// RegistryCtx stays stable when the registry changes, so a registration does not re-fire other components'
// effects; ListCtx is the live list, for the Help dialog.
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

export const RESERVED_CHORDS = Object.freeze(["alt+left", "alt+right"]);
const isReserved = (chord) => RESERVED_CHORDS.includes(normalizeChord(chord));
export const allowedChords = (keys = []) => keys.filter((k) => !isReserved(k));

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

  if (["control", "meta", "shift", "alt"].includes(key)) return null;
  parts.push(key);
  return parts.join("+");
};

export function ShortcutsProvider({ children }) {
  // A ref for a stable read; the version makes the list re-render on change.
  const registryRef = useRef(new Map());
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const register = useCallback(
    (id, def) => {
      const keys = allowedChords(def.keys || []);
      if (keys.length !== (def.keys || []).length && typeof console !== "undefined") console.warn(`Shortcut "${id}": Alt+←/→ are the browser's Back / Forward and are left to it.`);
      if (!keys.length) {
        registryRef.current.delete(id);
        bump();
        return;
      }
      registryRef.current.set(id, { ...def, keys });
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
      if (!chord || isReserved(chord)) return;

      const editable = isEditableTarget(document.activeElement);

      // Most recent registration wins.
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
    void version;
    return Array.from(registryRef.current.entries()).map(([id, def]) => ({
      id,
      ...def,
    }));
  }, [version]);

  // Must stay stable as the registry changes, or useKeyboardShortcut would re-register in a loop.
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

/** Re-renders on every registry change: to only register a shortcut, use `useKeyboardShortcut`. */
export function useShortcuts() {
  const reg = useContext(RegistryCtx);
  const list = useContext(ListCtx);
  if (!reg)
    throw new Error("useShortcuts must be used within ShortcutsProvider");
  return { ...reg, list };
}

/** One shortcut for the component's lifetime; `handler` and `when` need no memoizing. */
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
  const ctx = useContext(RegistryCtx);

  // Inline callbacks as effect deps would re-register on every render and can loop through the registry's
  // version bump ("Maximum update depth"): they are read through refs.
  const handlerRef = useRef(handler);
  const whenRef = useRef(when);
  // Set during render, not in an effect, so the handler is never one render stale.
  handlerRef.current = handler;
  whenRef.current = when;

  // `keys` is usually an inline literal: compared by content so the effect re-fires only when a chord changes.
  const keysKey = JSON.stringify(keys ?? null);
  const stableKeys = useMemo(() => JSON.parse(keysKey), [keysKey]);

  useEffect(() => {
    if (!ctx || !id || !stableKeys?.length) return undefined;
    ctx.register(id, {
      keys: stableKeys,
      handler: (e) => handlerRef.current?.(e),
      description,
      category,
      when: () => (whenRef.current ? whenRef.current() : true),
      disabled,
      allowInInputs,
    });
    return () => ctx.unregister(id);
  }, [
    ctx,
    id,
    stableKeys,
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
