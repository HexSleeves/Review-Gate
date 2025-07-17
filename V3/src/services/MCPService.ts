/**
 * MCP (Model Context Protocol) Service for Review Gate VS Code Extension
 *
 * This service handles all MCP server interactions, providing async status monitoring,
 * connection management, performance optimizations, and resource management.
 * It replaces the MCP-related functionality from the monolithic extension.ts file.
 */

import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import { BaseService, ServiceEventType } from "./BaseService";
import { MCPStatus, FileChangeHandler } from "../types";

/**
 * Interface for MCP server connection configuration
 */
export interface MCPConnectionConfig {
  /** Connection timeout in milliseconds */
  timeout: number;
  /** Number of retry attempts */
  retryAttempts: number;
  /** Delay between retries in milliseconds */
  retryDelay: number;
  /** Exponential backoff multiplier */
  backoffMultiplier: number;
  /** Maximum retry delay in milliseconds */
  maxRetryDelay: number;
}

/**
 * Interface for MCP status monitoring configuration
 */
export interface MCPMonitoringConfig {
  /** Status check interval in milliseconds */
  statusInterval: number;
  /** File age threshold for considering MCP active (milliseconds) */
  activeThreshold: number;
  /** Whether to use file system watchers instead of polling */
  useFileWatchers: boolean;
  /** Debounce delay for status changes in milliseconds */
  debounceDelay: number;
}

/**
 * Interface for MCP tool data structure
 */
export interface MCPToolData {
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
 * Interface for Review Gate trigger structure
 */
export interface ReviewGateTrigger {
  editor?: string;
  system?: string;
  data: MCPToolData;
}

/**
 * Interface for MCP server response cache entry
 */
interface MCPCacheEntry {
  data: any;
  timestamp: number;
  ttl: number;
}

/**
 * Interface for connection pool entry
 */
interface ConnectionPoolEntry {
  id: string;
  lastUsed: number;
  isActive: boolean;
  retryCount: number;
}

/**
 * MCP Service class extending BaseService
 */
export class MCPService extends BaseService {
  /** Current MCP server status */
  private mcpStatus: MCPStatus = MCPStatus.DISCONNECTED;

  /** Status monitoring interval */
  private statusInterval: NodeJS.Timeout | null = null;

  /** File system watchers */
  private fileWatchers: Map<string, fsSync.FSWatcher> = new Map();

  /** Response cache for performance optimization */
  private responseCache: Map<string, MCPCacheEntry> = new Map();

  /** Connection pool for managing multiple connections */
  private connectionPool: Map<string, ConnectionPoolEntry> = new Map();

  /** Debounced status update function */
  private debouncedStatusUpdate: (() => void) | null = null;

  /** Current trigger data being processed */
  private currentTriggerData: MCPToolData | null = null;

  /** Lazy loading flag */
  private isLazyLoaded: boolean = false;

  /** Retry timeouts for exponential backoff */
  private retryTimeouts: Map<string, NodeJS.Timeout> = new Map();

  /** Performance metrics specific to MCP operations */
  private mcpMetrics = {
    statusChecks: 0,
    successfulConnections: 0,
    failedConnections: 0,
    cacheHits: 0,
    cacheMisses: 0,
    averageResponseTime: 0,
    lastResponseTime: 0,
  };

  constructor() {
    super("MCPService");
  }

  /**
   * Initialize the MCP service
   */
  protected async onInitialize(
    context: vscode.ExtensionContext,
  ): Promise<void> {
    this.logInfo("Initializing MCP Service...");

    // Set up configuration listeners
    this.setupMCPConfigurationListeners();

    // Initialize lazy loading - only start monitoring when needed
    if (this.shouldStartMonitoring()) {
      await this.startMCPMonitoring();
    }

    this.logInfo("MCP Service initialized successfully");
  }

  /**
   * Dispose of service resources
   */
  protected onDispose(): void {
    this.logInfo("Disposing MCP Service...");

    // Clear status monitoring
    this.stopMCPMonitoring();

    // Clear file watchers
    this.clearFileWatchers();

    // Clear cache
    this.responseCache.clear();

    // Clear connection pool
    this.connectionPool.clear();

    // Clear retry timeouts
    this.retryTimeouts.forEach((timeout) => clearTimeout(timeout));
    this.retryTimeouts.clear();

    this.logInfo("MCP Service disposed successfully");
  }

