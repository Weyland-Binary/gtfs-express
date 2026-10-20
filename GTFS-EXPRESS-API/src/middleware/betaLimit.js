/**
 * betaLimit — helpers that give a licensed account its own express-rate-limit
 * bucket and a higher cap.
 *
 * The requests of an account whose licence runs (classified upstream by
 * userContext, which sets the pseudo-key `req.betaCode` = user:<id>; "beta"
 * in these names is only an identifier) get their OWN per-account bucket and
 * a higher cap; keyless traffic keeps the original IP/session key and the
 * original cap.
 *
 * The sign-in limiter (authLimiter, app.js) deliberately does NOT use these
 * helpers — it stays keyed by IP and capped low, since its whole job is to
 * throttle code guessing.
 */

/**
 * Wrap a limiter's keyGenerator so a licensed account gets a dedicated
 * `beta:<key>` bucket (isolated from other traffic sharing its IP), while keyless
 * requests fall back to the limiter's original key function.
 *
 * @param {(req, res) => string} fallbackKeyFn — the keyless key generator.
 */
const betaAwareKey = (fallbackKeyFn) => (req, res) =>
  req.betaCode ? `beta:${req.betaCode}` : fallbackKeyFn(req, res);

/**
 * Wrap a limiter's `max` so a licensed account gets the higher cap. Returns a
 * function suitable for express-rate-limit's function-form `max`/`limit`.
 *
 * @param {number} keylessMax — cap applied to keyless requests.
 * @param {number} betaMax    — cap applied to licensed accounts.
 */
const betaAwareMax = (keylessMax, betaMax) => (req) =>
  req.betaCode ? betaMax : keylessMax;

module.exports = { betaAwareKey, betaAwareMax };
