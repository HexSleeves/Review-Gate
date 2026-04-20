// Global state management for the extension
let state = {
  chatPanel: null,
  reviewGateWatcher: null,
  outputChannel: null,
  mcpStatus: false,
  statusCheckInterval: null,
  currentTriggerData: null,
  currentTransport: null,
  currentRecovery: null,
  currentRecording: null,
  context: null,
  logFilePath: null,
  extensionInstanceId: null,
};

module.exports = state;
