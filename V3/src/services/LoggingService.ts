/**
 * LoggingService - Centralized, high-performance logging service for Review Gate extension
 *
 * This service provides efficient logging operations with async I/O, buffering, rotation,
 * and structured logging capabilities. It replaces the synchronous logging patterns
 * from the monolithic extension.ts with a modern, scalable approach.
 *
 * Key Features:
 * - Async logging operations with buffering
 * - Log rotation and file management
 * - Performance optimizations (batching, filtering)
 * - Configuration integration
 * - Resource management and cleanup
 * - Structured logging with metadata
 * - Error tracking and aggregation
 * - Performance timing utilities
 */

import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createWriteStream, WriteStream } from "fs";
import { BaseService } from "./BaseService";

/**
 * Log level enumeration with numeric values for filtering
 */
export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

/**
 * Log entry interface for structured logging
 */
export interface LogEntry {
  /** Timestamp in ISO format */
  timestamp: string;
  /** Log level */
  level: LogLevel;
  /** Service or component name */
  source: string;
  /** Log message */
  message: string;
  /** Additional structured data */
  metadata?: Record<string, any>;
  /** Error object if applicable */
  error?: Error;
  /** Unique entry identifier */
  id?: string;
  /** Performance timing data */
  timing?: {
    duration?: number;
    startTime?: number;
    endTime?: number;
  };
}

/**
 * Log destination configuration
 */
export interface LogDestination {
  /** Destination type */
  type: "file" | "console" | "output_channel" | "memory";
  /** Destination-specific configuration */
  config: {
    /** File path for file destinations */
    filePath?: string;
    /** Maximum file size before rotation */
    maxFileSize?: number;
    /** Number of rotated files to keep */
    maxFiles?: number;
    /** Output channel name for VS Code output */
    channelName?: string;
    /** Memory buffer size for memory destinations */
    bufferSize?: number;
  };
  /** Minimum log level for this destination */
  minLevel: LogLevel;
  /** Whether destination is enabled */
  enabled: boolean;
}

/**
 * Log buffer for batching operations
 */
interface LogBuffer {
  /** Buffered log entries */
  entries: LogEntry[];
  /** Buffer creation timestamp */
  createdAt: number;
  /** Buffer size in bytes (approximate) */
  size: number;
}

/**
 * Extended performance metrics for logging operations
 */
interface LoggingPerformanceMetrics {
  /** Total log entries processed */
  totalEntries: number;
  /** Entries by log level */
  entriesByLevel: Record<LogLevel, number>;
  /** Buffer flush count */
  flushCount: number;
  /** Files rotated count */
  rotationCount: number;
  /** Current buffer size */
  currentBufferSize: number;
  /** Average log write time in milliseconds */
  averageLogWriteTime: number;
}

/**
 * Main logging service class
 */
export class LoggingService extends BaseService {
  /** Service name constant */
  private static readonly SERVICE_NAME = "LoggingService";

  /** Default log destinations */
  private destinations: Map<string, LogDestination> = new Map();

  /** Active write streams for file destinations */
  private writeStreams: Map<string, WriteStream> = new Map();

  /** VS Code output channels */
  private outputChannels: Map<string, vscode.OutputChannel> = new Map();

  /** Log buffer for batching */
  private logBuffer: LogBuffer = {
    entries: [],
    createdAt: Date.now(),
    size: 0,
  };

  /** Buffer flush timer */
  private flushTimer: NodeJS.Timeout | null = null;

  /** Extended logging performance metrics */
  private loggingMetrics: LoggingPerformanceMetrics = {
    totalEntries: 0,
    entriesByLevel: {
      [LogLevel.ERROR]: 0,
      [LogLevel.WARN]: 0,
      [LogLevel.INFO]: 0,
      [LogLevel.DEBUG]: 0,
    },
    averageLogWriteTime: 0,
    flushCount: 0,
    rotationCount: 0,
    currentBufferSize: 0,
  };

