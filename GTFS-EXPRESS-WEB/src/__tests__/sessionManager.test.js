import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSessionId,
  resetSession,
  setSessionId,
  clearSession,
  addSessionHeader,
  fetchWithSession,
} from "../utils/sessionManager";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session id lifecycle", () => {
  it("generates a strict UUID v4 and persists it", () => {
    const id = getSessionId();
    expect(id).toMatch(UUID_V4_RE);
    // Stable across calls within the same tab session.
    expect(getSessionId()).toBe(id);
  });

  it("resetSession rotates to a fresh UUID", () => {
    const first = getSessionId();
    const second = resetSession();
    expect(second).toMatch(UUID_V4_RE);
    expect(second).not.toBe(first);
    expect(getSessionId()).toBe(second);
  });

  it("setSessionId adopts a server-issued id (sample feed flow)", () => {
    setSessionId("11111111-2222-4333-8444-555555555555");
    expect(getSessionId()).toBe("11111111-2222-4333-8444-555555555555");
  });

  it("clearSession forgets the id so the next call mints a new one", () => {
    const first = getSessionId();
    clearSession();
    expect(getSessionId()).not.toBe(first);
  });
});

describe("addSessionHeader", () => {
  it("injects X-Session-ID while preserving caller headers and options", () => {
    setSessionId("11111111-2222-4333-8444-555555555555");
    const out = addSessionHeader({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(out.method).toBe("POST");
    expect(out.headers["Content-Type"]).toBe("application/json");
    expect(out.headers["X-Session-ID"]).toBe(
      "11111111-2222-4333-8444-555555555555",
    );
  });

  it("keeps a caller-provided X-Session-ID untouched (second-session uploads)", () => {
    setSessionId("11111111-2222-4333-8444-555555555555");
    const out = addSessionHeader({
      headers: { "X-Session-ID": "99999999-8888-4777-a666-555555555555" },
    });
    expect(out.headers["X-Session-ID"]).toBe(
      "99999999-8888-4777-a666-555555555555",
    );
  });
});

describe("fetchWithSession", () => {
  it("returns the raw Response on success (streaming stays possible)", async () => {
    const response = new Response("ok", { status: 200 });
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    const out = await fetchWithSession("/gtfs/agencies");
    expect(out).toBe(response);

    const [, options] = spy.mock.calls[0];
    expect(options.headers["X-Session-ID"]).toMatch(UUID_V4_RE);
  });

  it("turns HTTP 429 into a typed rate-limit error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "Slow down" }), { status: 429 }),
    );

    const err = await fetchWithSession("/gtfs/sql").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.isRateLimit).toBe(true);
    expect(err.status).toBe(429);
    expect(err.message).toBe("Slow down");
  });

  it("falls back to a generic message when the 429 body is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("plain text", { status: 429 }),
    );

    const err = await fetchWithSession("/gtfs/sql").catch((e) => e);
    expect(err.isRateLimit).toBe(true);
    expect(err.message).toBe("Too many requests");
  });

  it("re-throws network errors untouched", async () => {
    const boom = new TypeError("Failed to fetch");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(boom);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(fetchWithSession("/gtfs/agencies")).rejects.toBe(boom);
  });
});
