/**
 * Core type definitions for the Review Gate VS Code extension
 *
 * This module contains all interfaces, types, and enums used throughout
 * the extension for MCP server integration, webview management, audio
 * recording, and file polling functionality.
 */

/**
 * Enumeration of supported tool types in the MCP ecosystem
 */
export enum ToolType {
  FILE_READER = "file_reader",
  CODE_ANALYZER = "code_analyzer",
  SEARCH = "search",
  EXECUTE = "execute",
  BROWSER = "browser",
  CUSTOM = "custom",
}

/**
 * Enumeration of recording states for audio functionality
 */
export enum RecordingState {
  IDLE = "idle",
  RECORDING = "recording",
  PAUSED = "paused",
  STOPPED = "stopped",
  ERROR = "error",
}

/**
 * Enumeration of MCP server connection status
 */
export enum MCPStatus {
  DISCONNECTED = "disconnected",
  CONNECTING = "connecting",
  CONNECTED = "connected",
  ERROR = "error",
  RECONNECTING = "reconnecting",
}

/**
 * Enumeration of webview message types for communication
 */
export enum WebviewMessageType {
  TOOL_EXECUTE = "tool_execute",
  TOOL_RESULT = "tool_result",
  RECORDING_START = "recording_start",
  RECORDING_STOP = "recording_stop",
  RECORDING_STATUS = "recording_status",
  CONFIG_UPDATE = "config_update",
  ERROR = "error",
  READY = "ready",
}

/**
 * Interface representing tool data structure for MCP tools
 */
export interface ToolData {
  /** Unique identifier for the tool */
  id: string;
  /** Display name of the tool */
  name: string;
  /** Tool type classification */
  type: ToolType;
  /** Detailed description of tool functionality */
  description: string;
  /** Input schema defining expected parameters */
  inputSchema: Record<string, any>;
  /** Optional output schema defining return structure */
  outputSchema?: Record<string, any>;
  /** Whether the tool is currently available */
  enabled: boolean;
  /** Tool version for compatibility tracking */
  version?: string;
  /** Additional metadata */
  metadata?: Record<string, any>;
}

/**
 * Interface for Review Gate trigger configuration
 */
export interface ReviewGateTrigger {
  /** Unique trigger identifier */
  id: string;
  /** Human-readable trigger name */
  name: string;
  /** File pattern to match (glob syntax) */
  pattern: string;
  /** Whether trigger is currently active */
  enabled: boolean;
  /** Debounce delay in milliseconds */
  debounceMs: number;
  /** Actions to execute when triggered */
  actions: string[];
  /** Optional conditions for trigger activation */
  conditions?: {
    /** Minimum file size in bytes */
    minFileSize?: number;
    /** Maximum file size in bytes */
    maxFileSize?: number;
    /** Required file extensions */
    extensions?: string[];
    /** Exclude patterns */
    excludePatterns?: string[];
  };
}

/**
 * Interface for popup/notification options
 */
export interface PopupOptions {
  /** Popup title */
  title: string;
  /** Main message content */
  message: string;
  /** Popup type affecting styling and behavior */
  type: "info" | "warning" | "error" | "success";
  /** Auto-dismiss timeout in milliseconds */
  timeout?: number;
  /** Available action buttons */
  actions?: Array<{
    /** Button label */
    label: string;
    /** Action identifier */
    action: string;
    /** Button style */
    style?: "primary" | "secondary" | "danger";
  }>;
  /** Whether popup is modal */
  modal?: boolean;
}

/**
 * Interface for file attachments
 */
export interface Attachment {
  /** Unique attachment identifier */
  id: string;
  /** Original filename */
  filename: string;
  /** File path (absolute or relative) */
  path: string;
  /** MIME type */
  mimeType: string;
  /** File size in bytes */
  size: number;
  /** Creation timestamp */
  createdAt: Date;
  /** Optional file hash for integrity */
  hash?: string;
  /** Additional metadata */
  metadata?: Record<string, any>;
}

/**
 * Interface for audio recording process management
 */
export interface RecordingProcess {
  /** Unique process identifier */
  id: string;
  /** Current recording state */
  state: RecordingState;
  /** Recording start timestamp */
  startTime: Date;
  /** Recording duration in milliseconds */
  duration: number;
  /** Output file path */
  outputPath: string;
  /** Audio configuration */
  config: {
    /** Sample rate in Hz */
    sampleRate: number;
    /** Bit depth */
    bitDepth: number;
    /** Number of channels */
    channels: number;
    /** Output format */
    format: string;
  };
  /** Current file size in bytes */
  fileSize?: number;
  /** Error information if state is ERROR */
  error?: string;
}

/**
 * Base interface for webview messages
 */
export interface BaseWebviewMessage {
  /** Message type identifier */
  type: WebviewMessageType;
  /** Unique message identifier */
  id: string;
  /** Message timestamp */
  timestamp: Date;
}

/**
 * Tool execution request message
 */
export interface ToolExecuteMessage extends BaseWebviewMessage {
  type: WebviewMessageType.TOOL_EXECUTE;
  /** Tool identifier to execute */
  toolId: string;
  /** Parameters for tool execution */
  parameters: Record<string, any>;
  /** Optional execution context */
  context?: Record<string, any>;
}

