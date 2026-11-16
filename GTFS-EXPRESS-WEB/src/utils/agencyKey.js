/**
 * An agency's key in the reader: its agency_id, or, for the single agency GTFS lets go without one, the key every
 * read of an agency's lines understands (GET /routes/:agency_id and its kin). One key, so the pick, the selector, the
 * overview and the Tracés tab name the same agency.
 */
export const NO_AGENCY_ID = "default_agency_id";

export const agencyKeyOf = (agency) => {
  const id = agency?.agency_id;
  return id == null || String(id).trim() === "" ? NO_AGENCY_ID : id;
};

/** The agency_id a key stands for: none for the agency without one. */
export const agencyIdOfKey = (key) => (!key || key === NO_AGENCY_ID ? null : key);
