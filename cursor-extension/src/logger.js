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
  } catch (error) {
    logMessage(`Could not write to Review Gate log file: ${error.message}`);
  }
}

module.exports = {
  logMessage,
  logUserInput,
};
