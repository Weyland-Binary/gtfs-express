/**
 * flexEditService.js — CRUD for GTFS-Flex / DRT entities.
 *
 * Entities:
 *   - booking_rules     PK = booking_rule_id (TEXT)
 *   - locations_geojson PK = feature_id (TEXT) — one row per FeatureCollection feature
 *
 * booking_rules follows the standard TEXT-PK pattern via the generic factory
 * exported by faresEditService.js. locations_geojson is also a TEXT-PK table
 * but the `coordinates` column stores GeoJSON geometry as a JSON blob; the
 * handler validates that the body's coordinates are JSON-serialisable before
 * writing.
 *
 * Round-trip with locations.geojson:
 *   loadData() in sessionManager parses the file FeatureCollection on upload
 *   and populates the locations_geojson table with one row per Polygon /
 *   MultiPolygon feature. Export rebuilds the FeatureCollection from these
 *   rows. The CRUD handlers here mutate that same table — exports always
 *   reflect post-mutation state without round-tripping through the GeoJSON
 *   parser.
 */

"use strict";

const { makeTextPkCrud, fkExists } = require("./faresEditService");
const {
  requireEditMode,
  requireSession,
  logEdit,
  syncFaresFlexCache,
  respondWithValidation,
} = require("./_editCore");

const {
  validateBookingRuleFields,
  validateLocationsGeojsonFields,
  validateLocationGroupFields,
  validateLocationGroupStopFields,
} = require("../../utils/fieldValidators");

// ── booking_rules ────────────────────────────────────────────────────────────

const bookingRulesCrud = makeTextPkCrud({
  table: "booking_rules",
  pk: "booking_rule_id",
  fields: [
    "booking_type",
    "prior_notice_duration_min",
    "prior_notice_duration_max",
    "prior_notice_last_day",
    "prior_notice_last_time",
    "prior_notice_start_day",
    "prior_notice_start_time",
    "prior_notice_service_id",
    "message",
    "pickup_message",
    "drop_off_message",
    "phone_number",
    "info_url",
    "booking_url",
  ],
  requiredFields: ["booking_type"],
  validator: validateBookingRuleFields,
  fks: [
    {
      otherTable: "calendar",
      otherCol: "service_id",
      bodyField: "prior_notice_service_id",
    },
  ],
  entityKey: "booking_rule",
  responseKey: "booking_rule",
});

// ── locations.geojson (one row per Feature) ─────────────────────────────────
//
// We extend the validateLocationsGeojsonFields kernel with a small wrapper
// that also rejects malformed JSON in `coordinates` and `extra_properties`
// (the columns are TEXT in SQLite, but downstream consumers — exporter,
// readers — assume parseable JSON). Without this guard, a user could store
// arbitrary text and break every consumer until the next upload.

const validateLocationGeojsonPatch = (body) => {
  const errors = validateLocationsGeojsonFields(body);
  if ("coordinates" in body && body.coordinates !== null && body.coordinates !== "") {
    if (typeof body.coordinates !== "string") {
      errors.push("coordinates must be a JSON string");
    } else {
      try {
        const parsed = JSON.parse(body.coordinates);
        if (!Array.isArray(parsed)) {
          errors.push("coordinates must encode a JSON array");
        }
      } catch (_) {
        errors.push("coordinates must be valid JSON");
      }
    }
  }
  if (
    "extra_properties" in body &&
    body.extra_properties !== null &&
    body.extra_properties !== ""
  ) {
    if (typeof body.extra_properties !== "string") {
      errors.push("extra_properties must be a JSON string");
    } else {
      try {
        JSON.parse(body.extra_properties);
      } catch (_) {
        errors.push("extra_properties must be valid JSON");
      }
    }
  }
  return errors;
};

const locationsGeojsonCrud = makeTextPkCrud({
  table: "locations_geojson",
  pk: "feature_id",
  fields: [
    "geometry_type",
    "coordinates",
    "stop_name",
    "stop_desc",
    "extra_properties",
  ],
  requiredFields: ["geometry_type", "coordinates"],
  validator: validateLocationGeojsonPatch,
  entityKey: "location_geojson",
  responseKey: "location_geojson",
});

// ── location_groups (TEXT PK, optional name) — schema v13 ──────────────────

const locationGroupsCrud = makeTextPkCrud({
  table: "location_groups",
  pk: "location_group_id",
  fields: ["location_group_name"],
  validator: validateLocationGroupFields,
  entityKey: "location_group",
  responseKey: "location_group",
  cascade: [{ table: "location_group_stops", whereCol: "location_group_id" }],
  cascadeCacheKeys: ["location_group_stop"],
});

// ── location_group_stops (composite PK location_group_id+stop_id) ─────────
//
// Pure many-to-many junction table: PK *is* the data, so PATCH would always
// mutate the PK (forbidden). We expose only LIST/POST/DELETE; users who
// want to "move" a stop between groups DELETE the old row and POST the new.

