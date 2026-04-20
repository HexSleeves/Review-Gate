const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function requireWithMocks(modulePath, mocks) {
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[require.resolve(modulePath)];

  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const ipcModule = requireWithMocks("../src/ipc.js", {
  vscode: {
    window: {
      createOutputChannel() {
        return { appendLine() {}, dispose() {} };
      },
    },
  },
});

const { normalizeToolData, normalizeProgressPayload } = ipcModule.__test;

test("normalizeToolData accepts nested trigger envelopes and preserves contract fields", () => {
  const now = Date.parse("2026-04-20T12:00:00.000Z");
  const normalized = normalizeToolData(
    {
      system: "review-gate-v3",
      editor: "cursor",
      trigger_id: "trigger-1",
      data: {
        session_id: "session-1",
        protocol_version: "3.0",
        payload: {
          tool: "review_gate_chat",
          title: "Review deployment rollback plan",
        },
        message: "Please confirm the rollback order.",
      },
    },
    now
  );

  assert.equal(normalized.error, undefined);
  assert.equal(normalized.toolData.trigger_id, "trigger-1");
  assert.equal(normalized.toolData.session_id, "session-1");
  assert.equal(normalized.toolData.protocol_version, "3.0");
  assert.equal(normalized.toolData.tool, "review_gate_chat");
  assert.equal(normalized.toolData.message, "Please confirm the rollback order.");
  assert.equal(normalized.envelope.requestType, "review_gate_chat");
});

test("normalizeToolData rejects expired trigger envelopes", () => {
  const now = Date.parse("2026-04-20T12:00:00.000Z");
  const normalized = normalizeToolData(
    {
      system: "review-gate-v3",
      editor: "cursor",
      trigger_id: "trigger-expired",
      expires_at: "2026-04-20T11:59:59.000Z",
      message: "stale",
    },
    now
  );

  assert.equal(normalized.stale, true);
  assert.equal(normalized.error.problem, "Request expired before delivery.");
});

test("normalizeProgressPayload keeps active trigger progress and ignores foreign updates", () => {
  const now = Date.parse("2026-04-20T12:00:00.000Z");
  const valid = normalizeProgressPayload(
    {
      system: "review-gate-v3",
      type: "progress_update",
      data: {
        trigger_id: "trigger-1",
        percentage: 42,
        step: "Await extension acknowledgement",
        status: "active",
        updated_at: "2026-04-20T11:59:30.000Z",
      },
    },
    "trigger-1",
    now
  );

  assert.equal(valid.error, undefined);
  assert.equal(valid.progress.triggerId, "trigger-1");
  assert.equal(valid.progress.percentage, 42);
  assert.equal(valid.progress.step, "Await extension acknowledgement");

  const ignored = normalizeProgressPayload(
    {
      system: "review-gate-v3",
      data: {
        trigger_id: "trigger-2",
        percentage: 10,
      },
    },
    "trigger-1",
    now
  );

  assert.equal(ignored.ignored, "progress update for trigger-2");
});
