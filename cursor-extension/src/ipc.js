const fs = require("node:fs");
const path = require("node:path");
const state = require("./state");
const {
  REVIEW_GATE_PROTOCOL,
  atomicWriteJson,
  createTriggerTracker,
  getAckFilePath,
  getProgressFilePath,
  getTriggerFilePath,
} = require("./ipcFiles");

const DEFAULT_TRIGGER_TOOL = "review_gate_chat";
const FALLBACK_PROTOCOL_VERSION = "legacy";
const TRIGGER_STALE_AFTER_MS = 10 * 60 * 1000;
const PROGRESS_STALE_AFTER_MS = 2 * 60 * 1000;
const ARTIFACT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// Lazy load webview to avoid circular dependency
let webviewModule = null;
const handledTriggers = createTriggerTracker();

function getWebviewModule() {
  if (!webviewModule) {
    webviewModule = require("./webview");
  }
  return webviewModule;
}

function ensureExtensionInstanceId() {
  if (!state.extensionInstanceId) {
    state.extensionInstanceId = `review-gate-extension-${process.pid}-${Date.now().toString(36)}`;
  }
  return state.extensionInstanceId;
}

function appendTransportLog(message) {
  const line = `[transport] ${message}`;
  console.log(line);
  if (state.outputChannel) {
    state.outputChannel.appendLine(line);
  }
}

function parseTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatRecovery(problem, cause, fix) {
  return { problem, cause, fix };
}

function postTransportRecovery(recovery) {
  state.currentRecovery = recovery;
  if (state.chatPanel?.webview) {
    state.chatPanel.webview.postMessage({
      command: "transportRecovery",
      recovery,
    });
  }
}

function clearTransportRecovery() {
  state.currentRecovery = null;
}

function cleanupArtifact(filePath, reason) {
  try {
    fs.unlinkSync(filePath);
    appendTransportLog(`${reason}: ${path.basename(filePath)}`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      appendTransportLog(`Cleanup failed for ${path.basename(filePath)}: ${error.message}`);
    }
  }
}

