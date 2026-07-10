/**
 * chatAttachment.test.js — upload/delete utils for tabular chat attachments.
 *
 * Contract under test:
 *  - upload posts FormData under the `chatAttachment` field with the session
 *    header injected (via fetchWithSession) and returns the metadata JSON
 *  - non-OK responses become typed errors ({ code, status }) from the JSON
 *    envelope, matching the chatStream error-branching convention
 *  - delete URL-encodes the table name (rule #23) and hits the DELETE verb
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  uploadChatAttachment,
  deleteChatAttachment,
  ACCEPTED_EXTENSIONS,
  MAX_ATTACHMENT_BYTES,
} from "../utils/chatAttachment";

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: () => Promise.resolve(body),
});

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("uploadChatAttachment", () => {
  it("posts FormData with the chatAttachment field and returns metadata", async () => {
    const meta = { table: "_chat_att_1", rowCount: 2, columns: [] };
    fetch.mockResolvedValue(jsonResponse(meta));

    const file = new File(["a,b\n1,2\n"], "horaires.csv", { type: "text/csv" });
    const result = await uploadChatAttachment(file);

    expect(result).toEqual(meta);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toMatch(/\/sql\/nl2sql-chat\/attachment$/);
    expect(options.method).toBe("POST");
    expect(options.body).toBeInstanceOf(FormData);
    expect(options.body.get("chatAttachment")).toBe(file);
    expect(options.headers["X-Session-ID"]).toBeTruthy();
    // No manual Content-Type — the browser must set the multipart boundary.
    expect(options.headers["Content-Type"]).toBeUndefined();
  });

  it("surfaces the typed JSON envelope on non-OK responses", async () => {
    fetch.mockResolvedValue(
      jsonResponse(
        { error: "ATTACHMENT_TOO_LARGE", message: "File is too large" },
        { ok: false, status: 413 },
      ),
    );
    const file = new File(["x"], "big.csv");
    await expect(uploadChatAttachment(file)).rejects.toMatchObject({
      code: "ATTACHMENT_TOO_LARGE",
      status: 413,
    });
  });

  it("normalizes transport failures to NETWORK_ERROR", async () => {
    fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const file = new File(["x"], "a.csv");
    await expect(uploadChatAttachment(file)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });
});

describe("deleteChatAttachment", () => {
  it("DELETEs the encoded table path and resolves the envelope", async () => {
    fetch.mockResolvedValue(jsonResponse({ ok: true }));
    const result = await deleteChatAttachment("_chat_att_3");
    expect(result).toEqual({ ok: true });
    const [url, options] = fetch.mock.calls[0];
    expect(url).toMatch(/\/sql\/nl2sql-chat\/attachment\/_chat_att_3$/);
    expect(options.method).toBe("DELETE");
  });

  it("rejects with the typed envelope on failure", async () => {
    fetch.mockResolvedValue(
      jsonResponse(
        { error: "INVALID_INPUT", message: "Invalid attachment table name." },
        { ok: false, status: 400 },
      ),
    );
    await expect(deleteChatAttachment("_chat_att_9")).rejects.toMatchObject({
      code: "INVALID_INPUT",
      status: 400,
    });
  });
});

describe("client-side constants", () => {
  it("accepted extensions and size cap mirror the server defaults", () => {
    expect(ACCEPTED_EXTENSIONS.split(",")).toEqual([
      ".csv",
      ".tsv",
      ".txt",
      ".xlsx",
    ]);
    expect(MAX_ATTACHMENT_BYTES).toBe(5 * 1024 * 1024);
  });
});
