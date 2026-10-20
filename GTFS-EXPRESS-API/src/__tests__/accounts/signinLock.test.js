/**
 * Sign-in codes (accounts/store): a stranger's wrong codes lock the stranger, not the person. The wrong codes of an
 * address are counted per client (its IP address) and for every client together: twenty from one client lock that
 * client for the day, the person signing in from elsewhere still gets and uses a code; a hundred from all clients
 * lock the address (the bound on guesses).
 */

"use strict";

const store = require("../../services/accounts/store");

const MINUTE = 60 * 1000;
let clock = Date.parse("2026-10-20T08:00:00Z");
// Each code in its own hour: the send limits (one a minute, six an hour) are not what these tests measure.
const nextCode = (email, client) => {
  clock += 61 * MINUTE;
  return store.issueLoginCode(email, clock, { client });
};
// `n` wrong codes from a client, on as many codes as it takes (five tries a code).
const wrongCodes = (email, client, n) => {
  for (let left = n; left > 0; ) {
    const issued = nextCode(email, client);
    if (!issued.ok) return issued;
    const wrong = issued.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < Math.min(left, store.LOGIN_CODE_MAX_ATTEMPTS || 5) && left > 0; i++, left--) store.verifyLoginCode(email, wrong, clock, { client });
  }
  return { ok: true };
};

test("twenty wrong codes from one client lock that client, not the person", () => {
  const email = "victim-1@example.org";
  expect(wrongCodes(email, "203.0.113.7", store.LOGIN_CODE_MAX_FAILURES_PER_DAY).ok).toBe(true);

  // The stranger: no new code, no check.
  expect(nextCode(email, "203.0.113.7")).toMatchObject({ ok: false, reason: "too_many" });

  // The person, from their own address: a code, and it signs in.
  const mine = nextCode(email, "198.51.100.4");
  expect(mine.ok).toBe(true);
  expect(store.verifyLoginCode(email, "999999" === mine.code ? "888888" : "999999", clock, { client: "203.0.113.7" })).toMatchObject({ ok: false, reason: "locked" });
  expect(store.verifyLoginCode(email, mine.code, clock, { client: "198.51.100.4" })).toEqual({ ok: true });
});

test("every client together, the address takes a bounded number of wrong codes a day", () => {
  const email = "victim-2@example.org";
  const perClient = store.LOGIN_CODE_MAX_FAILURES_PER_DAY;
  const clients = Math.ceil(store.LOGIN_CODE_MAX_FAILURES_PER_DAY_TOTAL / perClient);
  // Within one day: the clients' codes are issued minutes apart here, not hours.
  const day = clock;
  let at = day;
  for (let c = 0; c < clients; c++) {
    for (let left = perClient; left > 0; ) {
      at += 61 * MINUTE / 12;
      const issued = store.issueLoginCode(email, at, { client: `192.0.2.${c}` });
      if (!issued.ok) {
        // The send limits of the address (six an hour): wait for the next hour.
        at += 60 * MINUTE;
        continue;
      }
      for (let i = 0; i < 5 && left > 0; i++, left--) store.verifyLoginCode(email, issued.code === "000000" ? "111111" : "000000", at, { client: `192.0.2.${c}` });
    }
  }
  expect(at - day).toBeLessThan(24 * 60 * MINUTE);
  // A client that gave no wrong code is refused too: the address took its day's guesses.
  expect(store.issueLoginCode(email, at + 2 * MINUTE, { client: "192.0.2.250" })).toMatchObject({ ok: false, reason: "too_many" });
  // The next day, it signs in again.
  const tomorrow = day + 25 * 60 * MINUTE;
  const issued = store.issueLoginCode(email, tomorrow, { client: "192.0.2.250" });
  expect(issued.ok).toBe(true);
  expect(store.verifyLoginCode(email, issued.code, tomorrow, { client: "192.0.2.250" })).toEqual({ ok: true });
});
