const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const state = require("./state");
const { logUserInput, logMessage } = require("./logger");
const { startNodeRecording, stopNodeRecording } = require("./audio");
const { getMimeType } = require("./utils");

function openReviewGatePopup(context, options = {}) {
  const {
    message = "Welcome to Review Gate V2! Please provide your review or feedback.",
    title = "Review Gate",
    autoFocus = false,
    toolData = null,
    mcpIntegration = false,
    triggerId = null,
    specialHandling = null,
  } = options;

  // Store trigger ID in current trigger data for use in message handlers
  if (triggerId) {
    state.currentTriggerData = { ...toolData, trigger_id: triggerId };
  }

  if (state.chatPanel) {
    state.chatPanel.reveal(vscode.ViewColumn.One);
    // Always use consistent title
    state.chatPanel.title = "Review Gate";

    // Set MCP status to active when revealing panel for new input
    if (mcpIntegration) {
      setTimeout(() => {
        state.chatPanel.webview.postMessage({
          command: "updateMcpStatus",
          active: true,
        });
      }, 100);
    }

    // Auto-focus if requested
    if (autoFocus) {
      setTimeout(() => {
        state.chatPanel.webview.postMessage({
          command: "focus",
        });
      }, 200);
    }

    return;
  }

  // Create webview panel
  state.chatPanel = vscode.window.createWebviewPanel(
    "reviewGateChat",
    title,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  // Set the HTML content
  state.chatPanel.webview.html = getReviewGateHTML(title, mcpIntegration);

  // Handle messages from webview
  state.chatPanel.webview.onDidReceiveMessage(
    (webviewMessage) => {
      // Get trigger ID from current trigger data or passed options
      const currentTriggerId =
        (state.currentTriggerData && state.currentTriggerData.trigger_id) ||
        triggerId;

      switch (webviewMessage.command) {
        case "send":
          // Log the user input and write response file for MCP integration
          const eventType = mcpIntegration
            ? "MCP_RESPONSE"
            : "REVIEW_SUBMITTED";
          logUserInput(
            webviewMessage.text,
            eventType,
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
          logUserInput(
            "User clicked attachment button",
            "ATTACHMENT_CLICK",
            currentTriggerId
          );
          handleFileAttachment(currentTriggerId);
          break;
        case "uploadImage":
          logUserInput(
            "User clicked image upload button",
            "IMAGE_UPLOAD_CLICK",
            currentTriggerId
          );
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
          logUserInput(
            "User started speech recording",
            "SPEECH_START",
            currentTriggerId
          );
          startNodeRecording(currentTriggerId);
          break;
        case "stopRecording":
          logUserInput(
            "User stopped speech recording",
            "SPEECH_STOP",
            currentTriggerId
          );
          stopNodeRecording(currentTriggerId);
          break;
        case "showError":
          vscode.window.showErrorMessage(webviewMessage.message);
          break;
        case "ready":
          // Send initial MCP status
          state.chatPanel.webview.postMessage({
            command: "updateMcpStatus",
            active: mcpIntegration ? true : state.mcpStatus,
          });
          // Only send welcome message for manual opens, not MCP tool calls
          if (
            message &&
            !mcpIntegration &&
            !message.includes("I have completed")
          ) {
            state.chatPanel.webview.postMessage({
              command: "addMessage",
              text: message,
              type: "system",
              plain: true,
              toolData: toolData,
              mcpIntegration: mcpIntegration,
              triggerId: triggerId,
              specialHandling: specialHandling,
            });
          }
          break;
      }
    },
    undefined,
    context.subscriptions
  );

  // Clean up when panel is closed
  state.chatPanel.onDidDispose(
    () => {
      state.chatPanel = null;
      state.currentTriggerData = null;
    },
    null,
    context.subscriptions
  );

  // Auto-focus if requested
  if (autoFocus) {
    setTimeout(() => {
      state.chatPanel.webview.postMessage({
        command: "focus",
      });
    }, 200);
  }
}

function handleReviewMessage(
  text,
  attachments,
  triggerId,
  mcpIntegration,
  specialHandling
) {
  const funnyResponses = [
    "Review sent - Hold on to your pants until the review gate is called again! 🎢",
    "Message delivered! Agent is probably doing agent things now... ⚡",
    "Your wisdom has been transmitted to the digital overlords! 🤖",
    "Response launched into the void - expect agent magic soon! ✨",
    "Review gate closed - Agent is chewing on your input! 🍕",
    "Message received and filed under 'Probably Important'! 📁",
    "Your input is now part of the agent's master plan! 🧠",
    "Review sent - The agent owes you one! 🤝",
    "Success! Your thoughts are now haunting the agent's dreams! 👻",
    "Delivered faster than pizza on a Friday night! 🍕",
  ];

  // Standard handling for other tools
  // Log to output channel for persistence
  if (state.outputChannel) {
    state.outputChannel.appendLine(
      `${mcpIntegration ? "MCP RESPONSE" : "REVIEW"} SUBMITTED: ${text}`
    );
  }

  // Send standard response back to webview
  if (state.chatPanel) {
    setTimeout(() => {
      // Pick a random funny response
      const randomResponse =
        funnyResponses[Math.floor(Math.random() * funnyResponses.length)];

      state.chatPanel.webview.postMessage({
        command: "addMessage",
        text: randomResponse,
        type: "system",
        plain: true, // Use plain styling for acknowledgments
      });

      // Set MCP status to inactive after sending response
      setTimeout(() => {
        if (state.chatPanel) {
          state.chatPanel.webview.postMessage({
            command: "updateMcpStatus",
            active: false,
          });
        }
      }, 1000);
    }, 500);
  }
}

function handleFileAttachment(triggerId) {
  logUserInput(
    "User requested file attachment for review",
    "FILE_ATTACHMENT",
    triggerId
  );

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
        const fileNames = filePaths.map((fp) => path.basename(fp));

        logUserInput(
          `Files selected for review: ${fileNames.join(", ")}`,
          "FILE_SELECTED",
          triggerId
        );

        if (state.chatPanel) {
          state.chatPanel.webview.postMessage({
            command: "addMessage",
            text: `Files attached for review:\n${fileNames
              .map((name) => "• " + name)
              .join("\n")}\n\nPaths:\n${filePaths
              .map((fp) => "• " + fp)
              .join("\n")}`,
            type: "system",
          });
        }
      } else {
        logUserInput(
          "No files selected for review",
          "FILE_CANCELLED",
          triggerId
        );
      }
    });
}

