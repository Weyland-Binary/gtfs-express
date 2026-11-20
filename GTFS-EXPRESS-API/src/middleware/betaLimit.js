/**
 * An account whose licence runs (req.betaCode = user:<id>, set by userContext; "beta" is only a name) gets a bucket
 * of its own, apart from the traffic sharing its address, and a higher cap. The sign-in limiter stays keyed by IP on
 * purpose: its job is to throttle code guessing.
 */

const betaAwareKey = (fallbackKeyFn) => (req, res) =>
  req.betaCode ? `beta:${req.betaCode}` : fallbackKeyFn(req, res);

const betaAwareMax = (keylessMax, betaMax) => (req) =>
  req.betaCode ? betaMax : keylessMax;

module.exports = { betaAwareKey, betaAwareMax };
