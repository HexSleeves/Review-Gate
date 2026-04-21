const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

let createWebviewPanelCalls = 0;

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
        createWebviewPanelCalls += 1;
        return {
          webview: {
            html: "",
            onDidReceiveMessage() {},
            postMessage() {},
          },
          reveal() {},
          onDidDispose() {},
          dispose() {},
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

const { createResponseEnvelope, normalizeResponseAttachments, getReviewGateHTML } = webviewModule.__test;

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

test("openReviewGatePopup recovers from InvalidStateError when reusing a stale panel", () => {
  createWebviewPanelCalls = 0;
  state.chatPanel = {
    reveal() {
      const error = new Error(
        "Could not register a ServiceWorker: The document is in an invalid state."
      );
      error.name = "InvalidStateError";
      throw error;
    },
    title: "Stale panel",
    webview: {
      postMessage() {},
    },
    dispose() {},
  };

  const context = { subscriptions: [] };

  assert.doesNotThrow(() => {
    webviewModule.openReviewGatePopup(context, {
      mcpIntegration: true,
      triggerId: "trigger-invalid-state",
    });
  });
  assert.equal(createWebviewPanelCalls, 1);
  assert.ok(state.chatPanel);
});

test("webview shell includes accessibility landmarks and keyboard support hooks", () => {
  const html = getReviewGateHTML({
    title: "Review Gate",
    message: "Review this plan",
    triggerId: "trigger-a11y",
    mcpIntegration: true,
    openedAt: "2026-04-21T00:00:00.000Z",
    toolData: {},
  });

  assert.match(html, /<main class="app-shell" id="appShell">/);
  assert.match(html, /id="liveRegion" class="sr-only" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /id="historyPanel" role="tabpanel" tabindex="0"/);
  assert.match(html, /aria-describedby="composerHelper attachmentSummary"/);
  assert.match(html, /aria-controls="historyPanel" tabindex="/);
  assert.ok(html.includes('dom.tabRow.addEventListener("keydown"'));
  assert.ok(html.includes('event.key.toLowerCase() === "s"'));
  assert.match(html, /@media \(prefers-contrast: more\)/);
  assert.match(html, /@media \(forced-colors: active\)/);
});