  /**
   * Get current MCP status
   */
  public getMCPStatus(): MCPStatus {
    return this.mcpStatus;
  }

  /**
   * Get MCP-specific performance metrics
   */
  public getMCPMetrics(): Readonly<typeof this.mcpMetrics> {
    return { ...this.mcpMetrics };
  }

  /**
   * Start MCP monitoring (lazy loading)
   */
  public async startMCPMonitoring(): Promise<void> {
    if (this.isLazyLoaded) {
      this.logDebug("MCP monitoring already started");
      return;
    }

    const { result } = await this.withTiming("startMCPMonitoring", async () => {
      const monitoringConfig = this.getMonitoringConfig();

      if (monitoringConfig.useFileWatchers) {
        await this.setupFileWatchers();
      } else {
        this.setupPollingMonitoring(monitoringConfig);
      }

      // Setup debounced status update
      this.setupDebouncedStatusUpdate(monitoringConfig.debounceDelay);

      // Initial status check
      await this.checkMCPStatus();

      this.isLazyLoaded = true;
      this.logInfo("MCP monitoring started successfully");
    });

    this.emitServiceEvent(ServiceEventType.CUSTOM, {
      event: "monitoring_started",
      config: this.getMonitoringConfig(),
    });
  }

  /**
   * Stop MCP monitoring
   */
  public stopMCPMonitoring(): void {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }

    this.clearFileWatchers();
    this.isLazyLoaded = false;

    this.logInfo("MCP monitoring stopped");
    this.emitServiceEvent(ServiceEventType.CUSTOM, {
      event: "monitoring_stopped",
    });
  }

  /**
   * Check MCP server status with caching and error handling
   */
  public async checkMCPStatus(): Promise<MCPStatus> {
    return this.withTiming("checkMCPStatus", async () => {
      this.mcpMetrics.statusChecks++;

      try {
        const mcpLogPath = this.getTempPath("review_gate_v2.log");
        const cacheKey = `status_${mcpLogPath}`;

        // Check cache first
        const cached = this.getCachedResponse(cacheKey);
        if (cached) {
          this.mcpMetrics.cacheHits++;
          return cached as MCPStatus;
        }

        this.mcpMetrics.cacheMisses++;

        // Check if file exists
        const fileExists = await this.fileExists(mcpLogPath);
        if (!fileExists) {
          await this.updateMCPStatus(MCPStatus.DISCONNECTED);
          this.cacheResponse(cacheKey, MCPStatus.DISCONNECTED, 1000); // Cache for 1 second
          return MCPStatus.DISCONNECTED;
        }

        // Check file age
        const stats = await fs.stat(mcpLogPath);
        const now = Date.now();
        const fileAge = now - stats.mtime.getTime();
        const activeThreshold = this.getMonitoringConfig().activeThreshold;

        const newStatus =
          fileAge < activeThreshold
            ? MCPStatus.CONNECTED
            : MCPStatus.DISCONNECTED;

        await this.updateMCPStatus(newStatus);
        this.cacheResponse(cacheKey, newStatus, 2000); // Cache for 2 seconds

        return newStatus;
      } catch (error) {
        this.logError("Error checking MCP status", error);
        await this.updateMCPStatus(MCPStatus.ERROR);
        return MCPStatus.ERROR;
      }
    }).then((result) => result.result);
  }

