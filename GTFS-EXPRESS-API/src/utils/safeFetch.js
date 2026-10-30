/**
 * safeFetch — download a user- or model-supplied URL without letting it
 * reach the server's own network (SSRF).
 *
 *   safeFetch(url, { timeoutMs, maxBytes, headers, maxRedirects })
 *     → { ok, status, url, headers: { get(name) }, arrayBuffer() }; `onBytes(received, total)` while the body streams
 *     (total null without a Content-Length)
 *
 * - http(s) only, no credentials in the URL, default ports or 1024+ only;
 * - the address is checked AT CONNECTION TIME through the socket's DNS
 *   lookup, so a name that resolves to a private, loopback, link-local,
 *   metadata or otherwise non-public address is refused — including when it
 *   changes between two resolutions (DNS rebinding);
 * - redirects are followed by hand (at most `maxRedirects`), each hop
 *   re-checked;
 * - the body is capped at `maxBytes` while it streams.
 *
 * `assertPublicUrl(url)` runs the synchronous part (scheme, credentials,
 * port, literal addresses, local names) and is used even when a test
 * injects its own fetch.
 */

"use strict";

const http = require("http");
const https = require("https");
const dns = require("dns");
const net = require("net");

const USER_AGENT = "gtfs-express/1.0 (+https://gtfsexpress.com)";

const blocked = (message) => Object.assign(new Error(message), { status: 400, code: "URL_NOT_ALLOWED" });

// IPv4 ranges that are not the public internet (RFC 6890 and friends).
const V4_BLOCKS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
const v4ToInt = (ip) => ip.split(".").reduce((n, o) => (n << 8) + (parseInt(o, 10) & 255), 0) >>> 0;
const inV4Block = (ip) => {
  const n = v4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
};

