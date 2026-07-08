import { describe, expect, it } from "vitest";
import { classifyFetchError } from "../utils/scheduleErrors";

// Regression: every non-rate-limit failure used to render as "No service
// for this date.", so HTTP 500s, network drops and dead sessions looked
// like a calendar gap in the feed. Only the backend's explicit no-service
// 404 may say "no service".
describe("classifyFetchError", () => {
  it("flags rate-limit errors first, whatever their status", () => {
    const error = new Error("Too many requests");
    error.isRateLimit = true;
    error.status = 429;
    expect(classifyFetchError(error)).toBe("rate-limit");
  });

  it("maps the backend's no-service 404 to no-service", () => {
    const error = new Error("No service for this date.");
    error.status = 404;
    expect(classifyFetchError(error)).toBe("no-service");
  });

  it("maps a dead-session 404 to a generic error, not no-service", () => {
    const error = new Error(
      '{"error":"No feed loaded for this session. Upload a GTFS file first."}',
    );
    error.status = 404;
    expect(classifyFetchError(error)).toBe("error");
  });

  it("maps a bodyless 404 to a generic error", () => {
    const error = new Error("");
    error.status = 404;
    expect(classifyFetchError(error)).toBe("error");
  });

  it("maps an HTTP 500 to a generic error, not no-service", () => {
    const error = new Error("Error fetching schedules.");
    error.status = 500;
    expect(classifyFetchError(error)).toBe("error");
  });

  it("maps a network failure without status to a generic error", () => {
    expect(classifyFetchError(new TypeError("Failed to fetch"))).toBe("error");
  });

  it("tolerates a missing error object", () => {
    expect(classifyFetchError(undefined)).toBe("error");
  });
});