  /**
   * Process Review Gate trigger with connection pooling and retry logic
   */
  public async processTrigger(trigger: ReviewGateTrigger): Promise<void> {
    const { result } = await this.withTiming("processTrigger", async () => {
      // Validate trigger
      if (!this.validateTrigger(trigger)) {
        throw new Error("Invalid trigger data");
      }

      this.currentTriggerData = trigger.data;
      this.logInfo(
        `Processing trigger: ${trigger.data.tool} (ID: ${trigger.data.trigger_id})`,
      );

      // Get or create connection
      const connectionId = await this.getConnection(trigger.data.trigger_id);

      try {
        // Process the trigger with retry logic
        await this.processWithRetry(async () => {
          await this.handleToolCall(trigger.data);
        }, this.getConnectionConfig());

        this.mcpMetrics.successfulConnections++;

        // Send acknowledgment
        await this.sendExtensionAcknowledgement(
          trigger.data.trigger_id,
          trigger.data.tool,
        );
      } catch (error) {
        this.mcpMetrics.failedConnections++;
        this.logError(
          `Failed to process trigger ${trigger.data.trigger_id}`,
          error,
        );
        throw error;
      } finally {
        // Return connection to pool
        this.returnConnection(connectionId);
      }
    });

    this.emitServiceEvent(ServiceEventType.CUSTOM, {
      event: "trigger_processed",
      triggerId: trigger.data.trigger_id,
      tool: trigger.data.tool,
    });
  }

  /**
   * Monitor trigger files with file system watchers
   */
  public async monitorTriggerFiles(): Promise<void> {
    const triggerFilePath = this.getTempPath("review_gate_trigger.json");

    // Setup main trigger file watcher
    await this.setupTriggerFileWatcher(triggerFilePath);

    // Setup backup trigger file watchers
    for (let i = 0; i < 3; i++) {
      const backupPath = this.getTempPath(`review_gate_trigger_${i}.json`);
      await this.setupTriggerFileWatcher(backupPath);
    }

    this.logInfo("Trigger file monitoring started");
  }

  /**
   * Clear response cache
   */
  public clearCache(): void {
    this.responseCache.clear();
    this.logDebug("Response cache cleared");
  }

  /**
   * Get cache statistics
   */
  public getCacheStats(): { size: number; hitRate: number } {
    const totalRequests =
      this.mcpMetrics.cacheHits + this.mcpMetrics.cacheMisses;
    const hitRate =
      totalRequests > 0 ? this.mcpMetrics.cacheHits / totalRequests : 0;

    return {
      size: this.responseCache.size,
      hitRate: Math.round(hitRate * 100) / 100,
    };
  }

  /**
   * Setup configuration listeners for MCP-specific settings
   */
  private setupMCPConfigurationListeners(): void {
    this.onConfigurationChange("mcp", (newConfig, oldConfig) => {
      this.logInfo("MCP configuration changed", {
        old: oldConfig,
        new: newConfig,
      });

      // Restart monitoring if configuration changed significantly
      if (
        newConfig.connectionTimeout !== oldConfig.connectionTimeout ||
        newConfig.retryAttempts !== oldConfig.retryAttempts
      ) {
        this.restartMonitoring();
      }
    });

    this.onConfigurationChange("polling", (newConfig, oldConfig) => {
      if (newConfig.interval !== oldConfig.interval) {
        this.logInfo("Polling interval changed, restarting monitoring");
        this.restartMonitoring();
      }
    });
  }

  /**
   * Setup file system watchers for MCP status monitoring
   */
  private async setupFileWatchers(): Promise<void> {
    const mcpLogPath = this.getTempPath("review_gate_v2.log");

    try {
      // Ensure directory exists
      const dir = path.dirname(mcpLogPath);
      await fs.mkdir(dir, { recursive: true });

      // Setup file watcher
      const watcher = fsSync.watch(
        dir,
        { persistent: false },
        (eventType, filename) => {
          if (filename === path.basename(mcpLogPath)) {
            this.logDebug(`File watcher event: ${eventType} for ${filename}`);
            if (this.debouncedStatusUpdate) {
              this.debouncedStatusUpdate();
            }
          }
        },
      );

      this.fileWatchers.set(mcpLogPath, watcher);
      this.registerDisposable({
        dispose: () => {
          watcher.close();
          this.fileWatchers.delete(mcpLogPath);
        },
      });

      this.logDebug(`File watcher setup for: ${mcpLogPath}`);
    } catch (error) {
      this.logError(
        "Failed to setup file watcher, falling back to polling",
        error,
      );
      this.setupPollingMonitoring(this.getMonitoringConfig());
    }
  }

