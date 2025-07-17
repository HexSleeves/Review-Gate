/**
 * Review Gate Service for handling trigger file monitoring and tool call processing
 *
 * This service extracts and modernizes the Review Gate functionality from the monolithic
 * extension.ts file, providing efficient file monitoring with chokidar, async tool call
 * processing with queuing, and comprehensive error handling.
 */

import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { BaseService, ServiceEventType } from "./BaseService";

// Import chokidar types - will be available at runtime via package.json dependency
interface FSWatcher {
  close(): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): FSWatcher;
}

// Dynamic import for chokidar to handle module resolution
let chokidar: any;

/**
 * Interface for tool data structure from MCP tools
 */
export interface ToolData {
  /** Tool identifier */
  tool: string;
  /** Unique trigger identifier */
  trigger_id: string;
  /** Tool mode (optional) */
  mode?: string;
  /** Whether this is a unified tool */
  unified_tool?: boolean;
  /** Message content */
  message?: string;
  /** Tool title */
  title?: string;
  /** Prompt text */
  prompt?: string;
  /** Text content for processing */
  text_content?: string;
  /** Content source */
  source?: string;
  /** Processing context */
  context?: string;
  /** Processing mode */
  processing_mode?: string;
  /** Reason for action */
  reason?: string;
  /** Whether action is immediate */
  immediate?: boolean;
  /** Whether cleanup is required */
  cleanup?: boolean;
  /** Instruction text */
  instruction?: string;
  /** Additional properties */
  [key: string]: unknown;
}

/**
 * Interface for Review Gate trigger structure
 */
export interface ReviewGateTrigger {
  /** Target editor (optional) */
  editor?: string;
  /** Target system (optional) */
  system?: string;
  /** Tool data payload */
  data: ToolData;
}

/**
 * Interface for popup configuration options
 */
export interface PopupOptions {
  /** Popup message */
  message?: string;
  /** Popup title */
  title?: string;
  /** Whether to auto-focus */
  autoFocus?: boolean;
  /** Associated tool data */
  toolData?: ToolData | null;
  /** Whether MCP integration is enabled */
  mcpIntegration?: boolean;
  /** Special handling mode */
  specialHandling?: string | null;
  /** Trigger identifier */
  triggerId?: string | null;
}

/**
 * Interface for file attachment data
 */
export interface Attachment {
  /** Unique attachment ID */
  id: string;
  /** Original filename */
  fileName: string;
  /** File path (optional) */
  filePath?: string;
  /** MIME type */
  mimeType: string;
  /** Base64 encoded data (optional) */
  base64Data?: string;
  /** Data URL (optional) */
  dataUrl?: string;
  /** File size in bytes */
  size: number;
  /** Content source (optional) */
  source?: string;
}

/**
 * Interface for tool call processing queue item
 */
interface ToolCallQueueItem {
  /** Unique item identifier */
  id: string;
  /** Tool data to process */
  toolData: ToolData;
  /** Processing timestamp */
  timestamp: Date;
  /** Number of retry attempts */
  retryCount: number;
  /** Processing timeout handle */
  timeoutHandle?: NodeJS.Timeout;
}

/**
 * Interface for cached tool configuration
 */
interface CachedToolConfig {
  /** Tool identifier */
  toolId: string;
  /** Tool configuration */
  config: any;
  /** Cache timestamp */
  cachedAt: Date;
  /** Cache expiry time */
  expiresAt: Date;
}

/**
 * Interface for file monitoring cache entry
 */
interface FileMonitoringCache {
  /** File path */
  filePath: string;
  /** File size in bytes */
  size: number;
  /** Last modification time */
  mtime: Date;
  /** File hash (optional) */
  hash?: string;
}

/**
 * Review Gate Service Events
 */
export enum ReviewGateEventType {
  TRIGGER_DETECTED = "triggerDetected",
  TOOL_CALL_PROCESSED = "toolCallProcessed",
  POPUP_OPENED = "popupOpened",
  FILE_MONITORING_STARTED = "fileMonitoringStarted",
  FILE_MONITORING_STOPPED = "fileMonitoringStopped",
  QUEUE_PROCESSED = "queueProcessed",
}

/**
 * Review Gate Service for handling trigger file monitoring and tool call processing
 */
export class ReviewGateService extends BaseService {
  /** File watcher instance */
  private fileWatcher: FSWatcher | null = null;

  /** Tool call processing queue */
  private processingQueue: Map<string, ToolCallQueueItem> = new Map();

  /** Tool configuration cache */
  private toolConfigCache: Map<string, CachedToolConfig> = new Map();

  /** File monitoring cache */
  private fileCache: Map<string, FileMonitoringCache> = new Map();

  /** Debounce timers for file changes */
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

  /** Current trigger data */
  private currentTriggerData: ToolData | null = null;

  /** Active webview panel */
  private chatPanel: vscode.WebviewPanel | null = null;

  /** Processing queue worker interval */
  private queueWorkerInterval: NodeJS.Timeout | null = null;

  /** Maximum queue size */
  private readonly MAX_QUEUE_SIZE = 100;

  /** Tool call timeout in milliseconds */
  private readonly TOOL_CALL_TIMEOUT = 30000;

  /** Cache expiry time in milliseconds */
  private readonly CACHE_EXPIRY_TIME = 300000; // 5 minutes

  /** Default debounce delay in milliseconds */
  private readonly DEFAULT_DEBOUNCE_DELAY = 250;

  constructor() {
    super("ReviewGateService");
  }

  /**
   * Initialize the Review Gate service
   */
  protected async onInitialize(
    context: vscode.ExtensionContext,
  ): Promise<void> {
    this.logInfo("Initializing Review Gate service");

    // Initialize chokidar dynamically
    try {
      chokidar = require("chokidar");
    } catch (error) {
      this.logError("Failed to import chokidar", error);
      throw new Error("chokidar dependency is required for file monitoring");
    }

    // Start file monitoring
    await this.startFileMonitoring();

    // Start queue processing worker
    this.startQueueWorker();

    this.logInfo("Review Gate service initialized successfully");
  }

  /**
   * Dispose of service resources
   */
  protected onDispose(): void {
    this.logInfo("Disposing Review Gate service");

    // Stop file monitoring
    this.stopFileMonitoring();

    // Stop queue worker
    this.stopQueueWorker();

    // Clear all caches and timers
    this.clearAllCaches();

    // Dispose webview panel
    if (this.chatPanel) {
      this.chatPanel.dispose();
      this.chatPanel = null;
    }

    this.logInfo("Review Gate service disposed");
  }

