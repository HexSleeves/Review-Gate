const fs = require("node:fs");
const vscode = require("vscode");
const state = require("./state");
const {
  REVIEW_GATE_PROTOCOL,
  atomicWriteJson,
  createTriggerTracker,
  getAckFilePath,
  getProgressFilePath,
  getTriggerFilePath,
} = require("./ipcFiles");

// Lazy load webview to avoid circular dependency
let webviewModule = null;
const handledTriggers = createTriggerTracker();

function getWebviewModule() {
  if (!webviewModule) {
    webviewModule = require("./webview");
  }
  return webviewModule;
}

function startMcpStatusMonitoring(context) {
  // Check MCP status every 2 seconds
  state.statusCheckInterval = setInterval(() => {
    checkMcpStatus();
  }, 2000);

  // Initial check
  checkMcpStatus();

  // Clean up on extension deactivation
  context.subscriptions.push({
    dispose: () => {
      if (state.statusCheckInterval) {
        clearInterval(state.statusCheckInterval);
      }
    },
  });
}

function checkMcpStatus() {
  try {
    // Check if MCP server log exists and is recent
    const mcpLogPath = state.logFilePath;
    if (!mcpLogPath) {
      return;
    }
    if (fs.existsSync(mcpLogPath)) {
      const stats = fs.statSync(mcpLogPath);
      const now = Date.now();
      const fileAge = now - stats.mtime.getTime();

      // Consider MCP active if log file was modified within last 30 seconds
      const wasActive = state.mcpStatus;
      state.mcpStatus = fileAge < 30000;

      if (wasActive !== state.mcpStatus) {
        updateChatPanelStatus();
      }
    } else {
      if (state.mcpStatus) {
        state.mcpStatus = false;
        updateChatPanelStatus();
      }
    }
  } catch (error) {
    console.error("❌ Error checking MCP status:", error);

    if (state.mcpStatus) {
      state.mcpStatus = false;
      updateChatPanelStatus();
    }
  }
}

function updateChatPanelStatus() {
  if (state.chatPanel) {
    state.chatPanel.webview.postMessage({
      command: "updateMcpStatus",
      active: state.mcpStatus,
    });
  }
}

function startReviewGateIntegration(context) {
  // Watch for Review Gate trigger file
  const triggerFilePath = getTriggerFilePath();

  // Check for existing trigger file first
  checkTriggerFile(context, triggerFilePath);

  // Use a more robust polling approach
  const pollInterval = setInterval(() => {
    checkTriggerFile(context, triggerFilePath);

    // Check progress update file
    checkProgressFile();
  }, 250); // Check every 250ms

  // Store the interval for cleanup
  state.reviewGateWatcher = pollInterval;

  // Add to context subscriptions for proper cleanup
  context.subscriptions.push({
    dispose: () => {
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    },
  });

  // Immediate check on startup
  setTimeout(() => {
    checkTriggerFile(context, triggerFilePath);
  }, 100);

  vscode.window.showInformationMessage("Review Gate V3 MCP integration ready!");
}

