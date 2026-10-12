// Utility to manage the sessionId on the client side

const SESSION_KEY = "gtfs_session_id";

/**
 * Generates a UUID v4 (CSPRNG only)
 */
const generateUUID = () => {
  // Use crypto.randomUUID() when available (modern browsers)
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  // CSPRNG fallback for older browsers
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const randomBytes = new Uint8Array(1);
    crypto.getRandomValues(randomBytes);
    const r = randomBytes[0] % 16;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

/**
 * Retrieves the current sessionId or generates a new one
 */
export const getSessionId = () => {
  let sessionId = sessionStorage.getItem(SESSION_KEY);

  if (!sessionId) {
    sessionId = generateUUID();
    sessionStorage.setItem(SESSION_KEY, sessionId);
  }

  return sessionId;
};

/**
 * Generates a new sessionId (to load a new GTFS file).
 */
export const resetSession = () => {
  const newSessionId = generateUUID();
  sessionStorage.setItem(SESSION_KEY, newSessionId);
  return newSessionId;
};

/**
 * Forces a specific sessionId (e.g. loading a sample from the server)
 */
export const setSessionId = (id) => {
  sessionStorage.setItem(SESSION_KEY, id);
};

/**
 * Removes the sessionId (useful for cleanup)
 */
export const clearSession = () => {
  sessionStorage.removeItem(SESSION_KEY);
};

// ── The browser's workspace token (target design §9, D39) ───────────────────
// 256 bits minted by the server (POST /workspace/token) that own the projects
// this browser keeps without an account. It lives in localStorage (every tab
// of the browser shares it, and it survives a new tab), travels in the
// X-Client-Token header of the workspace calls and of the coverage of the
// brief (POST /contract/coverage, which reads a document a project keeps only
// for its owner) — never in a URL, never on the other requests — and is
// replaced when the projects are attached to an account (the old one dies).
// The server keeps only its hash.
const CLIENT_TOKEN_KEY = "gtfs_client_token";
const CLIENT_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The workspace token of this browser, or null (none yet, storage disabled, or not one the server mints). */
export const getClientToken = () => {
  try {
    const token = localStorage.getItem(CLIENT_TOKEN_KEY);
    return token && CLIENT_TOKEN_RE.test(token) ? token : null;
  } catch {
    return null;
  }
};

/** Keep the token the server minted (or handed back after an attachment); false when the storage refuses. */
export const setClientToken = (token) => {
  if (!CLIENT_TOKEN_RE.test(String(token || ""))) return false;
  try {
    localStorage.setItem(CLIENT_TOKEN_KEY, token);
    return true;
  } catch {
    return false;
  }
};

/** Forget a token the server no longer knows (replaced, or purged with its last project). */
export const clearClientToken = () => {
  try {
    localStorage.removeItem(CLIENT_TOKEN_KEY);
  } catch {
    /* storage disabled */
  }
};

// A token the server stopped knowing is kept aside, never thrown away: the
// projects it owns are not lost with it (a server secret changed and put
// back, D39), and « Rattacher mes travaux à mon compte » presents it too.
const PREVIOUS_CLIENT_TOKEN_KEY = "gtfs_client_token_prev";

/** Set the current token aside (the server answered 401 CLIENT_TOKEN_REQUIRED): a new one is minted next. */
export const retireClientToken = () => {
  const token = getClientToken();
  try {
    if (token) localStorage.setItem(PREVIOUS_CLIENT_TOKEN_KEY, token);
  } catch {
    /* storage disabled */
  }
  clearClientToken();
};

/** The token set aside, or null. */
export const getPreviousClientToken = () => {
  try {
    const token = localStorage.getItem(PREVIOUS_CLIENT_TOKEN_KEY);
    return token && CLIENT_TOKEN_RE.test(token) ? token : null;
  } catch {
    return null;
  }
};

/** Forget the token set aside (its projects were attached to an account, or it is dead for good). */
export const clearPreviousClientToken = () => {
  try {
    localStorage.removeItem(PREVIOUS_CLIENT_TOKEN_KEY);
  } catch {
    /* storage disabled */
  }
};

// The beta access codes are retired (2026-10-08: the licence, an account signed in by a code sent by e-mail,
// replaced them). A code an older version kept in this browser is forgotten once, never sent again.
try {
  localStorage.removeItem("gtfs_beta_code");
} catch {
  /* storage disabled */
}

// Whether every request carries the browser credentials (the account cookie).
// Off by default: an API without ACCOUNTS_ENABLED answers no
// Access-Control-Allow-Credentials, and a credentialed cross-origin fetch
// would then fail. The AccountProvider turns it on once /config/features
// says accounts are enabled.
let includeCredentials = false;

/** Sends the account cookie with every fetchWithSession call (accounts on). */
export const setIncludeCredentials = (on) => {
  includeCredentials = Boolean(on);
};

/** The credentials mode for a call made without fetchWithSession (a stream, a form upload): the cookie when accounts are on. */
export const credentialsOption = () => (includeCredentials ? { credentials: "include" } : {});

// The paid offer (the API's services/paidAccess): a 402 SUBSCRIPTION_REQUIRED, or a 401 NOT_SIGNED_IN marked
// `paid`, says that editing or the Network Studio needs a subscription. Every such answer, whoever asked, opens the
// same offer (PaywallHost listens): nobody meets a bare error where the product asks to subscribe.
export const PAYWALL_EVENT = "gtfs:paywall";
export const notifyPaywall = async (response) => {
  if (!response || (response.status !== 402 && response.status !== 401)) return;
  try {
    const body = await response.clone().json();
    // The free trial's limit (TRIAL_NO_DELIVERY): everything was tried, taking the modified network away is the licence's.
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

/**
 * Adds the X-Session-ID header to fetch options (a caller-provided one is
 * preserved — the feed-comparison flow uploads a second feed into its own
 * session while the main one stays live), and the account cookie when
 * accounts are on: a licensed account's raised rate limits and its rights
 * ride on the cookie, never on a header.
 */
// The name this browser declares for its acts (the acknowledgements' « Je soussigné(e) », gtfs:ack-name — the same
// key AcknowledgementForm keeps): sent URI-encoded in X-Actor-Name so the edit log names who made each retouch
// (WP10, the named journal). A signed-in account's own name wins on the server.
const ACTOR_KEY = "gtfs:ack-name";
export const actorName = () => {
  try {
    const name = (localStorage.getItem(ACTOR_KEY) || "").trim();
    return name.length >= 2 && name.length <= 120 ? name : "";
  } catch {
    return "";
  }
};

// The reader's lens on a simulated draft (the API's transform/previewLens; the owner's direction of 2026-10-07: one
// reader, « Avant | Après »). While the person looks at « Après », the reader's reads — every GET, and the read-only
// SQL console's POST /sql — carry X-View-Preview with the draft's preview id: the API answers them from the feed the
// draft would produce (only its reader endpoints read it: the change engine, the workspace and every write ignore or
// refuse it). A caller that names its own session (another feed) or its own lens (an explicit "" reads the working
// copy, the « Avant » of a comparison) is left as it is.
let readerLens = null;
export const LENS_LOST_EVENT = "gtfs:lens-lost";
/** Looks at the draft `previewId` (null: the working copy again). */
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
// The reader's endpoints the API answers through the lens (previewLens's list): the change engine, the documents, the
// workspace — every other read — keep reading the working copy, so the header is never sent to them.
const LENS_READS = /\/gtfs\/(agencies|routes\/[^/]+|directions\/[^/]+\/[^/]+|stops_and_times\/.+|stops\/all|shapes\/[^/]+\/[^/]+|all_shapes|shapes_for_route\/[^/]+|route_patterns\/[^/]+|shape_coverage\/[^/]+|shapes_unused|calendar(_dates)?\/[^/]+|calendar(_dates)?_service\/[^/]+|statistics|quality_audit|(stop|route|trip|shape)_detail\/[^/]+|sql\/schema)$/;
/** Whether a request reads through the lens: a GET (or HEAD) of the reader, or the read-only SQL console. */
export const readsThroughLens = (url, options = {}) => {
  const method = String(options.method || "GET").toUpperCase();
  const path = pathOf(url);
  if (method === "POST") return /\/gtfs\/sql$/.test(path);
  return (method === "GET" || method === "HEAD") && LENS_READS.test(path);
};

export const addSessionHeader = (options = {}, url = null) => {
  const headerNames = Object.keys(options.headers || {}).map((h) =>
    h.toLowerCase(),
  );
  const headers = { ...options.headers };
  // With accounts on, the session cookie must reach the API on every call
  // (the studio gates read it), cross-origin included; a caller-provided
  // credentials mode always wins.
  const credentials = options.credentials || (includeCredentials ? "include" : undefined);

  if (!headerNames.includes("x-session-id")) {
    headers["X-Session-ID"] = getSessionId();
  }
  if (!headerNames.includes("x-actor-name")) {
    const name = actorName();
    if (name) headers["X-Actor-Name"] = encodeURIComponent(name);
  }
  if (readerLens && !headerNames.includes("x-view-preview") && !headerNames.includes("x-session-id") && readsThroughLens(url, options)) {
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

/**
 * Fetch wrapper that automatically adds the session header
 * and handles rate limiting errors.
 */
export const fetchWithSession = async (url, options = {}) => {
  try {
    const sent = addSessionHeader(options, url);
    const response = await fetch(url, sent);
    if (response.status === 402 || response.status === 401) notifyPaywall(response);
    // The draft the reader looked at is no longer simulated (expired, or the working copy changed since): said once,
    // the reader goes back to the working copy (GTFSApp) and the change is simulated again.
    if ((response.status === 404 || response.status === 409) && sent.headers?.["X-View-Preview"]) notifyLensLost(response, sent.headers["X-View-Preview"]);

    // Check rate limiting
    if (response.status === 429) {
      const errorData = await response
        .json()
        .catch(() => ({ message: "Too many requests" }));

      // Create a custom error with rate limiting information
      const error = new Error(
        errorData.message || "Request limit reached. Please wait.",
      );
      error.isRateLimit = true;
      error.status = 429;
      throw error;
    }

    return response;
  } catch (error) {
    // If it is already our rate limiting error, re-throw it
    if (error.isRateLimit) {
      throw error;
    }

    // For other network errors
    console.error("Fetch error:", error);
    throw error;
  }
};
