const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const state = require("./state");
const { startNodeRecording, stopNodeRecording } = require("./audio");
const { getMimeType } = require("./utils");
const { logUserInput } = require("./logger");

function createSessionPayload(options = {}) {
  return {
    message: options.message || "Welcome to Review Gate. Start a new review or resume a prior draft.",
    title: options.title || "Review Gate",
    autoFocus: Boolean(options.autoFocus),
    mcpIntegration: Boolean(options.mcpIntegration),
    toolData: options.toolData || null,
    triggerId: options.triggerId || null,
    specialHandling: options.specialHandling || null,
    openedAt: new Date().toISOString(),
  };
}

function serializeForWebview(data) {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function postToChatPanel(message) {
  if (state.chatPanel?.webview) {
    state.chatPanel.webview.postMessage(message);
  }
}

function openReviewGatePopup(context, options = {}) {
  const sessionPayload = createSessionPayload(options);
  const { autoFocus, message, title, toolData, mcpIntegration, triggerId, specialHandling } =
    sessionPayload;

  if (triggerId) {
    state.currentTriggerData = { ...toolData, trigger_id: triggerId };
  }

  if (state.chatPanel) {
    state.chatPanel.reveal(vscode.ViewColumn.One);
    state.chatPanel.title = "Review Gate";

    setTimeout(() => {
      postToChatPanel({
        command: "configureSession",
        payload: sessionPayload,
      });
    }, 100);

    if (autoFocus) {
      setTimeout(() => {
        postToChatPanel({ command: "focus" });
      }, 220);
    }

    return;
  }

  state.chatPanel = vscode.window.createWebviewPanel("reviewGateChat", title, vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });

  state.chatPanel.webview.html = getReviewGateHTML(sessionPayload);

  state.chatPanel.webview.onDidReceiveMessage(
    (webviewMessage) => {
      const currentTriggerId = state.currentTriggerData?.trigger_id || triggerId;

      switch (webviewMessage.command) {
        case "send":
          logUserInput(
            webviewMessage.text,
            mcpIntegration ? "MCP_RESPONSE" : "REVIEW_SUBMITTED",
            currentTriggerId,
            webviewMessage.attachments || []
          );
          handleReviewMessage(
            webviewMessage.text,
            webviewMessage.attachments,
            currentTriggerId,
            mcpIntegration,
            specialHandling
          );
          break;
        case "attach":
          logUserInput("User clicked attachment button", "ATTACHMENT_CLICK", currentTriggerId);
          handleFileAttachment(currentTriggerId);
          break;
        case "uploadImage":
          logUserInput("User clicked image upload button", "IMAGE_UPLOAD_CLICK", currentTriggerId);
          handleImageUpload(currentTriggerId);
          break;
        case "logPastedImage":
          logUserInput(
            `Image pasted from clipboard: ${webviewMessage.fileName} (${webviewMessage.size} bytes, ${webviewMessage.mimeType})`,
            "IMAGE_PASTED",
            currentTriggerId
          );
          break;
        case "logDragDropImage":
          logUserInput(
            `Image dropped from drag and drop: ${webviewMessage.fileName} (${webviewMessage.size} bytes, ${webviewMessage.mimeType})`,
            "IMAGE_DROPPED",
            currentTriggerId
          );
          break;
        case "logImageRemoved":
          logUserInput(
            `Image removed: ${webviewMessage.imageId}`,
            "IMAGE_REMOVED",
            currentTriggerId
          );
          break;
        case "startRecording":
          logUserInput("User started speech recording", "SPEECH_START", currentTriggerId);
          startNodeRecording(currentTriggerId);
          break;
        case "stopRecording":
          logUserInput("User stopped speech recording", "SPEECH_STOP", currentTriggerId);
          stopNodeRecording(currentTriggerId);
          break;
        case "showError":
          vscode.window.showErrorMessage(webviewMessage.message);
          break;
        case "ready":
          postToChatPanel({
            command: "updateMcpStatus",
            active: mcpIntegration ? true : state.mcpStatus,
          });
          postToChatPanel({
            command: "configureSession",
            payload: sessionPayload,
          });
          break;
        default:
          break;
      }
    },
    undefined,
    context.subscriptions
  );

  state.chatPanel.onDidDispose(
    () => {
      state.chatPanel = null;
      state.currentTriggerData = null;
    },
    null,
    context.subscriptions
  );

  if (autoFocus) {
    setTimeout(() => {
      postToChatPanel({ command: "focus" });
    }, 220);
  }
}

function handleReviewMessage(text, attachments, triggerId, mcpIntegration) {
  if (state.outputChannel) {
    state.outputChannel.appendLine(
      `${mcpIntegration ? "MCP RESPONSE" : "REVIEW"} SUBMITTED: ${text}`
    );
  }

  if (state.chatPanel) {
    const sentAt = new Date().toISOString();
    setTimeout(() => {
      postToChatPanel({
        command: "responseAcknowledged",
        payload: {
          sessionId: triggerId || `manual-${Date.now()}`,
          triggerId: triggerId || null,
          destination: mcpIntegration ? "Returned to MCP client" : "Saved to Review Gate log",
          summary: mcpIntegration
            ? "Response delivered through the current Review Gate flow."
            : "Manual review saved in the Review Gate session log.",
          sentAt,
          attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
        },
      });
    }, 240);
  }
}

function handleFileAttachment(triggerId) {
  logUserInput("User requested file attachment for review", "FILE_ATTACHMENT", triggerId);

  vscode.window
    .showOpenDialog({
      canSelectMany: true,
      openLabel: "Select file(s) for review",
      filters: {
        "All files": ["*"],
      },
    })
    .then((fileUris) => {
      if (fileUris && fileUris.length > 0) {
        const filePaths = fileUris.map((uri) => uri.fsPath);
        const fileNames = filePaths.map((filePath) => path.basename(filePath));

        logUserInput(
          `Files selected for review: ${fileNames.join(", ")}`,
          "FILE_SELECTED",
          triggerId
        );

        postToChatPanel({
          command: "appendTranscript",
          text: `Files attached for review:\n${fileNames.map((name) => "• " + name).join("\n")}`,
          type: "system",
        });
      } else {
        logUserInput("No files selected for review", "FILE_CANCELLED", triggerId);
      }
    });
}

