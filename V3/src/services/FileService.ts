/**
 * File Service for the Review Gate VS Code extension
 *
 * This service handles all file operations efficiently with async patterns,
 * file watching optimization, attachment handling, temporary file management,
 * and performance features like caching and batch operations.
 */

import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import * as chokidar from "chokidar";
import { BaseService } from "./BaseService";
import { Attachment } from "../types";

/**
 * File operation types for queuing system
 */
export enum FileOperationType {
  READ = "read",
  WRITE = "write",
  DELETE = "delete",
  COPY = "copy",
  MOVE = "move",
  STAT = "stat",
  MKDIR = "mkdir",
}

/**
 * File operation queue item
 */
export interface FileOperation {
  /** Unique operation identifier */
  id: string;
  /** Operation type */
  type: FileOperationType;
  /** Target file path */
  filePath: string;
  /** Operation parameters */
  params?: any;
  /** Operation priority (higher = more urgent) */
  priority: number;
  /** Creation timestamp */
  createdAt: Date;
  /** Promise resolve function */
  resolve: (value: any) => void;
  /** Promise reject function */
  reject: (error: Error) => void;
  /** Retry count */
  retryCount: number;
}

/**
 * File metadata cache entry
 */
export interface FileMetadata {
  /** File path */
  path: string;
  /** File size in bytes */
  size: number;
  /** Last modified timestamp */
  mtime: Date;
  /** File hash for integrity checking */
  hash?: string;
  /** MIME type */
  mimeType?: string;
  /** Cache timestamp */
  cachedAt: Date;
}

/**
 * File watcher configuration
 */
export interface FileWatcherConfig {
  /** File patterns to watch */
  patterns: string[];
  /** Patterns to ignore */
  ignored?: string[];
  /** Debounce delay in milliseconds */
  debounceMs: number;
  /** Whether to watch subdirectories */
  recursive: boolean;
  /** Maximum number of files to watch */
  maxFiles?: number;
}

/**
 * Temporary file entry
 */
export interface TempFileEntry {
  /** Unique identifier */
  id: string;
  /** File path */
  path: string;
  /** Creation timestamp */
  createdAt: Date;
  /** Expiration timestamp */
  expiresAt?: Date;
  /** Associated trigger ID */
  triggerId?: string;
  /** File size in bytes */
  size: number;
  /** Whether file is locked */
  locked: boolean;
}

/**
 * File validation result
 */
export interface FileValidationResult {
  /** Whether file is valid */
  valid: boolean;
  /** Error message if invalid */
  error?: string;
  /** File metadata */
  metadata?: FileMetadata;
}

/**
 * File attachment options
 */
export interface AttachmentOptions {
  /** Maximum file size in bytes */
  maxSize?: number;
  /** Allowed MIME types */
  allowedTypes?: string[];
  /** Whether to generate thumbnails for images */
  generateThumbnails?: boolean;
  /** Compression quality for images (0-100) */
  compressionQuality?: number;
}

/**
 * File Service class providing comprehensive file operations
 */
export class FileService extends BaseService {
  /** File operation queue */
  private operationQueue: FileOperation[] = [];

  /** Queue processing flag */
  private processingQueue = false;

  /** File metadata cache */
  private metadataCache = new Map<string, FileMetadata>();

  /** File content cache */
  private contentCache = new Map<string, { content: Buffer; cachedAt: Date }>();

  /** File watchers */
  private watchers = new Map<string, chokidar.FSWatcher>();

  /** Temporary files registry */
  private tempFiles = new Map<string, TempFileEntry>();

  /** File locks for concurrent access control */
  private fileLocks = new Map<string, Promise<void>>();

  /** Debounced file change handlers */
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  /** Maximum queue size */
  private readonly MAX_QUEUE_SIZE = 1000;

  /** Maximum cache size */
  private readonly MAX_CACHE_SIZE = 100;

  /** Cache TTL in milliseconds */
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  /** Maximum retry attempts */
  private readonly MAX_RETRIES = 3;

  constructor() {
    super("FileService");
  }

  /**
   * Initialize the file service
   */
  protected async onInitialize(
    context: vscode.ExtensionContext,
  ): Promise<void> {
    this.logInfo("Initializing FileService");

    // Start queue processor
    this.startQueueProcessor();

    // Set up cleanup on extension deactivation
    this.registerDisposable(
      new vscode.Disposable(() => {
        this.cleanup();
      }),
    );

    // Set up periodic cache cleanup
    const cacheCleanupInterval = setInterval(() => {
      this.cleanupCache();
    }, 60000); // Every minute

    this.registerDisposable(
      new vscode.Disposable(() => {
        clearInterval(cacheCleanupInterval);
      }),
    );

    // Set up periodic temp file cleanup
    const tempCleanupInterval = setInterval(() => {
      this.cleanupExpiredTempFiles();
    }, 30000); // Every 30 seconds

    this.registerDisposable(
      new vscode.Disposable(() => {
        clearInterval(tempCleanupInterval);
      }),
    );

    this.logInfo("FileService initialized successfully");
  }

