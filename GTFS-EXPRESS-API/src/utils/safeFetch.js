/**
 * safeFetch — download a user- or model-supplied URL without letting it
 * reach the server's own network (SSRF).
 *
 *   safeFetch(url, { timeoutMs, maxBytes, headers, maxRedirects })
 *     → { ok, status, url, headers: { get(name) }, arrayBuffer() }
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
    if (/^64:ff9b:/.test(a)) return true; // NAT64 (may map to private v4)
    if (/^2001:db8:/.test(a)) return true; // documentation
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

const requestOnce = (u, { timeoutMs, maxBytes, headers, signal }) =>
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
      res.on("data", (c) => {
        size += c.length;
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
const safeFetch = async (url, { timeoutMs = 20000, maxBytes = 80 * 1024 * 1024, headers = {}, maxRedirects = 5, signal = null } = {}) => {
  let u = assertPublicUrl(url);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await requestOnce(u, { timeoutMs, maxBytes, headers, signal });
    if (!res.redirect) return res;
    u = assertPublicUrl(new URL(res.redirect, u).toString());
  }
  throw Object.assign(new Error("Too many redirects."), { status: 502, code: "FEED_UNAVAILABLE" });
};

module.exports = { safeFetch, assertPublicUrl, isPrivateAddress, _internals: { guardedLookup } };