function handleImageUpload(triggerId) {
  logUserInput(
    "User requested image upload for review",
    "IMAGE_UPLOAD",
    triggerId
  );

  vscode.window
    .showOpenDialog({
      canSelectMany: true,
      openLabel: "Select image(s) to upload",
      filters: {
        Images: ["png", "jpg", "jpeg", "gif", "bmp", "webp"],
      },
    })
    .then((fileUris) => {
      if (fileUris && fileUris.length > 0) {
        fileUris.forEach((fileUri) => {
          const filePath = fileUri.fsPath;
          const fileName = path.basename(filePath);

          try {
            // Read the image file
            const imageBuffer = fs.readFileSync(filePath);
            const base64Data = imageBuffer.toString("base64");
            const mimeType = getMimeType(fileName);
            const dataUrl = `data:${mimeType};base64,${base64Data}`;

            const imageData = {
              fileName: fileName,
              filePath: filePath,
              mimeType: mimeType,
              base64Data: base64Data,
              dataUrl: dataUrl,
              size: imageBuffer.length,
            };

            logUserInput(
              `Image uploaded: ${fileName}`,
              "IMAGE_UPLOADED",
              triggerId
            );

            // Send image data to webview
            if (state.chatPanel) {
              state.chatPanel.webview.postMessage({
                command: "imageUploaded",
                imageData: imageData,
              });
            }
          } catch (error) {
            console.log(`Error processing image ${fileName}: ${error.message}`);
            vscode.window.showErrorMessage(
              `Failed to process image: ${fileName}`
            );
          }
        });
      } else {
        logUserInput(
          "No images selected for upload",
          "IMAGE_CANCELLED",
          triggerId
        );
      }
    });
}
function getReviewGateHTML(title = "Review Gate", mcpIntegration = false) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            margin: 0;
            padding: 0;
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .review-container {
            height: 100vh;
            display: flex;
            flex-direction: column;
            max-width: 600px;
            margin: 0 auto;
            width: 100%;
            animation: slideIn 0.3s ease-out;
        }

        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateY(20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .review-header {
            flex-shrink: 0;
            padding: 16px 20px 12px 20px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            gap: 8px;
            background: var(--vscode-editor-background);
        }

        .review-title {
            font-size: 18px;
            font-weight: 600;
            color: var(--vscode-foreground);
        }

        .review-author {
            font-size: 12px;
            opacity: 0.7;
            margin-left: auto;
        }

        .status-indicator {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--vscode-charts-orange);
            animation: pulse 2s infinite;
            transition: background-color 0.3s ease;
            margin-right: 4px;
        }

        .status-indicator.active {
            background: var(--vscode-charts-green);
        }

        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
        }

        .messages-container {
            flex: 1;
            overflow-y: auto;
            padding: 16px 20px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .message {
            display: flex;
            gap: 8px;
            animation: messageSlide 0.3s ease-out;
        }

        @keyframes messageSlide {
            from {
                opacity: 0;
                transform: translateY(10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .message.user {
            justify-content: flex-end;
        }

        .message-bubble {
            max-width: 70%;
            padding: 12px 16px;
            border-radius: 18px;
            word-wrap: break-word;
            white-space: pre-wrap;
        }

        .message.system .message-bubble {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-bottom-left-radius: 6px;
        }

        .message.user .message-bubble {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-bottom-right-radius: 6px;
        }

        .message.system.plain {
            justify-content: center;
            margin: 8px 0;
        }

        .message.system.plain .message-content {
            background: none;
            padding: 8px 16px;
            border-radius: 0;
            font-size: 13px;
            opacity: 0.8;
            font-style: italic;
            text-align: center;
            border: none;
            color: var(--vscode-foreground);
        }

        /* Speech error message styling */
        .message.system.plain .message-content[data-speech-error] {
            background: rgba(255, 107, 53, 0.1);
            border: 1px solid rgba(255, 107, 53, 0.3);
            color: var(--vscode-errorForeground);
            font-weight: 500;
            opacity: 1;
            padding: 12px 16px;
            border-radius: 8px;
        }

        .message-time {
            font-size: 11px;
            opacity: 0.6;
            margin-top: 4px;
        }

        .input-container {
            flex-shrink: 0;
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 16px 20px 20px 20px;
            border-top: 1px solid var(--vscode-panel-border);
            background: var(--vscode-editor-background);
        }

        .input-container.disabled {
            opacity: 0.5;
            pointer-events: none;
        }

        .input-wrapper {
            flex: 1;
            display: flex;
            align-items: center;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 20px;
            padding: 8px 12px;
            transition: all 0.2s ease;
            position: relative;
        }

        .mic-icon {
            position: absolute;
            left: 16px;
            top: 50%;
            transform: translateY(-50%);
            color: var(--vscode-input-placeholderForeground);
            font-size: 14px;
            pointer-events: none;
            opacity: 0.7;
            transition: all 0.2s ease;
        }

        .mic-icon.active {
            color: #ff6b35;
            opacity: 1;
            pointer-events: auto;
            cursor: pointer;
        }

        .mic-icon.recording {
            color: #ff3333;
            animation: pulse 1.5s infinite;
        }

        .mic-icon.processing {
            color: #ff6b35;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            0% { transform: translateY(-50%) rotate(0deg); }
            100% { transform: translateY(-50%) rotate(360deg); }
        }

        .input-wrapper:focus-within {
            border-color: transparent;
            box-shadow: 0 0 0 2px rgba(255, 165, 0, 0.4), 0 0 8px rgba(255, 165, 0, 0.2);
        }

        .message-input {
            flex: 1;
            background: transparent;
            border: none !important;
            outline: none !important;
            box-shadow: none !important;
            color: var(--vscode-input-foreground);
            resize: none;
            min-height: 20px;
            max-height: 120px;
            font-family: inherit;
            font-size: 14px;
            line-height: 1.4;
            padding-left: 24px; /* Make room for mic icon */
        }

        .message-input:focus {
            border: none !important;
            outline: none !important;
            box-shadow: none !important;
        }

        .message-input:focus-visible {
            border: none !important;
            outline: none !important;
            box-shadow: none !important;
        }

        .message-input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }

        .message-input:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .message-input.paste-highlight {
            box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.4) !important;
            transition: box-shadow 0.2s ease;
        }

        .attach-button {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            font-size: 14px;
            padding: 4px;
            border-radius: 50%;
            width: 28px;
            height: 28px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s ease;
        }

        .attach-button:hover {
            background: var(--vscode-button-hoverBackground);
            transform: scale(1.1);
        }

        .attach-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }

        .send-button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 50%;
            width: 36px;
            height: 36px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s ease;
            font-size: 14px;
        }

        .send-button:hover {
            background: var(--vscode-button-hoverBackground);
            transform: scale(1.05);
        }

        .send-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }

        .typing-indicator {
            display: none;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            font-size: 12px;
            opacity: 0.7;
        }

        .typing-dots {
            display: flex;
            gap: 2px;
        }

        .typing-dot {
            width: 4px;
            height: 4px;
            background: var(--vscode-foreground);
            border-radius: 50%;
            animation: typingDot 1.4s infinite ease-in-out;
        }

        .typing-dot:nth-child(1) { animation-delay: -0.32s; }
        .typing-dot:nth-child(2) { animation-delay: -0.16s; }

        @keyframes typingDot {
            0%, 80%, 100% { transform: scale(0); }
            40% { transform: scale(1); }
        }

        .mcp-status {
            font-size: 11px;
            opacity: 0.6;
            margin-left: 4px;
        }

        /* Drag and drop styling */
        body.drag-over {
            background: rgba(0, 123, 255, 0.05);
        }

        body.drag-over::before {
            content: 'Drop images here to attach them';
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 16px 24px 16px 48px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            z-index: 1000;
            pointer-events: none;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            font-family: var(--vscode-font-family);
        }

        body.drag-over::after {
            content: '\\f093';
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%) translate(-120px, 0);
            color: var(--vscode-badge-foreground);
            font-size: 16px;
            z-index: 1001;
            pointer-events: none;
            font-family: 'Font Awesome 6 Free';
            font-weight: 900;
        }

        /* Image preview styling */
        .image-preview {
            position: relative;
        }

        .image-container {
            position: relative;
        }

        .image-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }

        .image-filename {
            font-size: 12px;
            font-weight: 500;
            opacity: 0.9;
            flex: 1;
            margin-right: 8px;
            word-break: break-all;
        }

        .remove-image-btn {
            background: rgba(255, 59, 48, 0.1);
            border: 1px solid rgba(255, 59, 48, 0.3);
            color: #ff3b30;
            border-radius: 50%;
            width: 20px;
            height: 20px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            transition: all 0.2s ease;
            flex-shrink: 0;
        }

        .remove-image-btn:hover {
            background: rgba(255, 59, 48, 0.2);
            border-color: rgba(255, 59, 48, 0.5);
            transform: scale(1.1);
        }

        .remove-image-btn:active {
            transform: scale(0.95);
        }
    </style>
