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

const BETA_CODE_KEY = "gtfs_beta_code";

/**
 * Reads the persisted beta code, if the user has one. localStorage access is
 * wrapped because it throws in private-browsing / blocked-cookie contexts.
 */
export const getBetaCode = () => {
  try {
    return localStorage.getItem(BETA_CODE_KEY);
  } catch {
    return null;
  }
};

/**
 * Adds the X-Session-ID and X-Beta-Code headers to fetch options. Headers
 * explicitly supplied by the caller always win:
 *   - a caller-provided X-Session-ID is preserved — the feed-comparison flow
 *     uploads a second feed into its own session while the main one stays live;
 *   - a caller-provided X-Beta-Code is preserved (e.g. the beta gate dialog
 *     validating a freshly typed code that isn't persisted yet).
 *
 * X-Beta-Code must ride along on EVERY request, not just the gated ones: the
 * backend's betaContext classifier reads it to grant the raised beta rate
 * limits (see middleware/betaLimit.js). Without it an authenticated beta
 * tester silently falls back to the keyless caps — e.g. 5 revalidations/min
 * instead of 30 — and hits "Too many requests" after a handful of edits.
 */
export const addSessionHeader = (options = {}) => {
  const headerNames = Object.keys(options.headers || {}).map((h) =>
    h.toLowerCase(),
  );
  const headers = { ...options.headers };

  if (!headerNames.includes("x-session-id")) {
    headers["X-Session-ID"] = getSessionId();
  }
  if (!headerNames.includes("x-beta-code")) {
    const betaCode = getBetaCode();
    if (betaCode) headers["X-Beta-Code"] = betaCode;
  }

  return { ...options, headers };
};

/**
 * Fetch wrapper that automatically adds the session header
 * and handles rate limiting errors.
 */
export const fetchWithSession = async (url, options = {}) => {
  try {
    const response = await fetch(url, addSessionHeader(options));

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
