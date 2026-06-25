/**
 * sessionMutex.test.js — race protection between cleanupOldSessions
 * and in-flight mutations.
 *
 * The session manager exposes a counter-based mutex (Set of timestamped
 * tokens per sessionId) that lets cleanupOldSessions skip folders whose
 * gtfs.db is currently being written to. Without this guard, fsp.rm
 * could delete a folder mid-WAL-checkpoint and corrupt or lose the
 * user's edit session. Tokens older than STALE_OP_MS are auto-dropped
 * to recover from a handler that crashed before releasing.
 */

"use strict";

const {
  beginSessionMutation,
  isSessionMutationActive,
} = require("../services/sessionManager");

const VALID_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const VALID_SESSION_ID_2 = "22222222-2222-4222-8222-222222222222";

describe("sessionManager mutex", () => {
  test("begin returns a release function and isActive reflects state", () => {
    expect(isSessionMutationActive(VALID_SESSION_ID)).toBe(false);
    const release = beginSessionMutation(VALID_SESSION_ID);
    expect(typeof release).toBe("function");
    expect(isSessionMutationActive(VALID_SESSION_ID)).toBe(true);
    release();
    expect(isSessionMutationActive(VALID_SESSION_ID)).toBe(false);
  });

  test("invalid sessionId returns a no-op release", () => {
    const release = beginSessionMutation("not-a-uuid");
    expect(typeof release).toBe("function");
    expect(isSessionMutationActive("not-a-uuid")).toBe(false);
    release(); // no-op, must not throw
  });

  test("multiple concurrent mutations are tracked independently", () => {
    const r1 = beginSessionMutation(VALID_SESSION_ID);
    const r2 = beginSessionMutation(VALID_SESSION_ID);
    const r3 = beginSessionMutation(VALID_SESSION_ID);
    expect(isSessionMutationActive(VALID_SESSION_ID)).toBe(true);

    r1();
    expect(isSessionMutationActive(VALID_SESSION_ID)).toBe(true); // r2, r3 still alive
    r2();
    expect(isSessionMutationActive(VALID_SESSION_ID)).toBe(true); // r3 still alive
    r3();
    expect(isSessionMutationActive(VALID_SESSION_ID)).toBe(false);
  });

  test("release is idempotent (safe to wire to both 'finish' and 'close')", () => {
    const release = beginSessionMutation(VALID_SESSION_ID);
    expect(isSessionMutationActive(VALID_SESSION_ID)).toBe(true);
    release();
    release();
    release();
    expect(isSessionMutationActive(VALID_SESSION_ID)).toBe(false);
  });

  test("locks for distinct sessionIds do not interfere", () => {
    const r1 = beginSessionMutation(VALID_SESSION_ID);
    const r2 = beginSessionMutation(VALID_SESSION_ID_2);
    expect(isSessionMutationActive(VALID_SESSION_ID)).toBe(true);
    expect(isSessionMutationActive(VALID_SESSION_ID_2)).toBe(true);
    r1();
    expect(isSessionMutationActive(VALID_SESSION_ID)).toBe(false);
    expect(isSessionMutationActive(VALID_SESSION_ID_2)).toBe(true);
    r2();
    expect(isSessionMutationActive(VALID_SESSION_ID_2)).toBe(false);
  });

  test("stale tokens (>STALE_OP_MS old) are dropped on isActive check", () => {
    jest.useFakeTimers();
    try {
      const r1 = beginSessionMutation(VALID_SESSION_ID);
      expect(isSessionMutationActive(VALID_SESSION_ID)).toBe(true);

      // Fast-forward past 60s threshold without releasing.
      jest.advanceTimersByTime(61_000);

      // Stale token must be auto-dropped on the next check, otherwise a
      // handler that crashed without releasing would block cleanup forever.
      expect(isSessionMutationActive(VALID_SESSION_ID)).toBe(false);

      // The original release must remain a no-op (set already cleared).
      r1();
      expect(isSessionMutationActive(VALID_SESSION_ID)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a fresh token taken after a stale one keeps the session active", () => {
    jest.useFakeTimers();
    try {
      const stale = beginSessionMutation(VALID_SESSION_ID);
      jest.advanceTimersByTime(61_000);
      const fresh = beginSessionMutation(VALID_SESSION_ID);
      // The stale entry should be evicted by the next isActive call, but
      // the fresh one keeps the session pinned.
      expect(isSessionMutationActive(VALID_SESSION_ID)).toBe(true);
      stale(); // safe no-op
      expect(isSessionMutationActive(VALID_SESSION_ID)).toBe(true);
      fresh();
      expect(isSessionMutationActive(VALID_SESSION_ID)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});