function handleImageUpload(triggerId) {
  logUserInput("User requested image upload for review", "IMAGE_UPLOAD", triggerId);

  vscode.window
    .showOpenDialog({
      canSelectMany: true,
      openLabel: "Select image(s) to upload",
      filters: {
        Images: ["png", "jpg", "jpeg", "gif", "bmp", "webp"],
      },
    })
    .then((fileUris) => {
      if (!fileUris || fileUris.length === 0) {
        logUserInput("No images selected for upload", "IMAGE_CANCELLED", triggerId);
        return;
      }

      fileUris.forEach((fileUri) => {
        const filePath = fileUri.fsPath;
        const fileName = path.basename(filePath);

        try {
          const imageBuffer = fs.readFileSync(filePath);
          const base64Data = imageBuffer.toString("base64");
          const mimeType = getMimeType(fileName);
          const dataUrl = `data:${mimeType};base64,${base64Data}`;

          logUserInput(`Image uploaded: ${fileName}`, "IMAGE_UPLOADED", triggerId);

          postToChatPanel({
            command: "imageUploaded",
            imageData: {
              id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              fileName,
              filePath,
              mimeType,
              base64Data,
              dataUrl,
              size: imageBuffer.length,
            },
          });
        } catch (error) {
          console.log(`Error processing image ${fileName}: ${error.message}`);
          vscode.window.showErrorMessage(`Failed to process image: ${fileName}`);
        }
      });
    });
}