  /**
   * Start file monitoring with chokidar
   */
  private async startFileMonitoring(): Promise<void> {
    try {
      const tempDir = this.getTempPath("");
      const triggerPatterns = [
        path.join(tempDir, "review_gate_trigger.json"),
        path.join(tempDir, "review_gate_trigger_*.json"),
      ];

      this.logInfo(
        `Starting file monitoring for patterns: ${triggerPatterns.join(", ")}`,
      );

      this.fileWatcher = chokidar.watch(triggerPatterns, {
        persistent: true,
        ignoreInitial: false,
        usePolling: false,
        interval: this.getConfigProperty("polling", "interval"),
        binaryInterval: this.getConfigProperty("polling", "interval") * 2,
        awaitWriteFinish: {
          stabilityThreshold: 100,
          pollInterval: 50,
        },
      });

      if (!this.fileWatcher) {
        throw new Error("Failed to create file watcher");
      }

      this.fileWatcher.on("add", this.handleFileAdded.bind(this));
      this.fileWatcher.on("change", this.handleFileChanged.bind(this));
      this.fileWatcher.on("unlink", this.handleFileRemoved.bind(this));
      this.fileWatcher.on("error", this.handleFileWatcherError.bind(this));

      this.emitServiceEvent(ServiceEventType.CUSTOM, {
        eventType: ReviewGateEventType.FILE_MONITORING_STARTED,
        patterns: triggerPatterns,
      });

      this.logInfo("File monitoring started successfully");
    } catch (error) {
      this.logError("Failed to start file monitoring", error);
      throw error;
    }
  }

