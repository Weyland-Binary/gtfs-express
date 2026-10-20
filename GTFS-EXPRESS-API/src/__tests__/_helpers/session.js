/**
 * Session helpers for the HTTP suites: the bundled sample feed loaded into a fresh session, edit mode entered, and
 * a zip response read back into { file: text }.
 */

"use strict";

const request = require("supertest");
const unzipper = require("unzipper");

const app = require("../../app");

/** A fresh session on the bundled sample feed, in edit mode. → sessionId */
const sampleSession = async () => {
  const loaded = await request(app).get("/gtfs/load-sample");
  if (loaded.status !== 200 || !loaded.body.sessionId) throw new Error(`load-sample answered ${loaded.status}`);
  const sessionId = loaded.body.sessionId;
  const entered = await request(app).post("/gtfs/edit/enter").set("X-Session-ID", sessionId);
  if (entered.status !== 200) throw new Error(`edit/enter answered ${entered.status}`);
  return sessionId;
};

/** supertest parser that keeps the body as a Buffer (a zip). */
const binary = (res, done) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => done(null, Buffer.concat(chunks)));
};

/** The entries of a zip Buffer as { name: utf8 text }. */
const unzip = async (buffer) => {
  const dir = await unzipper.Open.buffer(buffer);
  const out = {};
  for (const entry of dir.files) out[entry.path] = (await entry.buffer()).toString("utf8");
  return out;
};

module.exports = { app, request, sampleSession, binary, unzip };