const listLocationGroupStops = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;
    const rows = ctx.db
      .prepare(
        "SELECT location_group_id, stop_id FROM location_group_stops " +
          "ORDER BY location_group_id, stop_id",
      )
      .all();
    res.json({ data: rows });
  } catch (err) {
    console.error("listLocationGroupStops error:", err);
    res.status(500).json({ error: err.message });
  }
};

const createLocationGroupStop = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    const errors = validateLocationGroupStopFields(body);
    if (errors.length) {
      return res
        .status(400)
        .json({ error: "Validation failed", details: errors });
    }

    if (!fkExists(db, "location_groups", "location_group_id", body.location_group_id)) {
      return res
        .status(400)
        .json({ error: `location_group_id not found: ${body.location_group_id}` });
    }
    if (!fkExists(db, "stops", "stop_id", body.stop_id)) {
      return res
        .status(400)
        .json({ error: `stop_id not found: ${body.stop_id}` });
    }

    const exists = db
      .prepare(
        "SELECT 1 FROM location_group_stops WHERE location_group_id = ? AND stop_id = ?",
      )
      .get(body.location_group_id, body.stop_id);
    if (exists) {
      return res.status(409).json({
        error: `(${body.location_group_id}, ${body.stop_id}) already exists in location_group_stops.`,
      });
    }

    const undoOps = [
      {
        sql:
          "DELETE FROM location_group_stops WHERE location_group_id = ? AND stop_id = ?",
        params: [body.location_group_id, body.stop_id],
      },
    ];
    const redoOps = [
      {
        sql:
          "INSERT INTO location_group_stops (location_group_id, stop_id) VALUES (?, ?)",
        params: [body.location_group_id, body.stop_id],
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "location_group_stop",
        entityId: `${body.location_group_id}:${body.stop_id}`,
        action: "create",
        description: `Mapped stop ${body.stop_id} to location_group ${body.location_group_id}`,
        undoOps,
        redoOps,
      });
      db.prepare(
        "INSERT INTO location_group_stops (location_group_id, stop_id) VALUES (?, ?)",
      ).run(body.location_group_id, body.stop_id);
    });
    tx.immediate();

    syncFaresFlexCache(sessionId, db, "location_group_stop");
    await respondWithValidation(
      res,
      sessionId,
      "location_group_stop",
      `${body.location_group_id}:${body.stop_id}`,
      {
        location_group_stop: {
          location_group_id: body.location_group_id,
          stop_id: body.stop_id,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    console.error("createLocationGroupStop error:", err);
    res.status(500).json({ error: err.message });
  }
};

const deleteLocationGroupStop = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { location_group_id, stop_id } = req.params;

    const row = db
      .prepare(
        "SELECT 1 FROM location_group_stops WHERE location_group_id = ? AND stop_id = ?",
      )
      .get(location_group_id, stop_id);
    if (!row) {
      return res.status(404).json({ error: "location_group_stop not found." });
    }

    const undoOps = [
      {
        sql:
          "INSERT INTO location_group_stops (location_group_id, stop_id) VALUES (?, ?)",
        params: [location_group_id, stop_id],
      },
    ];
    const redoOps = [
      {
        sql:
          "DELETE FROM location_group_stops WHERE location_group_id = ? AND stop_id = ?",
        params: [location_group_id, stop_id],
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "location_group_stop",
        entityId: `${location_group_id}:${stop_id}`,
        action: "delete",
        description: `Unmapped stop ${stop_id} from location_group ${location_group_id}`,
        undoOps,
        redoOps,
      });
      db.prepare(
        "DELETE FROM location_group_stops WHERE location_group_id = ? AND stop_id = ?",
      ).run(location_group_id, stop_id);
    });
    tx.immediate();

    syncFaresFlexCache(sessionId, db, "location_group_stop");
    await respondWithValidation(
      res,
      sessionId,
      "location_group_stop",
      `${location_group_id}:${stop_id}`,
      { deleted: { location_group_id, stop_id } },
    );
  } catch (err) {
    console.error("deleteLocationGroupStop error:", err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  // booking_rules
  listBookingRules: bookingRulesCrud.list,
  createBookingRule: bookingRulesCrud.create,
  updateBookingRule: bookingRulesCrud.update,
  deleteBookingRule: bookingRulesCrud.delete,
  // locations.geojson
  listLocationsGeojson: locationsGeojsonCrud.list,
  createLocationGeojson: locationsGeojsonCrud.create,
  updateLocationGeojson: locationsGeojsonCrud.update,
  deleteLocationGeojson: locationsGeojsonCrud.delete,
  // location_groups (schema v13)
  listLocationGroups: locationGroupsCrud.list,
  createLocationGroup: locationGroupsCrud.create,
  updateLocationGroup: locationGroupsCrud.update,
  deleteLocationGroup: locationGroupsCrud.delete,
  // location_group_stops (composite PK, junction)
  listLocationGroupStops,
  createLocationGroupStop,
  deleteLocationGroupStop,
};
