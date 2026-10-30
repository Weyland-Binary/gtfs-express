// Part of the hosted edition of GTFS Express (https://gtfsexpress.com), not of this source: see services/hostedEdition.js.
// Its routes answer 404 HOSTED_EDITION_ONLY; the community edition keeps no projects, so nothing starts.
const rest = require("../hostedEdition").absent("workspace/workspaceController");

module.exports = new Proxy({ start: () => {} }, { get: (target, prop) => (prop in target ? target[prop] : rest[prop]) });
