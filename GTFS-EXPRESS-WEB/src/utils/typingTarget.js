/** Where a key pressed belongs to what holds the focus, not to a screen's own shortcuts. */

// A text being typed keeps every key; a box ticked or a button pressed is no text.
const NOT_TEXT = /^(checkbox|radio|range|button|submit|reset|file|color|image)$/;
export const inField = (el) => {
  const tag = el?.tagName;
  if (tag === "INPUT") return !NOT_TEXT.test(el.type);
  return tag === "TEXTAREA" || tag === "SELECT" || Boolean(el?.isContentEditable);
};

// A dialog, a menu or a popover holding the focus keeps its keys.
export const inLayer = (el) => Boolean(el?.closest?.('.MuiModal-root, [role="dialog"], [role="menu"], [role="listbox"]'));
