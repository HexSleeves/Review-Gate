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

const state = require("../src/state");
state.currentTriggerData = {
  trigger_id: "trigger-3",
  session_id: "session-3",
  protocol_version: "3.0",
};
state.extensionInstanceId = "review-gate-extension-test";

const webviewModule = requireWithMocks("../src/webview.js", {
  vscode: {
    ViewColumn: { One: 1 },
    window: {
      createWebviewPanel() {
        return {
          webview: {
            html: "",
            onDidReceiveMessage() {},
            postMessage() {},
          },
          reveal() {},
          onDidDispose() {},
          title: "",
        };
      },
      showErrorMessage() {},
    },
  },
  "./audio": {
    startNodeRecording() {},
    stopNodeRecording() {},
  },
});

const { createResponseEnvelope, normalizeResponseAttachments } = webviewModule.__test;

test("normalizeResponseAttachments removes unsupported fields and preserves transport metadata", () => {
  const attachments = normalizeResponseAttachments([
    {
      id: "img-1",
      fileName: "diagram.png",
      filePath: "/tmp/diagram.png",
      mimeType: "image/png",
      size: "12",
      dataUrl: "data:image/png;base64,abc",
      base64Data: "abc",
      source: "paste",
      ignored: true,
    },
  ]);

  assert.deepEqual(attachments, [
    {
      id: "img-1",
      fileName: "diagram.png",
      filePath: "/tmp/diagram.png",
      mimeType: "image/png",
      size: 12,
      dataUrl: "data:image/png;base64,abc",
      base64Data: "abc",
      source: "paste",
    },
  ]);
});

test("createResponseEnvelope includes versioned and legacy response fields", () => {
  const envelope = createResponseEnvelope(
    "Rollback order is DB, workers, then API.",
    [{ id: "img-1", fileName: "diagram.png", size: 5 }],
    "trigger-3"
  );

  assert.equal(envelope.protocol_version, "3.0");
  assert.equal(envelope.trigger_id, "trigger-3");
  assert.equal(envelope.session_id, "session-3");
  assert.equal(envelope.response_status, "completed");
  assert.equal(envelope.user_payload.text, "Rollback order is DB, workers, then API.");
  assert.equal(envelope.validation_result.attachment_count, 1);
  assert.equal(envelope.extension_instance_id, "review-gate-extension-test");
  assert.equal(envelope.response, "Rollback order is DB, workers, then API.");
});