  /** Write time measurements for averaging */
  private writeTimes: number[] = [];

  /** Current log level filter */
  private currentLogLevel: LogLevel = LogLevel.INFO;

  /** Buffer configuration */
  private bufferConfig = {
    maxSize: 1024 * 1024, // 1MB
    maxEntries: 1000,
    flushInterval: 5000, // 5 seconds
    maxAge: 30000, // 30 seconds
  };

  constructor() {
    super(LoggingService.SERVICE_NAME);
  }

  /**
   * Initialize the logging service
   */
  protected async onInitialize(
    context: vscode.ExtensionContext,
  ): Promise<void> {
    this.logInfo("Initializing LoggingService");

    // Load configuration
    await this.loadConfiguration();

    // Setup default destinations
    await this.setupDefaultDestinations();

    // Setup configuration change listeners
    this.setupLoggingConfigurationListeners();

    // Start buffer flush timer
    this.startBufferFlushTimer();

    // Setup cleanup on context disposal
    this.registerDisposable(
      new vscode.Disposable(() => {
        this.flushAllBuffers();
      }),
    );

    this.logInfo("LoggingService initialized successfully");
  }

  /**
   * Dispose of logging service resources
   */
  protected onDispose(): void {
    this.logInfo("Disposing LoggingService");

    // Stop flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Flush all pending logs
    this.flushAllBuffers();

    // Close all write streams
    this.writeStreams.forEach((stream) => {
      stream.end();
    });
    this.writeStreams.clear();

    // Dispose output channels
    this.outputChannels.forEach((channel) => {
      channel.dispose();
    });
    this.outputChannels.clear();

    this.logInfo("LoggingService disposed");
  }

  /**
   * Log an error message
   */
  public async logError(
    message: string,
    error?: Error,
    metadata?: Record<string, any>,
  ): Promise<void> {
    await this.log(LogLevel.ERROR, message, metadata, error);
  }

  /**
   * Log a warning message
   */
  public async logWarning(
    message: string,
    metadata?: Record<string, any>,
  ): Promise<void> {
    await this.log(LogLevel.WARN, message, metadata);
  }

  /**
   * Log an info message
   */
  public async logInfo(
    message: string,
    metadata?: Record<string, any>,
  ): Promise<void> {
    await this.log(LogLevel.INFO, message, metadata);
  }

  /**
   * Log a debug message
   */
  public async logDebug(
    message: string,
    metadata?: Record<string, any>,
  ): Promise<void> {
    await this.log(LogLevel.DEBUG, message, metadata);
  }

  /**
   * Log user input with structured metadata
   */
  public async logUserInput(
    inputText: string,
    eventType: string = "MESSAGE",
    triggerId: string | null = null,
    attachments: any[] = [],
  ): Promise<void> {
    const metadata = {
      eventType,
      triggerId,
      attachments: attachments.length,
      inputLength: inputText.length,
    };

    await this.logInfo(`User Input: ${eventType}`, metadata);

    // Write to specific user input log file
    await this.writeToUserInputLog(
      inputText,
      eventType,
      triggerId,
      attachments,
    );
  }

  /**
   * Log performance timing information
   */
  public async logTiming(
    operation: string,
    duration: number,
    metadata?: Record<string, any>,
  ): Promise<void> {
    const timingMetadata = {
      ...metadata,
      operation,
      duration,
      timestamp: Date.now(),
    };

    await this.logDebug(
      `Performance: ${operation} completed in ${duration}ms`,
      timingMetadata,
    );
  }

  /**
   * Create a performance timer
   */
  public createTimer(operation: string): () => Promise<void> {
    const startTime = Date.now();
    return async () => {
      const duration = Date.now() - startTime;
      await this.logTiming(operation, duration);
    };
  }

