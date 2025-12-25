const vscode = require("vscode");
const state = require("./state");
const {
  startMcpStatusMonitoring,
  startReviewGateIntegration,
} = require("./ipc");
const { openReviewGatePopup } = require("./webview");

function activate(context) {
  console.log(
    "Review Gate V2 extension is now active in Cursor for MCP integration!"
  );

  // Create output channel for logging
  state.outputChannel =
    vscode.window.createOutputChannel("Review Gate V2 ゲート");
  context.subscriptions.push(state.outputChannel);

  // Register command to open Review Gate manually
  let disposable = vscode.commands.registerCommand(
    "reviewGate.openChat",
    () => {
      openReviewGatePopup(context, {
        message:
          "Welcome to Review Gate V2! Please provide your review or feedback.",
        title: "Review Gate",
      });
    }
  );

  context.subscriptions.push(disposable);

  // Start MCP status monitoring immediately
  startMcpStatusMonitoring(context);

  // Start Review Gate integration immediately
  startReviewGateIntegration(context);

  vscode.window.showInformationMessage(
    "Review Gate V2 activated! Use Cmd+Shift+R or wait for MCP tool calls."
  );
}

function deactivate() {
  if (state.reviewGateWatcher) {
    clearInterval(state.reviewGateWatcher);
  }

  if (state.statusCheckInterval) {
    clearInterval(state.statusCheckInterval);
  }

  if (state.outputChannel) {
    state.outputChannel.dispose();
  }
}

module.exports = {
  activate,
  deactivate,
};
