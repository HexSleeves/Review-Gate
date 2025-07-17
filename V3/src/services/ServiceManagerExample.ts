/**
 * ServiceManager Integration Example
 *
 * This file demonstrates how to integrate the ServiceManager into the main extension
 * activation and provides examples of how to use the service manager effectively.
 */

import * as vscode from "vscode";
import { ServiceManager, getServiceManager } from "./ServiceManager";
import { MCPService } from "./MCPService";
import { ReviewGateService } from "./ReviewGateService";
import { WebviewService } from "./WebviewService";
import { AudioService } from "./AudioService";
import { LoggingService } from "./LoggingService";
import { FileService } from "./FileService";

/**
 * Example extension activation function showing ServiceManager integration
 */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  console.log("[Extension] Activating Review Gate extension...");

  try {
    // Get the service manager instance
    const serviceManager = getServiceManager();

    // Initialize the service manager with the extension context
    await serviceManager.initialize(context);

    // Register extension commands that use services
    registerCommands(context, serviceManager);

    // Set up extension-level event handlers
    setupExtensionEventHandlers(serviceManager);

    // Add service manager to disposables for proper cleanup
    context.subscriptions.push({
      dispose: () => serviceManager.dispose(),
    });

    console.log("[Extension] Review Gate extension activated successfully");
  } catch (error) {
    console.error("[Extension] Failed to activate extension:", error);
    vscode.window.showErrorMessage(
      `Failed to activate Review Gate extension: ${error}`,
    );
    throw error;
  }
}

/**
 * Register VSCode commands that interact with services
 */
function registerCommands(
  context: vscode.ExtensionContext,
  serviceManager: ServiceManager,
): void {
  // Command to show service status
  const showServiceStatusCommand = vscode.commands.registerCommand(
    "reviewgate.showServiceStatus",
    async () => {
      const metrics = serviceManager.getMetrics();
      const healthStatuses = serviceManager.getAllServiceHealth();

      const statusMessage = [
        `Total Services: ${metrics.totalServices}`,
        `Active Services: ${metrics.servicesByState.active || 0}`,
        `Healthy Services: ${metrics.servicesByHealth.healthy || 0}`,
        `Uptime: ${Math.round(metrics.uptime / 1000)}s`,
      ].join("\n");

      vscode.window.showInformationMessage(statusMessage);
    },
  );

  // Command to restart a service
  const restartServiceCommand = vscode.commands.registerCommand(
    "reviewgate.restartService",
    async () => {
      const serviceNames = [
        "MCPService",
        "ReviewGateService",
        "WebviewService",
        "AudioService",
      ];
      const selectedService = await vscode.window.showQuickPick(serviceNames, {
        placeHolder: "Select service to restart",
      });

      if (selectedService) {
        const success = await serviceManager.restartService(selectedService);
        if (success) {
          vscode.window.showInformationMessage(
            `Service ${selectedService} restarted successfully`,
          );
        } else {
          vscode.window.showErrorMessage(
            `Failed to restart service ${selectedService}`,
          );
        }
      }
    },
  );

  // Command to trigger MCP tool call
  const triggerMCPCommand = vscode.commands.registerCommand(
    "reviewgate.triggerMCP",
    async () => {
      try {
        const mcpService =
          await serviceManager.getService<MCPService>("MCPService");
        if (mcpService) {
          // Example: trigger a tool call
          console.log("[Extension] MCP Service is available and ready");
          vscode.window.showInformationMessage(
            "MCP Service is ready for tool calls",
          );
        } else {
          vscode.window.showWarningMessage("MCP Service is not available");
        }
      } catch (error) {
        vscode.window.showErrorMessage(`MCP Service error: ${error}`);
      }
    },
  );

  // Command to start audio recording
  const startRecordingCommand = vscode.commands.registerCommand(
    "reviewgate.startRecording",
    async () => {
      try {
        const audioService =
          await serviceManager.getService<AudioService>("AudioService");
        if (audioService) {
          const triggerId = `manual-${Date.now()}`;
          await audioService.startRecording(triggerId);
          vscode.window.showInformationMessage("Audio recording started");
        } else {
          vscode.window.showWarningMessage("Audio Service is not available");
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Audio recording error: ${error}`);
      }
    },
  );

  // Command to show Review Gate popup
  const showReviewGateCommand = vscode.commands.registerCommand(
    "reviewgate.showPopup",
    async () => {
      try {
        const webviewService =
          await serviceManager.getService<WebviewService>("WebviewService");
        if (webviewService) {
          await webviewService.openReviewGatePopup({
            title: "Manual Review Gate",
            message: "Manual trigger activated",
            autoFocus: true,
            toolData: {
              tool: "manual_trigger",
              trigger_id: `manual-${Date.now()}`,
            },
            mcpIntegration: false,
            triggerId: `manual-${Date.now()}`,
          });
        } else {
          vscode.window.showWarningMessage("Webview Service is not available");
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Webview error: ${error}`);
      }
    },
  );

  // Add commands to disposables
  context.subscriptions.push(
    showServiceStatusCommand,
    restartServiceCommand,
    triggerMCPCommand,
    startRecordingCommand,
    showReviewGateCommand,
  );

  console.log("[Extension] Commands registered successfully");
}

