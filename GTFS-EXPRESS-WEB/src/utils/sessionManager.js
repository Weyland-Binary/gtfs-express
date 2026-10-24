import { LENS_LOST_EVENT, PAYWALL_EVENT, SESSION_LOST_EVENT } from "./appEvents";
const SESSION_KEY = "gtfs_session_id";

// The session id is a bearer credential: CSPRNG only, never Math.random.
const generateUUID = () => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const randomBytes = new Uint8Array(1);
    crypto.getRandomValues(randomBytes);
    const r = randomBytes[0] % 16;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

export const getSessionId = () => {
  let sessionId = sessionStorage.getItem(SESSION_KEY);

  if (!sessionId) {
    sessionId = generateUUID();
    sessionStorage.setItem(SESSION_KEY, sessionId);
  }

  return sessionId;
};

export const resetSession = () => {
  const newSessionId = generateUUID();
  sessionStorage.setItem(SESSION_KEY, newSessionId);
  return newSessionId;
};

/**
 * A session id not adopted yet: a new network is uploaded under it and adopted with setSessionId once the
 * server holds it, so the working copy open in the tab is never replaced by another network.
 */
export const newSessionId = () => generateUUID();

export const setSessionId = (id) => {
  sessionStorage.setItem(SESSION_KEY, id);
};

export const clearSession = () => {
  sessionStorage.removeItem(SESSION_KEY);
};

// ── The browser's workspace token
// Owns the projects this browser keeps without an account. Shared by every tab (localStorage), sent only
// in X-Client-Token on workspace calls, never in a URL; the server keeps only its hash.
const CLIENT_TOKEN_KEY = "gtfs_client_token";
const CLIENT_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const getClientToken = () => {
  try {
    const token = localStorage.getItem(CLIENT_TOKEN_KEY);
    return token && CLIENT_TOKEN_RE.test(token) ? token : null;
  } catch {
    return null;
  }
};

/** False when the storage refuses. */
export const setClientToken = (token) => {
  if (!CLIENT_TOKEN_RE.test(String(token || ""))) return false;
  try {
    localStorage.setItem(CLIENT_TOKEN_KEY, token);
    return true;
  } catch {
    return false;
  }
};

export const clearClientToken = () => {
  try {
    localStorage.removeItem(CLIENT_TOKEN_KEY);
  } catch {
    /* storage disabled */
  }
};

// A token the server stopped knowing is kept aside, never thrown away: its projects may come back (a server
// secret restored), and attaching the workspace to an account presents it too.
const PREVIOUS_CLIENT_TOKEN_KEY = "gtfs_client_token_prev";

export const retireClientToken = () => {
  const token = getClientToken();
  try {
    if (token) localStorage.setItem(PREVIOUS_CLIENT_TOKEN_KEY, token);
  } catch {
    /* storage disabled */
  }
  clearClientToken();
};

export const getPreviousClientToken = () => {
  try {
    const token = localStorage.getItem(PREVIOUS_CLIENT_TOKEN_KEY);
    return token && CLIENT_TOKEN_RE.test(token) ? token : null;
  } catch {
    return null;
  }
};

export const clearPreviousClientToken = () => {
  try {
    localStorage.removeItem(PREVIOUS_CLIENT_TOKEN_KEY);
  } catch {
    /* storage disabled */
  }
};

// A beta access code an older version kept in this browser is forgotten, never sent again.
try {
  localStorage.removeItem("gtfs_beta_code");
} catch {
  /* storage disabled */
}

// Off until accounts are enabled: an API without accounts answers no Access-Control-Allow-Credentials,
// and a credentialed cross-origin fetch would then fail.
let includeCredentials = false;

export const setIncludeCredentials = (on) => {
  includeCredentials = Boolean(on);
};

/** For calls made without fetchWithSession (a stream, a form upload). */
export const credentialsOption = () => (includeCredentials ? { credentials: "include" } : {});

// Every paid-offer refusal, whoever asked, opens the same offer, so nobody meets a bare error where the
// product asks to subscribe.
export const notifyPaywall = async (response) => {
  if (!response || (response.status !== 402 && response.status !== 401)) return;
  try {
    const body = await response.clone().json();
    if (body?.error === "TRIAL_NO_DELIVERY") {
      window.dispatchEvent(new CustomEvent(PAYWALL_EVENT, { detail: { entitlement: "deliver", state: "trial" } }));
      return;
    }
    const paid = body?.error === "SUBSCRIPTION_REQUIRED" || (body?.error === "NOT_SIGNED_IN" && body?.paid === true);
    if (!paid) return;
    const state = body.error === "SUBSCRIPTION_REQUIRED" ? "subscription_required" : "sign_in_required";
    window.dispatchEvent(new CustomEvent(PAYWALL_EVENT, { detail: { entitlement: body.entitlement === "edit" ? "edit" : "studio", state } }));
  } catch {
    /* not JSON: not the paid offer's answer */
  }
};

// An edit answered 404 SESSION_NOT_FOUND: the working copy was swept. Said at once (useWorkingCopyClock sets
// sessionLost on it), not at the clock's next minute.
export const notifySessionLost = (code = "SESSION_NOT_FOUND") => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SESSION_LOST_EVENT, { detail: { code } }));
};

// The name typed in the acknowledgements, sent URI-encoded in X-Actor-Name so the edit log names who made each
// edit; a signed-in account's own name wins on the server.
const ACTOR_KEY = "gtfs:ack-name";
export const actorName = () => {
  try {
    const name = (localStorage.getItem(ACTOR_KEY) || "").trim();
    return name.length >= 2 && name.length <= 120 ? name : "";
  } catch {
    return "";
  }
};

