/**
 * What translations.txt may translate: every field of type Text, URL, Email or Phone number of a GTFS file. The
 * server's own list (services/tableReads TRANSLATABLE_FIELDS), which translatableFields.test.js of the API holds
 * this copy to.
 */
export const TRANSLATABLE_FIELDS = {
  agency: ["agency_name", "agency_url", "agency_phone", "agency_fare_url", "agency_email"],
  stops: ["stop_code", "stop_name", "tts_stop_name", "stop_desc", "stop_url", "platform_code"],
  routes: ["route_short_name", "route_long_name", "route_desc", "route_url"],
  trips: ["trip_headsign", "trip_short_name"],
  stop_times: ["stop_headsign"],
  feed_info: ["feed_publisher_name", "feed_publisher_url", "feed_version", "feed_contact_email", "feed_contact_url"],
  pathways: ["signposted_as", "reversed_signposted_as"],
  levels: ["level_name"],
  attributions: ["organization_name", "attribution_url", "attribution_email", "attribution_phone"],
  areas: ["area_name"],
  networks: ["network_name"],
  fare_media: ["fare_media_name"],
  fare_products: ["fare_product_name"],
  rider_categories: ["rider_category_name", "eligibility_url"],
  location_groups: ["location_group_name"],
  booking_rules: ["message", "pickup_message", "drop_off_message", "phone_number", "info_url", "booking_url"],
};

export const TRANSLATABLE_TABLES = Object.keys(TRANSLATABLE_FIELDS);

/** The files whose rows several fields key: a translation names their text by its value, never by record_id. */
export const TRANSLATED_BY_VALUE = ["fare_products"];
