// Global state management for the extension
let state = {
    chatPanel: null,
    reviewGateWatcher: null,
    outputChannel: null,
    mcpStatus: false,
    statusCheckInterval: null,
    currentTriggerData: null,
    currentRecording: null,
    context: null
};

module.exports = state;