  /**
   * Stop file monitoring
   */
  private stopFileMonitoring(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
      this.emitServiceEvent(ServiceEventType.CUSTOM, {
        eventType: ReviewGateEventType.FILE_MONITORING_STOPPED,
      });
      this.logInfo("File monitoring stopped");
    }
  }

  /**
   * Handle file added event
   */
  private async handleFileAdded(filePath: string): Promise<void> {
    this.logDebug(`File added: ${filePath}`);
    await this.processTriggerFile(filePath);
  }

  /**
   * Handle file changed event
   */
  private async handleFileChanged(filePath: string): Promise<void> {
    this.logDebug(`File changed: ${filePath}`);

    // Implement debouncing to prevent excessive triggers
    const debounceKey = filePath;
    if (this.debounceTimers.has(debounceKey)) {
      clearTimeout(this.debounceTimers.get(debounceKey)!);
    }

    const debounceTimer = setTimeout(async () => {
      await this.processTriggerFile(filePath);
      this.debounceTimers.delete(debounceKey);
    }, this.DEFAULT_DEBOUNCE_DELAY);

    this.debounceTimers.set(debounceKey, debounceTimer);
  }

  /**
   * Handle file removed event
   */
  private handleFileRemoved(filePath: string): void {
    this.logDebug(`File removed: ${filePath}`);
    this.fileCache.delete(filePath);
  }

  /**
   * Handle file watcher errors
   */
  private handleFileWatcherError(error: Error): void {
    this.logError("File watcher error", error);
    this.emitServiceEvent(ServiceEventType.ERROR_OCCURRED, { error });
  }

  /**
   * Process trigger file with async operations and caching
   */
  private async processTriggerFile(filePath: string): Promise<void> {
    try {
      // Check if file exists
      const fileExists = await this.fileExists(filePath);
      if (!fileExists) {
        return;
      }

      // Get file stats for caching
      const stats = await fs.stat(filePath);
      const cacheKey = filePath;
      const cachedEntry = this.fileCache.get(cacheKey);

      // Check if file has changed since last processing
      if (
        cachedEntry &&
        cachedEntry.size === stats.size &&
        cachedEntry.mtime.getTime() === stats.mtime.getTime()
      ) {
        this.logDebug(`File ${filePath} unchanged, skipping processing`);
        return;
      }

      // Read and parse trigger file
      const fileContent = await fs.readFile(filePath, "utf8");
      const trigger = JSON.parse(fileContent) as ReviewGateTrigger;

      // Validate trigger
      if (!this.isValidTrigger(trigger)) {
        this.logWarning(`Invalid trigger in file: ${filePath}`);
        return;
      }

      // Update cache
      this.fileCache.set(cacheKey, {
        filePath,
        size: stats.size,
        mtime: stats.mtime,
      });

      this.logInfo(
        `Processing trigger: ${trigger.data.tool} (ID: ${trigger.data.trigger_id})`,
      );

      // Add to processing queue
      await this.queueToolCall(trigger.data);

      // Clean up trigger file
      await this.cleanupTriggerFile(filePath);

      this.emitServiceEvent(ServiceEventType.CUSTOM, {
        eventType: ReviewGateEventType.TRIGGER_DETECTED,
        trigger,
        filePath,
      });
    } catch (error) {
      this.logError(`Error processing trigger file ${filePath}`, error);
    }
  }

  /**
   * Validate trigger structure
   */
  private isValidTrigger(trigger: any): trigger is ReviewGateTrigger {
    if (!trigger || typeof trigger !== "object") {
      return false;
    }

    // Check editor filter
    if (trigger.editor && trigger.editor !== "cursor") {
      return false;
    }

    // Check system filter
    if (trigger.system && trigger.system !== "review-gate-v3") {
      return false;
    }

    // Validate data structure
    if (!trigger.data || typeof trigger.data !== "object") {
      return false;
    }

    // Validate required fields
    if (!trigger.data.tool || !trigger.data.trigger_id) {
      return false;
    }

    return true;
  }

  /**
   * Queue tool call for processing
   */
  private async queueToolCall(toolData: ToolData): Promise<void> {
    // Check queue size limit
    if (this.processingQueue.size >= this.MAX_QUEUE_SIZE) {
      this.logWarning("Processing queue is full, dropping oldest item");
      const oldestKey = this.processingQueue.keys().next().value;
      if (oldestKey) {
        this.processingQueue.delete(oldestKey);
      }
    }

    const queueItem: ToolCallQueueItem = {
      id: `${toolData.trigger_id}_${Date.now()}`,
      toolData,
      timestamp: new Date(),
      retryCount: 0,
    };

    this.processingQueue.set(queueItem.id, queueItem);
    this.logDebug(`Queued tool call: ${queueItem.id}`);
  }

  /**
   * Start queue processing worker
   */
  private startQueueWorker(): void {
    this.queueWorkerInterval = setInterval(async () => {
      await this.processQueue();
    }, 100); // Process queue every 100ms
  }

  /**
   * Stop queue processing worker
   */
  private stopQueueWorker(): void {
    if (this.queueWorkerInterval) {
      clearInterval(this.queueWorkerInterval);
      this.queueWorkerInterval = null;
    }
  }

  /**
   * Process queued tool calls
   */
  private async processQueue(): Promise<void> {
    if (this.processingQueue.size === 0) {
      return;
    }

    const queueItems = Array.from(this.processingQueue.values()).sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    for (const item of queueItems.slice(0, 5)) {
      // Process up to 5 items at once
      try {
        await this.processToolCall(item);
        this.processingQueue.delete(item.id);
      } catch (error) {
        this.logError(`Error processing tool call ${item.id}`, error);

        // Implement retry logic
        item.retryCount++;
        if (item.retryCount >= 3) {
          this.logError(
            `Max retries reached for tool call ${item.id}, removing from queue`,
          );
          this.processingQueue.delete(item.id);
        }
      }
    }

    if (this.processingQueue.size > 0) {
      this.emitServiceEvent(ServiceEventType.CUSTOM, {
        eventType: ReviewGateEventType.QUEUE_PROCESSED,
        queueSize: this.processingQueue.size,
      });
    }
  }

  /**
   * Process individual tool call with timeout handling
   */
  private async processToolCall(queueItem: ToolCallQueueItem): Promise<void> {
    const { toolData } = queueItem;

    return new Promise<void>((resolve, reject) => {
      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        reject(
          new Error(
            `Tool call ${queueItem.id} timed out after ${this.TOOL_CALL_TIMEOUT}ms`,
          ),
        );
      }, this.TOOL_CALL_TIMEOUT);

      queueItem.timeoutHandle = timeoutHandle;

      // Process the tool call
      this.handleReviewGateToolCall(toolData)
        .then(() => {
          clearTimeout(timeoutHandle);
          resolve();
        })
        .catch((error) => {
          clearTimeout(timeoutHandle);
          reject(error);
        });
    });
  }

  /**
   * Handle Review Gate tool call processing
   */
  private async handleReviewGateToolCall(toolData: ToolData): Promise<void> {
    this.currentTriggerData = toolData;

    const popupOptions = this.buildPopupOptions(toolData);

    // Open popup with webview integration
    await this.openReviewGatePopup(popupOptions);

    // Send acknowledgement
    await this.sendExtensionAcknowledgement(toolData.trigger_id, toolData.tool);

    // Show notification
    const toolName = toolData.tool.replace(/_/g, " ").toUpperCase();
    vscode.window.showInformationMessage(
      `Cursor Agent triggered "${toolName}" - Review Gate popup opened for your input!`,
    );

    this.emitServiceEvent(ServiceEventType.CUSTOM, {
      eventType: ReviewGateEventType.TOOL_CALL_PROCESSED,
      toolData,
    });
  }

  /**
   * Build popup options based on tool data
   */
  private buildPopupOptions(toolData: ToolData): PopupOptions {
    let popupOptions: PopupOptions = {};

    switch (toolData.tool) {
      case "review_gate": {
        const mode = toolData.mode ?? "chat";
        let modeTitle = `Review Gate V3 - ${
          mode.charAt(0).toUpperCase() + mode.slice(1)
        } Mode`;
        if (toolData.unified_tool) {
          modeTitle = `Review Gate V3 ゲート - Unified (${mode})`;
        }
        popupOptions = {
          message: toolData.message ?? "Please provide your input:",
          title: toolData.title ?? modeTitle,
          autoFocus: true,
          toolData,
          mcpIntegration: true,
          specialHandling: `unified_${mode}`,
        };
        break;
      }
      case "review_gate_chat": {
        popupOptions = {
          message:
            toolData.message ?? "Please provide your review or feedback:",
          title: toolData.title ?? "Review Gate V3 - ゲート",
          autoFocus: true,
          toolData,
          mcpIntegration: true,
        };
        break;
      }
      case "quick_review": {
        popupOptions = {
          message: toolData.prompt ?? "Quick feedback needed:",
          title: toolData.title ?? "Review Gate V3 ゲート - Quick Review",
          autoFocus: true,
          toolData,
          mcpIntegration: true,
          specialHandling: "quick_review",
        };
        break;
      }
      case "ingest_text": {
        const content = [
          `Cursor Agent received text input and needs your feedback:`,
          "",
          `Text Content: ${toolData.text_content}`,
          `Source: ${toolData.source}`,
          `Context: ${toolData.context ?? "None"}`,
          `Processing Mode: ${toolData.processing_mode}`,
          "",
          `Please review and provide your feedback:`,
        ].join("\n");
        popupOptions = {
          message: content,
          title: toolData.title ?? "Review Gate V3 ゲート - Text Input",
          autoFocus: true,
          toolData,
          mcpIntegration: true,
        };
        break;
      }
      case "shutdown_mcp": {
        const instruct = [
          `Cursor Agent is requesting to shutdown the MCP server:`,
          "",
          `Reason: ${toolData.reason}`,
          `Immediate: ${toolData.immediate ? "Yes" : "No"}`,
          `Cleanup: ${toolData.cleanup ? "Yes" : "No"}`,
          "",
          `Type 'CONFIRM' to proceed with shutdown, or provide alternative instructions:`,
        ].join("\n");
        popupOptions = {
          message: instruct,
          title:
            toolData.title ?? "Review Gate V3 ゲート - Shutdown Confirmation",
          autoFocus: true,
          toolData,
          mcpIntegration: true,
          specialHandling: "shutdown_mcp",
        };
        break;
      }
      case "file_review": {
        popupOptions = {
          message:
            toolData.instruction ?? "Cursor Agent needs you to select files:",
          title: toolData.title ?? "Review Gate V3 ゲート - File Review",
          autoFocus: true,
          toolData,
          mcpIntegration: true,
        };
        break;
      }
      default: {
        popupOptions = {
          message:
            toolData.message ??
            toolData.prompt ??
            toolData.instruction ??
            "Cursor Agent needs your input. Please provide your response:",
          title: toolData.title ?? "Review Gate V3 ゲート - General Input",
          autoFocus: true,
          toolData,
          mcpIntegration: true,
        };
      }
    }

    popupOptions.triggerId = toolData.trigger_id;
    popupOptions.title = "Review Gate";

    return popupOptions;
  }

  /**
   * Open Review Gate popup with webview integration
   */
  private async openReviewGatePopup(options: PopupOptions = {}): Promise<void> {
    const {
      message = "Welcome to Review Gate V3! Please provide your review or feedback.",
      title = "Review Gate",
      autoFocus = false,
      toolData = null,
      mcpIntegration = false,
      specialHandling = null,
      triggerId = null,
    } = options;

    this.logDebug(`Opening Review Gate popup with triggerId: ${triggerId}`);

    if (triggerId && toolData) {
      this.currentTriggerData = {
        ...toolData,
        trigger_id: triggerId,
      } as ToolData;
    }

    if (this.chatPanel) {
      this.chatPanel.reveal(vscode.ViewColumn.One);
      this.chatPanel.title = "Review Gate";

      if (mcpIntegration) {
        setTimeout(() => {
          this.chatPanel?.webview.postMessage({
            command: "updateMcpStatus",
            active: true,
          });
        }, 100);
      }

      if (autoFocus) {
        setTimeout(() => {
          this.chatPanel?.webview.postMessage({ command: "focus" });
        }, 200);
      }

      return;
    }

    this.chatPanel = vscode.window.createWebviewPanel(
      "reviewGateChat",
      title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    this.chatPanel.webview.html = this.getReviewGateHTML(title, mcpIntegration);

    // Set up webview message handling
    this.setupWebviewMessageHandling(
      mcpIntegration,
      specialHandling,
      triggerId,
      toolData,
    );

    // Set up panel disposal handling
    this.chatPanel.onDidDispose(() => {
      this.chatPanel = null;
      this.currentTriggerData = null;
    });

    if (autoFocus) {
      setTimeout(() => {
        this.chatPanel?.webview.postMessage({ command: "focus" });
      }, 200);
    }

    this.emitServiceEvent(ServiceEventType.CUSTOM, {
      eventType: ReviewGateEventType.POPUP_OPENED,
      options,
    });
  }

  /**
   * Set up webview message handling
   */
  private setupWebviewMessageHandling(
    mcpIntegration: boolean,
    specialHandling: string | null,
    triggerId: string | null,
    toolData: ToolData | null,
  ): void {
    if (!this.chatPanel) {
      return;
    }

    this.chatPanel.webview.onDidReceiveMessage(
      async (webviewMessage: {
        command: string;
        text?: string;
        attachments?: Attachment[];
        fileName?: string;
        size?: number;
        mimeType?: string;
        imageId?: string;
        message?: string;
        error?: string;
        transcription?: string;
      }) => {
        let currentTriggerId: string | null;
        if (this.currentTriggerData?.trigger_id) {
          currentTriggerId = this.currentTriggerData.trigger_id;
        } else if (triggerId) {
          currentTriggerId = triggerId;
        } else {
          currentTriggerId = null;
        }

        await this.handleWebviewMessage(
          webviewMessage,
          currentTriggerId,
          mcpIntegration,
          specialHandling,
        );
      },
    );
  }

  /**
   * Handle webview messages
   */
  private async handleWebviewMessage(
    webviewMessage: any,
    currentTriggerId: string | null,
    mcpIntegration: boolean,
    specialHandling: string | null,
  ): Promise<void> {
    switch (webviewMessage.command) {
      case "send": {
        const text = webviewMessage.text ?? "";
        const attachments = webviewMessage.attachments ?? [];
        const eventType = mcpIntegration ? "MCP_RESPONSE" : "REVIEW_SUBMITTED";
        await this.logUserInput(text, eventType, currentTriggerId, attachments);
        await this.handleReviewMessage(
          text,
          attachments,
          currentTriggerId,
          mcpIntegration,
          specialHandling,
        );
        break;
      }
      case "attach": {
        await this.logUserInput(
          "User clicked attachment button",
          "ATTACHMENT_CLICK",
          currentTriggerId,
        );
        await this.handleFileAttachment(currentTriggerId);
        break;
      }
      case "uploadImage": {
        await this.logUserInput(
          "User clicked image upload button",
          "IMAGE_UPLOAD_CLICK",
          currentTriggerId,
        );
        await this.handleImageUpload(currentTriggerId);
        break;
      }
      case "ready": {
        this.chatPanel?.webview.postMessage({
          command: "updateMcpStatus",
          active: mcpIntegration ? true : false,
        });
        break;
      }
      // Add other message handlers as needed
    }
  }

  /**
   * Send extension acknowledgement
   */
  private async sendExtensionAcknowledgement(
    triggerId: string,
    toolType: string,
  ): Promise<void> {
    try {
      const timestamp = new Date().toISOString();
      const ackData = {
        acknowledged: true,
        timestamp,
        trigger_id: triggerId,
        tool_type: toolType,
        extension: "review-gate-v3",
        popup_activated: true,
      };
      const ackFile = this.getTempPath(`review_gate_ack_${triggerId}.json`);
      await fs.writeFile(ackFile, JSON.stringify(ackData, null, 2));
    } catch (error) {
      this.logError("Could not send extension acknowledgement", error);
    }
  }

  /**
   * Log user input with async operations
   */
  private async logUserInput(
    inputText: string,
    eventType: string = "MESSAGE",
    triggerId: string | null = null,
    attachments: Attachment[] = [],
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const logMsg = `[${timestamp}] ${eventType}: ${inputText}`;

    this.logInfo(`REVIEW GATE USER INPUT: ${inputText}`);

    try {
      const logFile = this.getTempPath("review_gate_user_inputs.log");
      await fs.appendFile(logFile, `${logMsg}\n`);

      if (triggerId && eventType === "MCP_RESPONSE") {
        const responsePatterns = [
          this.getTempPath(`review_gate_response_${triggerId}.json`),
          this.getTempPath("review_gate_response.json"),
          this.getTempPath(`mcp_response_${triggerId}.json`),
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
            await fs.writeFile(responseFile, responseJson);
            this.logInfo(`MCP response written: ${responseFile}`);
          } catch (writeError) {
            this.logError(
              `Failed to write response file ${responseFile}`,
              writeError,
            );
          }
        }
      }
    } catch (error) {
      this.logError("Could not write to Review Gate log file", error);
    }
  }

  /**
   * Handle review message processing
   */
  private async handleReviewMessage(
    text: string,
    attachments: Attachment[],
    triggerId: string | null,
    mcpIntegration: boolean,
    specialHandling: string | null,
  ): Promise<void> {
    const funnyResponses = [
      "Review sent - Hold on to your pants until the review gate is called again! 🎢",
      "Message delivered! Agent is probably doing agent things now... ⚡",
      "Your wisdom has been transmitted to the digital overlords! 🤖",
      "Response launched into the void - expect agent magic soon! ✨",
      "Review gate closed - Agent is chewing on your input! 🍕",
      "Message received and filed under 'Probably Important'! 📁",
      "Your input is now part of the agent's master plan! 🧠",
      "Review sent - The agent owes you one! 🤝",
      "Success! Your thoughts are now haunting the agent's dreams! 👻",
      "Delivered faster than pizza on a Friday night! 🍕",
    ];

    if (specialHandling === "shutdown_mcp") {
      const confirmed =
        text.toUpperCase().includes("CONFIRM") || text.toUpperCase() === "YES";
      if (confirmed) {
        await this.logUserInput(
          `SHUTDOWN CONFIRMED: ${text}`,
          "SHUTDOWN_CONFIRMED",
          triggerId,
        );
        this.chatPanel?.webview.postMessage({
          command: "addMessage",
          text:
            `🛑 SHUTDOWN CONFIRMED: "${text}"\n\n` +
            `MCP server shutdown has been approved by user.\n\n` +
            `Cursor Agent will proceed with graceful shutdown.`,
          type: "system",
        });
      } else {
        await this.logUserInput(
          `SHUTDOWN ALTERNATIVE: ${text}`,
          "SHUTDOWN_ALTERNATIVE",
          triggerId,
        );
        this.chatPanel?.webview.postMessage({
          command: "addMessage",
          text:
            `💡 ALTERNATIVE INSTRUCTIONS: "${text}"\n\n` +
            `Your instructions have been sent to the Cursor Agent instead of shutdown confirmation.\n\n` +
            `The Agent will process your alternative request.`,
          type: "system",
        });
      }
    } else {
      const randomResponse =
        funnyResponses[Math.floor(Math.random() * funnyResponses.length)];
      this.chatPanel?.webview.postMessage({
        command: "addMessage",
        text: randomResponse,
        type: "system",
        plain: true,
      });
    }

    setTimeout(() => {
      this.chatPanel?.webview.postMessage({
        command: "updateMcpStatus",
        active: false,
      });
    }, 1000);
  }

  // Utility Methods

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
   * Check if file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clean up trigger file after processing
   */
  private async cleanupTriggerFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
      this.logDebug(`Cleaned up trigger file: ${filePath}`);
    } catch (error) {
      this.logWarning(`Could not clean up trigger file ${filePath}`, error);
    }
  }

  /**
   * Clear all caches and timers
   */
  private clearAllCaches(): void {
    // Clear debounce timers
    this.debounceTimers.forEach((timer) => clearTimeout(timer));
    this.debounceTimers.clear();

    // Clear processing queue
    this.processingQueue.forEach((item) => {
      if (item.timeoutHandle) {
        clearTimeout(item.timeoutHandle);
      }
    });
    this.processingQueue.clear();

    // Clear caches
    this.toolConfigCache.clear();
    this.fileCache.clear();
  }

  /**
   * Get Review Gate HTML content for webview
   */
  private getReviewGateHTML(
    title: string = "Review Gate",
    mcpIntegration: boolean = false,
  ): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            margin: 0;
            padding: 0;
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .review-container {
            height: 100vh;
            display: flex;
            flex-direction: column;
            max-width: 600px;
            margin: 0 auto;
            width: 100%;
            animation: slideIn 0.3s ease-out;
        }

        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateY(20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .review-header {
            flex-shrink: 0;
            padding: 16px 20px 12px 20px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            gap: 8px;
            background: var(--vscode-editor-background);
        }

        .review-title {
            font-size: 18px;
            font-weight: 600;
            color: var(--vscode-foreground);
        }

        .review-author {
            font-size: 12px;
            opacity: 0.7;
            margin-left: auto;
        }

        .status-indicator {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--vscode-charts-orange);
            animation: pulse 2s infinite;
            transition: background-color 0.3s ease;
            margin-right: 4px;
        }

        .status-indicator.active {
            background: var(--vscode-charts-green);
        }

        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
        }

        .messages-container {
            flex: 1;
            overflow-y: auto;
            padding: 16px 20px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .message {
            display: flex;
            gap: 8px;
            animation: messageSlide 0.3s ease-out;
        }

        @keyframes messageSlide {
            from {
                opacity: 0;
                transform: translateY(10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .message.user {
            justify-content: flex-end;
        }

        .message-bubble {
            max-width: 70%;
            padding: 12px 16px;
            border-radius: 18px;
            word-wrap: break-word;
            white-space: pre-wrap;
        }

        .message.system .message-bubble {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-bottom-left-radius: 6px;
        }

        .message.user .message-bubble {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-bottom-right-radius: 6px;
        }

        .message.system.plain {
            justify-content: center;
            margin: 8px 0;
        }

        .message.system.plain .message-content {
            background: none;
            padding: 8px 16px;
            border-radius: 0;
            font-size: 13px;
            opacity: 0.8;
            font-style: italic;
            text-align: center;
            border: none;
            color: var(--vscode-foreground);
        }

        /* Speech error message styling */
        .message.system.plain .message-content[data-speech-error] {
            background: rgba(255, 107, 53, 0.1);
            border: 1px solid rgba(255, 107, 53, 0.3);
            color: var(--vscode-errorForeground);
            font-weight: 500;
            opacity: 1;
            padding: 12px 16px;
            border-radius: 8px;
        }

        .message-time {
            font-size: 11px;
            opacity: 0.6;
            margin-top: 4px;
        }

        .input-container {
            flex-shrink: 0;
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 16px 20px 20px 20px;
            border-top: 1px solid var(--vscode-panel-border);
            background: var(--vscode-editor-background);
        }

        .input-container.disabled {
            opacity: 0.5;
            pointer-events: none;
        }

        .input-wrapper {
            flex: 1;
            display: flex;
            align-items: center;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 20px;
            padding: 8px 12px;
            transition: all 0.2s ease;
            position: relative;
        }

        .mic-icon {
            position: absolute;
            left: 16px;
            top: 50%;
            transform: translateY(-50%);
            color: var(--vscode-input-placeholderForeground);
            font-size: 14px;
            pointer-events: none;
            opacity: 0.7;
            transition: all 0.2s ease;
        }

        .mic-icon.active {
            color: #ff6b35;
            opacity: 1;
            pointer-events: auto;
            cursor: pointer;
        }

        .mic-icon.recording {
            color: #ff3333;
            animation: pulse 1.5s infinite;
        }

        .mic-icon.processing {
            color: #ff6b35;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            0% { transform: translateY(-50%) rotate(0deg); }
            100% { transform: translateY(-50%) rotate(360deg); }
        }

        .input-wrapper:focus-within {
            border-color: transparent;
            box-shadow: 0 0 0 2px rgba(255, 165, 0, 0.4), 0 0 8px rgba(255, 165, 0, 0.2);
        }

        .message-input {
            flex: 1;
            background: transparent;
            border: none !important;
            outline: none !important;
            box-shadow: none !important;
            color: var(--vscode-input-foreground);
            resize: none;
            min-height: 20px;
            max-height: 120px;
            font-family: inherit;
            font-size: 14px;
            line-height: 1.4;
            padding-left: 24px; /* Make room for mic icon */
        }

        .message-input:focus {
            border: none !important;
            outline: none !important;
            box-shadow: none !important;
        }

        .message-input:focus-visible {
            border: none !important;
            outline: none !important;
            box-shadow: none !important;
        }

        .message-input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }

        .message-input:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .message-input.paste-highlight {
            box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.4) !important;
            transition: box-shadow 0.2s ease;
        }

        .attach-button {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            font-size: 14px;
            padding: 4px;
            border-radius: 50%;
            width: 28px;
            height: 28px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s ease;
        }

        .attach-button:hover {
            background: var(--vscode-button-hoverBackground);
            transform: scale(1.1);
        }

        .attach-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }

        .send-button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 50%;
            width: 36px;
            height: 36px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s ease;
            font-size: 14px;
        }

        .send-button:hover {
            background: var(--vscode-button-hoverBackground);
            transform: scale(1.05);
        }

        .send-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }

        .typing-indicator {
            display: none;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            font-size: 12px;
            opacity: 0.7;
        }

        .typing-dots {
            display: flex;
            gap: 2px;
        }

        .typing-dot {
            width: 4px;
            height: 4px;
            background: var(--vscode-foreground);
            border-radius: 50%;
            animation: typingDot 1.4s infinite ease-in-out;
        }

        .typing-dot:nth-child(1) { animation-delay: -0.32s; }
        .typing-dot:nth-child(2) { animation-delay: -0.16s; }

        @keyframes typingDot {
            0%, 80%, 100% { transform: scale(0); }
            40% { transform: scale(1); }
        }

        .mcp-status {
            font-size: 11px;
            opacity: 0.6;
            margin-left: 4px;
        }

        /* Drag and drop styling */
        body.drag-over {
            background: rgba(0, 123, 255, 0.05);
        }

        body.drag-over::before {
            content: 'Drop images here to attach them';
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 16px 24px 16px 48px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            z-index: 1000;
            pointer-events: none;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            font-family: var(--vscode-font-family);
        }

        body.drag-over::after {
            content: '\\f093';
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%) translate(-120px, 0);
            color: var(--vscode-badge-foreground);
            font-size: 16px;
            z-index: 1001;
            pointer-events: none;
            font-family: 'Font Awesome 6 Free';
            font-weight: 900;
        }

        /* Image preview styling */
        .image-preview {
            position: relative;
        }

        .image-container {
            position: relative;
        }

        .image-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }

        .image-filename {
            font-size: 12px;
            font-weight: 500;
            opacity: 0.9;
            flex: 1;
            margin-right: 8px;
            word-break: break-all;
        }

        .remove-image-btn {
            background: rgba(255, 59, 48, 0.1);
            border: 1px solid rgba(255, 59, 48, 0.3);
            color: #ff3b30;
            border-radius: 50%;
            width: 20px;
            height: 20px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            transition: all 0.2s ease;
            flex-shrink: 0;
        }

        .remove-image-btn:hover {
            background: rgba(255, 59, 48, 0.2);
            border-color: rgba(255, 59, 48, 0.5);
            transform: scale(1.1);
        }

        .remove-image-btn:active {
            transform: scale(0.95);
        }
    </style>