  /**
   * Get current logging metrics
   */
  public getLoggingMetrics(): Readonly<LoggingPerformanceMetrics> {
    return { ...this.loggingMetrics };
  }

  /**
   * Flush all pending log entries immediately
   */
  public async flushAll(): Promise<void> {
    await this.flushBuffer();
  }

  /**
   * Add a custom log destination
   */
  public async addDestination(
    name: string,
    destination: LogDestination,
  ): Promise<void> {
    this.destinations.set(name, destination);

    if (destination.type === "file" && destination.config.filePath) {
      await this.setupFileDestination(name, destination);
    } else if (
      destination.type === "output_channel" &&
      destination.config.channelName
    ) {
      this.setupOutputChannelDestination(name, destination);
    }

    this.logDebug(`Added log destination: ${name}`, { destination });
  }

  /**
   * Remove a log destination
   */
  public async removeDestination(name: string): Promise<void> {
    const destination = this.destinations.get(name);
    if (!destination) {
      return;
    }

    // Clean up resources
    const stream = this.writeStreams.get(name);
    if (stream) {
      stream.end();
      this.writeStreams.delete(name);
    }

    const channel = this.outputChannels.get(name);
    if (channel) {
      channel.dispose();
      this.outputChannels.delete(name);
    }

    this.destinations.delete(name);
    this.logDebug(`Removed log destination: ${name}`);
  }

  /**
   * Update log level filter
   */
  public setLogLevel(level: LogLevel): void {
    this.currentLogLevel = level;
    this.logDebug(`Log level changed to: ${LogLevel[level]}`);
  }

  /**
   * Core logging method
   */
  private async log(
    level: LogLevel,
    message: string,
    metadata?: Record<string, any>,
    error?: Error,
  ): Promise<void> {
    // Filter by log level
    if (level > this.currentLogLevel) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      source: this.serviceName,
      message,
      metadata,
      error,
      id: this.generateLogId(),
    };

    // Update metrics
    this.loggingMetrics.totalEntries++;
    this.loggingMetrics.entriesByLevel[level]++;