function getReviewGateHTML(sessionPayload) {
  const serializedSession = serializeForWebview(sessionPayload);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${sessionPayload.title || "Review Gate"}</title>
  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
    }

    button,
    textarea {
      font: inherit;
    }

    button {
      cursor: pointer;
    }

    button:focus-visible,
    textarea:focus-visible {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      border: 0;
    }

    .app-shell {
      display: grid;
      gap: 16px;
      padding: 16px;
    }

    .shell-header,
    .region,
    .status-summary,
    .status-card,
    .launcher-card {
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 12px;
    }

    .shell-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      padding: 14px 16px;
    }

    .header-title {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
    }

    .header-meta,
    .secondary-copy,
    .detail-copy,
    .entry-time {
      color: var(--vscode-descriptionForeground);
    }

    .status-badge,
    .meta-pill,
    .timeline-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .status-badge.online {
      background: color-mix(in srgb, var(--vscode-testing-iconPassed) 18%, transparent);
      color: var(--vscode-testing-iconPassed);
    }

    .status-badge.offline {
      background: color-mix(in srgb, var(--vscode-testing-iconFailed) 18%, transparent);
      color: var(--vscode-testing-iconFailed);
    }

    .status-badge.manual {
      background: color-mix(in srgb, var(--vscode-charts-blue) 16%, transparent);
      color: var(--vscode-charts-blue);
    }

    .region {
      padding: 16px;
    }

    .region-header,
    .request-header,
    .progress-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
    }

    .region-title,
    .request-title,
    .card-title {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
    }

    .request-body,
    .composer-layout,
    .status-stack,
    .launcher-grid {
      display: grid;
      gap: 12px;
    }

    .request-summary {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
      line-height: 1.3;
    }

    .meta-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .request-message,
    .timeline-entry,
    .launcher-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
    }

    .request-message,
    .timeline-entry {
      padding: 12px;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.5;
    }

    .workspace-grid {
      display: grid;
      gap: 16px;
      grid-template-columns: minmax(260px, 1fr) minmax(320px, 1.1fr);
    }

    .tab-row,
    .launcher-actions,
    .composer-toolbar,
    .composer-actions,
    .status-actions,
    .result-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .tab-button,
    .ghost-button,
    .secondary-button,
    .primary-button {
      padding: 8px 12px;
      border-radius: 10px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
    }

    .tab-button.active,
    .primary-button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }

    .tab-button:hover:not(:disabled),
    .ghost-button:hover:not(:disabled),
    .secondary-button:hover:not(:disabled),
    .primary-button:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
      color: var(--vscode-button-foreground);
    }

    .timeline-list,
    .attachment-list,
    .progress-step-list,
    .launcher-list {
      display: grid;
      gap: 10px;
    }

    .timeline-header,
    .attachment-title,
    .launcher-list li {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: flex-start;
    }

    .timeline-label {
      font-weight: 600;
    }

    .message-input {
      width: 100%;
      min-height: 168px;
      resize: vertical;
      padding: 14px;
      border-radius: 12px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      background: var(--vscode-input-background, var(--vscode-editor-background));
      color: var(--vscode-input-foreground, var(--vscode-editor-foreground));
      line-height: 1.5;
    }

    .message-input.paste-highlight {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
    }

    .attachment-card {
      padding: 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      background: var(--vscode-editor-background);
      display: grid;
      gap: 8px;
    }

    .attachment-preview {
      width: 100%;
      max-height: 140px;
      object-fit: cover;
      border-radius: 8px;
      border: 1px solid var(--vscode-panel-border);
    }

    .status-summary,
    .status-card {
      padding: 14px 16px;
    }

    .status-summary {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
    }

    .status-card {
      display: none;
      gap: 12px;
    }

    .status-card.visible {
      display: grid;
    }

    .progress-bar {
      height: 8px;
      border-radius: 999px;
      overflow: hidden;
      background: var(--vscode-progressBar-background);
    }

    .progress-bar > span {
      display: block;
      height: 100%;
      background: var(--vscode-button-background);
      transition: width 160ms ease-out;
    }

    .progress-step-item {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 13px;
    }

    .progress-step-item.complete .step-state {
      color: var(--vscode-testing-iconPassed);
    }

    .progress-step-item.active .step-state {
      color: var(--vscode-charts-blue);
    }

    .launcher-grid {
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      margin-top: 12px;
    }

    .launcher-card {
      padding: 14px;
      display: grid;
      gap: 10px;
    }

    .launcher-list {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .hidden {
      display: none !important;
    }

    @media (max-width: 900px) {
      .workspace-grid {
        grid-template-columns: 1fr;
      }

      .shell-header,
      .region-header,
      .request-header,
      .status-summary,
      .progress-header {
        flex-direction: column;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        animation: none !important;
        transition: none !important;
      }
    }
  </style>
</head>
<body>
  <div class="app-shell">
    <header class="shell-header">
      <div>
        <p class="header-meta" id="headerMeta"></p>
        <h1 class="header-title" id="headerTitle"></h1>
      </div>
      <div>
        <span class="status-badge manual" id="availabilityBadge">Loading</span>
        <p class="header-meta" id="sessionMeta"></p>
      </div>
    </header>

    <div id="liveRegion" class="sr-only" aria-live="polite" aria-atomic="true"></div>

    <section class="region" id="launcherRegion" aria-labelledby="launcherHeading">
      <div class="region-header">
        <div>
          <h2 class="region-title" id="launcherHeading">Start from where you left off</h2>
          <p class="secondary-copy">Manual open keeps recent sessions, templates, and keyboard help visible.</p>
        </div>
        <div class="launcher-actions">
          <button class="primary-button" type="button" id="startReviewButton">Start new review</button>
          <button class="secondary-button" type="button" id="resumeReviewButton">Resume last request</button>
          <button class="ghost-button" type="button" id="openCheckpointsButton">View checkpoints</button>
        </div>
      </div>
      <div class="launcher-grid">
        <article class="launcher-card">
          <h3 class="card-title">Recent sessions</h3>
          <ul class="launcher-list" id="recentSessionsList"></ul>
        </article>
        <article class="launcher-card">
          <h3 class="card-title">Saved templates</h3>
          <ul class="launcher-list" id="savedTemplatesList"></ul>
        </article>
        <article class="launcher-card">
          <h3 class="card-title">Keyboard help</h3>
          <p class="secondary-copy">Cmd/Ctrl+Enter sends. Enter adds a newline. Tab moves between regions.</p>
        </article>
      </div>
    </section>

    <section class="region" id="requestRegion" aria-labelledby="requestHeading">
      <div class="request-header">
        <div>
          <p class="header-meta" id="requestEyebrow"></p>
          <h2 class="request-title" id="requestHeading">Request summary</h2>
        </div>
        <button class="ghost-button" type="button" id="toggleSummaryButton" aria-expanded="true">Collapse summary</button>
      </div>
      <div class="request-body" id="requestBody">
        <p class="request-summary" id="requestSummary"></p>
        <div class="meta-list" id="requestMeta"></div>
        <div class="request-message" id="requestMessage"></div>
        <div class="request-message" id="successLooksLike"></div>
      </div>
    </section>

    <div class="workspace-grid" id="workspaceRegion">
      <section class="region" aria-labelledby="historyHeading">
        <div class="region-header">
          <div>
            <h2 class="region-title" id="historyHeading">Session history</h2>
            <p class="secondary-copy">Switch between request, transcript, checkpoints, and activity.</p>
          </div>
          <div class="tab-row" id="tabRow" role="tablist" aria-label="History views"></div>
        </div>
        <div class="timeline-list" id="historyPanel"></div>
      </section>

      <section class="region" aria-labelledby="composerHeading">
        <div class="region-header">
          <div>
            <h2 class="region-title" id="composerHeading">Response draft</h2>
            <p class="secondary-copy" id="composerHelper">Keyboard-first compose area with attachments and optional voice input.</p>
          </div>
          <span class="timeline-pill" id="saveStateLabel">Draft not saved</span>
        </div>
        <div class="composer-layout">
          <label for="messageInput">Response</label>
          <textarea id="messageInput" class="message-input" rows="8" placeholder="Write a focused response."></textarea>
          <div class="composer-toolbar">
            <button class="secondary-button" type="button" id="addImageButton">Add image</button>
            <button class="secondary-button" type="button" id="voiceButton">Start voice</button>
          </div>
          <div class="secondary-copy" id="attachmentSummary">No attachments</div>
          <div class="attachment-list" id="attachmentList"></div>
          <div class="composer-actions">
            <button class="ghost-button" type="button" id="saveDraftButton">Save draft</button>
            <button class="ghost-button" type="button" id="discardDraftButton">Discard draft</button>
            <button class="primary-button" type="button" id="sendButton">Send response</button>
          </div>
        </div>
      </section>
    </div>

    <section class="status-stack" aria-labelledby="statusHeading">
      <div class="status-summary">
        <div>
          <h2 class="region-title" id="statusHeading">Delivery status</h2>
          <p class="secondary-copy" id="statusSummaryText"></p>
        </div>
        <div class="status-actions" id="statusActionGroup"></div>
      </div>

      <article class="status-card" id="progressCard" aria-live="polite">
        <div class="progress-header">
          <div>
            <h3 class="card-title" id="progressTitle">Delivery progress</h3>
            <p class="secondary-copy" id="progressSubtitle"></p>
          </div>
          <button class="ghost-button" type="button" id="toggleProgressDetailsButton" aria-expanded="true">Hide details</button>
        </div>
        <div class="progress-bar" aria-hidden="true"><span id="progressFill" style="width: 0%;"></span></div>
        <div class="detail-copy" id="progressMeta"></div>
        <div class="progress-step-list" id="progressSteps"></div>
      </article>

      <article class="status-card" id="resultCard">
        <div>
          <h3 class="card-title" id="resultTitle"></h3>
          <p class="secondary-copy" id="resultSubtitle"></p>
        </div>
        <div class="detail-copy" id="resultDetails"></div>
        <div class="result-actions" id="resultActions"></div>
      </article>
    </section>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const initialSession = ${serializedSession};
    const defaultTemplates = ["Code review request", "Architecture sign-off", "Release checklist"];
    const defaultProgressSteps = [
      "Validate response payload",
      "Write response file",
      "Await extension acknowledgement",
      "Return result to MCP client",
    ];

    const dom = {
      liveRegion: document.getElementById("liveRegion"),
      headerTitle: document.getElementById("headerTitle"),
      headerMeta: document.getElementById("headerMeta"),
      availabilityBadge: document.getElementById("availabilityBadge"),
      sessionMeta: document.getElementById("sessionMeta"),
      launcherRegion: document.getElementById("launcherRegion"),
      recentSessionsList: document.getElementById("recentSessionsList"),
      savedTemplatesList: document.getElementById("savedTemplatesList"),
      requestRegion: document.getElementById("requestRegion"),
      requestEyebrow: document.getElementById("requestEyebrow"),
      requestSummary: document.getElementById("requestSummary"),
      requestMeta: document.getElementById("requestMeta"),
      requestMessage: document.getElementById("requestMessage"),
      successLooksLike: document.getElementById("successLooksLike"),
      requestBody: document.getElementById("requestBody"),
      toggleSummaryButton: document.getElementById("toggleSummaryButton"),
      workspaceRegion: document.getElementById("workspaceRegion"),
      tabRow: document.getElementById("tabRow"),
      historyPanel: document.getElementById("historyPanel"),
      saveStateLabel: document.getElementById("saveStateLabel"),
      composerHelper: document.getElementById("composerHelper"),
      messageInput: document.getElementById("messageInput"),
      addImageButton: document.getElementById("addImageButton"),
      voiceButton: document.getElementById("voiceButton"),
      attachmentSummary: document.getElementById("attachmentSummary"),
      attachmentList: document.getElementById("attachmentList"),
      saveDraftButton: document.getElementById("saveDraftButton"),
      discardDraftButton: document.getElementById("discardDraftButton"),
      sendButton: document.getElementById("sendButton"),
      statusSummaryText: document.getElementById("statusSummaryText"),
      statusActionGroup: document.getElementById("statusActionGroup"),
      progressCard: document.getElementById("progressCard"),
      progressTitle: document.getElementById("progressTitle"),
      progressSubtitle: document.getElementById("progressSubtitle"),
      progressFill: document.getElementById("progressFill"),
      progressMeta: document.getElementById("progressMeta"),
      progressSteps: document.getElementById("progressSteps"),
      toggleProgressDetailsButton: document.getElementById("toggleProgressDetailsButton"),
      resultCard: document.getElementById("resultCard"),
      resultTitle: document.getElementById("resultTitle"),
      resultSubtitle: document.getElementById("resultSubtitle"),
      resultDetails: document.getElementById("resultDetails"),
      resultActions: document.getElementById("resultActions"),
      startReviewButton: document.getElementById("startReviewButton"),
      resumeReviewButton: document.getElementById("resumeReviewButton"),
      openCheckpointsButton: document.getElementById("openCheckpointsButton"),
    };

    const appState = {
      session: null,
      currentView: "home_idle",
      activeTab: "request",
      draftText: "",
      attachments: [],
      transcript: [],
      activity: [],
      checkpoints: [],
      recentSessions: [],
      savedTemplates: defaultTemplates.slice(),
      mcpActive: true,
      progress: null,
      progressExpanded: true,
      success: null,
      recovery: null,
      lastSavedAt: null,
      summaryCollapsed: false,
      isRecording: false,
      lastPasteTime: 0,
      dragCounter: 0,
    };

    function escapeHtml(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function formatTime(value) {
      if (!value) {
        return "Now";
      }
      const date = new Date(value);
      return Number.isNaN(date.getTime())
        ? "Now"
        : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }

    function humanCount(value) {
      if (Array.isArray(value)) {
        return value.length;
      }
      if (typeof value === "number") {
        return value;
      }
      if (typeof value === "string" && value.trim()) {
        return 1;
      }
      return 0;
    }

    function cloneSession(session) {
      return Object.assign({}, session || {});
    }

    function deriveRequestMeta(session) {
      const toolData = session.toolData || {};
      return {
        requestTitle:
          toolData.requestTitle ||
          toolData.title ||
          session.title ||
          (session.mcpIntegration ? "Incoming review request" : "New review"),
        source: toolData.tool || (session.mcpIntegration ? "review_gate_chat" : "manual_open"),
        urgency: toolData.urgency || toolData.priority || (session.mcpIntegration ? "High" : "Ready"),
        requestedBy:
          toolData.requestedBy ||
          toolData.requested_by ||
          toolData.source ||
          (session.mcpIntegration ? "review_gate" : "manual"),
        files: humanCount(toolData.files || toolData.file_paths || toolData.paths || toolData.changed_files),
        context: humanCount(toolData.context || toolData.context_files || toolData.contextFiles),
        successLooksLike:
          toolData.successLooksLike ||
          toolData.success_looks_like ||
          toolData.expectedOutcome ||
          toolData.goal ||
          "Respond with the next action, risk, or recommendation the requester needs.",
      };
    }

    function createTranscriptEntry(kind, label, text, timestamp) {
      return {
        id: "entry-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
        kind,
        label,
        text,
        timestamp: timestamp || new Date().toISOString(),
      };
    }

    function pushActivity(label, text, timestamp) {
      appState.activity.unshift(createTranscriptEntry("activity", label, text, timestamp));
    }

    function announce(text) {
      dom.liveRegion.textContent = text;
    }

    function setDraftPlaceholder() {
      const base = appState.session?.mcpIntegration
        ? "Cursor Agent is waiting for your response."
        : "Write a focused review response.";
      const suffix = appState.attachments.length
        ? " " + appState.attachments.length + " attachment(s) ready."
        : "";
      dom.messageInput.placeholder = base + suffix;
    }

    function resetForSession(session) {
      const nextSession = cloneSession(session);
      const sessionChanged =
        !appState.session ||
        appState.session.triggerId !== nextSession.triggerId ||
        appState.session.mcpIntegration !== nextSession.mcpIntegration ||
        appState.session.message !== nextSession.message;

      appState.session = nextSession;
      appState.currentView = nextSession.mcpIntegration ? "drafting" : "home_idle";
      appState.activeTab = nextSession.mcpIntegration ? "request" : "history";
      appState.summaryCollapsed = false;
      appState.progress = null;
      appState.progressExpanded = true;
      appState.success = null;
      appState.recovery = null;

      if (sessionChanged) {
        appState.draftText = "";
        appState.attachments = [];
        appState.lastSavedAt = null;
        appState.checkpoints = [];
        appState.transcript = [];
        appState.activity = [];

        if (nextSession.message) {
          appState.transcript.push(
            createTranscriptEntry(
              nextSession.mcpIntegration ? "request" : "history",
              nextSession.mcpIntegration ? "Agent request" : "Review launcher",
              nextSession.message,
              nextSession.openedAt
            )
          );
        }

        pushActivity(
          "Session opened",
          nextSession.mcpIntegration
            ? "Structured request received from Cursor MCP."
            : "Manual launcher is ready for a new review.",
          nextSession.openedAt
        );
      }

      announce(
        nextSession.mcpIntegration
          ? deriveRequestMeta(nextSession).requestTitle + ", " + deriveRequestMeta(nextSession).urgency + " priority."
          : "Review Gate launcher ready."
      );
      render();
    }

    function addAttachment(imageData) {
      appState.attachments.push(
        Object.assign({}, imageData, {
          id: imageData.id || "img-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
        })
      );
      pushActivity("Attachment added", imageData.fileName || "Image attached.");
      announce((imageData.fileName || "Image") + " attached.");
      render();
    }

    function removeAttachment(attachmentId) {
      const removed = appState.attachments.find((attachment) => attachment.id === attachmentId);
      appState.attachments = appState.attachments.filter((attachment) => attachment.id !== attachmentId);
      if (removed) {
        vscode.postMessage({ command: "logImageRemoved", imageId: attachmentId });
        pushActivity("Attachment removed", removed.fileName || "Image removed.");
      }
      render();
    }

    function saveDraft() {
      appState.draftText = dom.messageInput.value;
      appState.lastSavedAt = new Date().toISOString();
      appState.checkpoints.unshift({
        id: "checkpoint-" + Date.now(),
        title: "Draft saved",
        detail:
          (appState.draftText ? appState.draftText.slice(0, 72) : "Draft with no text") +
          (appState.draftText.length > 72 ? "…" : ""),
        timestamp: appState.lastSavedAt,
      });
      pushActivity("Draft saved", "Draft saved at " + formatTime(appState.lastSavedAt) + ".");
      announce("Draft saved.");
      render();
    }

    function discardDraft() {
      appState.draftText = "";
      appState.attachments = [];
      appState.success = null;
      appState.recovery = null;
      dom.messageInput.value = "";
      pushActivity("Draft cleared", "Draft and attachments were cleared.");
      announce("Draft cleared.");
      render();
      dom.messageInput.focus();
    }

    function applyProgress(progressData) {
      appState.progress = Object.assign(
        {
          title: "Delivery progress",
          percentage: 0,
          step: "Waiting for update",
          status: "active",
          updatedAt: new Date().toISOString(),
        },
        progressData || {}
      );
      appState.progress.updatedAt = new Date().toISOString();
      appState.progressExpanded = appState.progress.status !== "completed";
      pushActivity(
        "Progress update",
        appState.progress.step + " (" + Math.round(appState.progress.percentage) + "%)"
      );
      announce(appState.progress.step);
      render();
    }

    function applySuccess(payload) {
      const sentAt = payload?.sentAt || new Date().toISOString();
      appState.success = {
        title: "Response sent",
        subtitle: payload?.summary || "The response was delivered through Review Gate.",
        details: {
          "Session ID": payload?.sessionId || "Unavailable",
          Destination: payload?.destination || "Returned to MCP client",
          "Sent at": formatTime(sentAt),
          Attachments: String(payload?.attachmentCount || 0),
        },
        actions: [
          { id: "copy-session", label: "Copy session ID", value: payload?.sessionId || "" },
          { id: "open-history", label: "Open transcript" },
          { id: "new-review", label: "Start follow-up" },
        ],
      };
      appState.recovery = null;
      appState.progress = {
        title: "Delivery progress",
        percentage: 100,
        step: "Return result to MCP client",
        status: "completed",
        updatedAt: sentAt,
      };
      appState.recentSessions.unshift({
        title: deriveRequestMeta(appState.session).requestTitle,
        subtitle: payload?.destination || "Response sent",
        timestamp: sentAt,
      });
      appState.recentSessions = appState.recentSessions.slice(0, 5);
      appState.checkpoints.unshift({
        id: "sent-" + Date.now(),
        title: "Response sent",
        detail: payload?.sessionId || "Session complete",
        timestamp: sentAt,
      });
      appState.draftText = "";
      appState.attachments = [];
      dom.messageInput.value = "";
      pushActivity("Response sent", payload?.destination || "Returned to MCP client", sentAt);
      announce("Response sent.");
      render();
    }

    function applyRecovery(problem, cause, fix) {
      appState.recovery = {
        title: "Recovery",
        subtitle: problem,
        details: {
          Problem: problem,
          Cause: cause,
          Fix: fix,
        },
        actions: [{ id: "focus-draft", label: "Return to draft" }],
      };
      appState.success = null;
      announce(problem);
      render();
    }

    function appendTranscriptMessage(text, type) {
      if (!text) {
        return;
      }
      const labels = {
        assistant: "Agent",
        system: "System",
        user: "You",
      };
      appState.transcript.push(createTranscriptEntry("history", labels[type] || "System", text));
      pushActivity("Transcript updated", "New " + (labels[type] || "system").toLowerCase() + " message received.");
      render();
    }

    function renderHeader() {
      const meta = deriveRequestMeta(appState.session || {});
      dom.headerTitle.textContent = appState.session?.title || "Review Gate";
      dom.headerMeta.textContent = appState.session?.mcpIntegration
        ? "Structured request, transcript, composer, and delivery regions."
        : "Launcher workspace for manual reviews and follow-up drafts.";
      dom.sessionMeta.textContent =
        "Session " + (appState.session?.triggerId || "manual") + " · " + meta.requestTitle;
      dom.availabilityBadge.textContent = appState.session?.mcpIntegration
        ? appState.mcpActive
          ? "MCP ready"
          : "MCP inactive"
        : "Manual review";
      dom.availabilityBadge.className =
        "status-badge " +
        (appState.session?.mcpIntegration ? (appState.mcpActive ? "online" : "offline") : "manual");
    }

    function renderLauncher() {
      const visible = appState.currentView === "home_idle";
      dom.launcherRegion.classList.toggle("hidden", !visible);
      dom.recentSessionsList.innerHTML = appState.recentSessions.length
        ? appState.recentSessions
            .map(
              (session) =>
                "<li><span>" +
                escapeHtml(session.title) +
                '</span><span class="entry-time">' +
                escapeHtml(formatTime(session.timestamp)) +
                "</span></li>"
            )
            .join("")
        : '<li><span class="secondary-copy">No recent sessions yet.</span></li>';
      dom.savedTemplatesList.innerHTML = appState.savedTemplates
        .map(
          (template) =>
            "<li><span>" + escapeHtml(template) + '</span><span class="entry-time">Ready</span></li>'
        )
        .join("");
      dom.resumeReviewButton.disabled = !appState.recentSessions.length;
      dom.openCheckpointsButton.disabled = !appState.checkpoints.length;
    }

    function renderRequestRegion() {
      const meta = deriveRequestMeta(appState.session || {});
      const visible = appState.currentView !== "home_idle";
      dom.requestRegion.classList.toggle("hidden", !visible);
      dom.requestEyebrow.textContent = appState.session?.mcpIntegration ? "Structured request" : "Manual review";
      dom.requestSummary.textContent = meta.requestTitle;
      dom.requestMeta.innerHTML = [
        "Agent: " + meta.source,
        "Urgency: " + meta.urgency,
        "Files: " + meta.files,
        "Context: " + meta.context,
        "Requested by: " + meta.requestedBy,
      ]
        .map((item) => '<span class="meta-pill">' + escapeHtml(item) + "</span>")
        .join("");
      dom.requestMessage.textContent =
        appState.session?.message || "Use the draft area to prepare the next review response or note.";
      dom.successLooksLike.innerHTML =
        "<strong>Success looks like:</strong> " + escapeHtml(meta.successLooksLike);
      dom.requestBody.classList.toggle("hidden", appState.summaryCollapsed);
      dom.toggleSummaryButton.textContent = appState.summaryCollapsed ? "Expand summary" : "Collapse summary";
      dom.toggleSummaryButton.setAttribute("aria-expanded", String(!appState.summaryCollapsed));
    }

    function renderTabs() {
      const tabs = [
        { id: "request", label: "Request" },
        { id: "history", label: "History" },
        { id: "checkpoints", label: "Checkpoints" },
        { id: "activity", label: "Activity" },
      ];
      dom.tabRow.innerHTML = tabs
        .map((tab) => {
          const selected = tab.id === appState.activeTab;
          return (
            '<button class="tab-button' +
            (selected ? " active" : "") +
            '" role="tab" type="button" data-tab="' +
            tab.id +
            '" aria-selected="' +
            String(selected) +
            '">' +
            escapeHtml(tab.label) +
            "</button>"
          );
        })
        .join("");
    }

    function renderHistoryPanel() {
      if (appState.activeTab === "request") {
        const meta = deriveRequestMeta(appState.session || {});
        dom.historyPanel.innerHTML =
          '<div class="timeline-entry"><div class="timeline-header"><span class="timeline-label">Request context</span><span class="entry-time">' +
          escapeHtml(formatTime(appState.session?.openedAt)) +
          "</span></div><div>" +
          escapeHtml(appState.session?.message || "No request context available.") +
          '</div><div class="meta-list"><span class="meta-pill">Agent: ' +
          escapeHtml(meta.source) +
          '</span><span class="meta-pill">Urgency: ' +
          escapeHtml(meta.urgency) +
          '</span><span class="meta-pill">Requested by: ' +
          escapeHtml(meta.requestedBy) +
          "</span></div></div>";
        return;
      }

      const items =
        appState.activeTab === "history"
          ? appState.transcript
          : appState.activeTab === "checkpoints"
            ? appState.checkpoints.map((checkpoint) =>
                createTranscriptEntry("checkpoint", checkpoint.title, checkpoint.detail, checkpoint.timestamp)
              )
            : appState.activity;

      if (!items.length) {
        dom.historyPanel.innerHTML = '<div class="secondary-copy">Nothing to show yet.</div>';
        return;
      }

      dom.historyPanel.innerHTML = items
        .map(
          (entry) =>
            '<div class="timeline-entry"><div class="timeline-header"><span class="timeline-label">' +
            escapeHtml(entry.label) +
            '</span><span class="entry-time">' +
            escapeHtml(formatTime(entry.timestamp)) +
            "</span></div><div>" +
            escapeHtml(entry.text) +
            "</div></div>"
        )
        .join("");
    }

    function renderAttachments() {
      if (!appState.attachments.length) {
        dom.attachmentSummary.textContent = "No attachments";
        dom.attachmentList.innerHTML = "";
        return;
      }

      dom.attachmentSummary.textContent = appState.attachments.length + " attachment(s) ready";
      dom.attachmentList.innerHTML = appState.attachments
        .map(
          (attachment) =>
            '<article class="attachment-card"><div class="attachment-title"><span>' +
            escapeHtml(attachment.fileName || "Image attachment") +
            '</span><button class="ghost-button" type="button" data-remove-attachment="' +
            escapeHtml(attachment.id) +
            '" aria-label="Remove ' +
            escapeHtml(attachment.fileName || "attachment") +
            '">Remove</button></div>' +
            (attachment.dataUrl
              ? '<img class="attachment-preview" src="' +
                escapeHtml(attachment.dataUrl) +
                '" alt="' +
                escapeHtml(attachment.fileName || "Attached image") +
                '">'
              : "") +
            '<div class="secondary-copy">' +
            escapeHtml(((attachment.size || 0) / 1024).toFixed(1) + " KB") +
            "</div></article>"
        )
        .join("");
    }

    function renderComposer() {
      const visible = appState.currentView !== "home_idle";
      dom.workspaceRegion.classList.toggle("hidden", !visible);
      const disabled = Boolean(appState.session?.mcpIntegration && !appState.mcpActive);
      dom.messageInput.disabled = disabled;
      dom.addImageButton.disabled = disabled;
      dom.voiceButton.disabled = disabled;
      dom.sendButton.disabled = disabled;
      dom.messageInput.value = appState.draftText;
      dom.saveStateLabel.textContent = appState.lastSavedAt
        ? "Saved " + formatTime(appState.lastSavedAt)
        : "Draft not saved";
      dom.composerHelper.textContent = appState.session?.mcpIntegration
        ? "Cmd/Ctrl+Enter sends. Enter adds a newline. Attachments stay in the draft tray."
        : "Cmd/Ctrl+Enter sends. Enter adds a newline. Manual reviews stay local until sent.";
      dom.voiceButton.textContent = appState.isRecording ? "Stop voice" : "Start voice";
      setDraftPlaceholder();
      renderAttachments();
    }

    function renderStatusSummary() {
      const meta = deriveRequestMeta(appState.session || {});
      dom.statusSummaryText.textContent =
        appState.success?.subtitle ||
        appState.recovery?.subtitle ||
        appState.progress?.step ||
        (appState.currentView === "home_idle"
          ? "Ready to start a new review."
          : appState.session?.mcpIntegration && !appState.mcpActive
            ? "Extension disconnected. Draft is preserved until the transport returns."
            : "Waiting for your response. Keyboard-ready and attachment-aware.");
      dom.statusActionGroup.innerHTML =
        '<span class="timeline-pill">Session ' +
        escapeHtml(appState.session?.triggerId || "manual") +
        '</span><span class="timeline-pill">' +
        escapeHtml(meta.requestTitle) +
        "</span>";
    }

    function renderProgressCard() {
      if (!appState.progress) {
        dom.progressCard.classList.remove("visible");
        return;
      }

      const percentage = Math.round(appState.progress.percentage || 0);
      dom.progressCard.classList.add("visible");
      dom.progressTitle.textContent = appState.progress.title || "Delivery progress";
      dom.progressSubtitle.textContent = "Last update " + formatTime(appState.progress.updatedAt);
      dom.progressFill.style.width = percentage + "%";
      dom.progressMeta.textContent =
        percentage + "% complete · " + (appState.progress.status === "completed" ? "Complete" : "In progress");
      dom.toggleProgressDetailsButton.textContent = appState.progressExpanded ? "Hide details" : "Show details";
      dom.toggleProgressDetailsButton.setAttribute("aria-expanded", String(appState.progressExpanded));
      dom.progressSteps.innerHTML = appState.progressExpanded
        ? defaultProgressSteps
            .map((step, index) => {
              const progressIndex = Math.min(
                defaultProgressSteps.length - 1,
                Math.floor((percentage / 100) * defaultProgressSteps.length)
              );
              const isComplete = percentage >= 100 ? true : index < progressIndex;
              const isActive = !isComplete && step === appState.progress.step;
              return (
                '<div class="progress-step-item ' +
                (isComplete ? "complete" : isActive ? "active" : "") +
                '"><span class="step-label">' +
                escapeHtml(step) +
                '</span><span class="step-state">' +
                escapeHtml(isComplete ? "Complete" : isActive ? "Active" : "Pending") +
                "</span></div>"
              );
            })
            .join("")
        : "";
    }

    function renderResultCard() {
      const card = appState.recovery || appState.success;
      if (!card) {
        dom.resultCard.classList.remove("visible");
        return;
      }

      dom.resultCard.classList.add("visible");
      dom.resultTitle.textContent = card.title;
      dom.resultSubtitle.textContent = card.subtitle || "";
      dom.resultDetails.innerHTML = Object.keys(card.details || {})
        .map((key) => "<div><strong>" + escapeHtml(key) + ":</strong> " + escapeHtml(card.details[key]) + "</div>")
        .join("");
      dom.resultActions.innerHTML = (card.actions || [])
        .map(
          (action) =>
            '<button class="' +
            (action.id === "new-review" ? "primary-button" : "ghost-button") +
            '" type="button" data-result-action="' +
            escapeHtml(action.id) +
            '" data-result-value="' +
            escapeHtml(action.value || "") +
            '">' +
            escapeHtml(action.label) +
            "</button>"
        )
        .join("");
    }

    function render() {
      renderHeader();
      renderLauncher();
      renderRequestRegion();
      renderTabs();
      renderHistoryPanel();
      renderComposer();
      renderStatusSummary();
      renderProgressCard();
      renderResultCard();
    }

    function sendMessage() {
      const text = dom.messageInput.value.trim();
      if (!text && appState.attachments.length === 0) {
        applyRecovery(
          "Nothing to send",
          "The response draft is empty.",
          "Write a response or attach an image, then try again."
        );
        return;
      }

      appState.draftText = text;
      appState.success = null;
      appState.recovery = null;
      appState.progress = {
        title: "Delivery progress",
        percentage: 12,
        step: "Validate response payload",
        status: "active",
        updatedAt: new Date().toISOString(),
      };
      appState.transcript.push(
        createTranscriptEntry(
          "history",
          "You",
          text + (appState.attachments.length ? "\\n\\n[" + appState.attachments.length + " attachment(s)]" : "")
        )
      );
      pushActivity("Response submitted", "Payload prepared for extension delivery.");
      announce("Sending response.");
      render();

      vscode.postMessage({
        command: "send",
        text,
        attachments: appState.attachments,
        timestamp: new Date().toISOString(),
        mcpIntegration: appState.session?.mcpIntegration,
      });
    }

    function ensureDrafting() {
      if (appState.currentView === "home_idle") {
        appState.currentView = "drafting";
        appState.activeTab = "history";
        pushActivity("Draft opened", "Manual compose state is ready.");
        render();
      }
      dom.messageInput.focus();
    }

    function handleResultAction(actionId, actionValue) {
      switch (actionId) {
        case "focus-draft":
          dom.messageInput.focus();
          break;
        case "copy-session":
          if (actionValue) {
            navigator.clipboard?.writeText(actionValue);
            announce("Session ID copied.");
          }
          break;
        case "open-history":
          appState.activeTab = "history";
          render();
          break;
        case "new-review":
          if (appState.session?.mcpIntegration) {
            appState.success = null;
            appState.progress = null;
            render();
          } else {
            appState.currentView = "home_idle";
            discardDraft();
          }
          break;
        default:
          break;
      }
    }

    function processClipboardImage(file, source) {
      const reader = new FileReader();

      reader.onload = (event) => {
        const dataUrl = event.target.result;
        const base64Data = dataUrl.split(",")[1];
        const extension = (file.type.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "");
        const fileName =
          (source === "drop" ? "dropped" : "pasted") +
          "-image-" +
          new Date().toISOString().replace(/[:.]/g, "-") +
          "." +
          extension;

        addAttachment({
          id: "img-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
          fileName,
          filePath: source,
          mimeType: file.type,
          base64Data,
          dataUrl,
          size: file.size,
          source,
        });

        vscode.postMessage({
          command: source === "drop" ? "logDragDropImage" : "logPastedImage",
          fileName,
          size: file.size,
          mimeType: file.type,
        });
      };

      reader.onerror = () => {
        applyRecovery(
          "Image processing failed.",
          "The selected image could not be read in the webview.",
          "Try the upload button again or attach a different image."
        );
      };

      reader.readAsDataURL(file);
    }

    function handlePaste(event) {
      const now = Date.now();
      if (now - appState.lastPasteTime < 500) {
        return;
      }

      const clipboardData = event.clipboardData || window.clipboardData;
      if (!clipboardData || !clipboardData.items) {
        return;
      }

      for (let index = 0; index < clipboardData.items.length; index += 1) {
        const item = clipboardData.items[index];
        if (item.type.indexOf("image") !== -1) {
          event.preventDefault();
          appState.lastPasteTime = now;
          const file = item.getAsFile();
          if (file) {
            processClipboardImage(file, "paste");
          }
          break;
        }
      }
    }

    dom.startReviewButton.addEventListener("click", () => {
      ensureDrafting();
    });

    dom.resumeReviewButton.addEventListener("click", () => {
      ensureDrafting();
      appState.activeTab = "history";
      render();
    });

    dom.openCheckpointsButton.addEventListener("click", () => {
      ensureDrafting();
      appState.activeTab = "checkpoints";
      render();
    });

    dom.toggleSummaryButton.addEventListener("click", () => {
      appState.summaryCollapsed = !appState.summaryCollapsed;
      renderRequestRegion();
    });

    dom.toggleProgressDetailsButton.addEventListener("click", () => {
      appState.progressExpanded = !appState.progressExpanded;
      renderProgressCard();
    });

    dom.messageInput.addEventListener("input", () => {
      appState.draftText = dom.messageInput.value;
    });

    dom.messageInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        sendMessage();
      }
    });

    dom.messageInput.addEventListener("paste", handlePaste);
    document.addEventListener("paste", handlePaste);

    document.addEventListener("dragenter", (event) => {
      event.preventDefault();
      appState.dragCounter += 1;
      dom.messageInput.classList.add("paste-highlight");
    });

    document.addEventListener("dragleave", (event) => {
      event.preventDefault();
      appState.dragCounter = Math.max(0, appState.dragCounter - 1);
      if (!appState.dragCounter) {
        dom.messageInput.classList.remove("paste-highlight");
      }
    });

    document.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });

    document.addEventListener("drop", (event) => {
      event.preventDefault();
      appState.dragCounter = 0;
      dom.messageInput.classList.remove("paste-highlight");
      Array.from(event.dataTransfer?.files || []).forEach((file) => {
        if (file.type.startsWith("image/")) {
          processClipboardImage(file, "drop");
        }
      });
    });

    dom.addImageButton.addEventListener("click", () => {
      vscode.postMessage({ command: "uploadImage" });
    });

    dom.voiceButton.addEventListener("click", () => {
      if (appState.isRecording) {
        appState.isRecording = false;
        renderComposer();
        vscode.postMessage({ command: "stopRecording", timestamp: new Date().toISOString() });
      } else {
        appState.isRecording = true;
        renderComposer();
        vscode.postMessage({ command: "startRecording", timestamp: new Date().toISOString() });
      }
    });

    dom.saveDraftButton.addEventListener("click", () => {
      saveDraft();
    });

    dom.discardDraftButton.addEventListener("click", () => {
      discardDraft();
    });

    dom.sendButton.addEventListener("click", () => {
      sendMessage();
    });

    dom.tabRow.addEventListener("click", (event) => {
      const button = event.target.closest("[data-tab]");
      if (!button) {
        return;
      }
      appState.activeTab = button.getAttribute("data-tab");
      render();
    });

    dom.attachmentList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove-attachment]");
      if (!button) {
        return;
      }
      removeAttachment(button.getAttribute("data-remove-attachment"));
    });

    dom.resultActions.addEventListener("click", (event) => {
      const button = event.target.closest("[data-result-action]");
      if (!button) {
        return;
      }
      handleResultAction(
        button.getAttribute("data-result-action"),
        button.getAttribute("data-result-value")
      );
    });

    window.addEventListener("message", (event) => {
      const message = event.data || {};

      switch (message.command) {
        case "configureSession":
          resetForSession(message.payload || initialSession);
          break;
        case "focus":
          if (appState.currentView === "home_idle") {
            dom.startReviewButton.focus();
          } else {
            dom.messageInput.focus();
          }
          break;
        case "updateMcpStatus":
          appState.mcpActive = Boolean(message.active) || !appState.session?.mcpIntegration;
          render();
          break;
        case "updateProgress":
          applyProgress(message.data || {});
          break;
        case "hideProgress":
        case "resetProgress":
          appState.progress = null;
          render();
          break;
        case "imageUploaded":
          addAttachment(message.imageData || {});
          break;
        case "speechTranscribed":
          if (message.transcription && message.transcription.trim()) {
            dom.messageInput.value = dom.messageInput.value.trim()
              ? dom.messageInput.value.trim() + "\\n" + message.transcription.trim()
              : message.transcription.trim();
            appState.draftText = dom.messageInput.value;
            appState.isRecording = false;
            pushActivity("Voice captured", "Speech transcription added to the draft.");
            announce("Voice transcription added.");
            render();
            dom.messageInput.focus();
          } else {
            appState.isRecording = false;
            applyRecovery(
              "Voice capture did not complete.",
              message.error || "No speech was detected from the latest recording.",
              "Check microphone access, then try voice capture again or continue typing."
            );
          }
          break;
        case "responseAcknowledged":
          applySuccess(message.payload || {});
          break;
        case "addMessage":
        case "newMessage":
        case "appendTranscript":
          appendTranscriptMessage(message.text, message.type || "system");
          break;
        default:
          break;
      }
    });

    resetForSession(initialSession);
    vscode.postMessage({ command: "ready" });
  </script>
</body>
</html>`;
}

module.exports = {
  openReviewGatePopup,
};
