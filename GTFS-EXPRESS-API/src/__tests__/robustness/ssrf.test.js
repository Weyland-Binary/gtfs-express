/**
 * utils/safeFetch.isPrivateAddress — the addresses a download (a feed URL, an open-data catalogue) must never reach,
 * the IPv6 forms that embed an IPv4 address included.
 */

"use strict";

const { isPrivateAddress } = require("../../utils/safeFetch");

test.each([
  ["127.0.0.1"],
  ["10.0.0.5"],
  ["169.254.169.254"],
  ["::1"],
  ["::ffff:127.0.0.1"],
  ["::127.0.0.1"], // IPv4-compatible
  ["::a9fe:a9fe"], // IPv4-compatible, hex (169.254.169.254)
  ["::ffff:0:127.0.0.1"], // SIIT
  ["2002:7f00:1::"], // 6to4 of 127.0.0.1
  ["2002:a9fe:a9fe::1"], // 6to4 of 169.254.169.254
  ["2001:0:4136:e378:8000:63bf:3fff:fdd2"], // Teredo
  ["64:ff9b::7f00:1"], // NAT64 of 127.0.0.1
  ["fd00::1"],
  ["fe80::1"],
  ["100::1"],
])("%s is not public", (ip) => {
  expect(isPrivateAddress(ip)).toBe(true);
});

test.each([["93.184.216.34"], ["2606:4700:4700::1111"], ["2002:5db8:d822::1"], ["64:ff9b::5db8:d822"]])("%s is public", (ip) => {
  expect(isPrivateAddress(ip)).toBe(false);
});
