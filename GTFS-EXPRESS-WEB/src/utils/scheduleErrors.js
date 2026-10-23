/**
 * The API answers 404 both for "No service for this date." and for a dead session ("No feed loaded…");
 * only the former may be shown as an empty calendar.
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
