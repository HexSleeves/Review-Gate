/**
 * Base service class providing common functionality for all extension services
 *
 * This abstract class serves as the foundation for all services in the Review Gate
 * extension, providing lifecycle management, configuration access, logging utilities,
 * error handling patterns, event communication, and performance monitoring.
 */

import * as vscode from "vscode";
import { EventEmitter } from "events";
import {
  ExtensionConfigManager,
  getConfigManager,
} from "../config/extensionConfig";
import { ConfigChangeHandler } from "../types";

/**
 * Performance metrics interface for service monitoring
 */
export interface ServicePerformanceMetrics {
  /** Service initialization time in milliseconds */
  initializationTime: number;
  /** Current memory usage in bytes */
  memoryUsage: number;
  /** Total number of method calls */
  methodCallCount: number;
  /** Total number of errors encountered */
  errorCount: number;
  /** Average method execution time in milliseconds */
  averageExecutionTime: number;
  /** Last activity timestamp */
  lastActivity: Date;
  /** Service uptime in milliseconds */
  uptime: number;
}

/**
 * Service lifecycle state enumeration
 */
export enum ServiceState {
  UNINITIALIZED = "uninitialized",
  INITIALIZING = "initializing",
  ACTIVE = "active",
  DISPOSING = "disposing",
  DISPOSED = "disposed",
  ERROR = "error",
}

/**
 * Service event types for inter-service communication
 */
export enum ServiceEventType {
  STATE_CHANGED = "stateChanged",
  ERROR_OCCURRED = "errorOccurred",
  PERFORMANCE_UPDATE = "performanceUpdate",
  CONFIG_CHANGED = "configChanged",
  CUSTOM = "custom",
}

/**
 * Service event interface
 */
export interface ServiceEvent {
  /** Event type */
  type: ServiceEventType;
  /** Source service name */
  source: string;
  /** Event timestamp */
  timestamp: Date;
  /** Event data payload */
  data?: any;
  /** Error information if applicable */
  error?: Error;
}

/**
 * Method execution timing decorator result
 */
interface TimingResult<T> {
  /** Method execution result */
  result: T;
  /** Execution duration in milliseconds */
  duration: number;
}

/**
 * Abstract base service class providing common functionality
 */
export abstract class BaseService extends EventEmitter {
  /** Service name identifier */
  protected readonly serviceName: string;

  /** Current service state */
  protected state: ServiceState = ServiceState.UNINITIALIZED;

  /** VSCode extension context */
  protected context: vscode.ExtensionContext | null = null;

  /** Configuration manager instance */
  protected configManager: ExtensionConfigManager;

  /** Disposable resources */
  protected disposables: vscode.Disposable[] = [];

  /** Performance metrics */
  protected metrics: ServicePerformanceMetrics;

  /** Service initialization timestamp */
  protected initStartTime: number = 0;

  /** Method execution times for performance tracking */
  private executionTimes: number[] = [];

  /** Configuration change listeners */
  private configListeners: Map<string, vscode.Disposable> = new Map();

  /**
   * Constructor
   * @param serviceName - Unique service identifier
   */
  constructor(serviceName: string) {
    super();
    this.serviceName = serviceName;
    this.configManager = getConfigManager();
    this.metrics = this.initializeMetrics();

    // Set up error handling for the event emitter
    this.on("error", this.handleServiceError.bind(this));
  }

  /**
   * Initialize the service with extension context
   * @param context - VSCode extension context
   */
  public async initialize(context: vscode.ExtensionContext): Promise<void> {
    if (this.state !== ServiceState.UNINITIALIZED) {
      throw new Error(
        `Service ${this.serviceName} is already initialized or in invalid state: ${this.state}`,
      );
    }

    this.setState(ServiceState.INITIALIZING);
    this.initStartTime = Date.now();
    this.context = context;

    try {
      this.logInfo(`Initializing service: ${this.serviceName}`);

      // Set up configuration change listeners
      this.setupConfigurationListeners();

      // Call the abstract initialization method
      await this.onInitialize(context);

      // Update metrics
      this.metrics.initializationTime = Date.now() - this.initStartTime;
      this.metrics.lastActivity = new Date();

      this.setState(ServiceState.ACTIVE);
      this.logInfo(
        `Service ${this.serviceName} initialized successfully in ${this.metrics.initializationTime}ms`,
      );

      // Emit initialization complete event
      this.emitServiceEvent(ServiceEventType.STATE_CHANGED, {
        previousState: ServiceState.INITIALIZING,
        currentState: ServiceState.ACTIVE,
        initializationTime: this.metrics.initializationTime,
      });
    } catch (error) {
      this.setState(ServiceState.ERROR);
      this.metrics.errorCount++;
      this.logError(`Failed to initialize service ${this.serviceName}`, error);
      throw error;
    }
  }