</head>
<body>
    <div class="review-container">
        <div class="review-header">
            <div class="review-title">${title}</div>
            <div class="status-indicator" id="statusIndicator"></div>
            <div class="mcp-status" id="mcpStatus">Checking MCP...</div>
            <div class="review-author">by Lakshman Turlapati & HexSleeves</div>
        </div>

        <div class="messages-container" id="messages">
            <!-- Messages will be added here -->
        </div>

        <div class="typing-indicator" id="typingIndicator">
            <span>Processing review</span>
            <div class="typing-dots">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            </div>
        </div>

        <div class="input-container" id="inputContainer">
            <div class="input-wrapper">
                <i id="micIcon" class="fas fa-microphone mic-icon active" title="Click to speak"></i>
                <textarea id="messageInput" class="message-input" placeholder="${mcpIntegration ? 'Cursor Agent is waiting for your response...' : 'Type your review or feedback...'}" rows="1"></textarea>
                <button id="attachButton" class="attach-button" title="Upload image">
                    <i class="fas fa-image"></i>
                </button>
            </div>
            <button id="sendButton" class="send-button" title="Send ${mcpIntegration ? 'response to Agent' : 'review'}">
                <i class="fas fa-arrow-up"></i>
            </button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        const messagesContainer = document.getElementById('messages');
        const messageInput = document.getElementById('messageInput');
        const sendButton = document.getElementById('sendButton');
        const attachButton = document.getElementById('attachButton');
        const micIcon = document.getElementById('micIcon');
        const typingIndicator = document.getElementById('typingIndicator');
        const statusIndicator = document.getElementById('statusIndicator');
        const mcpStatus = document.getElementById('mcpStatus');
        const inputContainer = document.getElementById('inputContainer');

        let messageCount = 0;
        let mcpActive = true; // Default to true for better UX
        let mcpIntegration = ${mcpIntegration};
        let attachedImages = []; // Store uploaded images
        let isRecording = false;
        let mediaRecorder = null;

        function updateMcpStatus(active) {
            mcpActive = active;

            if (active) {
                statusIndicator.classList.add('active');
                mcpStatus.textContent = 'MCP Active';
                inputContainer.classList.remove('disabled');
                messageInput.disabled = false;
                sendButton.disabled = false;
                attachButton.disabled = false;
                messageInput.placeholder = mcpIntegration ? 'Cursor Agent is waiting for your response...' : 'Type your review or feedback...';
            } else {
                statusIndicator.classList.remove('active');
                mcpStatus.textContent = 'MCP Inactive';
                inputContainer.classList.add('disabled');
                messageInput.disabled = true;
                sendButton.disabled = true;
                attachButton.disabled = true;
                messageInput.placeholder = 'MCP server is not active. Please start the server to enable input.';
            }
        }

        function addMessage(text, type = 'user', toolData = null, plain = false, isError = false) {
            messageCount++;
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${type}\${plain ? ' plain' : ''}\`;

            const contentDiv = document.createElement('div');
            contentDiv.className = plain ? 'message-content' : 'message-bubble';
            contentDiv.textContent = text;

            // Add special styling for speech errors
            if (isError && plain) {
                contentDiv.setAttribute('data-speech-error', 'true');
            }

            messageDiv.appendChild(contentDiv);

            // Only add timestamp for non-plain messages
            if (!plain) {
                const timeDiv = document.createElement('div');
                timeDiv.className = 'message-time';
                timeDiv.textContent = new Date().toLocaleTimeString();
                messageDiv.appendChild(timeDiv);
            }

            messagesContainer.appendChild(messageDiv);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        function addSpeechError(errorMessage) {
            // Add prominent error message with special styling
            addMessage('🎤 Speech Error: ' + errorMessage, 'system', null, true, true);

            // Add helpful troubleshooting tips based on error type
            let tip = '';
            if (errorMessage.includes('permission') || errorMessage.includes('Permission')) {
                tip = '💡 Grant microphone access in system settings';
            } else if (errorMessage.includes('busy') || errorMessage.includes('device')) {
                tip = '💡 Close other recording apps and try again';
            } else if (errorMessage.includes('SoX') || errorMessage.includes('sox')) {
                tip = '💡 SoX audio tool may need to be installed or updated';
            } else if (errorMessage.includes('timeout')) {
                tip = '💡 Try speaking more clearly or check microphone connection';
            } else if (errorMessage.includes('Whisper') || errorMessage.includes('transcription')) {
                tip = '💡 Speech-to-text service may be unavailable';
            } else {
                tip = '💡 Check microphone permissions and try again';
            }

            if (tip) {
                setTimeout(() => {
                    addMessage(tip, 'system', null, true);
                }, 500);
            }
        }

        function showTyping() {
            typingIndicator.style.display = 'flex';
        }

        function hideTyping() {
            typingIndicator.style.display = 'none';
        }

        function simulateResponse(userMessage) {
            // Don't simulate response - the backend handles acknowledgments now
            // This avoids duplicate messages
            hideTyping();
        }

        function sendMessage() {
            const text = messageInput.value.trim();
            if (!text && attachedImages.length === 0) return;

            // Create message with text and images
            let displayMessage = text;
            if (attachedImages.length > 0) {
                displayMessage += (text ? '\\n\\n' : '') + \`[\${attachedImages.length} image(s) attached]\`;
            }

            addMessage(displayMessage, 'user');

            // Send to extension with images
            vscode.postMessage({
                command: 'send',
                text: text,
                attachments: attachedImages,
                timestamp: new Date().toISOString(),
                mcpIntegration: mcpIntegration
            });

            messageInput.value = '';
            attachedImages = []; // Clear attached images
            adjustTextareaHeight();

            // Ensure mic icon is visible after sending message
            toggleMicIcon();

            simulateResponse(displayMessage);
        }

        function adjustTextareaHeight() {
            messageInput.style.height = 'auto';
            messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
        }

        function handleImageUploaded(imageData) {
            // Add image to attachments with unique ID
            const imageId = 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            imageData.id = imageId;
            attachedImages.push(imageData);

            // Show image preview in messages with remove button
            const imagePreview = document.createElement('div');
            imagePreview.className = 'message system image-preview';
            imagePreview.setAttribute('data-image-id', imageId);
            imagePreview.innerHTML = \`
                <div class="message-bubble image-container">
                    <div class="image-header">
                        <span class="image-filename">\${imageData.fileName}</span>
                        <button class="remove-image-btn" onclick="removeImage('\${imageId}')" title="Remove image">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                    <img src="\${imageData.dataUrl}" style="max-width: 200px; max-height: 200px; border-radius: 8px; margin-top: 8px;" alt="Uploaded image">
                    <div style="margin-top: 8px; font-size: 12px; opacity: 0.7;">Image ready to send (\${(imageData.size / 1024).toFixed(1)} KB)</div>
                </div>
                <div class="message-time">\${new Date().toLocaleTimeString()}</div>
            \`;
            messagesContainer.appendChild(imagePreview);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;

            updateImageCounter();
        }

        // Remove image function
        function removeImage(imageId) {
            // Remove from attachments array
            attachedImages = attachedImages.filter(img => img.id !== imageId);

            // Remove from DOM
            const imagePreview = document.querySelector(\`[data-image-id="\${imageId}"]\`);
            if (imagePreview) {
                imagePreview.remove();
            }

            updateImageCounter();

            // Log removal
            console.log(\`🗑️ Image removed: \${imageId}\`);
            vscode.postMessage({
                command: 'logImageRemoved',
                imageId: imageId
            });
        }

        // Update image counter in input placeholder
        function updateImageCounter() {
            const count = attachedImages.length;
            const baseText = mcpIntegration ? 'Cursor Agent is waiting for your response' : 'Type your review or feedback';

            if (count > 0) {
                messageInput.placeholder = \`\${baseText}... \${count} image(s) attached\`;
            } else {
                messageInput.placeholder = \`\${baseText}...\`;
            }
        }

        // Handle paste events for images with debounce to prevent duplicates
        let lastPasteTime = 0;
        function handlePaste(e) {
            const now = Date.now();
            // Prevent duplicate pastes within 500ms
            if (now - lastPasteTime < 500) {
                return;
            }

            const clipboardData = e.clipboardData || window.clipboardData;
            if (!clipboardData) return;

            const items = clipboardData.items;
            if (!items) return;

            // Look for image items in clipboard
            for (let i = 0; i < items.length; i++) {
                const item = items[i];

                if (item.type.indexOf('image') !== -1) {
                    e.preventDefault(); // Prevent default paste behavior for images
                    lastPasteTime = now; // Update last paste time

                    const file = item.getAsFile();
                    if (file) {
                        processPastedImage(file);
                    }
                    break;
                }
            }
        }

        // Process pasted image file
        function processPastedImage(file) {
            const reader = new FileReader();

            reader.onload = function(e) {
                const dataUrl = e.target.result;
                const base64Data = dataUrl.split(',')[1];

                // Generate a filename with timestamp
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const extension = file.type.split('/')[1] || 'png';
                const fileName = \`pasted-image-\${timestamp}.\${extension}\`;

                const imageData = {
                    fileName: fileName,
                    filePath: 'clipboard', // Indicate this came from clipboard
                    mimeType: file.type,
                    base64Data: base64Data,
                    dataUrl: dataUrl,
                    size: file.size,
                    source: 'paste' // Mark as pasted image
                };

                console.log(\`📋 Image pasted: \${fileName} (\${file.size} bytes)\`);

                // Log the pasted image for MCP integration
                vscode.postMessage({
                    command: 'logPastedImage',
                    fileName: fileName,
                    size: file.size,
                    mimeType: file.type
                });

                // Add to attachments and show preview
                handleImageUploaded(imageData);
            };

            reader.onerror = function() {
                console.error('Error reading pasted image');
                addMessage('❌ Error processing pasted image', 'system', null, true);
            };

            reader.readAsDataURL(file);
        }

        // Drag and drop handlers
        let dragCounter = 0;

        function handleDragEnter(e) {
            e.preventDefault();
            dragCounter++;
            if (hasImageFiles(e.dataTransfer)) {
                document.body.classList.add('drag-over');
                messageInput.classList.add('paste-highlight');
            }
        }

        function handleDragLeave(e) {
            e.preventDefault();
            dragCounter--;
            if (dragCounter <= 0) {
                document.body.classList.remove('drag-over');
                messageInput.classList.remove('paste-highlight');
                dragCounter = 0;
            }
        }

        function handleDragOver(e) {
            e.preventDefault();
            if (hasImageFiles(e.dataTransfer)) {
                e.dataTransfer.dropEffect = 'copy';
            }
        }

        function handleDrop(e) {
            e.preventDefault();
            dragCounter = 0;
            document.body.classList.remove('drag-over');
            messageInput.classList.remove('paste-highlight');

            const files = e.dataTransfer.files;
            if (files && files.length > 0) {
                // Process files with a small delay to prevent conflicts with paste events
                setTimeout(() => {
                    for (let i = 0; i < files.length; i++) {
                        const file = files[i];
                        if (file.type.startsWith('image/')) {
                            // Log drag and drop action
                            vscode.postMessage({
                                command: 'logDragDropImage',
                                fileName: file.name,
                                size: file.size,
                                mimeType: file.type
                            });
                            processPastedImage(file);
                        }
                    }
                }, 50);
            }
        }

        function hasImageFiles(dataTransfer) {
            if (dataTransfer.types) {
                for (let i = 0; i < dataTransfer.types.length; i++) {
                    if (dataTransfer.types[i] === 'Files') {
                        return true; // We'll check for images on drop
                    }
                }
            }
            return false;
        }

        // Hide/show mic icon based on input
        function toggleMicIcon() {
            // Don't toggle if we're currently recording or processing
            if (isRecording || micIcon.classList.contains('processing')) {
                return;
            }

            if (messageInput.value.trim().length > 0) {
                micIcon.style.opacity = '0';
                micIcon.style.pointerEvents = 'none';
            } else {
                // Always ensure mic is visible and clickable when input is empty
                micIcon.style.opacity = '0.7';
                micIcon.style.pointerEvents = 'auto';
                // Ensure proper mic icon state
                if (!micIcon.classList.contains('fa-microphone')) {
                    micIcon.className = 'fas fa-microphone mic-icon active';
                }
            }
        }

        // Check if speech recording is available
        function isSpeechAvailable() {
            return (
                navigator.mediaDevices &&
                navigator.mediaDevices.getUserMedia &&
                typeof MediaRecorder !== 'undefined'
            );
        }

        // Speech recording functions - using Node.js backend
        function startRecording() {
            // Start recording via extension backend
            vscode.postMessage({
                command: 'startRecording',
                timestamp: new Date().toISOString()
            });

            isRecording = true;
            // Change icon to stop icon and add recording state
            micIcon.className = 'fas fa-stop mic-icon recording';
            micIcon.title = 'Recording... Click to stop';
            console.log('🎤 Recording started - UI updated to stop icon');
        }

        function stopRecording() {
            // Stop recording via extension backend
            vscode.postMessage({
                command: 'stopRecording',
                timestamp: new Date().toISOString()
            });

            isRecording = false;
            // Change to processing state
            micIcon.className = 'fas fa-spinner mic-icon processing';
            micIcon.title = 'Processing speech...';
            messageInput.placeholder = 'Processing speech... Please wait';
            console.log('🔄 Recording stopped - processing speech...');
        }

        function resetMicIcon() {
            // Reset to normal microphone state
            isRecording = false; // Ensure recording flag is cleared
            micIcon.className = 'fas fa-microphone mic-icon active';
            micIcon.title = 'Click to speak';
            messageInput.placeholder = mcpIntegration ? 'Cursor Agent is waiting for your response...' : 'Type your review or feedback...';

            // Force visibility based on input state
            if (messageInput.value.trim().length === 0) {
                micIcon.style.opacity = '0.7';
                micIcon.style.pointerEvents = 'auto';
            } else {
                micIcon.style.opacity = '0';
                micIcon.style.pointerEvents = 'none';
            }

            console.log('🎤 Mic icon reset to normal state');
        }

        // Event listeners
        messageInput.addEventListener('input', () => {
            adjustTextareaHeight();
            toggleMicIcon();
        });

        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // Add paste event listener for images
        messageInput.addEventListener('paste', handlePaste);
        document.addEventListener('paste', handlePaste);

        // Add drag and drop support for images
        document.addEventListener('dragover', handleDragOver);
        document.addEventListener('drop', handleDrop);
        document.addEventListener('dragenter', handleDragEnter);
        document.addEventListener('dragleave', handleDragLeave);

        sendButton.addEventListener('click', () => {
            sendMessage();
        });

        attachButton.addEventListener('click', () => {
            vscode.postMessage({ command: 'uploadImage' });
        });

        micIcon.addEventListener('click', () => {
            if (isRecording) {
                stopRecording();
            } else {
                startRecording();
            }
        });

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;

            switch (message.command) {
                case 'addMessage':
                    addMessage(message.text, message.type || 'system', message.toolData, message.plain || false);
                    break;
                case 'newMessage':
                    addMessage(message.text, message.type || 'system', message.toolData, message.plain || false);
                    if (message.mcpIntegration) {
                        mcpIntegration = true;
                        messageInput.placeholder = 'Cursor Agent is waiting for your response...';
                    }
                    break;
                case 'focus':
                    messageInput.focus();
                    break;
                case 'updateMcpStatus':
                    updateMcpStatus(message.active);
                    break;
                case 'imageUploaded':
                    handleImageUploaded(message.imageData);
                    break;
                case 'recordingStarted':
                    console.log('✅ Recording confirmation received from backend');
                    break;
                case 'speechTranscribed':
                    // Handle speech-to-text result
                    console.log('📝 Speech transcription received:', message);
                    if (message.transcription && message.transcription.trim()) {
                        messageInput.value = message.transcription.trim();
                        adjustTextareaHeight();
                        messageInput.focus();
                        console.log('✅ Text injected into input:', message.transcription.trim());
                        // Reset mic icon after successful transcription
                        resetMicIcon();
                    } else if (message.error) {
                        console.error('❌ Speech transcription error:', message.error);

                        // Show prominent error message in chat
                        addSpeechError(message.error);

                        // Also show in placeholder briefly
                        const originalPlaceholder = messageInput.placeholder;
                        messageInput.placeholder = 'Speech failed - try again';
                        setTimeout(() => {
                            messageInput.placeholder = originalPlaceholder;
                            resetMicIcon();
                        }, 3000);
                    } else {
                        console.log('⚠️ Empty transcription received');

                        // Show helpful message in chat
                        addMessage('🎤 No speech detected - please speak clearly and try again', 'system', null, true);

                        const originalPlaceholder = messageInput.placeholder;
                        messageInput.placeholder = 'No speech detected - try again';
                        setTimeout(() => {
                            messageInput.placeholder = originalPlaceholder;
                            resetMicIcon();
                        }, 3000);
                    }
                    break;
            }
        });

        // Initialize speech availability - now using SoX directly
        function initializeSpeech() {
            // Always available since we're using SoX directly
            micIcon.style.opacity = '0.7';
            micIcon.style.pointerEvents = 'auto';
            micIcon.title = 'Click to speak (SoX recording)';
            micIcon.classList.add('active');
            console.log('Speech recording available via SoX direct recording');

            // Ensure mic icon visibility on initialization
            if (messageInput.value.trim().length === 0) {
                micIcon.style.opacity = '0.7';
                micIcon.style.pointerEvents = 'auto';
            }
        }

        // Make removeImage globally accessible for onclick handlers
        window.removeImage = removeImage;

        // Initialize
        vscode.postMessage({ command: 'ready' });
        initializeSpeech();

        // Focus input immediately
        setTimeout(() => {
            messageInput.focus();
        }, 100);
    </script>
</body>
</html>`;
  }

  /**
   * Handle file attachment
   */
  private async handleFileAttachment(triggerId: string | null): Promise<void> {
    await this.logUserInput(
      "User requested file attachment for review",
      "FILE_ATTACHMENT",
      triggerId,
    );

    try {
      const fileUris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: "Select file(s) for review",
        filters: { "All files": ["*"] },
      });

      if (fileUris && fileUris.length > 0) {
        const filePaths = fileUris.map((uri) => uri.fsPath);
        const fileNames = filePaths.map((fp) => path.basename(fp));

        await this.logUserInput(
          `Files selected for review: ${fileNames.join(", ")}`,
          "FILE_SELECTED",
          triggerId,
        );

        this.chatPanel?.webview.postMessage({
          command: "addMessage",
          text:
            `Files attached for review:\n` +
            `${fileNames.map((n) => "• " + n).join("\n")}\n\n` +
            `Paths:\n` +
            `${filePaths.map((p) => "• " + p).join("\n")}`,
          type: "system",
        });
      } else {
        await this.logUserInput(
          "No files selected for review",
          "FILE_CANCELLED",
          triggerId,
        );
      }
    } catch (error) {
      this.logError("Error handling file attachment", error);
    }
  }

  /**
   * Handle image upload
   */
  private async handleImageUpload(triggerId: string | null): Promise<void> {
    await this.logUserInput(
      "User requested image upload for review",
      "IMAGE_UPLOAD",
      triggerId,
    );

    try {
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
            const imageBuffer = await fs.readFile(filePath);
            const base64Data = imageBuffer.toString("base64");
            const mimeType = this.getMimeType(fileName);
            const dataUrl = `data:${mimeType};base64,${base64Data}`;

            const imageData: Attachment = {
              id: `img_${Date.now()}_${Math.random()
                .toString(36)
                .substr(2, 9)}`,
              fileName,
              filePath,
              mimeType,
              base64Data,
              dataUrl,
              size: imageBuffer.length,
            };

            await this.logUserInput(
              `Image uploaded: ${fileName}`,
              "IMAGE_UPLOADED",
              triggerId,
            );

            this.chatPanel?.webview.postMessage({
              command: "imageUploaded",
              imageData,
            });
          } catch (error) {
            this.logError(`Error processing image ${fileName}`, error);
            vscode.window.showErrorMessage(
              `Failed to process image: ${fileName}`,
            );
          }
        }
      } else {
        await this.logUserInput(
          "No images selected for upload",
          "IMAGE_CANCELLED",
          triggerId,
        );
      }
    } catch (error) {
      this.logError("Error handling image upload", error);
    }
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
    return mimeTypes[ext] ?? "image/jpeg";
  }
}
