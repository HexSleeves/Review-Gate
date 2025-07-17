/**
 * Audio Service for handling speech-to-text recording functionality
 *
 * This service provides comprehensive audio recording capabilities including:
 * - Async audio operations with proper process lifecycle management
 * - SoX integration optimization with caching and pooling
 * - Recording session management with automatic cleanup
 * - Performance optimizations and resource management
 * - Microphone access permission handling
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, ChildProcess } from "child_process";
import { BaseService, ServiceEventType } from "./BaseService";
import {
  RecordingState,
  RecordingProcess as IRecordingProcess,
} from "../types";
import { ExtensionConfig } from "../config/extensionConfig";

/**
 * Enhanced recording process interface with additional metadata
 */
interface AudioRecordingProcess extends IRecordingProcess {
  /** Child process instance */
  process: ChildProcess;
  /** Process start time for timeout management */
  processStartTime: number;
  /** Cleanup timeout reference */
  cleanupTimeout?: NodeJS.Timeout;
  /** Force kill timeout reference */
  forceKillTimeout?: NodeJS.Timeout;
}

/**
 * SoX validation result interface
 */
interface SoxValidationResult {
  /** Whether SoX is available and functional */
  success: boolean;
  /** Error message if validation failed */
  error: string | null;
  /** SoX version information */
  version?: string;
  /** Microphone test result */
  microphoneAvailable?: boolean;
}

/**
 * Audio transcription request interface
 */
interface TranscriptionRequest {
  /** Request timestamp */
  timestamp: string;
  /** System identifier */
  system: string;
  /** Editor identifier */
  editor: string;
  /** Request data */
  data: {
    /** Tool type */
    tool: string;
    /** Audio file path */
    audio_file: string;
    /** Trigger identifier */
    trigger_id: string;
    /** Audio format */
    format: string;
  };
  /** MCP integration flag */
  mcp_integration: boolean;
}

/**
 * Audio session management interface
 */
interface AudioSession {
  /** Session identifier */
  id: string;
  /** Associated trigger ID */
  triggerId: string;
  /** Session start time */
  startTime: Date;
  /** Current recording process */
  recording?: AudioRecordingProcess;
  /** Temporary files created during session */
  tempFiles: string[];
  /** Session state */
  state: "idle" | "recording" | "processing" | "completed" | "error";
}

/**
 * Process pool entry interface
 */
interface ProcessPoolEntry {
  /** Process instance */
  process: ChildProcess;
  /** Whether process is currently in use */
  inUse: boolean;
  /** Creation timestamp */
  created: Date;
  /** Last used timestamp */
  lastUsed: Date;
}

/**
 * Audio Service class providing comprehensive audio recording functionality
 */
export class AudioService extends BaseService {
  /** Active recording sessions */
  private activeSessions: Map<string, AudioSession> = new Map();

  /** SoX validation cache */
  private soxValidationCache: {
    result: SoxValidationResult | null;
    timestamp: number;
    ttl: number;
  } = {
    result: null,
    timestamp: 0,
    ttl: 300000, // 5 minutes
  };

  /** Process pool for SoX operations */
  private processPool: ProcessPoolEntry[] = [];

  /** Maximum pool size */
  private readonly maxPoolSize = 3;

  /** Pool cleanup interval */
  private poolCleanupInterval?: NodeJS.Timeout;

  /** Transcription result cache */
  private transcriptionCache: Map<
    string,
    {
      result: string;
      timestamp: number;
      ttl: number;
    }
  > = new Map();

  /** Audio configuration cache */
  private audioConfigCache: ExtensionConfig["audio"] | null = null;

  /** Temporary file cleanup interval */
  private tempFileCleanupInterval?: NodeJS.Timeout;

  /**
   * Constructor
   */
  constructor() {
    super("AudioService");
  }

