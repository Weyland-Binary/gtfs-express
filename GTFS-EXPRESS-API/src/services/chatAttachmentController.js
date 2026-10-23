/**
 * Tabular chat attachments. The upload is gated like the chat plus a per-session rate limit (parsing is CPU work);
 * it makes no AI call, so no cost limiter. Deletion needs only the session and works with the chat switched off, so
 * leftover tables can always be removed. Unexpected errors go to next(err) (#6).
 */

"use strict";

const config = require("../config");
const chatAttachmentService = require("./chatAttachmentService");
const { recordEvent, extractReqMeta } = require("./eventLogger");
const { requireSession } = require("./edit/_editCore");
const { beginSessionMutation } = require("./sessionManager");

const sendTypedError = (res, err) => {
  res.status(err.status).json({
    error: err.code || "ATTACHMENT_ERROR",
    message: err.message,
  });
};

const uploadChatAttachment = async (req, res, next) => {
  // An attachment is useless without the chat.
  if (!config.NL2SQL_CHAT_ENABLED) {
    return res.status(503).json({
      error: "NL2SQL_CHAT_DISABLED",
      message: "The chat assistant is currently disabled on the server.",
    });
  }

  const sessionCtx = requireSession(req, res);
  if (!sessionCtx) return;

  const file = req.files && req.files.chatAttachment;
  if (!file || Array.isArray(file)) {
    return res.status(400).json({
      error: "INVALID_INPUT",
      message: "Exactly one file is required in the `chatAttachment` field.",
    });
  }

  // The session is pinned against TTL cleanup while the file is ingested.
  const releaseLock = beginSessionMutation(sessionCtx.sessionId);
  res.once("finish", releaseLock);
  res.once("close", releaseLock);

  try {
    const meta = await chatAttachmentService.ingestAttachment(
      { db: sessionCtx.db, sessionId: sessionCtx.sessionId },
      file,
    );
    recordEvent("chat.attachment", {
      ...extractReqMeta(req),
      format: meta.sheetName ? "xlsx" : "csv",
      rows: meta.rowCount,
      cols: meta.columns.length,
      truncated: meta.truncated,
    });
    res.json(meta);
  } catch (err) {
    if (err.userFacing && err.status) return sendTypedError(res, err);
    next(err);
  }
};

const deleteChatAttachment = (req, res, next) => {
  const sessionCtx = requireSession(req, res);
  if (!sessionCtx) return;

  try {
    // dropAttachment re-validates the table name against its strict pattern.
    chatAttachmentService.dropAttachment(
      { db: sessionCtx.db, sessionId: sessionCtx.sessionId },
      String(req.params.table || ""),
    );
    recordEvent("chat.attachment_removed", extractReqMeta(req));
    res.json({ ok: true });
  } catch (err) {
    if (err.userFacing && err.status) return sendTypedError(res, err);
    next(err);
  }
};

module.exports = {
  uploadChatAttachment,
  deleteChatAttachment,
};
