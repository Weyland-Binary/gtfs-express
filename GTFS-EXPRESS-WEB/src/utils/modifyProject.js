/**
 * Opens the draft that modifies the network open here (one draft per network), or a new project when `fresh`.
 * `kind` ("hand" | "brief") is taken only by a draft that holds no work in progress; `brief` (the assistant's
 * hand-off) lands in a brief draft's field, never sent by itself.
 */
import { OPEN_CHANGE_STUDIO_EVENT } from "./appEvents";
export const openModifyProject = ({ fresh = false, kind = null, brief = null } = {}) => {
  const text = typeof brief === "string" && brief.trim() ? brief.trim() : null;
  const detail = { ...(fresh ? { fresh: true } : {}), ...(text ? { kind: "brief", brief: text } : kind ? { kind } : {}) };
  window.dispatchEvent(new CustomEvent(OPEN_CHANGE_STUDIO_EVENT, Object.keys(detail).length ? { detail } : undefined));
};