  /**
   * Dispose of service resources
   */
  protected onDispose(): void {
    this.cleanup();
  }

  /**
   * Get temporary file path with OS-appropriate directory
   */
  public getTempPath(filename: string): string {
    const tempDir = process.platform === "win32" ? os.tmpdir() : "/tmp";
    return path.join(tempDir, filename);
  }

  /**
   * Read file content asynchronously with caching
   */
  public async readFile(filePath: string, useCache = true): Promise<Buffer> {
    return this.withTiming("readFile", async () => {
      // Check cache first
      if (useCache) {
        const cached = this.contentCache.get(filePath);
        if (cached && Date.now() - cached.cachedAt.getTime() < this.CACHE_TTL) {
          this.logDebug(`Cache hit for file: ${filePath}`);
          return cached.content;
        }
      }

      // Queue the operation
      const content = await this.queueOperation({
        type: FileOperationType.READ,
        filePath,
        priority: 5,
      });

      // Cache the result
      if (useCache && content.length < 1024 * 1024) {
        // Cache files < 1MB
        this.contentCache.set(filePath, {
          content,
          cachedAt: new Date(),
        });
        this.limitCacheSize();
      }

      return content;
    }).then((result) => result.result);
  }

  /**
   * Write file content asynchronously with atomic operations
   */
  public async writeFile(
    filePath: string,
    content: Buffer | string,
    options?: { atomic?: boolean },
  ): Promise<void> {
    return this.withTiming("writeFile", async () => {
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);

      await this.queueOperation({
        type: FileOperationType.WRITE,
        filePath,
        params: { content: buffer, atomic: options?.atomic ?? true },
        priority: 7,
      });

      // Invalidate cache
      this.contentCache.delete(filePath);
      this.metadataCache.delete(filePath);
    }).then((result) => result.result);
  }

  /**
   * Delete file asynchronously
   */
  public async deleteFile(filePath: string): Promise<void> {
    return this.withTiming("deleteFile", async () => {
      await this.queueOperation({
        type: FileOperationType.DELETE,
        filePath,
        priority: 6,
      });

      // Clean up caches
      this.contentCache.delete(filePath);
      this.metadataCache.delete(filePath);
    }).then((result) => result.result);
  }

  /**
   * Get file metadata with caching
   */
  public async getFileMetadata(
    filePath: string,
    useCache = true,
  ): Promise<FileMetadata> {
    return this.withTiming("getFileMetadata", async () => {
      // Check cache first
      if (useCache) {
        const cached = this.metadataCache.get(filePath);
        if (cached && Date.now() - cached.cachedAt.getTime() < this.CACHE_TTL) {
          return cached;
        }
      }

      const stats = await this.queueOperation({
        type: FileOperationType.STAT,
        filePath,
        priority: 3,
      });

      const metadata: FileMetadata = {
        path: filePath,
        size: stats.size,
        mtime: stats.mtime,
        mimeType: this.getMimeType(filePath),
        cachedAt: new Date(),
      };

      // Cache the metadata
      if (useCache) {
        this.metadataCache.set(filePath, metadata);
      }

      return metadata;
    }).then((result) => result.result);
  }

  /**
   * Check if file exists
   */
  public async fileExists(filePath: string): Promise<boolean> {
    try {
      await this.getFileMetadata(filePath, false);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create directory recursively
   */
  public async createDirectory(dirPath: string): Promise<void> {
    return this.withTiming("createDirectory", async () => {
      await this.queueOperation({
        type: FileOperationType.MKDIR,
        filePath: dirPath,
        priority: 4,
      });
    }).then((result) => result.result);
  }

  /**
   * Watch files for changes with debouncing
   */
  public watchFiles(
    config: FileWatcherConfig,
    onChange: (
      filePath: string,
      changeType: "add" | "change" | "unlink",
    ) => void,
  ): vscode.Disposable {
    const watcherId = crypto.randomUUID();

    const watcher = chokidar.watch(config.patterns, {
      ignored: config.ignored,
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      depth: config.recursive ? undefined : 1,
    });

    const debouncedHandler = (
      filePath: string,
      changeType: "add" | "change" | "unlink",
    ) => {
      const key = `${filePath}_${changeType}`;

      // Clear existing timer
      const existingTimer = this.debounceTimers.get(key);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Set new timer
      const timer = setTimeout(() => {
        this.debounceTimers.delete(key);
        onChange(filePath, changeType);
        this.logDebug(`File ${changeType}: ${filePath}`);
      }, config.debounceMs);

      this.debounceTimers.set(key, timer);
    };

    watcher.on("add", (filePath) => debouncedHandler(filePath, "add"));
    watcher.on("change", (filePath) => debouncedHandler(filePath, "change"));
    watcher.on("unlink", (filePath) => debouncedHandler(filePath, "unlink"));

    watcher.on("error", (error) => {
      this.logError(`File watcher error for ${watcherId}`, error);
    });

    this.watchers.set(watcherId, watcher);

    return new vscode.Disposable(() => {
      const watcher = this.watchers.get(watcherId);
      if (watcher) {
        watcher.close();
        this.watchers.delete(watcherId);
      }
    });
  }

  /**
   * Handle file attachment with validation and processing
   */
  public async handleFileAttachment(
    filePath: string,
    options: AttachmentOptions = {},
  ): Promise<Attachment> {
    return this.withTiming("handleFileAttachment", async () => {
      // Validate file
      const validation = await this.validateFile(filePath, options);
      if (!validation.valid) {
        throw new Error(`File validation failed: ${validation.error}`);
      }

      const metadata = validation.metadata!;
      const content = await this.readFile(filePath);

      // Generate base64 data
      const base64Data = content.toString("base64");
      const dataUrl = `data:${metadata.mimeType};base64,${base64Data}`;

      // Generate hash for integrity
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      const attachment: Attachment = {
        id: crypto.randomUUID(),
        filename: path.basename(filePath),
        path: filePath,
        mimeType: metadata.mimeType || "application/octet-stream",
        size: metadata.size,
        createdAt: new Date(),
        hash,
        metadata: {
          base64Data,
          dataUrl,
        },
      };

      this.logInfo(
        `File attachment created: ${attachment.filename} (${attachment.size} bytes)`,
      );
      return attachment;
    }).then((result) => result.result);
  }

  /**
   * Create temporary file with lifecycle management
   */
  public async createTempFile(
    content: Buffer | string,
    options: {
      filename?: string;
      extension?: string;
      triggerId?: string;
      expiresIn?: number; // milliseconds
    } = {},
  ): Promise<TempFileEntry> {
    return this.withTiming("createTempFile", async () => {
      const id = crypto.randomUUID();
      const filename =
        options.filename || `temp_${id}${options.extension || ".tmp"}`;
      const filePath = this.getTempPath(filename);

      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
      await this.writeFile(filePath, buffer);

      const expiresAt = options.expiresIn
        ? new Date(Date.now() + options.expiresIn)
        : undefined;

      const tempFile: TempFileEntry = {
        id,
        path: filePath,
        createdAt: new Date(),
        expiresAt,
        triggerId: options.triggerId,
        size: buffer.length,
        locked: false,
      };

      this.tempFiles.set(id, tempFile);
      this.logDebug(`Temporary file created: ${filePath}`);

      return tempFile;
    }).then((result) => result.result);
  }

  /**
   * Get temporary file by ID
   */
  public getTempFile(id: string): TempFileEntry | undefined {
    return this.tempFiles.get(id);
  }

  /**
   * Delete temporary file
   */
  public async deleteTempFile(id: string): Promise<void> {
    const tempFile = this.tempFiles.get(id);
    if (!tempFile) {
      return;
    }

    if (tempFile.locked) {
      throw new Error(`Temporary file ${id} is locked and cannot be deleted`);
    }

    try {
      await this.deleteFile(tempFile.path);
    } catch (error) {
      this.logWarning(
        `Failed to delete temporary file: ${tempFile.path}`,
        error,
      );
    }

    this.tempFiles.delete(id);
    this.logDebug(`Temporary file deleted: ${tempFile.path}`);
  }

  /**
   * Lock temporary file to prevent deletion
   */
  public lockTempFile(id: string): void {
    const tempFile = this.tempFiles.get(id);
    if (tempFile) {
      tempFile.locked = true;
    }
  }

  /**
   * Unlock temporary file
   */
  public unlockTempFile(id: string): void {
    const tempFile = this.tempFiles.get(id);
    if (tempFile) {
      tempFile.locked = false;
    }
  }

  /**
   * Batch file operations for efficiency
   */
  public async batchOperations<T>(
    operations: Array<() => Promise<T>>,
  ): Promise<T[]> {
    return this.withTiming("batchOperations", async () => {
      const results = await Promise.allSettled(operations.map((op) => op()));

      const successResults: T[] = [];
      const errors: Error[] = [];

      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          successResults.push(result.value);
        } else {
          errors.push(
            new Error(`Batch operation ${index} failed: ${result.reason}`),
          );
        }
      });

      if (errors.length > 0) {
        this.logWarning(`${errors.length} batch operations failed`, errors);
      }

      return successResults;
    }).then((result) => result.result);
  }

  /**
   * Get MIME type from file extension
   */
  private getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".txt": "text/plain",
      ".json": "application/json",
      ".js": "application/javascript",
      ".ts": "application/typescript",
      ".html": "text/html",
      ".css": "text/css",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".bmp": "image/bmp",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
      ".zip": "application/zip",
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".ogg": "audio/ogg",
    };
    return mimeTypes[ext] || "application/octet-stream";
  }

  /**
   * Validate file against options
   */
  private async validateFile(
    filePath: string,
    options: AttachmentOptions,
  ): Promise<FileValidationResult> {
    try {
      const metadata = await this.getFileMetadata(filePath, false);

      // Check file size
      if (options.maxSize && metadata.size > options.maxSize) {
        return {
          valid: false,
          error: `File size ${metadata.size} exceeds maximum ${options.maxSize} bytes`,
        };
      }

      // Check MIME type
      if (options.allowedTypes && metadata.mimeType) {
        const isAllowed = options.allowedTypes.some((type) => {
          if (type.endsWith("/*")) {
            return metadata.mimeType!.startsWith(type.slice(0, -1));
          }
          return metadata.mimeType === type;
        });

        if (!isAllowed) {
          return {
            valid: false,
            error: `File type ${metadata.mimeType} is not allowed`,
          };
        }
      }

      return { valid: true, metadata };
    } catch (error) {
      return {
        valid: false,
        error: `Failed to validate file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Queue file operation for processing
   */
  private async queueOperation(params: {
    type: FileOperationType;
    filePath: string;
    params?: any;
    priority: number;
  }): Promise<any> {
    if (this.operationQueue.length >= this.MAX_QUEUE_SIZE) {
      throw new Error("File operation queue is full");
    }

    return new Promise((resolve, reject) => {
      const operation: FileOperation = {
        id: crypto.randomUUID(),
        type: params.type,
        filePath: params.filePath,
        params: params.params,
        priority: params.priority,
        createdAt: new Date(),
        resolve,
        reject,
        retryCount: 0,
      };

      // Insert operation in priority order
      const insertIndex = this.operationQueue.findIndex(
        (op) => op.priority < operation.priority,
      );

      if (insertIndex === -1) {
        this.operationQueue.push(operation);
      } else {
        this.operationQueue.splice(insertIndex, 0, operation);
      }

      this.logDebug(`Queued ${params.type} operation for ${params.filePath}`);
    });
  }

  /**
   * Start the queue processor
   */
  private startQueueProcessor(): void {
    const processQueue = async () => {
      if (this.processingQueue || this.operationQueue.length === 0) {
        return;
      }

      this.processingQueue = true;

      while (this.operationQueue.length > 0) {
        const operation = this.operationQueue.shift()!;

        try {
          const result = await this.executeOperation(operation);
          operation.resolve(result);
        } catch (error) {
          if (operation.retryCount < this.MAX_RETRIES) {
            operation.retryCount++;
            this.operationQueue.unshift(operation); // Retry at front of queue
            this.logWarning(
              `Retrying operation ${operation.id} (attempt ${operation.retryCount})`,
            );
          } else {
            operation.reject(error as Error);
            this.logError(
              `Operation ${operation.id} failed after ${this.MAX_RETRIES} retries`,
              error,
            );
          }
        }
      }

      this.processingQueue = false;
    };

    // Process queue every 10ms
    setInterval(processQueue, 10);
  }

  /**
   * Execute a file operation
   */
  private async executeOperation(operation: FileOperation): Promise<any> {
    const { type, filePath, params } = operation;

    // Acquire file lock if needed
    await this.acquireFileLock(filePath);

    try {
      switch (type) {
        case FileOperationType.READ:
          return await fs.readFile(filePath);

        case FileOperationType.WRITE:
          if (params.atomic) {
            const tempPath = `${filePath}.tmp`;
            await fs.writeFile(tempPath, params.content);
            await fs.rename(tempPath, filePath);
          } else {
            await fs.writeFile(filePath, params.content);
          }
          break;

        case FileOperationType.DELETE:
          await fs.unlink(filePath);
          break;

        case FileOperationType.STAT:
          return await fs.stat(filePath);

        case FileOperationType.MKDIR:
          await fs.mkdir(filePath, { recursive: true });
          break;

        case FileOperationType.COPY:
          await fs.copyFile(filePath, params.destination);
          break;

        case FileOperationType.MOVE:
          await fs.rename(filePath, params.destination);
          break;

        default:
          throw new Error(`Unknown operation type: ${type}`);
      }
    } finally {
      this.releaseFileLock(filePath);
    }
  }

  /**
   * Acquire file lock for concurrent access control
   */
  private async acquireFileLock(filePath: string): Promise<void> {
    const existingLock = this.fileLocks.get(filePath);
    if (existingLock) {
      await existingLock;
    }

    let resolveLock: (() => void) | undefined;
    const lockPromise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });

    this.fileLocks.set(filePath, lockPromise);

    // Store resolve function for later use
    (lockPromise as any)._resolve = resolveLock!;
  }

  /**
   * Release file lock
   */
  private releaseFileLock(filePath: string): void {
    const lock = this.fileLocks.get(filePath);
    if (lock && (lock as any)._resolve) {
      (lock as any)._resolve();
      this.fileLocks.delete(filePath);
    }
  }

  /**
   * Clean up expired cache entries
   */
  private cleanupCache(): void {
    const now = Date.now();

    // Clean content cache
    for (const [key, value] of this.contentCache.entries()) {
      if (now - value.cachedAt.getTime() > this.CACHE_TTL) {
        this.contentCache.delete(key);
      }
    }

    // Clean metadata cache
    for (const [key, value] of this.metadataCache.entries()) {
      if (now - value.cachedAt.getTime() > this.CACHE_TTL) {
        this.metadataCache.delete(key);
      }
    }

    this.logDebug(
      `Cache cleanup completed. Content: ${this.contentCache.size}, Metadata: ${this.metadataCache.size}`,
    );
  }

  /**
   * Limit cache size to prevent memory issues
   */
  private limitCacheSize(): void {
    if (this.contentCache.size > this.MAX_CACHE_SIZE) {
      // Remove oldest entries
      const entries = Array.from(this.contentCache.entries());
      entries.sort((a, b) => a[1].cachedAt.getTime() - b[1].cachedAt.getTime());

      const toRemove = entries.slice(0, entries.length - this.MAX_CACHE_SIZE);
      toRemove.forEach(([key]) => this.contentCache.delete(key));
    }

    if (this.metadataCache.size > this.MAX_CACHE_SIZE) {
      const entries = Array.from(this.metadataCache.entries());
      entries.sort((a, b) => a[1].cachedAt.getTime() - b[1].cachedAt.getTime());

      const toRemove = entries.slice(0, entries.length - this.MAX_CACHE_SIZE);
      toRemove.forEach(([key]) => this.metadataCache.delete(key));
    }
  }

  /**
   * Clean up expired temporary files
   */
  private cleanupExpiredTempFiles(): void {
    const now = Date.now();
    const expiredFiles: string[] = [];

    for (const [id, tempFile] of this.tempFiles.entries()) {
      if (
        tempFile.expiresAt &&
        now > tempFile.expiresAt.getTime() &&
        !tempFile.locked
      ) {
        expiredFiles.push(id);
      }
    }

    expiredFiles.forEach(async (id) => {
      try {
        await this.deleteTempFile(id);
      } catch (error) {
        this.logWarning(`Failed to cleanup expired temp file ${id}`, error);
      }
    });

    if (expiredFiles.length > 0) {
      this.logDebug(
        `Cleaned up ${expiredFiles.length} expired temporary files`,
      );
    }
  }

  /**
   * Cleanup all resources
   */
  private cleanup(): void {
    this.logInfo("Cleaning up FileService resources");

    // Clear all timers
    this.debounceTimers.forEach((timer) => clearTimeout(timer));
    this.debounceTimers.clear();

    // Close all watchers
    this.watchers.forEach((watcher) => watcher.close());
    this.watchers.clear();

    // Clean up temporary files
    const tempFileCleanup = this.getConfigProperty("tempFiles", "cleanup");
    if (tempFileCleanup) {
      this.tempFiles.forEach(async (tempFile, id) => {
        if (!tempFile.locked) {
          try {
            await this.deleteTempFile(id);
          } catch (error) {
            this.logWarning(
              `Failed to cleanup temp file during disposal: ${tempFile.path}`,
              error,
            );
          }
        }
      });
    }

    // Clear caches
    this.contentCache.clear();
    this.metadataCache.clear();
    this.fileLocks.clear();

    this.logInfo("FileService cleanup completed");
  }
}