  /**
   * Initialize the audio service
   */
  protected async onInitialize(
    context: vscode.ExtensionContext,
  ): Promise<void> {
    this.logInfo("Initializing AudioService...");

    // Cache audio configuration
    this.audioConfigCache = this.getConfigValue("audio");

    // Set up configuration change listeners
    this.onConfigurationChange("audio", (newConfig) => {
      this.audioConfigCache = newConfig;
      this.logInfo("Audio configuration updated");
      this.emitServiceEvent(ServiceEventType.CONFIG_CHANGED, {
        section: "audio",
        config: newConfig,
      });
    });

    // Initialize process pool cleanup
    this.setupProcessPoolCleanup();

    // Initialize temporary file cleanup
    this.setupTempFileCleanup();

    // Validate SoX setup on initialization (async, don't block)
    this.validateSoxSetup().catch((error) => {
      this.logWarning("Initial SoX validation failed", error);
    });

    this.logInfo("AudioService initialized successfully");
  }

  /**
   * Dispose of service resources
   */
  protected onDispose(): void {
    this.logInfo("Disposing AudioService...");

    // Stop all active recordings
    this.activeSessions.forEach((session, sessionId) => {
      this.stopRecording(sessionId).catch((error) => {
        this.logError(
          `Error stopping recording for session ${sessionId}`,
          error,
        );
      });
    });

    // Clear process pool
    this.clearProcessPool();

    // Clear intervals
    if (this.poolCleanupInterval) {
      clearInterval(this.poolCleanupInterval);
    }

    if (this.tempFileCleanupInterval) {
      clearInterval(this.tempFileCleanupInterval);
    }

    // Clear caches
    this.transcriptionCache.clear();
    this.audioConfigCache = null;

    this.logInfo("AudioService disposed successfully");
  }

