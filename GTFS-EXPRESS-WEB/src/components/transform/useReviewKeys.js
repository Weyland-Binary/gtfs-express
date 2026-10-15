/**
 * useReviewKeys — the review at the keyboard (a change on twenty lines is read again in twenty keystrokes): on ③,
 * J and K move the focus along the lines the draft changes (ChangeReview marks the line and scrolls to it), Enter opens the focused line in the reader on « Après », ? goes to the first question
 * waiting (the autopilot's); on ⑤, Enter applies the change once everything is accepted. Nothing fires while the
 * person types (an input, a textarea, a select, an editable element has the focus) or holds a modifier, and Enter
 * stays a focused control's own (a button, a link, a fold's summary, a tick).
 *
 *   keysOf(lines, focus, dir) → the line J (+1) or K (−1) lands on: the next one after the focused line, the
 *                               first (or last) when none is focused, the ends held
 */

import { useEffect } from "react";

const TYPING = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const TYPING_ROLES = new Set(["textbox", "searchbox", "combobox", "listbox", "spinbutton", "slider"]);

/** Whether a key pressed on this element belongs to what the person types (or picks: a combobox, a listbox). */
export const typingIn = (el) => Boolean(el && (TYPING.has(el.tagName) || el.isContentEditable || TYPING_ROLES.has(el.getAttribute?.("role"))));

const CONTROLS = new Set(["BUTTON", "A", "SUMMARY", "INPUT"]);
const CONTROL_ROLES = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "checkbox", "radio", "switch"]);

/**
 * Whether Enter on this element is the element's own act — a button, a link, a fold's summary, a tick: the review
 * leaves it alone (else, with the focus on « Ajouter aux objectifs » at ⑤, Enter would apply the whole change).
 */
export const controlIn = (el) => Boolean(el && (CONTROLS.has(el.tagName) || CONTROL_ROLES.has(el.getAttribute?.("role"))));

/** The line the focus moves to: `lines` [{ route, label }], `focus` the route or label in focus, `dir` +1 (J) or −1 (K). */
export const keysOf = (lines, focus, dir) => {
  if (!lines.length) return null;
  const keyOf = (l) => String(l.route || l.label);
  const i = focus == null ? -1 : lines.findIndex((l) => keyOf(l) === String(focus) || String(l.label) === String(focus));
  if (i < 0) return dir > 0 ? lines[0] : lines[lines.length - 1];
  const j = Math.min(lines.length - 1, Math.max(0, i + dir));
  return lines[j];
};

/**
 * `enabled`: the shortcuts are live (③ or ⑤ shown, nothing modal); `lines`, `focus`, `onFocus(line)`: the review's
 * lines and their focus; `onOpen(line)`: Enter on a focused line; `onQuestion()`: ?; `onApply()`: Enter where the
 * act stands (⑤), when `canApply`.
 */
export default function useReviewKeys({ enabled = false, lines = [], focus = null, onFocus = null, onOpen = null, onQuestion = null, onApply = null, canApply = false }) {
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return undefined;
    const onKey = (e) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || typingIn(document.activeElement)) return;
      const key = e.key;
      if ((key === "j" || key === "k") && onFocus && lines.length) {
        const to = keysOf(lines, focus, key === "j" ? 1 : -1);
        if (to) {
          e.preventDefault();
          onFocus(to);
        }
      } else if (key === "Enter") {
        // A focused control takes its own Enter (a button, a link, a fold, a tick): never the review's.
        if (controlIn(document.activeElement)) return;
        if (onApply && canApply) {
          e.preventDefault();
          onApply();
        } else if (onOpen && focus != null) {
          const line = lines.find((l) => String(l.route || l.label) === String(focus) || String(l.label) === String(focus));
          if (line) {
            e.preventDefault();
            onOpen(line);
          }
        }
      } else if (key === "?" && onQuestion) {
        e.preventDefault();
        onQuestion();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled, lines, focus, onFocus, onOpen, onQuestion, onApply, canApply]);
}