</head>
<body>
    <div class="review-container">
        <div class="review-header">
            <div class="review-title">${title}</div>
            <div class="status-indicator" id="statusIndicator"></div>
            <div class="mcp-status" id="mcpStatus">Checking MCP...</div>
            <div class="review-author">by Lakshman Turlapati</div>
        </div>

        <div class="messages-container" id="messages">
            <!-- Messages will be added here -->
        </div>

        <div class="typing-indicator" id="typingIndicator">
            <span>Processing review</span>
            <div class="typing-dots">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            </div>
        </div>

        <div class="input-container" id="inputContainer">
            <div class="input-wrapper">
                <i id="micIcon" class="fas fa-microphone mic-icon active" title="Click to speak"></i>
                <textarea id="messageInput" class="message-input" placeholder="${
                  mcpIntegration
                    ? "Cursor Agent is waiting for your response..."
                    : "Type your review or feedback..."
                }" rows="1"></textarea>
                <button id="attachButton" class="attach-button" title="Upload image">
                    <i class="fas fa-image"></i>
                </button>
            </div>
            <button id="sendButton" class="send-button" title="Send ${
              mcpIntegration ? "response to Agent" : "review"
            }">
                <i class="fas fa-arrow-up"></i>
            </button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        const messagesContainer = document.getElementById('messages');
        const messageInput = document.getElementById('messageInput');
        const sendButton = document.getElementById('sendButton');
        const attachButton = document.getElementById('attachButton');
        const micIcon = document.getElementById('micIcon');
        const typingIndicator = document.getElementById('typingIndicator');
        const statusIndicator = document.getElementById('statusIndicator');
        const mcpStatus = document.getElementById('mcpStatus');
        const inputContainer = document.getElementById('inputContainer');

        let messageCount = 0;
        let mcpActive = true; // Default to true for better UX
        let mcpIntegration = ${mcpIntegration};
        let attachedImages = []; // Store uploaded images
        let isRecording = false;
        let mediaRecorder = null;

        function updateMcpStatus(active) {
            mcpActive = active;

            if (active) {
                statusIndicator.classList.add('active');
                mcpStatus.textContent = 'MCP Active';
                inputContainer.classList.remove('disabled');
                messageInput.disabled = false;
                sendButton.disabled = false;
                attachButton.disabled = false;
                messageInput.placeholder = mcpIntegration ? 'Cursor Agent is waiting for your response...' : 'Type your review or feedback...';
            } else {
                statusIndicator.classList.remove('active');
                mcpStatus.textContent = 'MCP Inactive';
                inputContainer.classList.add('disabled');
                messageInput.disabled = true;
                sendButton.disabled = true;
                attachButton.disabled = true;
                messageInput.placeholder = 'MCP server is not active. Please start the server to enable input.';
            }
        }

        function addMessage(text, type = 'user', toolData = null, plain = false, isError = false) {
            messageCount++;
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${type}\${plain ? ' plain' : ''}\`;

            const contentDiv = document.createElement('div');
            contentDiv.className = plain ? 'message-content' : 'message-bubble';
            contentDiv.textContent = text;

            // Add special styling for speech errors
            if (isError && plain) {
                contentDiv.setAttribute('data-speech-error', 'true');
            }

            messageDiv.appendChild(contentDiv);

            // Only add timestamp for non-plain messages
            if (!plain) {
                const timeDiv = document.createElement('div');
                timeDiv.className = 'message-time';
                timeDiv.textContent = new Date().toLocaleTimeString();
                messageDiv.appendChild(timeDiv);
            }

            messagesContainer.appendChild(messageDiv);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        function addSpeechError(errorMessage) {
            // Add prominent error message with special styling
            addMessage('🎤 Speech Error: ' + errorMessage, 'system', null, true, true);

            // Add helpful troubleshooting tips based on error type
            let tip = '';
            if (errorMessage.includes('permission') || errorMessage.includes('Permission')) {
                tip = '💡 Grant microphone access in system settings';
            } else if (errorMessage.includes('busy') || errorMessage.includes('device')) {
                tip = '💡 Close other recording apps and try again';
            } else if (errorMessage.includes('SoX') || errorMessage.includes('sox')) {
                tip = '💡 SoX audio tool may need to be installed or updated';
            } else if (errorMessage.includes('timeout')) {
                tip = '💡 Try speaking more clearly or check microphone connection';
            } else if (errorMessage.includes('Whisper') || errorMessage.includes('transcription')) {
                tip = '💡 Speech-to-text service may be unavailable';
            } else {
                tip = '💡 Check microphone permissions and try again';
            }

            if (tip) {
                setTimeout(() => {
                    addMessage(tip, 'system', null, true);
                }, 500);
            }
        }

        function showTyping() {
            typingIndicator.style.display = 'flex';
        }

        function hideTyping() {
            typingIndicator.style.display = 'none';
        }

        function simulateResponse(userMessage) {
            // Don't simulate response - the backend handles acknowledgments now
            // This avoids duplicate messages
            hideTyping();
        }

        function sendMessage() {
            const text = messageInput.value.trim();
            if (!text && attachedImages.length === 0) return;

            // Create message with text and images
            let displayMessage = text;
            if (attachedImages.length > 0) {
                displayMessage += (text ? '\\n\\n' : '') + \`[\${attachedImages.length} image(s) attached]\`;
            }

            addMessage(displayMessage, 'user');

            // Send to extension with images
            vscode.postMessage({
                command: 'send',
                text: text,
                attachments: attachedImages,
                timestamp: new Date().toISOString(),
                mcpIntegration: mcpIntegration
            });

            messageInput.value = '';
            attachedImages = []; // Clear attached images
            adjustTextareaHeight();

            // Ensure mic icon is visible after sending message
            toggleMicIcon();

            simulateResponse(displayMessage);
        }

        function adjustTextareaHeight() {
            messageInput.style.height = 'auto';
            messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
        }

        function handleImageUploaded(imageData) {
            // Add image to attachments with unique ID
            const imageId = 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            imageData.id = imageId;
            attachedImages.push(imageData);

            // Show image preview in messages with remove button
            const imagePreview = document.createElement('div');
            imagePreview.className = 'message system image-preview';
            imagePreview.setAttribute('data-image-id', imageId);
            imagePreview.innerHTML = \`
                <div class="message-bubble image-container">
                    <div class="image-header">
                        <span class="image-filename">\${imageData.fileName}</span>
                        <button class="remove-image-btn" onclick="removeImage('\${imageId}')" title="Remove image">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                    <img src="\${imageData.dataUrl}" style="max-width: 200px; max-height: 200px; border-radius: 8px; margin-top: 8px;" alt="Uploaded image">
                    <div style="margin-top: 8px; font-size: 12px; opacity: 0.7;">Image ready to send (\${(imageData.size / 1024).toFixed(1)} KB)</div>
                </div>
                <div class="message-time">\${new Date().toLocaleTimeString()}</div>
            \`;
            messagesContainer.appendChild(imagePreview);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;

            updateImageCounter();
        }

        // Remove image function
        function removeImage(imageId) {
            // Remove from attachments array
            attachedImages = attachedImages.filter(img => img.id !== imageId);

            // Remove from DOM
            const imagePreview = document.querySelector(\`[data-image-id="\${imageId}"]\`);
            if (imagePreview) {
                imagePreview.remove();
            }

            updateImageCounter();

            // Log removal
            console.log(\`🗑️ Image removed: \${imageId}\`);
            vscode.postMessage({
                command: 'logImageRemoved',
                imageId: imageId
            });
        }

        // Update image counter in input placeholder
        function updateImageCounter() {
            const count = attachedImages.length;
            const baseText = mcpIntegration ? 'Cursor Agent is waiting for your response' : 'Type your review or feedback';

            if (count > 0) {
                messageInput.placeholder = \`\${baseText}... \${count} image(s) attached\`;
            } else {
                messageInput.placeholder = \`\${baseText}...\`;
            }
        }

        // Handle paste events for images with debounce to prevent duplicates
        let lastPasteTime = 0;
        function handlePaste(e) {
            const now = Date.now();
            // Prevent duplicate pastes within 500ms
            if (now - lastPasteTime < 500) {
                return;
            }

            const clipboardData = e.clipboardData || window.clipboardData;
            if (!clipboardData) return;

            const items = clipboardData.items;
            if (!items) return;

            // Look for image items in clipboard
            for (let i = 0; i < items.length; i++) {
                const item = items[i];

                if (item.type.indexOf('image') !== -1) {
                    e.preventDefault(); // Prevent default paste behavior for images
                    lastPasteTime = now; // Update last paste time

                    const file = item.getAsFile();
                    if (file) {
                        processPastedImage(file);
                    }
                    break;
                }
            }
        }

        // Process pasted image file
        function processPastedImage(file) {
            const reader = new FileReader();

            reader.onload = function(e) {
                const dataUrl = e.target.result;
                const base64Data = dataUrl.split(',')[1];

                // Generate a filename with timestamp
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const extension = file.type.split('/')[1] || 'png';
                const fileName = \`pasted-image-\${timestamp}.\${extension}\`;

                const imageData = {
                    fileName: fileName,
                    filePath: 'clipboard', // Indicate this came from clipboard
                    mimeType: file.type,
                    base64Data: base64Data,
                    dataUrl: dataUrl,
                    size: file.size,
                    source: 'paste' // Mark as pasted image
                };

                console.log(\`📋 Image pasted: \${fileName} (\${file.size} bytes)\`);

                // Log the pasted image for MCP integration
                vscode.postMessage({
                    command: 'logPastedImage',
                    fileName: fileName,
                    size: file.size,
                    mimeType: file.type
                });

                // Add to attachments and show preview
                handleImageUploaded(imageData);
            };

            reader.onerror = function() {
                console.error('Error reading pasted image');
                addMessage('❌ Error processing pasted image', 'system', null, true);
            };

            reader.readAsDataURL(file);
        }

        // Drag and drop handlers
        let dragCounter = 0;

        function handleDragEnter(e) {
            e.preventDefault();
            dragCounter++;
            if (hasImageFiles(e.dataTransfer)) {
                document.body.classList.add('drag-over');
                messageInput.classList.add('paste-highlight');
            }
        }

        function handleDragLeave(e) {
            e.preventDefault();
            dragCounter--;
            if (dragCounter <= 0) {
                document.body.classList.remove('drag-over');
                messageInput.classList.remove('paste-highlight');
                dragCounter = 0;
            }
        }

        function handleDragOver(e) {
            e.preventDefault();
            if (hasImageFiles(e.dataTransfer)) {
                e.dataTransfer.dropEffect = 'copy';
            }
        }

        function handleDrop(e) {
            e.preventDefault();
            dragCounter = 0;
            document.body.classList.remove('drag-over');
            messageInput.classList.remove('paste-highlight');

            const files = e.dataTransfer.files;
            if (files && files.length > 0) {
                // Process files with a small delay to prevent conflicts with paste events
                setTimeout(() => {
                    for (let i = 0; i < files.length; i++) {
                        const file = files[i];
                        if (file.type.startsWith('image/')) {
                            // Log drag and drop action
                            vscode.postMessage({
                                command: 'logDragDropImage',
                                fileName: file.name,
                                size: file.size,
                                mimeType: file.type
                            });
                            processPastedImage(file);
                        }
                    }
                }, 50);
            }
        }

        function hasImageFiles(dataTransfer) {
            if (dataTransfer.types) {
                for (let i = 0; i < dataTransfer.types.length; i++) {
                    if (dataTransfer.types[i] === 'Files') {
                        return true; // We'll check for images on drop
                    }
                }
            }
            return false;
        }

        // Hide/show mic icon based on input
        function toggleMicIcon() {
            // Don't toggle if we're currently recording or processing
            if (isRecording || micIcon.classList.contains('processing')) {
                return;
            }

            if (messageInput.value.trim().length > 0) {
                micIcon.style.opacity = '0';
                micIcon.style.pointerEvents = 'none';
            } else {
                // Always ensure mic is visible and clickable when input is empty
                micIcon.style.opacity = '0.7';
                micIcon.style.pointerEvents = 'auto';
                // Ensure proper mic icon state
                if (!micIcon.classList.contains('fa-microphone')) {
                    micIcon.className = 'fas fa-microphone mic-icon active';
                }
            }
        }

        // Check if speech recording is available
        function isSpeechAvailable() {
            return (
                navigator.mediaDevices &&
                navigator.mediaDevices.getUserMedia &&
                typeof MediaRecorder !== 'undefined'
            );
        }

        // Speech recording functions - using Node.js backend
        function startRecording() {
            // Start recording via extension backend
            vscode.postMessage({
                command: 'startRecording',
                timestamp: new Date().toISOString()
            });

            isRecording = true;
            // Change icon to stop icon and add recording state
            micIcon.className = 'fas fa-stop mic-icon recording';
            micIcon.title = 'Recording... Click to stop';
            console.log('🎤 Recording started - UI updated to stop icon');
        }

        function stopRecording() {
            // Stop recording via extension backend
            vscode.postMessage({
                command: 'stopRecording',
                timestamp: new Date().toISOString()
            });

            isRecording = false;
            // Change to processing state
            micIcon.className = 'fas fa-spinner mic-icon processing';
            micIcon.title = 'Processing speech...';
            messageInput.placeholder = 'Processing speech... Please wait';
            console.log('🔄 Recording stopped - processing speech...');
        }

        function resetMicIcon() {
            // Reset to normal microphone state
            isRecording = false; // Ensure recording flag is cleared
            micIcon.className = 'fas fa-microphone mic-icon active';
            micIcon.title = 'Click to speak';
            messageInput.placeholder = mcpIntegration ? 'Cursor Agent is waiting for your response...' : 'Type your review or feedback...';

            // Force visibility based on input state
            if (messageInput.value.trim().length === 0) {
                micIcon.style.opacity = '0.7';
                micIcon.style.pointerEvents = 'auto';
            } else {
                micIcon.style.opacity = '0';
                micIcon.style.pointerEvents = 'none';
            }

            console.log('🎤 Mic icon reset to normal state');
        }

        // Event listeners
        messageInput.addEventListener('input', () => {
            adjustTextareaHeight();
            toggleMicIcon();
        });

        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // Add paste event listener for images
        messageInput.addEventListener('paste', handlePaste);
        document.addEventListener('paste', handlePaste);

        // Add drag and drop support for images
        document.addEventListener('dragover', handleDragOver);
        document.addEventListener('drop', handleDrop);
        document.addEventListener('dragenter', handleDragEnter);
        document.addEventListener('dragleave', handleDragLeave);

        sendButton.addEventListener('click', () => {
            sendMessage();
        });

        attachButton.addEventListener('click', () => {
            vscode.postMessage({ command: 'uploadImage' });
        });

        micIcon.addEventListener('click', () => {
            if (isRecording) {
                stopRecording();
            } else {
                startRecording();
            }
        });

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;

            switch (message.command) {
                case 'addMessage':
                    addMessage(message.text, message.type || 'system', message.toolData, message.plain || false);
                    break;
                case 'newMessage':
                    addMessage(message.text, message.type || 'system', message.toolData, message.plain || false);
                    if (message.mcpIntegration) {
                        mcpIntegration = true;
                        messageInput.placeholder = 'Cursor Agent is waiting for your response...';
                    }
                    break;
                case 'focus':
                    messageInput.focus();
                    break;
                case 'updateMcpStatus':
                    updateMcpStatus(message.active);
                    break;
                case 'imageUploaded':
                    handleImageUploaded(message.imageData);
                    break;
                case 'recordingStarted':
                    console.log('✅ Recording confirmation received from backend');
                    break;
                case 'speechTranscribed':
                    // Handle speech-to-text result
                    console.log('📝 Speech transcription received:', message);
                    if (message.transcription && message.transcription.trim()) {
                        messageInput.value = message.transcription.trim();
                        adjustTextareaHeight();
                        messageInput.focus();
                        console.log('✅ Text injected into input:', message.transcription.trim());
                        // Reset mic icon after successful transcription
                        resetMicIcon();
                    } else if (message.error) {
                        console.error('❌ Speech transcription error:', message.error);

                        // Show prominent error message in chat
                        addSpeechError(message.error);

                        // Also show in placeholder briefly
                        const originalPlaceholder = messageInput.placeholder;
                        messageInput.placeholder = 'Speech failed - try again';
                        setTimeout(() => {
                            messageInput.placeholder = originalPlaceholder;
                            resetMicIcon();
                        }, 3000);
                    } else {
                        console.log('⚠️ Empty transcription received');

                        // Show helpful message in chat
                        addMessage('🎤 No speech detected - please speak clearly and try again', 'system', null, true);

                        const originalPlaceholder = messageInput.placeholder;
                        messageInput.placeholder = 'No speech detected - try again';
                        setTimeout(() => {
                            messageInput.placeholder = originalPlaceholder;
                            resetMicIcon();
                        }, 3000);
                    }
                    break;
            }
        });

        // Initialize speech availability - now using SoX directly
        function initializeSpeech() {
            // Always available since we're using SoX directly
            micIcon.style.opacity = '0.7';
            micIcon.style.pointerEvents = 'auto';
            micIcon.title = 'Click to speak (SoX recording)';
            micIcon.classList.add('active');
            console.log('Speech recording available via SoX direct recording');

            // Ensure mic icon visibility on initialization
            if (messageInput.value.trim().length === 0) {
                micIcon.style.opacity = '0.7';
                micIcon.style.pointerEvents = 'auto';
            }
        }

        // Make removeImage globally accessible for onclick handlers
        window.removeImage = removeImage;

        // Initialize
        vscode.postMessage({ command: 'ready' });
        initializeSpeech();

        // Focus input immediately
        setTimeout(() => {
            messageInput.focus();
        }, 100);
    </script>
</body>
</html>`;
}

module.exports = {
  openReviewGatePopup,
};