// The reader's lens on a simulated draft: its reads carry X-View-Preview and the API answers them from the
// feed the draft would produce. A caller that names its own session or its own lens ("" for the working
// copy) is left as it is.
let readerLens = null;
/** Null reads the working copy again. */
export const setReaderLens = (previewId) => {
  readerLens = typeof previewId === "string" && /^[a-f0-9]{18}$/.test(previewId) ? previewId : null;
};
export const getReaderLens = () => readerLens;
const pathOf = (url) => {
  try {
    return new URL(String(url), "http://localhost").pathname;
  } catch {
    return String(url || "");
  }
};
// Must match the API's previewLens list: every other read stays on the working copy and never gets the header.
const LENS_READS = /\/gtfs\/(agencies|routes\/[^/]+|directions\/[^/]+\/[^/]+|stops_and_times\/.+|stops\/all|shapes\/[^/]+\/[^/]+|all_shapes|shapes_for_route\/[^/]+|route_patterns\/[^/]+|shape_coverage\/[^/]+|shapes_unused|calendar(_dates)?\/[^/]+|calendar(_dates)?_service\/[^/]+|statistics|quality_audit|search|(stop|route|trip|shape)_detail\/[^/]+|sql\/schema)$/;
/** A reader GET or HEAD, or the read-only SQL console (its query, its CSV). */
export const readsThroughLens = (url, options = {}) => {
  const method = String(options.method || "GET").toUpperCase();
  const path = pathOf(url);
  if (method === "POST") return /\/gtfs\/sql(\/export\.csv)?$/.test(path);
  return (method === "GET" || method === "HEAD") && LENS_READS.test(path);
};

// While a draft is worked in, every request, reads and writes alike, goes to the draft's session so what an
// editor saves shows at once; the draft's own routes and the workspace's name the working copy.
let draftSession = null;
const SESSION_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Null works in the working copy again. */
export const setDraftSession = (id) => {
  draftSession = typeof id === "string" && SESSION_RE.test(id) ? id : null;
};
export const getDraftSession = () => draftSession;
// A stored preview's reads go to the session it was simulated on: the working copy's.
const MAIN_ONLY = /\/gtfs\/(transform\/draft(\/[a-z]+)?|transform\/preview\/[a-f0-9]{18}\/.+|workspace\/.*)$/;
export const sessionFor = (url) => (draftSession && !MAIN_ONLY.test(pathOf(url)) ? draftSession : getSessionId());

/**
 * A caller's own X-Session-ID is kept (a second feed may be uploaded into its own session). An account's
 * rights ride on the cookie, never on a header. `withSession: false` sends no session at all, for the calls that
 * belong to no working copy (a share's page, the workspace token, the catalogue, the brief's documents).
 */
export const addSessionHeader = (input = {}, url = null) => {
  const { withSession = true, ...options } = input;
  const headerNames = Object.keys(options.headers || {}).map((h) =>
    h.toLowerCase(),
  );
  const headers = { ...options.headers };
  // A caller-provided credentials mode always wins.
  const credentials = options.credentials || (includeCredentials ? "include" : undefined);

  if (withSession && !headerNames.includes("x-session-id")) {
    headers["X-Session-ID"] = sessionFor(url);
  }
  if (!headerNames.includes("x-actor-name")) {
    const name = actorName();
    if (name) headers["X-Actor-Name"] = encodeURIComponent(name);
  }
  if (withSession && readerLens && !headerNames.includes("x-view-preview") && !headerNames.includes("x-session-id") && readsThroughLens(url, options)) {
    headers["X-View-Preview"] = readerLens;
  }

  return credentials ? { ...options, credentials, headers } : { ...options, headers };
};

const notifyLensLost = async (response, previewId) => {
  try {
    const body = await response.clone().json();
    if (body?.error !== "PREVIEW_NOT_FOUND" && body?.error !== "PREVIEW_STALE") return;
    window.dispatchEvent(new CustomEvent(LENS_LOST_EVENT, { detail: { code: body.error, previewId } }));
  } catch {
    /* not the lens's answer */
  }
};

export const fetchWithSession = async (url, options = {}) => {
  try {
    const sent = addSessionHeader(options, url);
    const response = await fetch(url, sent);
    if (response.status === 402 || response.status === 401) notifyPaywall(response);
    // The previewed draft expired or went stale: the reader goes back to the working copy.
    if ((response.status === 404 || response.status === 409) && sent.headers?.["X-View-Preview"]) notifyLensLost(response, sent.headers["X-View-Preview"]);

    if (response.status === 429) {
      const errorData = await response
        .json()
        .catch(() => ({ message: "Too many requests" }));

      const error = new Error(
        errorData.message || "Request limit reached. Please wait.",
      );
      error.isRateLimit = true;
      error.status = 429;
      // Some limiters answer a sentence in `error`: only a CODE is a code.
      error.code = /^[A-Z][A-Z0-9_]+$/.test(String(errorData.error || "")) ? errorData.error : "RATE_LIMITED";
      error.body = errorData;
      const retry = Number(errorData.retryAfterSec ?? response.headers?.get?.("retry-after"));
      if (Number.isFinite(retry) && retry > 0) error.retryAfterSec = retry;
      throw error;
    }

    return response;
  } catch (error) {
    if (error.isRateLimit) {
      throw error;
    }

    console.error("Fetch error:", error);
    throw error;
  }
};
