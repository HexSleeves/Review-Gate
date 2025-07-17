/**
 * WebviewService - Manages Review Gate popup and webview interactions
 *
 * This service extracts webview functionality from the monolithic extension.ts
 * and provides optimized webview management with lazy creation, async message
 * handling, resource optimization, and proper state management.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BaseService, ServiceEventType } from "./BaseService";
import { ExtensionConfig } from "../config/extensionConfig";

/**
 * Interface for webview popup configuration options
 */
export interface WebviewPopupOptions {
  /** Popup title */
  title?: string;
  /** Main message content */
  message?: string;
  /** Whether to auto-focus the webview */
  autoFocus?: boolean;
  /** Tool data for MCP integration */
  toolData?: ToolData | null;
  /** Whether MCP integration is enabled */
  mcpIntegration?: boolean;
  /** Special handling mode */
  specialHandling?: string | null;
  /** Trigger ID for tracking */
  triggerId?: string | null;
}

/**
 * Interface for tool data structure
 */
export interface ToolData {
  tool: string;
  trigger_id: string;
  mode?: string;
  unified_tool?: boolean;
  message?: string;
  title?: string;
  prompt?: string;
  text_content?: string;
  source?: string;
  context?: string;
  processing_mode?: string;
  reason?: string;
  immediate?: boolean;
  cleanup?: boolean;
  instruction?: string;
  [key: string]: unknown;
}

/**
 * Interface for file attachments
 */
export interface WebviewAttachment {
  id: string;
  fileName: string;
  filePath?: string;
  mimeType: string;
  base64Data?: string;
  dataUrl?: string;
  size: number;
  source?: string;
}

/**
 * Interface for webview messages
 */
export interface WebviewMessage {
  command: string;
  text?: string;
  attachments?: WebviewAttachment[];
  fileName?: string;
  size?: number;
  mimeType?: string;
  imageId?: string;
  message?: string;
  error?: string;
  transcription?: string;
}

/**
 * Interface for webview state persistence
 */
interface WebviewState {
  isVisible: boolean;
  title: string;
  lastMessage?: string;
  mcpStatus: boolean;
  currentTriggerData?: ToolData;
  attachments: WebviewAttachment[];
  userInputs: string[];
}

/**
 * Message queue item for async processing
 */
interface QueuedMessage {
  id: string;
  message: WebviewMessage;
  timestamp: Date;
  priority: number;
  retryCount: number;
}

/**
 * WebviewService class for managing Review Gate webview interactions
 */
export class WebviewService extends BaseService {
  /** Current webview panel instance */
  private webviewPanel: vscode.WebviewPanel | null = null;

  /** Webview state for persistence */
  private webviewState: WebviewState;

  /** Message processing queue */
  private messageQueue: QueuedMessage[] = [];

  /** Message processing active flag */
  private isProcessingMessages = false;

  /** Cached HTML content for performance */
  private cachedHtmlContent: Map<string, string> = new Map();

  /** Current MCP status */
  private mcpStatus = false;

  /** Current trigger data */
  private currentTriggerData: ToolData | null = null;

  /** Message timeout handlers */
  private messageTimeouts: Map<string, NodeJS.Timeout> = new Map();

  /** Performance metrics */
  private webviewMetrics = {
    creationCount: 0,
    messageCount: 0,
    averageResponseTime: 0,
    errorCount: 0,
  };

  constructor() {
    super("WebviewService");
    this.webviewState = this.initializeWebviewState();
  }

  /**
   * Initialize the webview service
   */
  protected async onInitialize(
    context: vscode.ExtensionContext,
  ): Promise<void> {
    this.logInfo("Initializing WebviewService");

    // Set up configuration listeners
    this.onConfigurationChange(
      "webview",
      this.handleWebviewConfigChange.bind(this),
    );
    this.onConfigurationChange(
      "logging",
      this.handleLoggingConfigChange.bind(this),
    );

    // Start message processing
    this.startMessageProcessing();

    this.logInfo("WebviewService initialized successfully");
  }

  /**
   * Dispose of webview service resources
   */
  protected onDispose(): void {
    this.logInfo("Disposing WebviewService");

    // Clear message queue
    this.messageQueue = [];
    this.isProcessingMessages = false;

    // Clear timeouts
    this.messageTimeouts.forEach((timeout) => clearTimeout(timeout));
    this.messageTimeouts.clear();

    // Dispose webview panel
    if (this.webviewPanel) {
      this.webviewPanel.dispose();
      this.webviewPanel = null;
    }

    // Clear cached content
    this.cachedHtmlContent.clear();

    this.logInfo("WebviewService disposed successfully");
  }