function checkProgressFile() {
  try {
    const progressFilePath = getProgressFilePath();

    if (fs.existsSync(progressFilePath)) {
      const data = fs.readFileSync(progressFilePath, "utf8");
      const progressData = JSON.parse(data);

      // Verify this is a progress update from Review Gate
      if (progressData.type === "progress_update" && progressData.system === REVIEW_GATE_PROTOCOL) {
        const { title, percentage, step, status } = progressData.data;

        console.log(`📊 Progress: ${percentage}% - ${step}`);

        // Forward to webview if panel is open
        if (state.chatPanel?.webview) {
          state.chatPanel.webview.postMessage({
            command: "updateProgress",
            data: {
              title,
              percentage,
              step,
              status,
            },
          });
        }
      }

      // Clean up progress file after reading
      try {
        fs.unlinkSync(progressFilePath);
      } catch (cleanupError) {
        console.error("❌ Error cleaning up progress file:", cleanupError);
        // File may have been consumed already
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.log(`Error reading progress file: ${error.message}`);
    }
  }
}

function checkTriggerFile(context, filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, "utf8");
      const triggerData = JSON.parse(data);
      const toolData = normalizeToolData(triggerData);

      // Check if this is for Cursor and Review Gate
      if (triggerData.editor && triggerData.editor !== "cursor") {
        try {
          fs.unlinkSync(filePath);
        } catch (cleanupError) {
          console.log(`Could not clean non-cursor trigger file: ${cleanupError.message}`);
        }
        return;
      }

      if (triggerData.system && triggerData.system !== REVIEW_GATE_PROTOCOL) {
        try {
          fs.unlinkSync(filePath);
        } catch (cleanupError) {
          console.log(`Could not clean non-protocol trigger file: ${cleanupError.message}`);
        }
        return;
      }

      if (!toolData) {
        console.log("Ignoring invalid Review Gate trigger payload");
        try {
          fs.unlinkSync(filePath);
        } catch (cleanupError) {
          console.log(`Could not clean invalid trigger file: ${cleanupError.message}`);
        }
        return;
      }

      const triggerId = toolData.trigger_id;
      if (!handledTriggers.markHandled(triggerId)) {
        console.log(`Ignoring duplicate Review Gate trigger: ${triggerId}`);
        try {
          fs.unlinkSync(filePath);
        } catch (cleanupError) {
          console.log(`Could not clean duplicate trigger file: ${cleanupError.message}`);
        }
        return;
      }

      console.log(`Review Gate triggered: ${toolData.tool}`);

      // Store current trigger data
      state.currentTriggerData = toolData;

      handleReviewGateToolCall(context, toolData);

      // Clean up trigger file immediately
      try {
        fs.unlinkSync(filePath);
      } catch (cleanupError) {
        console.log(`Could not clean trigger file: ${cleanupError.message}`);
      }
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.log(`Invalid trigger JSON, deleting file: ${error.message}`);
      try {
        fs.unlinkSync(filePath);
      } catch (cleanupError) {
        console.log(`Could not clean malformed trigger file: ${cleanupError.message}`);
      }
      return;
    }

    if (error.code !== "ENOENT") {
      console.log(`Error reading trigger file: ${error.message}`);
    }
  }
}

function normalizeToolData(triggerData) {
  if (!triggerData || typeof triggerData !== "object") {
    return null;
  }

  const nested = triggerData.data;
  const payload = nested && typeof nested === "object" ? { ...nested } : { ...triggerData };

  if (!payload.tool) {
    payload.tool = "review_gate_chat";
  }

  if (!payload.trigger_id && typeof triggerData.trigger_id === "string") {
    payload.trigger_id = triggerData.trigger_id;
  }

  if (!payload.message && typeof triggerData.message === "string") {
    payload.message = triggerData.message;
  }

  if (!payload.title && typeof triggerData.title === "string") {
    payload.title = triggerData.title;
  }

  return payload;
}

function handleReviewGateToolCall(context, toolData) {
  let popupOptions = {};
  const toolName = typeof toolData.tool === "string" ? toolData.tool : "review_gate_chat";

  switch (toolName) {
    case "review_gate":
    case "review_gate_chat":
      popupOptions = {
        message: toolData.message || "Please provide your review or feedback:",
        title: toolData.title || "Review Gate V3",
        autoFocus: true,
        toolData: toolData,
        mcpIntegration: true,
      };
      break;

    // ... (other cases simplified for brevity, logic is same as before)
    default:
      popupOptions = {
        message: toolData.message || "Cursor Agent needs your input.",
        title: "Review Gate V3",
        autoFocus: true,
        toolData: toolData,
        mcpIntegration: true,
      };
  }

  // Add trigger ID
  popupOptions.triggerId = toolData.trigger_id;

  // Open popup using lazy loaded module
  const webview = getWebviewModule();
  webview.openReviewGatePopup(context, popupOptions);

  sendExtensionAcknowledgement(toolData.trigger_id, toolName);

  const toolDisplayName = toolName.replaceAll("_", " ").toUpperCase();
  vscode.window.showInformationMessage(`Cursor Agent triggered "${toolDisplayName}"`);
}

function sendExtensionAcknowledgement(triggerId, toolType) {
  try {
    const timestamp = new Date().toISOString();
    const ackData = {
      acknowledged: true,
      timestamp: timestamp,
      trigger_id: triggerId,
      tool_type: toolType,
      extension: REVIEW_GATE_PROTOCOL,
      popup_activated: true,
    };

    const ackFile = getAckFilePath(triggerId);
    atomicWriteJson(ackFile, ackData);
  } catch (error) {
    console.log(`Could not send extension acknowledgement: ${error.message}`);
  }
}

module.exports = {
  startMcpStatusMonitoring,
  startReviewGateIntegration,
  updateChatPanelStatus,
};
