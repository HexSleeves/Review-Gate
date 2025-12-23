const fs = require('fs');
const vscode = require('vscode');
const state = require('./state');
const { getTempPath } = require('./utils');
const { logMessage } = require('./logger');

// Lazy load webview to avoid circular dependency
let webviewModule = null;
function getWebviewModule() {
    if (!webviewModule) {
        webviewModule = require('./webview');
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
        }
    });
}

function checkMcpStatus() {
    try {
        // Check if MCP server log exists and is recent
        const mcpLogPath = getTempPath('review_gate_v2.log');
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
        if (state.mcpStatus) {
            state.mcpStatus = false;
            updateChatPanelStatus();
        }
    }
}

function updateChatPanelStatus() {
    if (state.chatPanel) {
        state.chatPanel.webview.postMessage({
            command: 'updateMcpStatus',
            active: state.mcpStatus
        });
    }
}

function startReviewGateIntegration(context) {
    // Watch for Review Gate trigger file
    const triggerFilePath = getTempPath('review_gate_trigger.json');
    
    // Check for existing trigger file first
    checkTriggerFile(context, triggerFilePath);
    
    // Use a more robust polling approach
    const pollInterval = setInterval(() => {
        // Check main trigger file
        checkTriggerFile(context, triggerFilePath);
        
        // Check backup trigger files
        for (let i = 0; i < 3; i++) {
            const backupTriggerPath = getTempPath(`review_gate_trigger_${i}.json`);
            checkTriggerFile(context, backupTriggerPath);
        }
    }, 250); // Check every 250ms
    
    // Store the interval for cleanup
    state.reviewGateWatcher = pollInterval;
    
    // Add to context subscriptions for proper cleanup
    context.subscriptions.push({
        dispose: () => {
            if (pollInterval) {
                clearInterval(pollInterval);
            }
        }
    });
    
    // Immediate check on startup
    setTimeout(() => {
        checkTriggerFile(context, triggerFilePath);
    }, 100);
    
    vscode.window.showInformationMessage('Review Gate V2 MCP integration ready!');
}

function checkTriggerFile(context, filePath) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            const triggerData = JSON.parse(data);
            
            // Check if this is for Cursor and Review Gate
            if (triggerData.editor && triggerData.editor !== 'cursor') {
                return;
            }
            
            if (triggerData.system && triggerData.system !== 'review-gate-v2') {
                return;
            }
            
            console.log(`Review Gate triggered: ${triggerData.data.tool}`);
            
            // Store current trigger data
            state.currentTriggerData = triggerData.data;
            
            handleReviewGateToolCall(context, triggerData.data);
            
            // Clean up trigger file immediately
            try {
                fs.unlinkSync(filePath);
            } catch (cleanupError) {
                console.log(`Could not clean trigger file: ${cleanupError.message}`);
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.log(`Error reading trigger file: ${error.message}`);
        }
    }
}

function handleReviewGateToolCall(context, toolData) {
    let popupOptions = {};
    
    switch (toolData.tool) {
        case 'review_gate':
        case 'review_gate_chat':
            popupOptions = {
                message: toolData.message || "Please provide your review or feedback:",
                title: toolData.title || "Review Gate V2",
                autoFocus: true,
                toolData: toolData,
                mcpIntegration: true
            };
            break;
            
        // ... (other cases simplified for brevity, logic is same as before)
        default:
            popupOptions = {
                message: toolData.message || "Cursor Agent needs your input.",
                title: "Review Gate V2",
                autoFocus: true,
                toolData: toolData,
                mcpIntegration: true
            };
    }
    
    // Add trigger ID
    popupOptions.triggerId = toolData.trigger_id;
    
    // Open popup using lazy loaded module
    const webview = getWebviewModule();
    webview.openReviewGatePopup(context, popupOptions);
    
    sendExtensionAcknowledgement(toolData.trigger_id, toolData.tool);
    
    const toolDisplayName = toolData.tool.replace('_', ' ').toUpperCase();
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
            extension: 'review-gate-v2',
            popup_activated: true
        };
        
        const ackFile = getTempPath(`review_gate_ack_${triggerId}.json`);
        fs.writeFileSync(ackFile, JSON.stringify(ackData, null, 2));
        
    } catch (error) {
        console.log(`Could not send extension acknowledgement: ${error.message}`);
    }
}

module.exports = {
    startMcpStatusMonitoring,
    startReviewGateIntegration,
    updateChatPanelStatus
};
