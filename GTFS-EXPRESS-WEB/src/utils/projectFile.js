/**
 * projectFile.js — Client helpers for the on-disk persistence of projects.
 *
 * Two formats are involved:
 *   • .gtfsproj — self-contained binary SQLite (work save/resume)
 *   • .zip GTFS — final spec-compliant export (for production)
 *
 * This module handles ONLY the `.gtfsproj`. The GTFS ZIP export is handled by
 * `EditModeContext.exportGTFS`.
 */

import API_BASE_URL from "../config";
import { fetchWithSession } from "./sessionManager";

export const PROJECT_EXT = ".gtfsproj";

/**
 * Downloads the current project as a `.gtfsproj` file.
 * The server produces a VACUUM INTO on the fly → compacted file.
 *
 * @param {object} [opts]
 * @param {string} [opts.suggestedName] — forced for the `download` attribute.
 * @returns {Promise<{ok: true, filename: string} | {ok: false, error: string}>}
 */
export const saveProjectToFile = async (opts = {}) => {
  try {
    const res = await fetchWithSession(
      `${API_BASE_URL}/edit/project/export`,
      { method: "GET" },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return {
        ok: false,
        error: body.error || `HTTP ${res.status}`,
      };
    }
    // Suggested name: priority to Content-Disposition header, otherwise fallback.
    let filename = opts.suggestedName || null;
    if (!filename) {
      const cd = res.headers.get("Content-Disposition") || "";
      const match = cd.match(/filename="([^"]+)"/);
      if (match) filename = match[1];
    }
    if (!filename) {
      const stamp = new Date().toISOString().slice(0, 10);
      filename = `gtfs-project-${stamp}${PROJECT_EXT}`;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Short delay before revokeObjectURL for some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok: true, filename };
  } catch (err) {
    return { ok: false, error: err.message || "Network error" };
  }
};

/**
 * Uploads a `.gtfsproj` file to the backend. The server validates,
 * performs an atomic swap, and returns counts + meta.
 *
 * @param {File} file — user file (input[type=file] or drag&drop)
 * @param {(progress: number) => void} [onProgress]
 * @param {string|null} [betaCode] — beta tester code (sent in `X-Beta-Code`).
 *        The `/edit/project/import` route is beta-gated: without a valid code,
 *        the backend responds 403 + body.error ∈ { BETA_CODE_REQUIRED, INVALID_BETA_CODE,
 *        BETA_REVOKED, BETA_CONFIG_ERROR }.
 * @returns {Promise<{ok: true, meta: object, counts: object, betaTester?: object} | {ok: false, error: string, errorCode?: string}>}
 */
export const openProjectFromFile = async (file, onProgress, betaCode = null) => {
  if (!file) return { ok: false, error: "No file selected." };
  const lowerName = (file.name || "").toLowerCase();
  if (!lowerName.endsWith(PROJECT_EXT)) {
    return {
      ok: false,
      error: `File must have a ${PROJECT_EXT} extension (got "${file.name}").`,
    };
  }

  // We use XMLHttpRequest for progress tracking (fetch does not expose
  // upload progress in mainstream browsers).
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE_URL}/edit/project/import`);
    // The sessionId must be injected manually (not via fetchWithSession).
    const sessionId = sessionStorage.getItem("gtfs_session_id");
    if (sessionId) xhr.setRequestHeader("X-Session-ID", sessionId);
    if (betaCode) xhr.setRequestHeader("X-Beta-Code", betaCode);

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) {
        onProgress(Math.round((ev.loaded / ev.total) * 100));
      }
    };
    xhr.onload = () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON body */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ ok: true, ...(body || {}) });
      } else {
        resolve({
          ok: false,
          error: (body && (body.message || body.error)) || `HTTP ${xhr.status}`,
          // body.error is the typed code (e.g. INVALID_BETA_CODE) on the beta gate side;
          // we surface it as-is so the UI can display the correct modal.
          errorCode: (body && body.error) || null,
        });
      }
    };
    xhr.onerror = () =>
      resolve({ ok: false, error: "Network error during upload" });
    xhr.onabort = () => resolve({ ok: false, error: "Upload aborted" });

    const form = new FormData();
    form.append("projectFile", file);
    xhr.send(form);
  });
};

/**
 * Current project metadata (or `null` if outside edit mode).
 */
export const fetchProjectMeta = async () => {
  try {
    const res = await fetchWithSession(`${API_BASE_URL}/edit/project/meta`);
    if (!res.ok) return null;
    const body = await res.json();
    return body || null;
  } catch {
    return null;
  }
};
