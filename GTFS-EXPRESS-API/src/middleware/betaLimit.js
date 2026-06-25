/**
 * betaLimit — helpers that make an express-rate-limit limiter beta-aware.
 *
 * Requests carrying a valid X-Beta-Code (classified upstream by betaContext,
 * which sets `req.betaCode`) get their OWN per-code bucket and a higher cap;
 * keyless traffic keeps the original IP/session key and the original cap.
 *
 * The brute-force limiters (betaGateLimiter, betaGateFailureLimiter)
 * deliberately do NOT use these helpers — they must stay keyed by IP and
 * capped low regardless of any code, since their whole job is to throttle
 * code guessing.
 */

/**
 * Wrap a limiter's keyGenerator so beta holders get a dedicated `beta:<code>`
 * bucket (isolated from other traffic sharing their IP), while keyless
 * requests fall back to the limiter's original key function.
 *
 * @param {(req, res) => string} fallbackKeyFn — the keyless key generator.
 */
const betaAwareKey = (fallbackKeyFn) => (req, res) =>
  req.betaCode ? `beta:${req.betaCode}` : fallbackKeyFn(req, res);

/**
 * Wrap a limiter's `max` so beta holders get the higher cap. Returns a
 * function suitable for express-rate-limit's function-form `max`/`limit`.
 *
 * @param {number} keylessMax — cap applied to keyless requests.
 * @param {number} betaMax    — cap applied to valid beta-code holders.
 */
const betaAwareMax = (keylessMax, betaMax) => (req) =>
  req.betaCode ? betaMax : keylessMax;

module.exports = { betaAwareKey, betaAwareMax };
