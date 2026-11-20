/**
 * Which editor a validation finding opens: its `entityType` and `entityId`, or the row as read when the import kept it
 * aside (`asideId`). Free of React, so the corpus tools measure the same answer the report gives.
 */

import { getFixMetaForRule } from "./ruleFieldMapping.js";

export const FIXABLE_TYPES = new Set(["stop", "route", "trip", "stop_time", "agency", "calendar", "shape", "feed_info"]);

/** Resolve { entityType, fields } for a finding, or null when not fixable. */
export const resolveFixMeta = (finding) => {
  if (!finding || finding.aggregate || finding.resolvedByImport) return null;
  // The row is not in the tables: its record cannot be opened, the row as read can.
  if (finding.asideId) return { entityType: "aside", fields: finding.field ? [finding.field] : [], asideId: finding.asideId };
  if (!finding.entityId) return null;
  const mapping = getFixMetaForRule(finding.ruleCode, finding);
  if (!mapping) return null;
  const entityType = mapping.entityType || finding.entityType || null;
  if (!entityType || !FIXABLE_TYPES.has(entityType)) return null;
  const fields = mapping.fields.length > 0 ? mapping.fields : finding.field ? [finding.field] : [];
  return { entityType, fields };
};

export const isFixableFinding = (finding) => resolveFixMeta(finding) !== null;