    // Add to buffer
    await this.addToBuffer(entry);
  }

  /**
   * Add log entry to buffer
   */
  private async addToBuffer(entry: LogEntry): Promise<void> {
    const entrySize = this.estimateEntrySize(entry);

    this.logBuffer.entries.push(entry);
    this.logBuffer.size += entrySize;
    this.loggingMetrics.currentBufferSize = this.logBuffer.size;

    // Check if buffer should be flushed
    if (this.shouldFlushBuffer()) {
      await this.flushBuffer();
    }
  }

  /**
   * Check if buffer should be flushed
   */
  private shouldFlushBuffer(): boolean {
    const now = Date.now();
    const bufferAge = now - this.logBuffer.createdAt;

    return (
      this.logBuffer.entries.length >= this.bufferConfig.maxEntries ||
      this.logBuffer.size >= this.bufferConfig.maxSize ||
      bufferAge >= this.bufferConfig.maxAge
    );
  }

  /**
   * Flush the log buffer to all destinations
   */
  private async flushBuffer(): Promise<void> {
    if (this.logBuffer.entries.length === 0) {
      return;
    }

    const startTime = Date.now();
    const entries = [...this.logBuffer.entries];

    // Clear buffer
    this.logBuffer.entries = [];
    this.logBuffer.size = 0;
    this.logBuffer.createdAt = Date.now();
    this.loggingMetrics.currentBufferSize = 0;

    try {
      // Write to all destinations
      await Promise.all(
        Array.from(this.destinations.entries()).map(([name, destination]) =>
          this.writeToDestination(name, destination, entries),
        ),
      );

      // Update metrics
      const writeTime = Date.now() - startTime;
      this.writeTimes.push(writeTime);
      if (this.writeTimes.length > 100) {
        this.writeTimes.shift();
      }
      this.loggingMetrics.averageLogWriteTime =
        this.writeTimes.reduce((sum, time) => sum + time, 0) /
        this.writeTimes.length;
      this.loggingMetrics.flushCount++;
    } catch (error) {
      console.error("Error flushing log buffer:", error);
    }
  }

  /**
   * Write entries to a specific destination
   */
  private async writeToDestination(
    name: string,
    destination: LogDestination,
    entries: LogEntry[],
  ): Promise<void> {
    if (!destination.enabled) {
      return;
    }

    // Filter entries by destination's minimum level
    const filteredEntries = entries.filter(
      (entry) => entry.level <= destination.minLevel,
    );
    if (filteredEntries.length === 0) {
      return;
    }

    switch (destination.type) {
      case "file":
        await this.writeToFile(name, destination, filteredEntries);
        break;
      case "console":
        this.writeToConsole(filteredEntries);
        break;
      case "output_channel":
        this.writeToOutputChannel(name, filteredEntries);
        break;
      case "memory":
        // Memory destinations are handled separately
        break;
    }
  }

  /**
   * Write entries to file destination
   */
  private async writeToFile(
    name: string,
    destination: LogDestination,
    entries: LogEntry[],
  ): Promise<void> {
    const filePath = destination.config.filePath!;
    let stream = this.writeStreams.get(name);

    if (!stream) {
      await this.setupFileDestination(name, destination);
      stream = this.writeStreams.get(name);
    }

    if (!stream) {
      throw new Error(`Failed to setup file stream for ${name}`);
    }

    // Check if file rotation is needed
    await this.checkFileRotation(name, destination);

    // Write entries
    for (const entry of entries) {
      const logLine = this.formatLogEntry(entry) + "\n";
      stream.write(logLine);
    }
  }

  /**
   * Write entries to console
   */
  private writeToConsole(entries: LogEntry[]): void {
    entries.forEach((entry) => {
      const formatted = this.formatLogEntry(entry);
      switch (entry.level) {
        case LogLevel.ERROR:
          console.error(formatted);
          break;
        case LogLevel.WARN:
          console.warn(formatted);
          break;
        case LogLevel.INFO:
          console.log(formatted);
          break;
        case LogLevel.DEBUG:
          console.debug(formatted);
          break;
      }
    });
  }

  /**
   * Write entries to VS Code output channel
   */
  private writeToOutputChannel(name: string, entries: LogEntry[]): void {
    const channel = this.outputChannels.get(name);
    if (!channel) {
      return;
    }

    entries.forEach((entry) => {
      const formatted = this.formatLogEntry(entry);
      channel.appendLine(formatted);
    });
  }

  /**
   * Setup file destination with stream
   */
  private async setupFileDestination(
    name: string,
    destination: LogDestination,
  ): Promise<void> {
    const filePath = destination.config.filePath!;

    // Ensure directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Create write stream
    const stream = createWriteStream(filePath, { flags: "a" });
    this.writeStreams.set(name, stream);

    // Handle stream errors
    stream.on("error", (error) => {
      this.metrics.errorCount++;
      console.error(`Log file stream error for ${name}:`, error);
    });
  }

  /**
   * Setup output channel destination
   */
  private setupOutputChannelDestination(
    name: string,
    destination: LogDestination,
  ): void {
    const channelName = destination.config.channelName!;
    const channel = vscode.window.createOutputChannel(channelName);
    this.outputChannels.set(name, channel);

    // Register for disposal
    this.registerDisposable(channel);
  }

  /**
   * Check and perform file rotation if needed
   */
  private async checkFileRotation(
    name: string,
    destination: LogDestination,
  ): Promise<void> {
    const filePath = destination.config.filePath!;
    const maxFileSize = destination.config.maxFileSize || 10 * 1024 * 1024; // 10MB default

    try {
      const stats = await fs.stat(filePath);
      if (stats.size >= maxFileSize) {
        await this.rotateLogFile(name, destination);
      }
    } catch (error) {
      // File doesn't exist yet, no rotation needed
    }
  }

  /**
   * Rotate log file
   */
  private async rotateLogFile(
    name: string,
    destination: LogDestination,
  ): Promise<void> {
    const filePath = destination.config.filePath!;
    const maxFiles = destination.config.maxFiles || 5;

    // Close current stream
    const stream = this.writeStreams.get(name);
    if (stream) {
      stream.end();
      this.writeStreams.delete(name);
    }

    try {
      // Rotate existing files
      for (let i = maxFiles - 1; i > 0; i--) {
        const oldFile = `${filePath}.${i}`;
        const newFile = `${filePath}.${i + 1}`;

        try {
          await fs.access(oldFile);
          if (i === maxFiles - 1) {
            await fs.unlink(oldFile); // Delete oldest file
          } else {
            await fs.rename(oldFile, newFile);
          }
        } catch {
          // File doesn't exist, continue
        }
      }

      // Move current file to .1
      await fs.rename(filePath, `${filePath}.1`);

      // Create new stream
      await this.setupFileDestination(name, destination);
      this.loggingMetrics.rotationCount++;
    } catch (error) {
      this.metrics.errorCount++;
      console.error(`Error rotating log file ${filePath}:`, error);
    }
  }

  /**
   * Write to user input log file (legacy compatibility)
   */
  private async writeToUserInputLog(
    inputText: string,
    eventType: string,
    triggerId: string | null,
    attachments: any[],
  ): Promise<void> {
    try {
      const timestamp = new Date().toISOString();
      const logMsg = `[${timestamp}] ${eventType}: ${inputText}`;

      const logFile = this.getTempPath("review_gate_user_inputs.log");
      await fs.appendFile(logFile, `${logMsg}\n`);

      // Handle MCP response files for compatibility
      if (triggerId && eventType === "MCP_RESPONSE") {
        await this.writeMcpResponseFiles(
          inputText,
          triggerId,
          attachments,
          timestamp,
        );
      }
    } catch (error) {
      this.metrics.errorCount++;
      console.error("Error writing user input log:", error);
    }
  }

  /**
   * Write MCP response files for compatibility
   */
  private async writeMcpResponseFiles(
    inputText: string,
    triggerId: string,
    attachments: any[],
    timestamp: string,
  ): Promise<void> {
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
      event_type: "MCP_RESPONSE",
      source: "review_gate_extension",
    };

    const responseJson = JSON.stringify(responseData, null, 2);

    for (const responseFile of responsePatterns) {
      try {
        await fs.writeFile(responseFile, responseJson);
      } catch (error) {
        this.metrics.errorCount++;
        console.error(`Failed to write response file ${responseFile}:`, error);
      }
    }
  }

  /**
   * Get temporary file path (cross-platform)
   */
  private getTempPath(filename: string): string {
    if (process.platform === "win32") {
      return path.join(os.tmpdir(), filename);
    } else {
      return path.join("/tmp", filename);
    }
  }

  /**
   * Format log entry for output
   */
  private formatLogEntry(entry: LogEntry): string {
    const levelStr = LogLevel[entry.level].padEnd(5);
    let formatted = `[${entry.timestamp}] ${levelStr} [${entry.source}] ${entry.message}`;

    if (entry.metadata) {
      formatted += ` | ${JSON.stringify(entry.metadata)}`;
    }

    if (entry.error) {
      formatted += ` | Error: ${entry.error.message}`;
      if (entry.error.stack) {
        formatted += `\nStack: ${entry.error.stack}`;
      }
    }

    return formatted;
  }

  /**
   * Estimate log entry size in bytes
   */
  private estimateEntrySize(entry: LogEntry): number {
    return JSON.stringify(entry).length * 2; // Rough estimate
  }

  /**
   * Generate unique log entry ID
   */
  private generateLogId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Load configuration from extension config
   */
  private async loadConfiguration(): Promise<void> {
    const loggingConfig = this.getConfigValue("logging");

    // Update log level
    this.currentLogLevel = this.mapConfigLogLevel(loggingConfig.level);

    // Update buffer configuration based on performance settings
    const pollingConfig = this.getConfigValue("polling");
    this.bufferConfig.flushInterval = Math.max(
      pollingConfig.interval * 2,
      1000,
    );
  }

  /**
   * Map configuration log level to LogLevel enum
   */
  private mapConfigLogLevel(configLevel: string): LogLevel {
    switch (configLevel.toLowerCase()) {
      case "error":
        return LogLevel.ERROR;
      case "warn":
        return LogLevel.WARN;
      case "info":
        return LogLevel.INFO;
      case "debug":
        return LogLevel.DEBUG;
      default:
        return LogLevel.INFO;
    }
  }

  /**
   * Setup default log destinations
   */
  private async setupDefaultDestinations(): Promise<void> {
    const loggingConfig = this.getConfigValue("logging");

    // Console destination
    await this.addDestination("console", {
      type: "console",
      config: {},
      minLevel: this.currentLogLevel,
      enabled: true,
    });

    // VS Code output channel
    await this.addDestination("output_channel", {
      type: "output_channel",
      config: {
        channelName: "Review Gate V3 ゲート",
      },
      minLevel: LogLevel.INFO,
      enabled: true,
    });

    // File logging if enabled
    if (loggingConfig.enableFileLogging) {
      const logDir = this.getTempPath("review_gate_logs");
      await fs.mkdir(logDir, { recursive: true });

      await this.addDestination("main_log", {
        type: "file",
        config: {
          filePath: path.join(logDir, "review_gate.log"),
          maxFileSize: 10 * 1024 * 1024, // 10MB
          maxFiles: 5,
        },
        minLevel: this.currentLogLevel,
        enabled: true,
      });

      // Separate error log
      await this.addDestination("error_log", {
        type: "file",
        config: {
          filePath: path.join(logDir, "review_gate_errors.log"),
          maxFileSize: 5 * 1024 * 1024, // 5MB
          maxFiles: 3,
        },
        minLevel: LogLevel.ERROR,
        enabled: true,
      });
    }
  }

  /**
   * Setup configuration change listeners
   */
  private setupLoggingConfigurationListeners(): void {
    this.onConfigurationChange("logging", async (newConfig) => {
      this.currentLogLevel = this.mapConfigLogLevel(newConfig.level);

      // Update destination levels
      this.destinations.forEach((destination, name) => {
        if (name === "console" || name === "main_log") {
          destination.minLevel = this.currentLogLevel;
        }
      });

      // Enable/disable file logging
      if (newConfig.enableFileLogging && !this.destinations.has("main_log")) {
        await this.setupDefaultDestinations();
      } else if (
        !newConfig.enableFileLogging &&
        this.destinations.has("main_log")
      ) {
        await this.removeDestination("main_log");
        await this.removeDestination("error_log");
      }

      this.logDebug("Logging configuration updated", { newConfig });
    });
  }

  /**
   * Start buffer flush timer
   */
  private startBufferFlushTimer(): void {
    this.flushTimer = setInterval(async () => {
      try {
        await this.flushBuffer();
      } catch (error) {
        this.metrics.errorCount++;
        console.error("Error in scheduled buffer flush:", error);
      }
    }, this.bufferConfig.flushInterval);
  }

  /**
   * Flush all buffers synchronously (for disposal)
   */
  private flushAllBuffers(): void {
    if (this.logBuffer.entries.length > 0) {
      // Synchronous flush for disposal
      const entries = [...this.logBuffer.entries];
      this.logBuffer.entries = [];
      this.logBuffer.size = 0;

      // Write to console as fallback
      entries.forEach((entry) => {
        const formatted = this.formatLogEntry(entry);
        console.log(formatted);
      });
    }
  }
}