  /**
   * Dispose of service resources
   */
  public dispose(): void {
    if (
      this.state === ServiceState.DISPOSED ||
      this.state === ServiceState.DISPOSING
    ) {
      return;
    }

    this.setState(ServiceState.DISPOSING);
    this.logInfo(`Disposing service: ${this.serviceName}`);

    try {
      // Call the abstract disposal method
      this.onDispose();

      // Dispose of configuration listeners
      this.configListeners.forEach((disposable) => disposable.dispose());
      this.configListeners.clear();

      // Dispose of all registered disposables
      this.disposables.forEach((disposable) => {
        try {
          disposable.dispose();
        } catch (error) {
          this.logError(
            `Error disposing resource in ${this.serviceName}`,
            error,
          );
        }
      });
      this.disposables = [];

      // Remove all event listeners
      this.removeAllListeners();

      this.setState(ServiceState.DISPOSED);
      this.logInfo(`Service ${this.serviceName} disposed successfully`);
    } catch (error) {
      this.setState(ServiceState.ERROR);
      this.logError(`Error disposing service ${this.serviceName}`, error);
    }
  }

  /**
   * Check if the service is active and ready for use
   */
  public isActive(): boolean {
    return this.state === ServiceState.ACTIVE;
  }

  /**
   * Get current service state
   */
  public getState(): ServiceState {
    return this.state;
  }

  /**
   * Get service name
   */
  public getServiceName(): string {
    return this.serviceName;
  }

  /**
   * Get current performance metrics
   */
  public getMetrics(): Readonly<ServicePerformanceMetrics> {
    // Update uptime and memory usage
    this.updateMetrics();
    return { ...this.metrics };
  }

  /**
   * Register a disposable resource for automatic cleanup
   */
  protected registerDisposable(disposable: vscode.Disposable): void {
    this.disposables.push(disposable);
  }

  /**
   * Get configuration value with type safety
   */
  protected getConfigValue<
    K extends keyof import("../config/extensionConfig").ExtensionConfig,
  >(
    section: K,
  ): Readonly<import("../config/extensionConfig").ExtensionConfig[K]> {
    return this.configManager.getSection(section);
  }

  /**
   * Get specific configuration property
   */
  protected getConfigProperty<
    K extends keyof import("../config/extensionConfig").ExtensionConfig,
    P extends keyof import("../config/extensionConfig").ExtensionConfig[K],
  >(
    section: K,
    property: P,
  ): import("../config/extensionConfig").ExtensionConfig[K][P] {
    return this.configManager.getValue(section, property);
  }

  /**
   * Listen for configuration changes
   */
  protected onConfigurationChange<
    K extends keyof import("../config/extensionConfig").ExtensionConfig,
  >(section: K | "*", handler: ConfigChangeHandler): void {
    const key = `${this.serviceName}_${section.toString()}`;

    // Dispose existing listener if any
    const existingListener = this.configListeners.get(key);
    if (existingListener) {
      existingListener.dispose();
    }

    // Register new listener
    const disposable = this.configManager.onConfigurationChange(
      section,
      handler,
    );
    this.configListeners.set(key, disposable);
  }

  /**
   * Execute a method with performance timing
   */
  protected async withTiming<T>(
    methodName: string,
    operation: () => Promise<T>,
  ): Promise<TimingResult<T>> {
    const startTime = Date.now();
    this.metrics.methodCallCount++;
    this.metrics.lastActivity = new Date();

    try {
      const result = await operation();
      const duration = Date.now() - startTime;

      // Update execution times for average calculation
      this.executionTimes.push(duration);
      if (this.executionTimes.length > 100) {
        this.executionTimes.shift(); // Keep only last 100 measurements
      }

      this.logDebug(`Method ${methodName} executed in ${duration}ms`);

      return { result, duration };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.metrics.errorCount++;
      this.logError(`Method ${methodName} failed after ${duration}ms`, error);
      throw error;
    }
  }

  /**
   * Emit a service event for inter-service communication
   */
  protected emitServiceEvent(
    type: ServiceEventType,
    data?: any,
    error?: Error,
  ): void {
    const event: ServiceEvent = {
      type,
      source: this.serviceName,
      timestamp: new Date(),
      data,
      error,
    };

    this.emit("serviceEvent", event);

    // Also emit specific event type
    this.emit(type, event);
  }

  /**
   * Log info message
   */
  protected logInfo(message: string, ...args: any[]): void {
    const logLevel = this.getConfigProperty("logging", "level");
    if (["info", "debug"].includes(logLevel)) {
      console.log(`[${this.serviceName}] INFO: ${message}`, ...args);
    }
  }

