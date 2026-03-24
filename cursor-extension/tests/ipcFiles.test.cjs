const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createTriggerTracker,
  getResponseFilePath,
} = require("../src/ipcFiles");

test("trigger tracker dedupes repeated trigger ids", () => {
  const tracker = createTriggerTracker(1000);

  assert.equal(tracker.markHandled("trigger-1", 100), true);
  assert.equal(tracker.markHandled("trigger-1", 200), false);
  assert.equal(tracker.markHandled("trigger-1", 1501), true);
});

test("response files are scoped to a specific trigger id", () => {
  const path = getResponseFilePath("trigger-42");
  assert.match(path, /review_gate_response_trigger-42\.json$/);
});