  /**
   * Setup polling-based monitoring
   */
  private setupPollingMonitoring(config: MCPMonitoringConfig): void {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
    }

    this.statusInterval = setInterval(async () => {
      try {
        await this.checkMCPStatus();
      } catch (error) {
        this.logError("Error in status polling", error);
      }
    }, config.statusInterval);

    this.registerDisposable({
      dispose: () => {
        if (this.statusInterval) {
          clearInterval(this.statusInterval);
          this.statusInterval = null;
        }
      },
    });

    this.logDebug(
      `Polling monitoring setup with interval: ${config.statusInterval}ms`,
    );
  }

  /**
   * Setup debounced status update function
   */
  private setupDebouncedStatusUpdate(debounceDelay: number): void {
    let timeoutId: NodeJS.Timeout | null = null;

    this.debouncedStatusUpdate = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      timeoutId = setTimeout(async () => {
        try {
          await this.checkMCPStatus();
        } catch (error) {
          this.logError("Error in debounced status update", error);
        }
      }, debounceDelay);
    };
  }

  /**
   * Setup trigger file watcher
   */
  private async setupTriggerFileWatcher(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    const filename = path.basename(filePath);

    try {
      await fs.mkdir(dir, { recursive: true });

      const watcher = fsSync.watch(
        dir,
        { persistent: false },
        async (eventType, changedFile) => {
          if (changedFile === filename && eventType === "rename") {
            try {
              await this.processTriggerFile(filePath);
            } catch (error) {
              this.logError(`Error processing trigger file ${filePath}`, error);
            }
          }
        },
      );

      this.fileWatchers.set(filePath, watcher);
      this.registerDisposable({
        dispose: () => {
          watcher.close();
          this.fileWatchers.delete(filePath);
        },
      });
    } catch (error) {
      this.logError(
        `Failed to setup trigger file watcher for ${filePath}`,
        error,
      );
    }
  }

  /**
   * Process trigger file
   */
  private async processTriggerFile(filePath: string): Promise<void> {
    try {
      const fileExists = await this.fileExists(filePath);
      if (!fileExists) {
        return;
      }

      const data = await fs.readFile(filePath, "utf8");
      const trigger = JSON.parse(data) as ReviewGateTrigger;

      // Validate trigger
      if (trigger.editor && trigger.editor !== "cursor") {
        return;
      }
      if (trigger.system && trigger.system !== "review-gate-v3") {
        return;
      }

      // Process the trigger
      await this.processTrigger(trigger);

      // Clean up trigger file
      try {
        await fs.unlink(filePath);
      } catch (cleanupError) {
        this.logWarning(
          `Could not clean trigger file: ${filePath}`,
          cleanupError,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logError(`Error processing trigger file ${filePath}`, error);
      }
    }
  }

  /**
   * Handle tool call processing
   */
  private async handleToolCall(toolData: MCPToolData): Promise<void> {
    this.logInfo(`Handling tool call: ${toolData.tool}`);

    // Emit tool call event for other services to handle
    this.emitServiceEvent(ServiceEventType.CUSTOM, {
      event: "tool_call",
      toolData,
      triggerId: toolData.trigger_id,
    });

    // Cache the tool data for potential reuse
    this.cacheResponse(`tool_${toolData.trigger_id}`, toolData, 30000); // Cache for 30 seconds
  }

  /**
   * Send extension acknowledgment
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

      this.logDebug(`Acknowledgment sent for trigger: ${triggerId}`);
    } catch (error) {
      this.logError(
        `Could not send extension acknowledgement for ${triggerId}`,
        error,
      );
    }
  }

  /**
   * Update MCP status and emit events
   */
  private async updateMCPStatus(newStatus: MCPStatus): Promise<void> {
    if (this.mcpStatus !== newStatus) {
      const oldStatus = this.mcpStatus;
      this.mcpStatus = newStatus;

      this.logInfo(`MCP status changed: ${oldStatus} -> ${newStatus}`);

      this.emitServiceEvent(ServiceEventType.CUSTOM, {
        event: "status_changed",
        oldStatus,
        newStatus,
        timestamp: new Date(),
      });
    }
  }

  /**
   * Get or create a connection from the pool
   */
  private async getConnection(triggerId: string): Promise<string> {
    const connectionId = `conn_${triggerId}_${Date.now()}`;

    const connection: ConnectionPoolEntry = {
      id: connectionId,
      lastUsed: Date.now(),
      isActive: true,
      retryCount: 0,
    };

    this.connectionPool.set(connectionId, connection);
    this.logDebug(`Connection created: ${connectionId}`);

    return connectionId;
  }

  /**
   * Return connection to pool
   */
  private returnConnection(connectionId: string): void {
    const connection = this.connectionPool.get(connectionId);
    if (connection) {
      connection.isActive = false;
      connection.lastUsed = Date.now();
      this.logDebug(`Connection returned to pool: ${connectionId}`);
    }
  }

  /**
   * Process operation with retry logic and exponential backoff
   */
  private async processWithRetry<T>(
    operation: () => Promise<T>,
    config: MCPConnectionConfig,
  ): Promise<T> {
    let lastError: Error | null = null;
    let delay = config.retryDelay;

    for (let attempt = 0; attempt <= config.retryAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (attempt === config.retryAttempts) {
          break; // Last attempt failed
        }

        this.logWarning(
          `Operation failed, retrying in ${delay}ms (attempt ${attempt + 1}/${
            config.retryAttempts
          })`,
          error,
        );

        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, delay));

        // Exponential backoff
        delay = Math.min(
          delay * config.backoffMultiplier,
          config.maxRetryDelay,
        );
      }
    }

    throw lastError || new Error("Operation failed after all retry attempts");
  }

  /**
   * Validate trigger data
   */
  private validateTrigger(trigger: ReviewGateTrigger): boolean {
    return !!(
      trigger &&
      trigger.data &&
      trigger.data.tool &&
      trigger.data.trigger_id
    );
  }

  /**
   * Cache response with TTL
   */
  private cacheResponse(key: string, data: any, ttl: number): void {
    this.responseCache.set(key, {
      data,
      timestamp: Date.now(),
      ttl,
    });

    // Clean up expired entries periodically
    this.cleanupExpiredCache();
  }

  /**
   * Get cached response if not expired
   */
  private getCachedResponse(key: string): any | null {
    const entry = this.responseCache.get(key);
    if (!entry) {
      return null;
    }

    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.responseCache.delete(key);
      return null;
    }

    return entry.data;
  }

  /**
   * Clean up expired cache entries
   */
  private cleanupExpiredCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.responseCache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.responseCache.delete(key);
      }
    }
  }

  /**
   * Clear all file watchers
   */
  private clearFileWatchers(): void {
    this.fileWatchers.forEach((watcher) => {
      try {
        watcher.close();
      } catch (error) {
        this.logError("Error closing file watcher", error);
      }
    });
    this.fileWatchers.clear();
  }

  /**
   * Restart monitoring with current configuration
   */
  private async restartMonitoring(): Promise<void> {
    this.stopMCPMonitoring();
    await this.startMCPMonitoring();
  }

  /**
   * Check if monitoring should start automatically
   */
  private shouldStartMonitoring(): boolean {
    return this.getConfigProperty("polling", "enabled");
  }

  /**
   * Get monitoring configuration
   */
  private getMonitoringConfig(): MCPMonitoringConfig {
    const pollingConfig = this.getConfigValue("polling");

    return {
      statusInterval: pollingConfig.interval,
      activeThreshold: 30000, // 30 seconds
      useFileWatchers: true, // Prefer file watchers over polling
      debounceDelay: 500, // 500ms debounce
    };
  }

  /**
   * Get connection configuration
   */
  private getConnectionConfig(): MCPConnectionConfig {
    const mcpConfig = this.getConfigValue("mcp");

    return {
      timeout: mcpConfig.connectionTimeout,
      retryAttempts: mcpConfig.retryAttempts,
      retryDelay: 1000, // 1 second initial delay
      backoffMultiplier: 2, // Double delay each retry
      maxRetryDelay: 10000, // Max 10 seconds delay
    };
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
   * Check if file exists (async)
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