  /**
   * Log warning message
   */
  protected logWarning(message: string, ...args: any[]): void {
    const logLevel = this.getConfigProperty("logging", "level");
    if (["warn", "info", "debug"].includes(logLevel)) {
      console.warn(`[${this.serviceName}] WARN: ${message}`, ...args);
    }
  }

  /**
   * Log error message
   */
  protected logError(message: string, error?: any, ...args: any[]): void {
    const logLevel = this.getConfigProperty("logging", "level");
    if (["error", "warn", "info", "debug"].includes(logLevel)) {
      console.error(`[${this.serviceName}] ERROR: ${message}`, error, ...args);
    }

    // Emit error event
    this.emitServiceEvent(ServiceEventType.ERROR_OCCURRED, { message, error });
  }

  /**
   * Log debug message
   */
  protected logDebug(message: string, ...args: any[]): void {
    const logLevel = this.getConfigProperty("logging", "level");
    if (logLevel === "debug") {
      console.debug(`[${this.serviceName}] DEBUG: ${message}`, ...args);
    }
  }

  /**
   * Handle service errors
   */
  private handleServiceError(error: Error): void {
    this.metrics.errorCount++;
    this.logError(`Unhandled service error in ${this.serviceName}`, error);
  }

  /**
   * Set service state and emit change event
   */
  private setState(newState: ServiceState): void {
    const previousState = this.state;
    this.state = newState;

    if (previousState !== newState) {
      this.emitServiceEvent(ServiceEventType.STATE_CHANGED, {
        previousState,
        currentState: newState,
      });
    }
  }

  /**
   * Initialize performance metrics
   */
  private initializeMetrics(): ServicePerformanceMetrics {
    return {
      initializationTime: 0,
      memoryUsage: 0,
      methodCallCount: 0,
      errorCount: 0,
      averageExecutionTime: 0,
      lastActivity: new Date(),
      uptime: 0,
    };
  }

  /**
   * Update performance metrics
   */
  private updateMetrics(): void {
    // Update memory usage (approximation)
    if (process.memoryUsage) {
      this.metrics.memoryUsage = process.memoryUsage().heapUsed;
    }

    // Update uptime
    if (this.initStartTime > 0) {
      this.metrics.uptime = Date.now() - this.initStartTime;
    }

    // Update average execution time
    if (this.executionTimes.length > 0) {
      this.metrics.averageExecutionTime =
        this.executionTimes.reduce((sum, time) => sum + time, 0) /
        this.executionTimes.length;
    }
  }

  /**
   * Set up configuration change listeners
   */
  private setupConfigurationListeners(): void {
    // Listen for logging configuration changes
    this.onConfigurationChange("logging", (newConfig, oldConfig) => {
      this.logDebug(`Logging configuration changed for ${this.serviceName}`, {
        old: oldConfig,
        new: newConfig,
      });
    });
  }

  /**
   * Abstract method for service-specific initialization
   * Must be implemented by derived classes
   */
  protected abstract onInitialize(
    context: vscode.ExtensionContext,
  ): Promise<void>;

  /**
   * Abstract method for service-specific disposal
   * Must be implemented by derived classes
   */
  protected abstract onDispose(): void;
}

/**
 * Service registry for managing service instances
 */
export class ServiceRegistry {
  private static instance: ServiceRegistry;
  private services: Map<string, BaseService> = new Map();

  private constructor() {}

  /**
   * Get singleton instance
   */
  public static getInstance(): ServiceRegistry {
    if (!ServiceRegistry.instance) {
      ServiceRegistry.instance = new ServiceRegistry();
    }
    return ServiceRegistry.instance;
  }

  /**
   * Register a service
   */
  public register(service: BaseService): void {
    const serviceName = service.getServiceName();
    if (this.services.has(serviceName)) {
      throw new Error(`Service ${serviceName} is already registered`);
    }
    this.services.set(serviceName, service);
  }

  /**
   * Get a registered service
   */
  public get<T extends BaseService>(serviceName: string): T | undefined {
    return this.services.get(serviceName) as T;
  }

  /**
   * Get all registered services
   */
  public getAll(): BaseService[] {
    return Array.from(this.services.values());
  }

  /**
   * Dispose all services
   */
  public disposeAll(): void {
    this.services.forEach((service) => {
      try {
        service.dispose();
      } catch (error) {
        console.error(
          `Error disposing service ${service.getServiceName()}:`,
          error,
        );
      }
    });
    this.services.clear();
  }
}

/**
 * Convenience function to get the service registry
 */
export function getServiceRegistry(): ServiceRegistry {
  return ServiceRegistry.getInstance();
}
