const fs = require("fs");
const state = require("./state");
const { getTempPath } = require("./utils");
const { atomicWriteJson, getResponseFilePath } = require("./ipcFiles");

function logMessage(message) {
  const timestamp = new Date().toISOString();
  const logMsg = `[${timestamp}] ${message}`;
  console.log(logMsg);
  if (state.outputChannel) {
    state.outputChannel.appendLine(logMsg);
  }
}

function logUserInput(inputText, eventType = "MESSAGE", triggerId = null, attachments = []) {
  const timestamp = new Date().toISOString();
  const logMsg = `[${timestamp}] ${eventType}: ${inputText}`;
  console.log(`REVIEW GATE USER INPUT: ${inputText}`);

  if (state.outputChannel) {
    state.outputChannel.appendLine(logMsg);
  }

  // Write to file for external monitoring
  try {
    const logFile = getTempPath("review_gate_user_inputs.log");
    fs.appendFileSync(logFile, `${logMsg}\n`);

    // Write response file for MCP server integration if we have a trigger ID
    if (triggerId && eventType === "MCP_RESPONSE") {
      const responseData = {
        timestamp: timestamp,
        trigger_id: triggerId,
        user_input: inputText,
        response: inputText,
        message: inputText,
        attachments: attachments,
        event_type: eventType,
        source: "review_gate_extension",
      };

      const responseFile = getResponseFilePath(triggerId);
      atomicWriteJson(responseFile, responseData);
      logMessage(`MCP response written: ${responseFile}`);
    }
  } catch (error) {
    logMessage(`Could not write to Review Gate log file: ${error.message}`);
  }
}

module.exports = {
  logMessage,
  logUserInput,
};