  /**
   * Open or show the Review Gate popup with lazy creation
   */
  public async openReviewGatePopup(
    options: WebviewPopupOptions = {},
  ): Promise<void> {
    const timing = await this.withTiming("openReviewGatePopup", async () => {
      const {
        title = "Review Gate",
        message = "Welcome to Review Gate V3! Please provide your review or feedback.",
        autoFocus = false,
        toolData = null,
        mcpIntegration = false,
        specialHandling = null,
        triggerId = null,
      } = options;

      this.logDebug(
        "Opening Review Gate popup with triggerId: " + (triggerId || "none"),
      );

      // Update current trigger data
      if (triggerId && toolData) {
        this.currentTriggerData = {
          ...toolData,
          trigger_id: triggerId,
        };
        this.webviewState.currentTriggerData = this.currentTriggerData;
      }

      // Update webview state
      this.webviewState.title = title;
      this.webviewState.mcpStatus = mcpIntegration;
      this.webviewState.lastMessage = message;

      // Show existing panel or create new one
      if (this.webviewPanel) {
        await this.showExistingPanel(autoFocus, mcpIntegration);
      } else {
        await this.createNewPanel(
          title,
          message,
          autoFocus,
          mcpIntegration,
          toolData,
          specialHandling,
          triggerId,
        );
      }

      // Emit service event
      this.emitServiceEvent(ServiceEventType.CUSTOM, {
        action: "popup_opened",
        triggerId,
        mcpIntegration,
      });
    });

    this.logDebug("Popup opened in " + timing.duration + "ms");
  }

  /**
   * Update MCP status in the webview
   */
  public updateMcpStatus(active: boolean): void {
    this.mcpStatus = active;
    this.webviewState.mcpStatus = active;

    if (this.webviewPanel) {
      this.sendMessageToWebview({
        command: "updateMcpStatus",
        active,
      });
    }
  }

  /**
   * Get current webview state
   */
  public getWebviewState(): Readonly<WebviewState> {
    return { ...this.webviewState };
  }

  /**
   * Get webview performance metrics
   */
  public getWebviewMetrics(): Readonly<typeof this.webviewMetrics> {
    return { ...this.webviewMetrics };
  }

  /**
   * Initialize webview state
   */
  private initializeWebviewState(): WebviewState {
    return {
      isVisible: false,
      title: "Review Gate",
      mcpStatus: false,
      attachments: [],
      userInputs: [],
    };
  }

  /**
   * Handle webview configuration changes
   */
  private handleWebviewConfigChange(
    newConfig: ExtensionConfig["webview"],
  ): void {
    this.logDebug("Webview configuration changed", newConfig);

    // Clear cached HTML content when theme changes
    if (this.cachedHtmlContent.size > 0) {
      this.cachedHtmlContent.clear();
      this.logDebug("Cleared cached HTML content due to config change");
    }
  }

  /**
   * Handle logging configuration changes
   */
  private handleLoggingConfigChange(
    newConfig: ExtensionConfig["logging"],
  ): void {
    this.logDebug("Logging configuration changed", newConfig);
  }

  /**
   * Show existing webview panel
   */
  private async showExistingPanel(
    autoFocus: boolean,
    mcpIntegration: boolean,
  ): Promise<void> {
    if (!this.webviewPanel) {
      return;
    }

    this.webviewPanel.reveal(vscode.ViewColumn.One);
    this.webviewPanel.title = this.webviewState.title;
    this.webviewState.isVisible = true;

    // Update MCP status
    if (mcpIntegration) {
      setTimeout(() => {
        this.sendMessageToWebview({
          command: "updateMcpStatus",
          active: true,
        });
      }, 100);
    }

    // Auto-focus if requested
    if (autoFocus) {
      setTimeout(() => {
        this.sendMessageToWebview({ command: "focus" });
      }, 200);
    }
  }

  /**
   * Create new webview panel with lazy loading
   */
  private async createNewPanel(
    title: string,
    message: string,
    autoFocus: boolean,
    mcpIntegration: boolean,
    toolData: ToolData | null,
    specialHandling: string | null,
    triggerId: string | null,
  ): Promise<void> {
    this.logDebug("Creating new webview panel");

    // Create webview panel with optimized options
    this.webviewPanel = vscode.window.createWebviewPanel(
      "reviewGateChat",
      title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: this.context ? [this.context.extensionUri] : [],
      },
    );