  /**
   * Start audio recording for a trigger
   */
  public async startRecording(triggerId: string): Promise<{
    success: boolean;
    sessionId?: string;
    error?: string;
  }> {
    return this.withTiming("startRecording", async () => {
      try {
        this.logInfo(`Starting recording for trigger: ${triggerId}`);

        // Check if recording already exists for this trigger
        const existingSession = Array.from(this.activeSessions.values()).find(
          (session) =>
            session.triggerId === triggerId && session.state === "recording",
        );

        if (existingSession) {
          return {
            success: false,
            error: "Recording already in progress for this trigger",
          };
        }

        // Validate SoX setup
        const validation = await this.validateSoxSetup();
        if (!validation.success) {
          return {
            success: false,
            error: validation.error || "SoX validation failed",
          };
        }

        // Create new session
        const sessionId = this.generateSessionId();
        const session: AudioSession = {
          id: sessionId,
          triggerId,
          startTime: new Date(),
          tempFiles: [],
          state: "idle",
        };

        // Generate audio file path
        const audioConfig =
          this.audioConfigCache || this.getConfigValue("audio");
        const timestamp = Date.now();
        const audioFile = this.getTempPath(
          `review_gate_audio_${triggerId}_${timestamp}.${audioConfig.format}`,
        );

        // Create recording process
        const recordingProcess = await this.createRecordingProcess(
          audioFile,
          audioConfig,
        );

        session.recording = recordingProcess;
        session.tempFiles.push(audioFile);
        session.state = "recording";

        this.activeSessions.set(sessionId, session);

        this.logInfo(
          `Recording started successfully: session=${sessionId}, file=${audioFile}`,
        );

        // Emit recording started event
        this.emitServiceEvent(ServiceEventType.CUSTOM, {
          action: "recording_started",
          sessionId,
          triggerId,
          audioFile,
        });

        return {
          success: true,
          sessionId,
        };
      } catch (error) {
        this.logError("Failed to start recording", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }).then((result) => result.result);
  }

  /**
   * Stop audio recording for a session
   */
  public async stopRecording(sessionId: string): Promise<{
    success: boolean;
    audioFile?: string;
    transcription?: string;
    error?: string;
  }> {
    return this.withTiming("stopRecording", async () => {
      try {
        const session = this.activeSessions.get(sessionId);
        if (!session) {
          return {
            success: false,
            error: "Recording session not found",
          };
        }

        if (!session.recording || session.state !== "recording") {
          return {
            success: false,
            error: "No active recording for this session",
          };
        }

        this.logInfo(`Stopping recording for session: ${sessionId}`);

        const { recording } = session;
        const audioFile = recording.outputPath;

        // Update session state
        session.state = "processing";

        // Stop the recording process gracefully
        await this.stopRecordingProcess(recording);

        // Wait for file to be written
        await this.waitForAudioFile(audioFile);

        // Validate audio file
        const fileStats = await this.validateAudioFile(audioFile);
        if (!fileStats.valid) {
          session.state = "error";
          return {
            success: false,
            error: fileStats.error || "Invalid audio file",
          };
        }

        // Process transcription if file is valid
        let transcription: string | undefined;
        if (fileStats.size > 500) {
          // Minimum file size threshold
          try {
            transcription = await this.processTranscription(
              audioFile,
              session.triggerId,
            );
          } catch (transcriptionError) {
            this.logWarning("Transcription failed", transcriptionError);
          }
        } else {
          this.logWarning("Audio file too small, skipping transcription");
        }

        // Update session state
        session.state = "completed";
        session.recording = undefined;

        // Schedule cleanup
        this.scheduleSessionCleanup(sessionId);

        this.logInfo(
          `Recording stopped successfully: session=${sessionId}, transcription=${!!transcription}`,
        );

        // Emit recording stopped event
        this.emitServiceEvent(ServiceEventType.CUSTOM, {
          action: "recording_stopped",
          sessionId,
          triggerId: session.triggerId,
          audioFile,
          transcription,
        });

        return {
          success: true,
          audioFile,
          transcription,
        };
      } catch (error) {
        this.logError("Failed to stop recording", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }).then((result) => result.result);
  }

  /**
   * Get recording status for a session
   */
  public getRecordingStatus(sessionId: string): {
    exists: boolean;
    session?: AudioSession;
    duration?: number;
  } {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return { exists: false };
    }

    const duration = session.recording
      ? Date.now() - session.recording.startTime.getTime()
      : 0;

    return {
      exists: true,
      session: { ...session }, // Return copy to prevent mutation
      duration,
    };
  }

  /**
   * Get all active sessions
   */
  public getActiveSessions(): AudioSession[] {
    return Array.from(this.activeSessions.values()).map((session) => ({
      ...session,
    }));
  }

  /**
   * Cancel a recording session
   */
  public async cancelRecording(sessionId: string): Promise<boolean> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return false;
    }

    try {
      if (session.recording) {
        await this.stopRecordingProcess(session.recording, true);
      }

      // Clean up session immediately
      await this.cleanupSession(sessionId);

      this.emitServiceEvent(ServiceEventType.CUSTOM, {
        action: "recording_cancelled",
        sessionId,
        triggerId: session.triggerId,
      });

      return true;
    } catch (error) {
      this.logError(`Failed to cancel recording session ${sessionId}`, error);
      return false;
    }
  }

  /**
   * Validate SoX setup with caching
   */
  private async validateSoxSetup(): Promise<SoxValidationResult> {
    // Check cache first
    const now = Date.now();
    if (
      this.soxValidationCache.result &&
      now - this.soxValidationCache.timestamp < this.soxValidationCache.ttl
    ) {
      return this.soxValidationCache.result;
    }

    return new Promise((resolve) => {
      try {
        this.logDebug("Validating SoX setup...");

        const testProcess = spawn("sox", ["--version"], { stdio: "pipe" });
        let soxVersion = "";

        testProcess.stdout.on("data", (data) => {
          soxVersion += data.toString();
        });

        testProcess.on("close", (code) => {
          if (code !== 0) {
            const result: SoxValidationResult = {
              success: false,
              error: "SoX command not found or failed",
            };
            this.cacheSoxValidation(result);
            resolve(result);
            return;
          }

          this.logDebug(`SoX found: ${soxVersion.trim()}`);

          // Test microphone access
          this.testMicrophoneAccess().then((micResult) => {
            const result: SoxValidationResult = {
              success: micResult.success,
              error: micResult.error,
              version: soxVersion.trim(),
              microphoneAvailable: micResult.success,
            };
            this.cacheSoxValidation(result);
            resolve(result);
          });
        });

        testProcess.on("error", (err) => {
          const result: SoxValidationResult = {
            success: false,
            error: `SoX not installed: ${err.message}`,
          };
          this.cacheSoxValidation(result);
          resolve(result);
        });

        // Timeout for version check
        setTimeout(() => {
          try {
            testProcess.kill("SIGTERM");
          } catch {}
          const result: SoxValidationResult = {
            success: false,
            error: "SoX version check timed out",
          };
          this.cacheSoxValidation(result);
          resolve(result);
        }, 2000);
      } catch (error) {
        const result: SoxValidationResult = {
          success: false,
          error: `SoX validation error: ${error instanceof Error ? error.message : "Unknown error"}`,
        };
        this.cacheSoxValidation(result);
        resolve(result);
      }
    });
  }

  /**
   * Test microphone access
   */
  private async testMicrophoneAccess(): Promise<{
    success: boolean;
    error: string | null;
  }> {
    return new Promise((resolve) => {
      const testFile = this.getTempPath(
        `review_gate_mic_test_${Date.now()}.wav`,
      );
      const micTest = spawn(
        "sox",
        ["-d", "-r", "16000", "-c", "1", testFile, "trim", "0", "0.1"],
        {
          stdio: "pipe",
        },
      );

      let testErr = "";
      micTest.stderr.on("data", (data) => {
        testErr += data.toString();
      });

      micTest.on("close", (testCode) => {
        // Clean up test file
        try {
          fs.unlinkSync(testFile);
        } catch {}

        if (testCode !== 0) {
          let errMsg = "Microphone access failed";
          if (testErr.includes("Permission denied")) {
            errMsg =
              "Microphone permission denied - please allow microphone access";
          } else if (testErr.includes("No such device")) {
            errMsg = "No microphone device found";
          } else if (testErr.includes("Device or resource busy")) {
            errMsg = "Microphone is busy - close other recording apps";
          } else if (testErr) {
            errMsg = `Microphone test failed: ${testErr.substring(0, 100)}`;
          }
          resolve({ success: false, error: errMsg });
        } else {
          this.logDebug("Microphone access test successful");
          resolve({ success: true, error: null });
        }
      });

      // Timeout for microphone test
      setTimeout(() => {
        try {
          micTest.kill("SIGTERM");
        } catch {}
        resolve({ success: false, error: "Microphone test timed out" });
      }, 3000);
    });
  }

  /**
   * Cache SoX validation result
   */
  private cacheSoxValidation(result: SoxValidationResult): void {
    this.soxValidationCache = {
      result,
      timestamp: Date.now(),
      ttl: result.success ? 300000 : 60000, // 5 minutes for success, 1 minute for failure
    };
  }

  /**
   * Create recording process with optimized settings
   */
  private async createRecordingProcess(
    audioFile: string,
    audioConfig: ExtensionConfig["audio"],
  ): Promise<AudioRecordingProcess> {
    const soxArgs = [
      "-d", // Default input device
      "-r",
      audioConfig.sampleRate.toString(),
      "-c",
      audioConfig.channels.toString(),
      "-b",
      audioConfig.bitDepth.toString(),
      audioFile,
    ];

    // Add maximum duration if configured
    if (audioConfig.maxDuration > 0) {
      soxArgs.push("trim", "0", audioConfig.maxDuration.toString());
    }

    const process = spawn("sox", soxArgs, { stdio: "pipe" });
    const startTime = new Date();

    const recordingProcess: AudioRecordingProcess = {
      id: this.generateSessionId(),
      state: RecordingState.RECORDING,
      startTime,
      duration: 0,
      outputPath: audioFile,
      config: {
        sampleRate: audioConfig.sampleRate,
        bitDepth: audioConfig.bitDepth,
        channels: audioConfig.channels,
        format: audioConfig.format,
      },
      process,
      processStartTime: Date.now(),
    };

    // Set up process event handlers
    process.on("error", (error) => {
      this.logError("Recording process error", error);
      recordingProcess.state = RecordingState.ERROR;
      recordingProcess.error = error.message;
    });

    process.stderr.on("data", (data) => {
      this.logDebug(`SoX stderr: ${data}`);
    });

    return recordingProcess;
  }

  /**
   * Stop recording process gracefully
   */
  private async stopRecordingProcess(
    recording: AudioRecordingProcess,
    force: boolean = false,
  ): Promise<void> {
    return new Promise((resolve) => {
      const { process } = recording;

      if (!process || process.killed) {
        resolve();
        return;
      }

      // Set up exit handler
      const onExit = () => {
        recording.state = RecordingState.STOPPED;
        if (recording.cleanupTimeout) {
          clearTimeout(recording.cleanupTimeout);
        }
        if (recording.forceKillTimeout) {
          clearTimeout(recording.forceKillTimeout);
        }
        resolve();
      };

      process.once("exit", onExit);

      if (force) {
        // Force kill immediately
        try {
          process.kill("SIGKILL");
        } catch (error) {
          this.logWarning("Error force killing process", error);
          resolve();
        }
      } else {
        // Graceful shutdown
        try {
          process.kill("SIGTERM");
        } catch (error) {
          this.logWarning("Error terminating process", error);
          resolve();
          return;
        }

        // Set up force kill timeout
        recording.forceKillTimeout = setTimeout(() => {
          this.logWarning("Force killing recording process after timeout");
          try {
            process.kill("SIGKILL");
          } catch {}
        }, 3000);
      }
    });
  }

  /**
   * Wait for audio file to be written and available
   */
  private async waitForAudioFile(
    audioFile: string,
    timeout: number = 5000,
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        if (fs.existsSync(audioFile)) {
          // Wait a bit more for file to be fully written
          await new Promise((resolve) => setTimeout(resolve, 500));
          return;
        }
      } catch (error) {
        this.logDebug("Error checking audio file existence", error);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error("Audio file not created within timeout");
  }

  /**
   * Validate audio file
   */
  private async validateAudioFile(audioFile: string): Promise<{
    valid: boolean;
    size: number;
    error?: string;
  }> {
    try {
      if (!fs.existsSync(audioFile)) {
        return {
          valid: false,
          size: 0,
          error: "Audio file does not exist",
        };
      }

      const stats = fs.statSync(audioFile);
      const size = stats.size;

      if (size === 0) {
        return {
          valid: false,
          size: 0,
          error: "Audio file is empty",
        };
      }

      return {
        valid: true,
        size,
      };
    } catch (error) {
      return {
        valid: false,
        size: 0,
        error:
          error instanceof Error ? error.message : "Unknown validation error",
      };
    }
  }

  /**
   * Process transcription with caching
   */
  private async processTranscription(
    audioFile: string,
    triggerId: string,
  ): Promise<string> {
    // Check cache first
    const cacheKey = `${audioFile}_${triggerId}`;
    const cached = this.transcriptionCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < cached.ttl) {
      return cached.result;
    }

    // Create transcription request
    const transcriptionRequest: TranscriptionRequest = {
      timestamp: new Date().toISOString(),
      system: "review-gate-v3",
      editor: "cursor",
      data: {
        tool: "speech_to_text",
        audio_file: audioFile,
        trigger_id: triggerId,
        format: "wav",
      },
      mcp_integration: true,
    };

    const triggerFile = this.getTempPath(
      `review_gate_speech_trigger_${triggerId}.json`,
    );
    fs.writeFileSync(
      triggerFile,
      JSON.stringify(transcriptionRequest, null, 2),
    );

    this.logDebug(`Speech-to-text request sent: ${triggerFile}`);

    // Poll for result
    const result = await this.pollForTranscriptionResult(
      triggerId,
      triggerFile,
    );

    // Cache result
    if (result) {
      this.transcriptionCache.set(cacheKey, {
        result,
        timestamp: Date.now(),
        ttl: 300000, // 5 minutes
      });
    }

    return result || "";
  }

