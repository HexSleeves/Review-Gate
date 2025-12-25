const fs = require("fs");
const state = require("./state");
const { getTempPath } = require("./utils");

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
      // Write multiple response file patterns for better compatibility
      const responsePatterns = [
        getTempPath(`review_gate_response_${triggerId}.json`),
        getTempPath("review_gate_response.json"), // Fallback generic response
        getTempPath(`mcp_response_${triggerId}.json`), // Alternative pattern
        getTempPath("mcp_response.json"), // Generic MCP response
      ];

      const responseData = {
        timestamp: timestamp,
        trigger_id: triggerId,
        user_input: inputText,
        response: inputText, // Also provide as 'response' field
        message: inputText, // Also provide as 'message' field
        attachments: attachments, // Include image attachments
        event_type: eventType,
        source: "review_gate_extension",
      };

      const responseJson = JSON.stringify(responseData, null, 2);

      // Write to all response file patterns
      responsePatterns.forEach((responseFile) => {
        try {
          fs.writeFileSync(responseFile, responseJson);
          logMessage(`MCP response written: ${responseFile}`);
        } catch (writeError) {
          logMessage(`Failed to write response file ${responseFile}: ${writeError.message}`);
        }
      });
    }
  } catch (error) {
    logMessage(`Could not write to Review Gate log file: ${error.message}`);
  }
}

module.exports = {
  logMessage,
  logUserInput,
};