function quarantineArtifact(filePath, reason, suffix = "invalid") {
  const quarantinePath = `${filePath}.${Date.now()}.${suffix}`;
  try {
    fs.renameSync(filePath, quarantinePath);
    appendTransportLog(`${reason}: ${path.basename(quarantinePath)}`);
    return quarantinePath;
  } catch (error) {
    appendTransportLog(`Quarantine failed for ${path.basename(filePath)}: ${error.message}`);
    cleanupArtifact(filePath, `Deleted ${reason.toLowerCase()} artifact`);
    return null;
  }
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function normalizeToolData(triggerData, now = Date.now()) {
  const root = normalizeObject(triggerData);
  if (!root) {
    return { error: formatRecovery("Malformed request payload.", "Trigger payload was not a JSON object.", "Retry after the request is rewritten.") };
  }

  if (root.editor && root.editor !== "cursor") {
    return { ignored: "non-cursor trigger" };
  }

  if (root.system && root.system !== REVIEW_GATE_PROTOCOL) {
    return { ignored: "foreign protocol trigger" };
  }

  const nested = normalizeObject(root.data);
  const nestedPayload = normalizeObject(nested?.payload);
  const basePayload = {
    ...(nestedPayload || {}),
    ...(nested || {}),
    ...root,
  };

  delete basePayload.data;
  delete basePayload.payload;
  delete basePayload.editor;
  delete basePayload.system;

  const triggerId =
    (typeof basePayload.trigger_id === "string" && basePayload.trigger_id) ||
    (typeof basePayload.triggerId === "string" && basePayload.triggerId) ||
    null;

  if (!triggerId) {
    return {
      error: formatRecovery(
        "Malformed request payload.",
        "Trigger payload was missing trigger_id.",
        "Retry after the request is regenerated."
      ),
    };
  }

  const protocolVersion =
    (typeof basePayload.protocol_version === "string" && basePayload.protocol_version) ||
    FALLBACK_PROTOCOL_VERSION;
  const sessionId =
    (typeof basePayload.session_id === "string" && basePayload.session_id) ||
    (typeof basePayload.sessionId === "string" && basePayload.sessionId) ||
    triggerId;
  const requestType =
    (typeof basePayload.request_type === "string" && basePayload.request_type) ||
    (typeof basePayload.tool === "string" && basePayload.tool) ||
    DEFAULT_TRIGGER_TOOL;

  const createdAt =
    (typeof basePayload.created_at === "string" && basePayload.created_at) ||
    (typeof basePayload.timestamp === "string" && basePayload.timestamp) ||
    new Date(now).toISOString();
  const createdAtMs = parseTimestamp(createdAt) || now;
  const expiresAt =
    (typeof basePayload.expires_at === "string" && basePayload.expires_at) ||
    (typeof basePayload.expiresAt === "string" && basePayload.expiresAt) ||
    null;
  const expiresAtMs = parseTimestamp(expiresAt);

  if (expiresAt && !expiresAtMs) {
    return {
      error: formatRecovery(
        "Malformed request payload.",
        "Trigger payload included an invalid expires_at timestamp.",
        "Retry after the request is regenerated."
      ),
    };
  }

  if (expiresAtMs && expiresAtMs <= now) {
    return {
      stale: true,
      error: formatRecovery(
        "Request expired before delivery.",
        "Trigger expires_at timestamp is already in the past.",
        "Retry from the MCP client to create a fresh request."
      ),
    };
  }

  if (now - createdAtMs > TRIGGER_STALE_AFTER_MS) {
    return {
      stale: true,
      error: formatRecovery(
        "Stale request recovered.",
        "Trigger file was older than the active transport window.",
        "Retry from the MCP client to create a fresh request."
      ),
    };
  }

  basePayload.tool = requestType;
  basePayload.trigger_id = triggerId;
  basePayload.session_id = sessionId;
  basePayload.protocol_version = protocolVersion;
  basePayload.request_type = requestType;
  basePayload.created_at = createdAt;
  basePayload.expires_at = expiresAt;

  return {
    toolData: basePayload,
    envelope: {
      triggerId,
      sessionId,
      protocolVersion,
      requestType,
      createdAt,
      createdAtMs,
      expiresAt,
      expiresAtMs,
    },
  };
}

function normalizeProgressPayload(progressData, activeTriggerId, now = Date.now()) {
  const root = normalizeObject(progressData);
  if (!root) {
    return {
      error: formatRecovery(
        "Malformed progress payload.",
        "Progress payload was not a JSON object.",
        "Wait for the next transport update or retry the request."
      ),
    };
  }

  if (root.system && root.system !== REVIEW_GATE_PROTOCOL) {
    return { ignored: "foreign progress update" };
  }

  const nested = normalizeObject(root.data);
  const nestedPayload = normalizeObject(nested?.payload);
  const data = {
    ...(nestedPayload || {}),
    ...(nested || {}),
    ...root,
  };

  delete data.data;
  delete data.payload;
  delete data.system;

  const triggerId =
    (typeof data.trigger_id === "string" && data.trigger_id) ||
    (typeof data.triggerId === "string" && data.triggerId) ||
    null;

  if (activeTriggerId && triggerId && triggerId !== activeTriggerId) {
    return { ignored: `progress update for ${triggerId}` };
  }

  if (activeTriggerId && !triggerId) {
    return {
      error: formatRecovery(
        "Malformed progress payload.",
        "Progress update was missing trigger_id for the active request.",
        "Wait for the next transport update or retry the request."
      ),
    };
  }

  const progressTimestamp =
    (typeof data.updated_at === "string" && data.updated_at) ||
    (typeof data.timestamp === "string" && data.timestamp) ||
    new Date(now).toISOString();
  const progressTimestampMs = parseTimestamp(progressTimestamp) || now;

  if (now - progressTimestampMs > PROGRESS_STALE_AFTER_MS) {
    return { ignored: "stale progress update" };
  }

  const numericPercentage = Number(data.percentage);
  const percentage = Number.isFinite(numericPercentage)
    ? Math.max(0, Math.min(100, numericPercentage))
    : 0;

  return {
    progress: {
      triggerId: triggerId || activeTriggerId || null,
      sessionId:
        (typeof data.session_id === "string" && data.session_id) ||
        (typeof data.sessionId === "string" && data.sessionId) ||
        null,
      title: typeof data.title === "string" && data.title ? data.title : "Delivery progress",
      percentage,
      step: typeof data.step === "string" && data.step ? data.step : "Transport update received",
      status: typeof data.status === "string" && data.status ? data.status : "active",
      updatedAt: progressTimestamp,
    },
  };
}

function pruneStaleArtifacts(now = Date.now()) {
  const transportDir = path.dirname(getTriggerFilePath());
  let removed = 0;

  try {
    const files = fs.readdirSync(transportDir);
    for (const fileName of files) {
      if (!/^review_gate_(trigger|progress|ack_|response_)/.test(fileName)) {
        continue;
      }

      const filePath = path.join(transportDir, fileName);
      let stats;

      try {
        stats = fs.statSync(filePath);
      } catch {
        continue;
      }

      if (now - stats.mtimeMs <= ARTIFACT_STALE_AFTER_MS) {
        continue;
      }

      cleanupArtifact(filePath, "Removed stale transport artifact");
      removed += 1;
    }
  } catch (error) {
    appendTransportLog(`Artifact pruning failed: ${error.message}`);
  }

  return removed;
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
  const prunedArtifacts = pruneStaleArtifacts();

  if (prunedArtifacts > 0) {
    appendTransportLog(`Recovered ${prunedArtifacts} stale transport artifact(s) on startup`);
  }

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
}

function checkProgressFile() {
  const progressFilePath = getProgressFilePath();

  try {
    if (fs.existsSync(progressFilePath)) {
      const normalized = normalizeProgressPayload(
        readJsonFile(progressFilePath),
        state.currentTransport?.triggerId || state.currentTriggerData?.trigger_id || null
      );

      if (normalized.ignored) {
        cleanupArtifact(progressFilePath, `Discarded ${normalized.ignored}`);
        return;
      }

      if (normalized.error) {
        quarantineArtifact(progressFilePath, normalized.error.problem, "progress-invalid");
        postTransportRecovery(normalized.error);
        return;
      }

      appendTransportLog(
        `Progress ${Math.round(normalized.progress.percentage)}% for ${normalized.progress.triggerId || "manual"}`
      );

      if (state.chatPanel?.webview) {
        state.chatPanel.webview.postMessage({
          command: "updateProgress",
          data: normalized.progress,
        });
      }

      cleanupArtifact(progressFilePath, "Consumed progress update");
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      quarantineArtifact(progressFilePath, "Malformed progress payload", "progress-json");
      postTransportRecovery(
        formatRecovery(
          "Malformed progress payload.",
          "Progress file was not valid JSON.",
          "Wait for the next transport update or retry the request."
        )
      );
      return;
    }

    if (error.code !== "ENOENT") {
      appendTransportLog(`Progress read failed: ${error.message}`);
    }
  }
}

function checkTriggerFile(context, filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const normalized = normalizeToolData(readJsonFile(filePath));

      if (normalized.ignored) {
        cleanupArtifact(filePath, `Discarded ${normalized.ignored}`);
        return;
      }

      if (normalized.error) {
        if (normalized.stale) {
          cleanupArtifact(filePath, normalized.error.problem);
        } else {
          quarantineArtifact(filePath, normalized.error.problem, "trigger-invalid");
        }
        postTransportRecovery(normalized.error);
        return;
      }

      const { toolData, envelope } = normalized;

      if (!handledTriggers.markHandled(envelope.triggerId)) {
        cleanupArtifact(filePath, `Discarded duplicate trigger ${envelope.triggerId}`);
        return;
      }

      appendTransportLog(`Trigger accepted: ${toolData.tool} (${envelope.triggerId})`);
      state.currentTriggerData = toolData;
      state.currentTransport = {
        ...envelope,
        status: "received",
      };
      clearTransportRecovery();

      handleReviewGateToolCall(context, toolData);

      cleanupArtifact(filePath, "Consumed trigger");
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      quarantineArtifact(filePath, "Malformed trigger payload", "trigger-json");
      postTransportRecovery(
        formatRecovery(
          "Malformed request payload.",
          "Trigger file was not valid JSON.",
          "Retry after the request is regenerated."
        )
      );
      return;
    }

    if (error.code !== "ENOENT") {
      appendTransportLog(`Trigger read failed: ${error.message}`);
    }
  }
}