/** An IPv6 literal's eight 16-bit groups (a dotted IPv4 tail read as the last two), else null. */
const v6Groups = (a) => {
  let s = a;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const o = dotted[1].split(".").map(Number);
    if (o.some((x) => x > 255)) return null;
    s = `${s.slice(0, -dotted[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...rest].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => Number.isFinite(g)) ? groups : null;
};

/** The IPv4 address two groups hold, dotted. */
const v4Of = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");

/** The IPv4 address a well-known-prefix NAT64 address (64:ff9b::/96) embeds, else null. */
const nat64Embedded = (a) => {
  const g = v6Groups(a);
  if (!g || g[0] !== 0x64 || g[1] !== 0xff9b || g.slice(2, 6).some((x) => x !== 0)) return null;
  return v4Of(g[6], g[7]);
};

/** True when an IP literal is not a public unicast address. */
const isPrivateAddress = (ip) => {
  const addr = String(ip || "").replace(/^\[|\]$/g, "");
  if (net.isIPv4(addr)) return inV4Block(addr);
  if (net.isIPv6(addr)) {
    const a = addr.toLowerCase();
    if (a === "::" || a === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return inV4Block(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(a)) return true; // mapped, hex form
    if (/^f[cd]/.test(a)) return true; // unique local fc00::/7
    if (/^fe[89ab]/.test(a)) return true; // link-local fe80::/10
    if (/^ff/.test(a)) return true; // multicast
    // NAT64, well-known prefix 64:ff9b::/96 (IPv6-only networks with DNS64
    // answer it for every IPv4 host): judged by the IPv4 address it embeds.
    const nat64 = nat64Embedded(a);
    if (nat64) return inV4Block(nat64);
    if (/^64:ff9b:/.test(a)) return true; // other NAT64 prefixes (local-use 64:ff9b:1::/48…)
    if (/^2001:db8:/.test(a)) return true; // documentation
    const g = v6Groups(a);
    if (!g) return true;
    // IPv4-compatible (::a.b.c.d, deprecated) and SIIT (::ffff:0:a.b.c.d): an IPv4 address in IPv6 clothing that a
    // stack may route to the IPv4 host — 127.0.0.1 or the metadata service as well as any other.
    if (g.slice(0, 6).every((x) => x === 0)) return true;
    if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return true;
    // 6to4 (2002::/16): the IPv4 address of its relay is groups 1–2, judged as that address.
    if (g[0] === 0x2002) return inV4Block(v4Of(g[1], g[2]));
    // Teredo (2001::/32): the client's IPv4 address is hidden (inverted) in it; no feed is served from a tunnel.
    if (g[0] === 0x2001 && g[1] === 0) return true;
    // Discard-only 100::/64.
    if (g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)) return true;
    return false;
  }
  return true; // not an IP: callers pass addresses only
};

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|localdomain|home|lan|intranet|corp)$/i;

/** Scheme, credentials, port, literal address and local names. Throws URL_NOT_ALLOWED. */
const assertPublicUrl = (raw) => {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw blocked("Invalid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw blocked("Only http(s) URLs can be downloaded.");
  if (u.username || u.password) throw blocked("URLs with credentials are not accepted.");
  if (u.port && !["80", "443"].includes(u.port) && parseInt(u.port, 10) < 1024) throw blocked("This port is not allowed.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw blocked("The URL has no host.");
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw blocked("This address is not on the public internet.");
  } else if (LOCAL_NAMES.test(host) || !host.includes(".")) {
    throw blocked("This host is not on the public internet.");
  }
  return u;
};

// DNS lookup that refuses non-public answers: used by the socket itself.
const guardedLookup = (hostname, options, callback) => {
  const opts = typeof options === "object" && options ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || !list.length) return callback(blocked("This host resolves to an address that is not on the public internet."));
    if (opts.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
};

const requestOnce = (u, { timeoutMs, maxBytes, headers, signal, onBytes = null }) =>
  new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(u, { method: "GET", headers: { "User-Agent": USER_AGENT, ...headers }, lookup: guardedLookup, timeout: timeoutMs }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: res.headers.location, status });
      }
      const chunks = [];
      let size = 0;
      const expected = Number(res.headers["content-length"]) || null;
      res.on("data", (c) => {
        size += c.length;
        if (onBytes) onBytes(size, expected);
        if (size > maxBytes) {
          req.destroy(Object.assign(new Error(`The download exceeds ${Math.round(maxBytes / 1e6)} MB.`), { status: 413, code: "FEED_TOO_LARGE" }));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({
          ok: status >= 200 && status < 300,
          status,
          url: u.toString(),
          headers: { get: (name) => (res.headers[String(name).toLowerCase()] ?? null) },
          arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
          buffer: body,
        });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("The download timed out."), { status: 504, code: "FEED_TIMEOUT" })));
    req.on("error", (err) => reject(err.code === "URL_NOT_ALLOWED" || err.status ? err : Object.assign(err, { status: 502, code: err.code || "FEED_UNAVAILABLE" })));
    if (signal) {
      if (signal.aborted) req.destroy(Object.assign(new Error("Aborted."), { code: "ABORTED" }));
      else signal.addEventListener("abort", () => req.destroy(Object.assign(new Error("Aborted."), { code: "ABORTED" })), { once: true });
    }
    req.end();
  });

/** Fetch-like download of a public URL (see the header). */
const safeFetch = async (url, { timeoutMs = 20000, maxBytes = 80 * 1024 * 1024, headers = {}, maxRedirects = 5, signal = null, httpsOnly = false, deadlineMs = null, onBytes = null } = {}) => {
  const secure = (u) => {
    if (httpsOnly && u.protocol !== "https:") throw blocked("Only https URLs are allowed here (a redirect to http is refused).");
    return u;
  };
  let u = secure(assertPublicUrl(url));
  // timeoutMs is an idle timeout; deadlineMs bounds the whole download.
  let sig = signal;
  let timer = null;
  if (deadlineMs) {
    const ctl = new AbortController();
    timer = setTimeout(() => ctl.abort(), deadlineMs);
    if (signal) signal.addEventListener("abort", () => ctl.abort(), { once: true });
    sig = ctl.signal;
  }
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const res = await requestOnce(u, { timeoutMs, maxBytes, headers, signal: sig, onBytes });
      if (!res.redirect) return res;
      u = secure(assertPublicUrl(new URL(res.redirect, u).toString()));
    }
    throw Object.assign(new Error("Too many redirects."), { status: 502, code: "FEED_UNAVAILABLE" });
  } catch (err) {
    if (err.code === "ABORTED" && timer && !(signal && signal.aborted)) throw Object.assign(new Error("The download took too long."), { status: 504, code: "FEED_TIMEOUT" });
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

module.exports = { safeFetch, assertPublicUrl, isPrivateAddress, _internals: { guardedLookup } };
