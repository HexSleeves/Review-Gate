const fs = require("node:fs");
const { getTempPath } = require("./utils");

const REVIEW_GATE_PROTOCOL = "review-gate-v3";

function getTriggerFilePath() {
  return getTempPath("review_gate_trigger.json");
}

function getProgressFilePath() {
  return getTempPath("review_gate_progress.json");
}

function getAckFilePath(triggerId) {
  return getTempPath(`review_gate_ack_${triggerId}.json`);
}

function getResponseFilePath(triggerId) {
  return getTempPath(`review_gate_response_${triggerId}.json`);
}

function getSpeechTriggerFilePath(triggerId) {
  return getTempPath(`review_gate_speech_trigger_${triggerId}.json`);
}

function getSpeechResponseFilePath(triggerId) {
  return getTempPath(`review_gate_speech_response_${triggerId}.json`);
}

function atomicWriteJson(filePath, payload) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function createTriggerTracker(maxAgeMs = 10 * 60 * 1000) {
  const handled = new Map();

  function purge(now) {
    for (const [triggerId, entry] of handled.entries()) {
      const handledAt = Number(entry?.handledAt);
      if (!Number.isFinite(handledAt) || now - handledAt > maxAgeMs) {
        handled.delete(triggerId);
      }
    }
  }

  return {
    markHandled(triggerId, replayTokenOrNow = null, nowOverride = null) {
      let replayToken = null;
      let now = Date.now();

      if (typeof replayTokenOrNow === "number" && nowOverride === null) {
        now = replayTokenOrNow;
      } else {
        replayToken =
          typeof replayTokenOrNow === "string" && replayTokenOrNow ? replayTokenOrNow : null;
        if (typeof nowOverride === "number") {
          now = nowOverride;
        }
      }

      purge(now);
      if (!triggerId) {
        return true;
      }

      const existing = handled.get(triggerId);
      if (existing) {
        if (existing.replayToken === replayToken) {
          return false;
        }
      }

      handled.set(triggerId, {
        handledAt: now,
        replayToken,
      });
      return true;
    },
    reset() {
      handled.clear();
    },
  };
}

module.exports = {
  REVIEW_GATE_PROTOCOL,
  atomicWriteJson,
  createTriggerTracker,
  getAckFilePath,
  getProgressFilePath,
  getResponseFilePath,
  getSpeechResponseFilePath,
  getSpeechTriggerFilePath,
  getTriggerFilePath,
};