    // Update metrics
    this.webviewMetrics.creationCount++;
    this.webviewState.isVisible = true;

    // Set HTML content with caching
    this.webviewPanel.webview.html = await this.getOptimizedHtmlContent(
      title,
      mcpIntegration,
    );

    // Set up message handling
    this.setupMessageHandling(
      mcpIntegration,
      specialHandling,
      triggerId,
      toolData,
      message,
    );

    // Set up disposal handling
    this.setupDisposalHandling();

    // Auto-focus if requested
    if (autoFocus) {
      setTimeout(() => {
        this.sendMessageToWebview({ command: "focus" });
      }, 200);
    }

    this.logDebug("New webview panel created successfully");
  }

  /**
   * Set up webview message handling with async processing
   */
  private setupMessageHandling(
    mcpIntegration: boolean,
    specialHandling: string | null,
    triggerId: string | null,
    toolData: ToolData | null,
    message: string,
  ): void {
    if (!this.webviewPanel) {
      return;
    }

    this.webviewPanel.webview.onDidReceiveMessage(
      async (webviewMessage: WebviewMessage) => {
        if (webviewMessage.command === "ready") {
          this.handleReadyMessage(
            mcpIntegration,
            message,
            toolData,
            triggerId,
            specialHandling,
          );
        } else {
          // Queue message for async processing
          await this.queueMessage(
            webviewMessage,
            mcpIntegration,
            specialHandling,
            triggerId,
          );
        }
      },
      undefined,
      this.disposables,
    );
  }

  /**
   * Set up webview disposal handling
   */
  private setupDisposalHandling(): void {
    if (!this.webviewPanel) {
      return;
    }

    this.webviewPanel.onDidDispose(
      () => {
        this.webviewPanel = null;
        this.currentTriggerData = null;
        this.webviewState.isVisible = false;
        this.webviewState.currentTriggerData = undefined;

        this.logDebug("Webview panel disposed");

        // Emit disposal event
        this.emitServiceEvent(ServiceEventType.CUSTOM, {
          action: "webview_disposed",
        });
      },
      null,
      this.disposables,
    );
  }

  /**
   * Send message to webview with error handling
   */
  private sendMessageToWebview(message: any): void {
    if (!this.webviewPanel) {
      this.logWarning("Attempted to send message to disposed webview");
      return;
    }

    try {
      this.webviewPanel.webview.postMessage(message);
    } catch (error) {
      this.logError("Failed to send message to webview", error);
    }
  }

  /**
   * Handle webview ready message
   */
  private handleReadyMessage(
    mcpIntegration: boolean,
    message: string,
    toolData: ToolData | null,
    triggerId: string | null,
    specialHandling: string | null,
  ): void {
    this.sendMessageToWebview({
      command: "updateMcpStatus",
      active: mcpIntegration ? true : this.mcpStatus,
    });

    if (message && !mcpIntegration && !message.includes("I have completed")) {
      this.sendMessageToWebview({
        command: "addMessage",
        text: message,
        type: "system",
        plain: true,
        toolData,
        mcpIntegration,
        triggerId,
        specialHandling,
      });
    }
  }

  /**
   * Queue message for async processing
   */
  private async queueMessage(
    message: WebviewMessage,
    mcpIntegration: boolean,
    specialHandling: string | null,
    triggerId: string | null,
  ): Promise<void> {
    const queuedMessage: QueuedMessage = {
      id: "msg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9),
      message,
      timestamp: new Date(),
      priority: this.getMessagePriority(message.command),
      retryCount: 0,
    };

    this.messageQueue.push(queuedMessage);
    this.messageQueue.sort((a, b) => b.priority - a.priority);

    this.logDebug(
      "Message queued: " +
        message.command +
        " (queue size: " +
        this.messageQueue.length +
        ")",
    );

    // Set timeout for message processing
    const timeout = setTimeout(() => {
      this.logWarning("Message processing timeout: " + queuedMessage.id);
      this.messageTimeouts.delete(queuedMessage.id);
    }, 30000);

    this.messageTimeouts.set(queuedMessage.id, timeout);
  }

  /**
   * Start async message processing
   */
  private startMessageProcessing(): void {
    if (this.isProcessingMessages) {
      return;
    }

    this.isProcessingMessages = true;
    this.processMessageQueue();
  }

  /**
   * Process message queue asynchronously
   */
  private async processMessageQueue(): Promise<void> {
    while (this.isProcessingMessages && this.messageQueue.length > 0) {
      const queuedMessage = this.messageQueue.shift();
      if (!queuedMessage) {
        continue;
      }

      try {
        const startTime = Date.now();
        await this.processMessage(queuedMessage);

        const processingTime = Date.now() - startTime;
        this.updateResponseTimeMetrics(processingTime);

        // Clear timeout
        const timeout = this.messageTimeouts.get(queuedMessage.id);
        if (timeout) {
          clearTimeout(timeout);
          this.messageTimeouts.delete(queuedMessage.id);
        }

        this.webviewMetrics.messageCount++;
      } catch (error) {
        this.webviewMetrics.errorCount++;
        this.logError("Error processing message " + queuedMessage.id, error);

        // Retry logic
        if (queuedMessage.retryCount < 3) {
          queuedMessage.retryCount++;
          this.messageQueue.unshift(queuedMessage);
          this.logDebug(
            "Retrying message " +
              queuedMessage.id +
              " (attempt " +
              queuedMessage.retryCount +
              ")",
          );
        }
      }

      // Small delay to prevent blocking
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Continue processing if there are more messages
    if (this.messageQueue.length > 0) {
      setTimeout(() => this.processMessageQueue(), 100);
    }
  }

  /**
   * Process individual message
   */
  private async processMessage(queuedMessage: QueuedMessage): Promise<void> {
    const { message } = queuedMessage;
    const currentTriggerId = this.getCurrentTriggerId();

    switch (message.command) {
      case "send":
        await this.handleSendMessage(message, currentTriggerId);
        break;
      case "attach":
        await this.handleAttachMessage(currentTriggerId);
        break;
      case "uploadImage":
        await this.handleImageUploadMessage(currentTriggerId);
        break;
      case "logPastedImage":
        this.handleLogPastedImage(message, currentTriggerId);
        break;
      case "logDragDropImage":
        this.handleLogDragDropImage(message, currentTriggerId);
        break;
      case "logImageRemoved":
        this.handleLogImageRemoved(message, currentTriggerId);
        break;
      case "startRecording":
        await this.handleStartRecording(currentTriggerId);
        break;
      case "stopRecording":
        await this.handleStopRecording(currentTriggerId);
        break;
      case "showError":
        this.handleShowError(message);
        break;
      case "speechTranscribed":
        this.handleSpeechTranscribed(message);
        break;
      default:
        this.logWarning("Unknown message command: " + message.command);
    }
  }

  /**
   * Get message priority for queue ordering
   */
  private getMessagePriority(command: string): number {
    const priorities: Record<string, number> = {
      send: 10,
      showError: 9,
      speechTranscribed: 8,
      startRecording: 7,
      stopRecording: 7,
      attach: 5,
      uploadImage: 5,
      ready: 3,
      logPastedImage: 1,
      logDragDropImage: 1,
      logImageRemoved: 1,
    };
    return priorities[command] || 0;
  }

  /**
   * Update response time metrics
   */
  private updateResponseTimeMetrics(processingTime: number): void {
    const currentAverage = this.webviewMetrics.averageResponseTime;
    const messageCount = this.webviewMetrics.messageCount;

    this.webviewMetrics.averageResponseTime =
      (currentAverage * messageCount + processingTime) / (messageCount + 1);
  }

  /**
   * Get current trigger ID
   */
  private getCurrentTriggerId(): string | null {
    return this.currentTriggerData?.trigger_id || null;
  }

  /**
   * Handle send message
   */
  private async handleSendMessage(
    message: WebviewMessage,
    triggerId: string | null,
  ): Promise<void> {
    const text = message.text || "";
    const attachments = message.attachments || [];

    this.logUserInput(text, "MCP_RESPONSE", triggerId, attachments);
    this.webviewState.userInputs.push(text);

    // Add to webview
    this.sendMessageToWebview({
      command: "addMessage",
      text: "Review sent - Hold on to your pants until the review gate is called again! 🎢",
      type: "system",
      plain: true,
    });

    // Update MCP status after delay
    setTimeout(() => {
      this.sendMessageToWebview({
        command: "updateMcpStatus",
        active: false,
      });
    }, 1000);

    // Emit event for other services
    this.emitServiceEvent(ServiceEventType.CUSTOM, {
      action: "message_sent",
      text,
      attachments,
      triggerId,
    });
  }

  /**
   * Handle attach message
   */
  private async handleAttachMessage(triggerId: string | null): Promise<void> {
    this.logUserInput(
      "User requested file attachment for review",
      "FILE_ATTACHMENT",
      triggerId,
    );

    const fileUris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: "Select file(s) for review",
      filters: { "All files": ["*"] },
    });

    if (fileUris && fileUris.length > 0) {
      const filePaths = fileUris.map((uri) => uri.fsPath);
      const fileNames = filePaths.map((fp) => path.basename(fp));

      this.logUserInput(
        "Files selected for review: " + fileNames.join(", "),
        "FILE_SELECTED",
        triggerId,
      );

      this.sendMessageToWebview({
        command: "addMessage",
        text:
          "Files attached for review:\n" +
          fileNames.map((n) => "• " + n).join("\n") +
          "\n\n" +
          "Paths:\n" +
          filePaths.map((p) => "• " + p).join("\n"),
        type: "system",
      });
    } else {
      this.logUserInput(
        "No files selected for review",
        "FILE_CANCELLED",
        triggerId,
      );
    }
  }

  /**
   * Handle image upload message
   */
  private async handleImageUploadMessage(
    triggerId: string | null,
  ): Promise<void> {
    this.logUserInput(
      "User requested image upload for review",
      "IMAGE_UPLOAD",
      triggerId,
    );

    const fileUris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: "Select image(s) to upload",
      filters: {
        Images: ["png", "jpg", "jpeg", "gif", "bmp", "webp"],
      },
    });

    if (fileUris && fileUris.length > 0) {
      for (const fileUri of fileUris) {
        const filePath = fileUri.fsPath;
        const fileName = path.basename(filePath);

        try {
          const imageBuffer = fs.readFileSync(filePath);
          const base64Data = imageBuffer.toString("base64");
          const mimeType = this.getMimeType(fileName);
          const dataUrl = "data:" + mimeType + ";base64," + base64Data;

          const imageData: WebviewAttachment = {
            fileName,
            filePath,
            mimeType,
            base64Data,
            dataUrl,
            size: imageBuffer.length,
            id:
              "img_" +
              Date.now() +
              "_" +
              Math.random().toString(36).substr(2, 9),
          };

          this.logUserInput(
            "Image uploaded: " + fileName,
            "IMAGE_UPLOADED",
            triggerId,
          );

          this.sendMessageToWebview({
            command: "imageUploaded",
            imageData,
          });
        } catch (error) {
          this.logError("Error processing image " + fileName, error);
          vscode.window.showErrorMessage(
            "Failed to process image: " + fileName,
          );
        }
      }
    } else {
      this.logUserInput(
        "No images selected for upload",
        "IMAGE_CANCELLED",
        triggerId,
      );
    }
  }

  /**
   * Handle log pasted image
   */
  private handleLogPastedImage(
    message: WebviewMessage,
    triggerId: string | null,
  ): void {
    if (message.fileName && message.size !== undefined && message.mimeType) {
      this.logUserInput(
        "Image pasted from clipboard: " +
          message.fileName +
          " (" +
          message.size +
          " bytes, " +
          message.mimeType +
          ")",
        "IMAGE_PASTED",
        triggerId,
      );
    }
  }

  /**
   * Handle log drag drop image
   */
  private handleLogDragDropImage(
    message: WebviewMessage,
    triggerId: string | null,
  ): void {
    if (message.fileName && message.size !== undefined && message.mimeType) {
      this.logUserInput(
        "Image dropped from drag and drop: " +
          message.fileName +
          " (" +
          message.size +
          " bytes, " +
          message.mimeType +
          ")",
        "IMAGE_DROPPED",
        triggerId,
      );
    }
  }

  /**
   * Handle log image removed
   */
  private handleLogImageRemoved(
    message: WebviewMessage,
    triggerId: string | null,
  ): void {
    if (message.imageId) {
      this.logUserInput(
        "Image removed: " + message.imageId,
        "IMAGE_REMOVED",
        triggerId,
      );
    }
  }

  /**
   * Handle start recording
   */
  private async handleStartRecording(triggerId: string | null): Promise<void> {
    this.logUserInput(
      "User started speech recording",
      "SPEECH_START",
      triggerId,
    );

    // Emit event for AudioService to handle
    this.emitServiceEvent(ServiceEventType.CUSTOM, {
      action: "start_recording",
      triggerId,
    });
  }

  /**
   * Handle stop recording
   */
  private async handleStopRecording(triggerId: string | null): Promise<void> {
    this.logUserInput(
      "User stopped speech recording",
      "SPEECH_STOP",
      triggerId,
    );

    // Emit event for AudioService to handle
    this.emitServiceEvent(ServiceEventType.CUSTOM, {
      action: "stop_recording",
      triggerId,
    });
  }

  /**
   * Handle show error
   */
  private handleShowError(message: WebviewMessage): void {
    if (message.message) {
      vscode.window.showErrorMessage(message.message);
    }
  }

  /**
   * Handle speech transcribed
   */
  private handleSpeechTranscribed(message: WebviewMessage): void {
    const transcription = message.transcription;
    const error = message.error;

    if (transcription && transcription.trim()) {
      this.sendMessageToWebview({
        command: "addMessage",
        text: transcription.trim(),
        type: "system",
        plain: false,
      });
    } else if (error) {
      this.sendMessageToWebview({
        command: "addMessage",
        text: "❌ Speech Error: " + error,
        type: "system",
        plain: true,
      });
    }
  }

  /**
   * Get optimized HTML content with caching and CSP
   */
  private async getOptimizedHtmlContent(
    title: string,
    mcpIntegration: boolean,
  ): Promise<string> {
    const cacheKey = title + "_" + mcpIntegration;

    if (this.cachedHtmlContent.has(cacheKey)) {
      this.logDebug("Using cached HTML content");
      return this.cachedHtmlContent.get(cacheKey)!;
    }

    const html = this.generateOptimizedHtml(title, mcpIntegration);
    this.cachedHtmlContent.set(cacheKey, html);

    this.logDebug("Generated and cached new HTML content");
    return html;
  }

  /**
   * Generate optimized HTML with CSP and performance optimizations
   */
  private generateOptimizedHtml(
    title: string,
    mcpIntegration: boolean,
  ): string {
    const nonce = this.generateNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data: https:; font-src 'self';">
    <title>${title}</title>
    <style>
        :root {
            --vscode-font-family: var(--vscode-font-family);
            --vscode-font-size: var(--vscode-font-size);
            --vscode-foreground: var(--vscode-foreground);
            --vscode-background: var(--vscode-editor-background);
            --vscode-input-background: var(--vscode-input-background);
            --vscode-input-border: var(--vscode-input-border);
            --vscode-button-background: var(--vscode-button-background);
            --vscode-button-foreground: var(--vscode-button-foreground);
            --vscode-button-hoverBackground: var(--vscode-button-hoverBackground);
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-background);
            padding: 20px;
            line-height: 1.6;
        }

        .container {
            max-width: 800px;
            margin: 0 auto;
        }

        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--vscode-input-border);
        }

        .title {
            font-size: 1.5em;
            font-weight: bold;
        }

        .status-indicator {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.9em;
        }

        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: #ff6b6b;
            transition: background-color 0.3s ease;
        }

        .status-dot.active {
            background-color: #51cf66;
        }

        .messages {
            min-height: 300px;
            max-height: 400px;
            overflow-y: auto;
            margin-bottom: 20px;
            padding: 15px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
        }

        .message {
            margin-bottom: 15px;
            padding: 10px;
            border-radius: 4px;
            word-wrap: break-word;
        }

        .message.system {
            background-color: rgba(0, 123, 255, 0.1);
            border-left: 3px solid #007bff;
        }

        .message.user {
            background-color: rgba(40, 167, 69, 0.1);
            border-left: 3px solid #28a745;
        }

        .input-section {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        .input-row {
            display: flex;
            gap: 10px;
            align-items: flex-end;
        }

        .input-field {
            flex: 1;
            min-height: 80px;
            padding: 10px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            resize: vertical;
        }

        .input-field:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }

        .button {
            padding: 8px 16px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            transition: background-color 0.2s ease;
        }

        .button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }

        .button-group {
            display: flex;
            gap: 10px;
        }

        .attachments {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-top: 10px;
        }

        .attachment {
            display: flex;
            align-items: center;
            gap: 5px;
            padding: 5px 10px;
            background-color: rgba(0, 123, 255, 0.1);
            border-radius: 4px;
            font-size: 0.9em;
        }

        .attachment .remove {
            cursor: pointer;
            color: #ff6b6b;
            font-weight: bold;
        }

        .recording-indicator {
            display: none;
            align-items: center;
            gap: 8px;
            color: #ff6b6b;
            font-weight: bold;
        }

        .recording-indicator.active {
            display: flex;
        }

        .pulse {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: #ff6b6b;
            animation: pulse 1s infinite;
        }

        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
        }

        .hidden {
            display: none;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="title">${title}</div>
            <div class="status-indicator">
                <div class="status-dot" id="statusDot"></div>
                <span id="statusText">Disconnected</span>
            </div>
        </div>

        <div class="messages" id="messages"></div>

        <div class="input-section">
            <div class="input-row">
                <textarea
                    id="messageInput"
                    class="input-field"
                    placeholder="Type your message here..."
                    rows="3"
                ></textarea>
            </div>

            <div class="button-group">
                <button id="sendButton" class="button">Send</button>
                <button id="attachButton" class="button">Attach File</button>
                <button id="imageButton" class="button">Upload Image</button>
                <button id="recordButton" class="button">🎤 Record</button>
            </div>

            <div class="recording-indicator" id="recordingIndicator">
                <div class="pulse"></div>
                <span>Recording...</span>
            </div>

            <div class="attachments" id="attachments"></div>
        </div>
    </div>

    <script nonce="${nonce}">
        (function() {
            const vscode = acquireVsCodeApi();

            // DOM elements
            const messageInput = document.getElementById('messageInput');
            const sendButton = document.getElementById('sendButton');
            const attachButton = document.getElementById('attachButton');
            const imageButton = document.getElementById('imageButton');
            const recordButton = document.getElementById('recordButton');
            const messages = document.getElementById('messages');
            const statusDot = document.getElementById('statusDot');
            const statusText = document.getElementById('statusText');
            const recordingIndicator = document.getElementById('recordingIndicator');
            const attachments = document.getElementById('attachments');

            // State
            let isRecording = false;
            let currentAttachments = [];
            let mcpActive = ${mcpIntegration};

            // Initialize
            updateMcpStatus(mcpActive);

            // Event listeners
            sendButton.addEventListener('click', sendMessage);
            attachButton.addEventListener('click', () => vscode.postMessage({ command: 'attach' }));
            imageButton.addEventListener('click', () => vscode.postMessage({ command: 'uploadImage' }));
            recordButton.addEventListener('click', toggleRecording);

            messageInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    sendMessage();
                }
            });

            // Paste handling for images
            messageInput.addEventListener('paste', handlePaste);

            // Drag and drop handling
            document.addEventListener('dragover', (e) => e.preventDefault());
            document.addEventListener('drop', handleDrop);

            // Functions
            function sendMessage() {
                const text = messageInput.value.trim();
                if (!text && currentAttachments.length === 0) return;

                vscode.postMessage({
                    command: 'send',
                    text: text,
                    attachments: currentAttachments
                });

                addMessage(text, 'user');
                messageInput.value = '';
                currentAttachments = [];
                updateAttachmentsDisplay();
            }

            function toggleRecording() {
                if (isRecording) {
                    stopRecording();
                } else {
                    startRecording();
                }
            }

            function startRecording() {
                isRecording = true;
                recordButton.textContent = '⏹️ Stop';
                recordingIndicator.classList.add('active');
                vscode.postMessage({ command: 'startRecording' });
            }

            function stopRecording() {
                isRecording = false;
                recordButton.textContent = '🎤 Record';
                recordingIndicator.classList.remove('active');
                vscode.postMessage({ command: 'stopRecording' });
            }

            function addMessage(text, type = 'system', plain = false) {
                const messageDiv = document.createElement('div');
                messageDiv.className = 'message ' + type;

                if (plain) {
                    messageDiv.textContent = text;
                } else {
                    messageDiv.innerHTML = text.replace(/\\n/g, '<br>');
                }

                messages.appendChild(messageDiv);
                messages.scrollTop = messages.scrollHeight;
            }

            function updateMcpStatus(active) {
                mcpActive = active;
                statusDot.classList.toggle('active', active);
                statusText.textContent = active ? 'Connected' : 'Disconnected';
            }

            function handlePaste(e) {
                const items = e.clipboardData.items;
                for (let item of items) {
                    if (item.type.indexOf('image') !== -1) {
                        const file = item.getAsFile();
                        if (file) {
                            handleImageFile(file, 'paste');
                        }
                    }
                }
            }

            function handleDrop(e) {
                e.preventDefault();
                const files = e.dataTransfer.files;
                for (let file of files) {
                    if (file.type.indexOf('image') !== -1) {
                        handleImageFile(file, 'drop');
                    }
                }
            }

            function handleImageFile(file, source) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const attachment = {
                        id: 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                        fileName: file.name,
                        mimeType: file.type,
                        size: file.size,
                        dataUrl: e.target.result,
                        source: source
                    };

                    currentAttachments.push(attachment);
                    updateAttachmentsDisplay();

                    // Log the action
                    if (source === 'paste') {
                        vscode.postMessage({
                            command: 'logPastedImage',
                            fileName: file.name,
                            size: file.size,
                            mimeType: file.type
                        });
                    } else if (source === 'drop') {
                        vscode.postMessage({
                            command: 'logDragDropImage',
                            fileName: file.name,
                            size: file.size,
                            mimeType: file.type
                        });
                    }
                };
                reader.readAsDataURL(file);
            }

            function updateAttachmentsDisplay() {
                attachments.innerHTML = '';
                currentAttachments.forEach(attachment => {
                    const attachmentDiv = document.createElement('div');
                    attachmentDiv.className = 'attachment';
                    attachmentDiv.innerHTML = '<span>' + attachment.fileName + '</span><span class="remove" onclick="removeAttachment(\'' + attachment.id + '\')">×</span>';
                    attachments.appendChild(attachmentDiv);
                });
            }

            function removeAttachment(id) {
                currentAttachments = currentAttachments.filter(att => att.id !== id);
                updateAttachmentsDisplay();
                vscode.postMessage({
                    command: 'logImageRemoved',
                    imageId: id
                });
            }

            // Message handling from extension
            window.addEventListener('message', event => {
                const message = event.data;

                switch (message.command) {
                    case 'updateMcpStatus':
                        updateMcpStatus(message.active);
                        break;
                    case 'addMessage':
                        addMessage(message.text, message.type || 'system', message.plain);
                        break;
                    case 'focus':
                        messageInput.focus();
                        break;
                    case 'imageUploaded':
                        currentAttachments.push(message.imageData);
                        updateAttachmentsDisplay();
                        break;
                    case 'recordingStarted':
                        // Handle recording started
                        break;
                    case 'speechTranscribed':
                        if (message.transcription) {
                            messageInput.value = message.transcription;
                        }
                        if (message.error) {
                            addMessage('❌ Speech Error: ' + message.error, 'system', true);
                        }
                        break;
                }
            });

            // Send ready message
            vscode.postMessage({ command: 'ready' });
        })();
    </script>
