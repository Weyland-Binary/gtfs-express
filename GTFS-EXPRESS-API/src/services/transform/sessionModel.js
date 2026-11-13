/**
 * The feed model of a session at its current data version, built once and shared by every reader of it (the stop
 * sheets, the offer): a few models kept, the oldest dropped first.
 */

"use strict";

const { getDataVersion } = require("../../middleware/readCache");
const { buildFeedModel } = require("./feedModel");

const MAX_MODELS = 4;
const _models = new Map();

const modelOf = (sessionId, db) => {
  const key = `${sessionId}|${getDataVersion(db)}`;
  if (_models.has(key)) {
    const model = _models.get(key);
    _models.delete(key);
    _models.set(key, model);
    return model;
  }
  const model = buildFeedModel(db);
  _models.set(key, model);
  while (_models.size > MAX_MODELS) _models.delete(_models.keys().next().value);
  return model;
};

module.exports = { modelOf, _internals: { _models, MAX_MODELS } };