  /**
   * Poll for transcription result
   */
  private async pollForTranscriptionResult(
    triggerId: string,
    triggerFile: string,
    timeout: number = 30000,
  ): Promise<string | null> {
    const startTime = Date.now();
    const pollInterval = 500;

    return new Promise((resolve) => {
      const poller = setInterval(() => {
        const resultFile = this.getTempPath(
          `review_gate_speech_response_${triggerId}.json`,
        );

        try {
          if (fs.existsSync(resultFile)) {
            const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));

            // Clean up files
            try {
              fs.unlinkSync(resultFile);
              fs.unlinkSync(triggerFile);
            } catch {}

            clearInterval(poller);
            resolve(result.transcription || null);
            return;
          }
        } catch (error) {
          this.logDebug("Error reading transcription result", error);
        }

        // Check timeout
        if (Date.now() - startTime >= timeout) {
          this.logWarning("Transcription polling timeout");

          // Clean up trigger file
          try {
            fs.unlinkSync(triggerFile);
          } catch {}

          clearInterval(poller);
          resolve(null);
        }
      }, pollInterval);
    });
  }

  /**
   * Setup process pool cleanup
   */
  private setupProcessPoolCleanup(): void {
    this.poolCleanupInterval = setInterval(() => {
      this.cleanupProcessPool();
    }, 60000); // Clean up every minute
  }

  /**
   * Clean up process pool
   */
  private cleanupProcessPool(): void {
    const now = Date.now();
    const maxAge = 300000; // 5 minutes

    this.processPool = this.processPool.filter((entry) => {
      if (!entry.inUse && now - entry.lastUsed.getTime() > maxAge) {
        try {
          entry.process.kill("SIGTERM");
        } catch {}
        return false;
      }
      return true;
    });
  }

  /**
   * Clear entire process pool
   */
  private clearProcessPool(): void {
    for (const entry of this.processPool) {
      try {
        entry.process.kill("SIGTERM");
      } catch {}
    }
    this.processPool = [];
  }

  /**
   * Setup temporary file cleanup
   */
  private setupTempFileCleanup(): void {
    this.tempFileCleanupInterval = setInterval(() => {
      this.cleanupTempFiles();
    }, 300000); // Clean up every 5 minutes
  }

  /**
   * Clean up old temporary files
   */
  private cleanupTempFiles(): void {
    const tempDir = this.getTempDir();
    const maxAge = 3600000; // 1 hour
    const now = Date.now();

    try {
      const files = fs.readdirSync(tempDir);

      for (const file of files) {
        if (
          file.startsWith("review_gate_audio_") ||
          file.startsWith("review_gate_mic_test_")
        ) {
          const filePath = path.join(tempDir, file);
          try {
            const stats = fs.statSync(filePath);
            if (now - stats.mtime.getTime() > maxAge) {
              fs.unlinkSync(filePath);
              this.logDebug(`Cleaned up old temp file: ${file}`);
            }
          } catch (error) {
            this.logDebug(`Error cleaning up temp file ${file}`, error);
          }
        }
      }
    } catch (error) {
      this.logDebug("Error during temp file cleanup", error);
    }
  }

  /**
   * Schedule session cleanup
   */
  private scheduleSessionCleanup(sessionId: string): void {
    setTimeout(() => {
      this.cleanupSession(sessionId).catch((error) => {
        this.logError(
          `Error during scheduled cleanup of session ${sessionId}`,
          error,
        );
      });
    }, 300000); // Clean up after 5 minutes
  }

  /**
   * Clean up session resources
   */
  private async cleanupSession(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return;
    }

    this.logDebug(`Cleaning up session: ${sessionId}`);

    // Stop recording if still active
    if (session.recording) {
      await this.stopRecordingProcess(session.recording, true);
    }

    // Clean up temporary files
    for (const tempFile of session.tempFiles) {
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
          this.logDebug(`Cleaned up temp file: ${tempFile}`);
        }
      } catch (error) {
        this.logDebug(`Error cleaning up temp file ${tempFile}`, error);
      }
    }

    // Remove session
    this.activeSessions.delete(sessionId);

    this.emitServiceEvent(ServiceEventType.CUSTOM, {
      action: "session_cleaned_up",
      sessionId,
    });
  }

  /**
   * Generate unique session ID
   */
  private generateSessionId(): string {
    return `audio_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get temporary file path
   */
  private getTempPath(filename: string): string {
    return path.join(this.getTempDir(), filename);
  }

  /**
   * Get temporary directory
   */
  private getTempDir(): string {
    return process.platform === "win32" ? os.tmpdir() : "/tmp";
  }
}
