/**
 * The state of an edit form over data the screen behind reads again after every edit (a new object for the same row):
 * what the person typed is never replaced by such a read.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * A dialog's form, built by `build()` when the dialog opens and when `identity` (the row's key and the mode, a string)
 * changes, never on a render in between. `onStart` resets what the dialog keeps beside the form.
 * Returns [form, setForm, initial].
 */
export function useOpenedForm(open, identity, build, onStart) {
  const [initial, setInitial] = useState(build);
  const [form, setForm] = useState(initial);
  useEffect(() => {
    if (!open) return;
    const fresh = build();
    setInitial(fresh);
    setForm(fresh);
    onStart?.(fresh);
    // `build` and `onStart` read the props of the render that opened the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, identity]);
  return [form, setForm, initial];
}

/** `fresh` with the fields the person changed since `base` kept as typed. */
export const keepTyped = (form, base, fresh) => {
  if (!form || !base || !fresh) return fresh;
  const next = { ...fresh };
  for (const key of Object.keys(fresh)) {
    if (form[key] !== base[key]) next[key] = form[key];
  }
  return next;
};

/**
 * A panel's form over a row read again on every data version: `follow(fresh)` moves the fields left alone to the row
 * just read and keeps the ones the person changed, `restart(fresh)` drops them (another row, a save).
 */
export function useFollowingForm(empty = null) {
  const [base, setBase] = useState(empty);
  const [form, setForm] = useState(empty);
  const baseRef = useRef(empty);
  const follow = useCallback((fresh) => {
    const previous = baseRef.current;
    baseRef.current = fresh;
    setBase(fresh);
    setForm((current) => keepTyped(current, previous, fresh));
  }, []);
  const restart = useCallback((fresh) => {
    baseRef.current = fresh;
    setBase(fresh);
    setForm(fresh);
  }, []);
  const dirty = useMemo(() => Boolean(base && form) && Object.keys(base).some((key) => form[key] !== base[key]), [base, form]);
  return { form, setForm, base, dirty, follow, restart };
}

/**
 * What a form sends, from the row it holds (each field as the server stores it, null for an empty one): on an edit,
 * the fields that differ from the row the form opened on, null clearing the ones the person emptied.
 */
export const changedFields = (before, after) => Object.fromEntries(Object.entries(after).filter(([key, value]) => value !== before[key]));

/** On a create, the fields filled in. */
export const filledFields = (row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));

/** True once a form no longer holds what it opened on. */
export const differs = (form, opened) => Object.keys(opened).some((key) => form[key] !== opened[key]);
