/**
 * chatAttachmentController — HTTP surface for tabular chat attachments.
 *
 *   POST   /gtfs/sql/nl2sql-chat/attachment          (multipart, field `chatAttachment`)
 *   DELETE /gtfs/sql/nl2sql-chat/attachment/:table
 *
 * Upload is gated exactly like the chat itself (`chatAccessGate` on the
 * route: beta code path or anonymous free tier) plus a dedicated per-session
 * rate limiter in app.js — parsing is CPU work. No aiCostLimiter here: the
 * upload makes no AI call; the imported table only costs tokens when a chat
 * turn actually references it.
 *
 * Deletion is session-gated only (a user destroying their own uploaded data
 * must never burn chat quota) and stays available even when the chat
 * kill-switch is off, so leftover tables can always be removed.
 *
 * Errors: typed errors thrown by chatAttachmentService carry
 * { status, code, userFacing } and are returned as the same JSON envelope
 * shape as the chat endpoint ({ error: CODE, message }); anything unexpected
 * goes to the centralized error middleware via next(err) (rule #6).
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
  // Same kill-switch as the chat: an attachment is useless without it.
  if (!config.NL2SQL_CHAT_ENABLED) {
    return res.status(503).json({
      error: "NL2SQL_CHAT_DISABLED",
      message: "The chat assistant is currently disabled on the server.",
    });
  }

  const sessionCtx = requireSession(req, res);
  if (!sessionCtx) return; // requireSession already wrote 4xx JSON

  const file = req.files && req.files.chatAttachment;
  if (!file || Array.isArray(file)) {
    return res.status(400).json({
      error: "INVALID_INPUT",
      message: "Exactly one file is required in the `chatAttachment` field.",
    });
  }

  // Pin the session against TTL cleanup while the file is being ingested —
  // same idempotent release wiring as requireEditMode (_editCore).
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
    // dropAttachment re-validates the table name against the strict pattern
    // (defense in depth on top of route-param shape).
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
