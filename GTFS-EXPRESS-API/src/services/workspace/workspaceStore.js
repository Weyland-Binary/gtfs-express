// Part of the hosted edition of GTFS Express (https://gtfsexpress.com), not of this source: see services/hostedEdition.js.
// The community edition keeps no projects: the workspace answers off, so the code that consults it reads a lone copy.
const rest = require("../hostedEdition").absent("workspace/workspaceStore");

const off = {
  enabled: () => false,
  exists: () => false,
  isBound: () => false,
  bindingOf: () => null,
  sessionRoleOf: () => null,
};

module.exports = new Proxy(off, { get: (target, prop) => (prop in target ? target[prop] : rest[prop]) });
