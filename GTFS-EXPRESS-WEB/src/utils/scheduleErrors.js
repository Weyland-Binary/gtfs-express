/**
 * scheduleErrors.js — maps a failed schedule fetch to what the user should
 * be told. The backend answers 404 both for "no service runs on this date"
 * (plain-text "No service for this date.") and for a dead session ("No feed
 * loaded for this session..." JSON); only the former may be presented as an
 * empty calendar. Every other failure (5xx, network drop) is a real error.
 */

export const classifyFetchError = (error) => {
  if (error && error.isRateLimit) return "rate-limit";
  if (
    error &&
    error.status === 404 &&
    /no service/i.test(error.message || "")
  ) {
    return "no-service";
  }
  return "error";
};
