/**
 * A refused edit (any non-2xx of /edit/*) as one sentence in the interface's language, the server's own words
 * kept apart. The body is read defensively: an nginx 502 answers HTML, never "Unexpected token <". A 404
 * SESSION_NOT_FOUND / INVALID_SESSION is the working copy swept: sessionLost is raised at once, not at the
 * clock's next minute.
 */
import { humanError, isTechnical } from "./humanError";
import { getDraftSession, notifySessionLost } from "./sessionManager";

const CODE_RE = /^[A-Z][A-Z0-9_]{2,}$/;
const LOST_CODES = new Set(["SESSION_NOT_FOUND", "INVALID_SESSION", "NO_SESSION"]);
const MAX_DETAIL = 300;

const codeOf = (v) => (typeof v === "string" && CODE_RE.test(v.trim()) ? v.trim() : null);

/**
 * `{ status, code, message, detail, text, kind, sessionLost }`: `message` is the human sentence, `detail` the
 * server's phrase and `details` list when they read as sentences (joined, capped), `text` both together for a toast.
 */
export const editRefusal = async (res, t) => {
  const status = Number(res?.status) || 0;
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const code = codeOf(body?.code) || codeOf(body?.error) || null;
  const phrase = [body?.message, body?.error].find((v) => typeof v === "string" && v && !codeOf(v)) || "";
  const human = humanError({ status, code, message: phrase || `HTTP ${status}`, body: body || {} }, t) || {};
  // The edit API says what is wrong in `error` (a sentence) and `details` (a list): kept when they read as sentences.
  const details = [code ? null : phrase, ...(Array.isArray(body?.details) ? body.details : [])].filter((d) => typeof d === "string" && d.trim() && !isTechnical(d));
  let detail = details.join("; ");
  if (detail.length > MAX_DETAIL) detail = `${detail.slice(0, MAX_DETAIL)}…`;
  const sessionLost = status === 404 && LOST_CODES.has(code);
  // A draft's own session gone is not the working copy's: the clock's poll says that one.
  if (sessionLost && !getDraftSession()) notifySessionLost(code);
  const message = human.message || t("error.human.unknown");
  return { status, code, message, detail, text: detail ? `${message} — ${detail}` : message, kind: human.kind || "unknown", sessionLost };
};

/** A thrown failure (the network, an aborted call) as one sentence. */
export const editFailure = (err, t) => humanError(err, t)?.message || t("error.human.unknown");
