"use strict";

/** Whether a feed has one agency: its lines may then leave agency_id empty (GTFS). */
const hasSingleAgency = (db) => (db.prepare("SELECT COUNT(*) AS n FROM agency").get()?.n || 0) <= 1;

/** Whether a line is an agency's: its agency_id, or none written in a feed with a single agency. No agency asked: any line. */
const lineOfAgency = (route, agencyId, singleAgency) => !agencyId || route.agency_id === agencyId || (Boolean(singleAgency) && !String(route.agency_id ?? "").trim());

module.exports = { hasSingleAgency, lineOfAgency };