/**
 * Tool execution result message
 */
export interface ToolResultMessage extends BaseWebviewMessage {
  type: WebviewMessageType.TOOL_RESULT;
  /** Original tool identifier */
  toolId: string;
  /** Execution success status */
  success: boolean;
  /** Result data or error information */
  data: any;
  /** Execution duration in milliseconds */
  duration?: number;
}

/**
 * Recording control messages
 */
export interface RecordingStartMessage extends BaseWebviewMessage {
  type: WebviewMessageType.RECORDING_START;
  /** Recording configuration */
  config: RecordingProcess["config"];
  /** Optional output filename */
  filename?: string;
}

export interface RecordingStopMessage extends BaseWebviewMessage {
  type: WebviewMessageType.RECORDING_STOP;
  /** Recording process identifier */
  recordingId: string;
}

export interface RecordingStatusMessage extends BaseWebviewMessage {
  type: WebviewMessageType.RECORDING_STATUS;
  /** Current recording process state */
  recording: RecordingProcess;
}

/**
 * Configuration update message
 */
export interface ConfigUpdateMessage extends BaseWebviewMessage {
  type: WebviewMessageType.CONFIG_UPDATE;
  /** Configuration section to update */
  section: string;
  /** New configuration values */
  config: Record<string, any>;
}

/**
 * Error message
 */
export interface ErrorMessage extends BaseWebviewMessage {
  type: WebviewMessageType.ERROR;
  /** Error code */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Detailed error information */
  details?: any;
  /** Stack trace if available */
  stack?: string;
}

/**
 * Ready message indicating webview initialization complete
 */
export interface ReadyMessage extends BaseWebviewMessage {
  type: WebviewMessageType.READY;
  /** Webview capabilities */
  capabilities: string[];
  /** Webview version */
  version: string;
}

/**
 * Union type for all possible webview messages
 */
export type WebviewMessage =
  | ToolExecuteMessage
  | ToolResultMessage
  | RecordingStartMessage
  | RecordingStopMessage
  | RecordingStatusMessage
  | ConfigUpdateMessage
  | ErrorMessage
  | ReadyMessage;

/**
 * Interface for MCP server configuration
 */
export interface MCPServerConfig {
  /** Server identifier */
  id: string;
  /** Server display name */
  name: string;
  /** Server endpoint URL or command */
  endpoint: string;
  /** Connection type */
  type: "stdio" | "websocket" | "http";
  /** Connection timeout in milliseconds */
  timeout: number;
  /** Retry configuration */
  retry: {
    /** Number of retry attempts */
    attempts: number;
    /** Delay between retries in milliseconds */
    delay: number;
  };
  /** Authentication configuration */
  auth?: {
    /** Authentication type */
    type: "none" | "bearer" | "basic" | "custom";
    /** Authentication credentials */
    credentials?: Record<string, string>;
  };
  /** Server-specific options */
  options?: Record<string, any>;
}

/**
 * Interface for file polling configuration
 */
export interface FilePollingConfig {
  /** Whether polling is enabled */
  enabled: boolean;
  /** Polling interval in milliseconds */
  interval: number;
  /** File patterns to watch */
  patterns: string[];
  /** Patterns to exclude */
  excludePatterns: string[];
  /** Whether to watch subdirectories */
  recursive: boolean;
  /** Debounce delay for file changes */
  debounceMs: number;
}

/**
 * Type guard to check if a message is a tool execute message
 */
export function isToolExecuteMessage(
  message: WebviewMessage,
): message is ToolExecuteMessage {
  return message.type === WebviewMessageType.TOOL_EXECUTE;
}

/**
 * Type guard to check if a message is a tool result message
 */
export function isToolResultMessage(
  message: WebviewMessage,
): message is ToolResultMessage {
  return message.type === WebviewMessageType.TOOL_RESULT;
}

/**
 * Type guard to check if a message is a recording start message
 */
export function isRecordingStartMessage(
  message: WebviewMessage,
): message is RecordingStartMessage {
  return message.type === WebviewMessageType.RECORDING_START;
}

/**
 * Type guard to check if a message is a recording stop message
 */
export function isRecordingStopMessage(
  message: WebviewMessage,
): message is RecordingStopMessage {
  return message.type === WebviewMessageType.RECORDING_STOP;
}

/**
 * Type guard to check if a message is an error message
 */
export function isErrorMessage(
  message: WebviewMessage,
): message is ErrorMessage {
  return message.type === WebviewMessageType.ERROR;
}

/**
 * Utility type for partial configuration updates
 */
export type PartialConfig<T> = {
  [P in keyof T]?: T[P] extends object ? PartialConfig<T[P]> : T[P];
};

/**
 * Utility type for required fields
 */
export type RequiredFields<T, K extends keyof T> = T & Required<Pick<T, K>>;

/**
 * Event handler type for configuration changes
 */
export type ConfigChangeHandler<T = any> = (
  newConfig: T,
  oldConfig: T,
) => void | Promise<void>;

/**
 * Event handler type for file changes
 */
export type FileChangeHandler = (
  filePath: string,
  changeType: "created" | "modified" | "deleted",
) => void | Promise<void>;