/**
 * Set up extension-level event handlers for service manager events
 */
function setupExtensionEventHandlers(serviceManager: ServiceManager): void {
  // Handle service manager initialization
  serviceManager.on("initialized", (data) => {
    console.log(
      `[Extension] ServiceManager initialized with ${data.totalServices} services`,
    );
    vscode.window.showInformationMessage(
      "Review Gate services initialized successfully",
    );
  });

  // Handle service restarts
  serviceManager.on("serviceRestarted", (data) => {
    console.log(
      `[Extension] Service restarted: ${data.serviceName} (attempt ${data.attempts})`,
    );
    vscode.window.showInformationMessage(
      `Service ${data.serviceName} restarted`,
    );
  });

  // Handle service events for cross-service coordination
  serviceManager.on("serviceEvent", (data) => {
    console.log(
      `[Extension] Service event from ${data.source}:`,
      data.event.type,
    );

    // Example: Handle specific service events at extension level
    switch (data.event.type) {
      case "tool_call":
        console.log(`[Extension] Tool call detected: ${data.event.data?.tool}`);
        break;
      case "recording_started":
        console.log(
          `[Extension] Recording started for trigger: ${data.event.data?.triggerId}`,
        );
        break;
      case "webview_shown":
        console.log(
          `[Extension] Webview shown for tool: ${data.event.data?.tool}`,
        );
        break;
    }
  });

  // Handle configuration changes
  serviceManager.on("configurationChanged", (data) => {
    console.log("[Extension] Configuration changed, services updated");
  });

  // Handle performance updates (if monitoring is enabled)
  serviceManager.on("performanceUpdate", (metrics) => {
    console.log(
      `[Extension] Performance update - Uptime: ${Math.round(metrics.uptime / 1000)}s`,
    );
  });

  console.log("[Extension] Event handlers setup completed");
}

/**
 * Example of how to use services in extension code
 */
export class ExtensionServiceHelper {
  private serviceManager: ServiceManager;

  constructor() {
    this.serviceManager = getServiceManager();
  }

  /**
   * Example: Process a file through multiple services
   */
  async processFile(filePath: string): Promise<void> {
    try {
      // Get required services
      const fileService =
        await this.serviceManager.getService<FileService>("FileService");
      const loggingService =
        await this.serviceManager.getService<LoggingService>("LoggingService");

      if (!fileService || !loggingService) {
        throw new Error("Required services not available");
      }

      // Log the operation
      await loggingService.logInfo("Processing file", { filePath });

      // Read file content
      const content = await fileService.readFile(filePath);

      // Process content (example)
      console.log(
        `[ExtensionHelper] Processing file: ${filePath} (${content.length} bytes)`,
      );

      // Log completion
      await loggingService.logInfo("File processed successfully", { filePath });
    } catch (error) {
      console.error("[ExtensionHelper] File processing error:", error);
      throw error;
    }
  }

  /**
   * Example: Coordinate multiple services for a complex operation
   */
  async handleToolCall(toolData: any): Promise<void> {
    try {
      // Get all required services
      const mcpService =
        await this.serviceManager.getService<MCPService>("MCPService");
      const reviewGateService =
        await this.serviceManager.getService<ReviewGateService>(
          "ReviewGateService",
        );
      const webviewService =
        await this.serviceManager.getService<WebviewService>("WebviewService");

      if (!mcpService || !reviewGateService || !webviewService) {
        throw new Error("Required services not available");
      }

      // Show the review gate popup
      await webviewService.openReviewGatePopup({
        title: "Tool Call Handler",
        message: "Processing tool call",
        toolData,
        mcpIntegration: true,
        triggerId: toolData.trigger_id || `tool-${Date.now()}`,
      });

      // The ReviewGateService doesn't have a processTrigger method - it processes triggers automatically
      // through file monitoring. We can emit an event instead.
      console.log(`[ExtensionHelper] Tool call processed: ${toolData.tool}`);

      console.log("[ExtensionHelper] Tool call handled successfully");
    } catch (error) {
      console.error("[ExtensionHelper] Tool call handling error:", error);
      throw error;
    }
  }

  /**
   * Get service health summary
   */
  getServiceHealthSummary(): string {
    const healthStatuses = this.serviceManager.getAllServiceHealth();
    const metrics = this.serviceManager.getMetrics();

    const summary = [
      `Services: ${metrics.totalServices}`,
      `Healthy: ${metrics.servicesByHealth.healthy || 0}`,
      `Degraded: ${metrics.servicesByHealth.degraded || 0}`,
      `Unhealthy: ${metrics.servicesByHealth.unhealthy || 0}`,
      `Uptime: ${Math.round(metrics.uptime / 1000)}s`,
    ];

    return summary.join(" | ");
  }
}

/**
 * Extension deactivation function
 */
export function deactivate(): void {
  console.log("[Extension] Deactivating Review Gate extension...");

  // ServiceManager disposal is handled automatically through context.subscriptions
  // but we can also explicitly dispose if needed
  const serviceManager = getServiceManager();
  serviceManager.dispose();

  console.log("[Extension] Review Gate extension deactivated");
}