</body>
</html>`;
  }

  /**
   * Generate nonce for CSP
   */
  private generateNonce(): string {
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < 32; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * Get MIME type from filename
   */
  private getMimeType(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".bmp": "image/bmp",
      ".webp": "image/webp",
    };
    return mimeTypes[ext] || "image/jpeg";
  }

  /**
   * Get temporary file path
   */
  private getTempPath(filename: string): string {
    if (process.platform === "win32") {
      return path.join(os.tmpdir(), filename);
    } else {
      return path.join("/tmp", filename);
    }
  }

  /**
   * Log user input with file writing
   */
  private logUserInput(
    inputText: string,
    eventType: string = "MESSAGE",
    triggerId: string | null = null,
    attachments: WebviewAttachment[] = [],
  ): void {
    const timestamp = new Date().toISOString();
    const logMsg = "[" + timestamp + "] " + eventType + ": " + inputText;

    this.logInfo("USER INPUT: " + inputText);

    try {
      const logFile = this.getTempPath("review_gate_user_inputs.log");
      fs.appendFileSync(logFile, logMsg + "\n");

      if (triggerId && eventType === "MCP_RESPONSE") {
        const responsePatterns = [
          this.getTempPath("review_gate_response_" + triggerId + ".json"),
          this.getTempPath("review_gate_response.json"),
          this.getTempPath("mcp_response_" + triggerId + ".json"),
          this.getTempPath("mcp_response.json"),
        ];

        const responseData = {
          timestamp,
          trigger_id: triggerId,
          user_input: inputText,
          response: inputText,
          message: inputText,
          attachments,
          event_type: eventType,
          source: "review_gate_extension",
        };

        const responseJson = JSON.stringify(responseData, null, 2);
        for (const responseFile of responsePatterns) {
          try {
            fs.writeFileSync(responseFile, responseJson);
            this.logDebug("MCP response written: " + responseFile);
          } catch (writeError) {
            this.logError(
              "Failed to write response file " + responseFile,
              writeError,
            );
          }
        }
      }
    } catch (error) {
      this.logError("Could not write to Review Gate log file", error);
    }
  }
}
