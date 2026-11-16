/**
 * A refused edit (any non-2xx of /edit/*) as one sentence in the interface's language, the server's own words
 * kept apart: the one way every screen of the editor says a failed edit. The body is read defensively: an nginx 502
 * answers HTML, never "Unexpected token <". A 404 SESSION_NOT_FOUND / INVALID_SESSION is the working copy swept:
 * sessionLost is raised at once, not at the clock's next minute.
 */
import { humanError, isTechnical } from "./humanError";
import { getDraftSession, notifySessionLost } from "./sessionManager";

const CODE_RE = /^[A-Z][A-Z0-9_]{2,}$/;
const LOST_CODES = new Set(["SESSION_NOT_FOUND", "INVALID_SESSION", "NO_SESSION"]);
const MAX_DETAIL = 300;

const codeOf = (v) => (typeof v === "string" && CODE_RE.test(v.trim()) ? v.trim() : null);

// The refusal's own facts, read from the answer: its status, its code when `error` or `code` is one, its phrase.
const factsOf = (answered, read) => {
  const status = Number(answered) || 0;
  const body = read && typeof read === "object" ? read : null;
  const code = codeOf(body?.code) || codeOf(body?.error) || null;
  return { status, body, code, sessionLost: status === 404 && LOST_CODES.has(code) };
};
// A draft's own session gone is not the working copy's: the clock's poll says that one.
const tellLost = ({ sessionLost, code }) => {
  if (sessionLost && !getDraftSession()) notifySessionLost(code);
};

/** What a refusal says, with no effect of its own: `{ status, code, message, detail, text, kind, sessionLost }`. */
const saidOf = (answered, read, t) => {
  const { status, body, code, sessionLost } = factsOf(answered, read);
  const phrase = [body?.message, body?.error].find((v) => typeof v === "string" && v && !codeOf(v)) || "";
  const human = humanError({ status, code, message: phrase || `HTTP ${status}`, body: body || {} }, t) || {};
  // The edit API says what is wrong in `error` (a sentence) and `details` (a list): kept when they read as sentences.
  const details = [code ? null : phrase, ...(Array.isArray(body?.details) ? body.details : [])].filter((d) => typeof d === "string" && d.trim() && !isTechnical(d));
  let detail = details.join("; ");
  if (detail.length > MAX_DETAIL) detail = `${detail.slice(0, MAX_DETAIL)}…`;
  // A 4xx without a code nor a sentence of its status (a 409, a 422) is a refusal, never « an error, try again ».
  const refused = !code && status >= 400 && status < 500 && (!human.kind || human.kind === "unknown");
  const message = refused ? t("edit.refused") : human.message || t("error.human.unknown");
  return { status, code, message, detail, text: detail ? `${message} — ${detail}` : message, kind: refused ? "refused" : human.kind || "unknown", sessionLost };
};

/**
 * `{ status, code, message, detail, text, kind, sessionLost }`: `message` is the human sentence, `detail` the
 * server's phrase and `details` list when they read as sentences (joined, capped), `text` both together for a toast.
 */
export const editRefusal = async (res, t) => {
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return editRefusalOf(res?.status, body, t);
};

/** The same, of an answer whose body is already read. */
export const editRefusalOf = (status, body, t) => {
  const said = saidOf(status, body, t);
  tellLost(said);
  return said;
};

/** A thrown failure (the network, an aborted call) as one sentence. */
export const editFailure = (err, t) => humanError(err, t)?.message || t("error.human.unknown");

/** An Error to throw for a refused edit whose body is already read: it carries the answer, said by `editErrorText`. */
export const refusedEdit = (status, body) => {
  tellLost(factsOf(status, body));
  return Object.assign(new Error(`HTTP ${Number(status) || 0}`), { refused: { status, body } });
};

/**
 * What to show for anything caught around an edit: the refusal thrown by `refusedEdit`, else the failure in one
 * sentence. No effect of its own: a screen may keep the error and say it as it renders.
 */
export const editErrorText = (err, t) => (typeof err === "string" ? err : err && err.refused ? saidOf(err.refused.status, err.refused.body, t).text : editFailure(err, t));