function handleReviewGateToolCall(context, toolData) {
  let popupOptions;
  const toolName = typeof toolData.tool === "string" ? toolData.tool : "review_gate_chat";

  switch (toolName) {
    case "review_gate":
    case "review_gate_chat":
      popupOptions = {
        message: toolData.message || "Please provide your review or feedback:",
        title: toolData.title || "Review Gate",
        autoFocus: true,
        toolData: toolData,
        mcpIntegration: true,
      };
      break;

    // ... (other cases simplified for brevity, logic is same as before)
    default:
      popupOptions = {
        message: toolData.message || "Cursor Agent needs your input.",
        title: "Review Gate",
        autoFocus: true,
        toolData: toolData,
        mcpIntegration: true,
      };
  }

  // Add trigger ID
  popupOptions.triggerId = toolData.trigger_id;
  popupOptions.sessionId = toolData.session_id;

  // Open popup using lazy loaded module
  const webview = getWebviewModule();
  webview.openReviewGatePopup(context, popupOptions);

  sendExtensionAcknowledgement(toolData, toolName);
}

function sendExtensionAcknowledgement(toolData, toolType) {
  try {
    const triggerId = toolData.trigger_id;
    const timestamp = new Date().toISOString();
    const ackData = {
      protocol_version: toolData.protocol_version || FALLBACK_PROTOCOL_VERSION,
      acknowledged: true,
      timestamp: timestamp,
      acknowledged_at: timestamp,
      trigger_id: triggerId,
      session_id: toolData.session_id || triggerId,
      request_type: toolData.request_type || toolType,
      tool_type: toolType,
      extension: REVIEW_GATE_PROTOCOL,
      extension_instance_id: ensureExtensionInstanceId(),
      status: "accepted",
      popup_activated: true,
    };

    const ackFile = getAckFilePath(triggerId);
    atomicWriteJson(ackFile, ackData);
    if (state.currentTransport?.triggerId === triggerId) {
      state.currentTransport = {
        ...state.currentTransport,
        status: "acknowledged",
        acknowledgedAt: timestamp,
      };
    }
    appendTransportLog(`Acknowledged trigger ${triggerId}`);
  } catch (error) {
    const recovery = formatRecovery(
      "Request delivery failed.",
      `Acknowledgement write failed: ${error.message}`,
      "Retry after the extension regains write access to the transport directory."
    );
    postTransportRecovery(recovery);
    appendTransportLog(`Acknowledgement failed: ${error.message}`);
  }
}

module.exports = {
  startMcpStatusMonitoring,
  startReviewGateIntegration,
  updateChatPanelStatus,
  __test: {
    normalizeProgressPayload,
    normalizeToolData,
    pruneStaleArtifacts,
  },
};
