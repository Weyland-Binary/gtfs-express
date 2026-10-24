/**
 * The one way the web calls the API and reads its answer. Every failure throws an Error carrying `code`, `status`,
 * `body` and `retryAfterSec`, the shape humanError and refusalToAction read.
 */

import API_BASE_URL from "../config";
import { fetchWithSession } from "./sessionManager";

export const jsonHeaders = () => ({ "Content-Type": "application/json" });

export const apiUrl = (path) => `${API_BASE_URL}${path}`;

/** A refused answer's body (`{ error, message, …details }`) as the coded Error. */
export const apiError = (status, body = {}, headers = null) => {
  const data = body && typeof body === "object" ? body : {};
  const err = new Error(data.message || (typeof data.error === "string" ? data.error : "") || `HTTP ${status}`);
  err.code = typeof data.error === "string" && data.error ? data.error : `HTTP_${status}`;
  err.status = status;
  err.body = data;
  const retry = Number(data.retryAfterSec ?? headers?.get?.("retry-after"));
  if (Number.isFinite(retry) && retry > 0) err.retryAfterSec = retry;
  return err;
};

export const httpError = (res, data = {}) => apiError(res.status, data, res.headers);

/** A request that never reached the server (offline, aborted) as a coded Error. */
export const transportError = (err) => {
  const e = new Error(err?.name === "AbortError" ? "aborted" : err?.message || "Network error");
  e.code = err?.name === "AbortError" ? "ABORTED" : "NETWORK_ERROR";
  return e;
};

/** fetchWithSession, a transport failure coded; the Response is returned whatever its status. */
export const request = async (url, options = {}) => {
  try {
    return await fetchWithSession(url, options);
  } catch (err) {
    // fetchWithSession's own refusals (429) already carry their status and code.
    if (err?.status) throw err;
    throw transportError(err);
  }
};

/** The Response itself when it is ok, else its body thrown as the coded Error (for blobs and streams). */
export const ensureOk = async (res) => {
  if (res.ok) return res;
  throw httpError(res, await res.json().catch(() => ({})));
};

/** The JSON body of an ok Response (`empty` for a 204), else the coded Error. */
export const readJson = async (res, { empty = {} } = {}) => {
  if (res.ok && res.status === 204) return empty;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  return data;
};

export const requestJson = async (url, options = {}, readOptions = {}) => readJson(await request(url, options), readOptions);

export const post = (path, body, { signal, headers = null, withSession } = {}) =>
  requestJson(apiUrl(path), { method: "POST", headers: { ...jsonHeaders(), ...(headers || {}) }, body: JSON.stringify(body), ...(signal ? { signal } : {}), ...(withSession === false ? { withSession: false } : {}) });
