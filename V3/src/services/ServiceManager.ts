/**
 * ServiceManager - Centralized service coordination and lifecycle management
 *
 * This manager coordinates all services in the Review Gate extension, providing:
 * - Service lifecycle management with proper initialization order
 * - Lazy loading and service discovery
 * - Inter-service communication and event coordination
 * - Performance monitoring and resource management
 * - Configuration management and hot-reloading
 * - Error handling and service recovery
 * - Health monitoring and restart capabilities
 */

import * as vscode from "vscode";
import { EventEmitter } from "events";
import {
  BaseService,
  ServiceState,
  ServiceEventType,
  ServiceEvent,
  ServicePerformanceMetrics,
  getServiceRegistry,
} from "./BaseService";
import {
  ExtensionConfigManager,
  getConfigManager,
  ExtensionConfig,
} from "../config/extensionConfig";

// Import all service classes
import { MCPService } from "./MCPService";
import { ReviewGateService } from "./ReviewGateService";
import { WebviewService } from "./WebviewService";
import { AudioService } from "./AudioService";
import { LoggingService } from "./LoggingService";
import { FileService } from "./FileService";

/**
 * Service dependency configuration
 */
interface ServiceDependency {
  /** Service name */
  name: string;
  /** Services this service depends on */
  dependencies: string[];
  /** Whether service is required for extension functionality */
  required: boolean;
  /** Whether service should be lazily loaded */
  lazy: boolean;
  /** Service initialization priority (higher = earlier) */
  priority: number;
}

/**
 * Service health status
 */
export enum ServiceHealth {
  HEALTHY = "healthy",
  DEGRADED = "degraded",
  UNHEALTHY = "unhealthy",
  UNKNOWN = "unknown",
}

/**
 * Service health check result
 */
export interface ServiceHealthCheck {
  /** Service name */
  service: string;
  /** Health status */
  status: ServiceHealth;
  /** Health check timestamp */
  timestamp: Date;
  /** Additional health information */
  details?: {
    /** Error message if unhealthy */
    error?: string;
    /** Performance metrics */
    metrics?: ServicePerformanceMetrics;
    /** Last successful operation timestamp */
    lastSuccess?: Date;
    /** Resource usage information */
    resources?: {
      memory?: number;
      cpu?: number;
    };
  };
}

/**
 * Service manager configuration
 */
export interface ServiceManagerConfig {
  /** Health check interval in milliseconds */
  healthCheckInterval: number;
  /** Service restart attempts before giving up */
  maxRestartAttempts: number;
  /** Restart delay in milliseconds */
  restartDelay: number;
  /** Whether to enable performance monitoring */
  enablePerformanceMonitoring: boolean;
  /** Performance monitoring interval in milliseconds */
  performanceMonitoringInterval: number;
  /** Maximum service initialization timeout in milliseconds */
  initializationTimeout: number;
}

/**
 * Service manager performance metrics
 */
export interface ServiceManagerMetrics {
  /** Total services managed */
  totalServices: number;
  /** Services by state */
  servicesByState: Record<ServiceState, number>;
  /** Services by health */
  servicesByHealth: Record<ServiceHealth, number>;
  /** Total service restarts */
  totalRestarts: number;
  /** Average service initialization time */
  averageInitTime: number;
  /** Manager uptime in milliseconds */
  uptime: number;
  /** Last health check timestamp */
  lastHealthCheck: Date;
}

/**
 * Service registration entry
 */
interface ServiceRegistration {
  /** Service name */
  name: string;
  /** Service class constructor */
  serviceClass: new () => BaseService;
  /** Service instance (if created) */
  instance?: BaseService;
  /** Service dependency configuration */
  dependency: ServiceDependency;
  /** Service health status */
  health: ServiceHealthCheck;
  /** Restart attempt count */
  restartAttempts: number;
  /** Last restart timestamp */
  lastRestart?: Date;
  /** Service creation timestamp */
  createdAt?: Date;
  /** Service initialization duration */
  initDuration?: number;
}

/**
 * Main ServiceManager class
 */
export class ServiceManager extends EventEmitter {
  /** Singleton instance */
  private static instance: ServiceManager;

  /** Extension context */
  private context: vscode.ExtensionContext | null = null;

  /** Configuration manager */
  private configManager: ExtensionConfigManager;

  /** Service registrations */
  private services = new Map<string, ServiceRegistration>();

  /** Service manager configuration */
  private config: ServiceManagerConfig;

  /** Manager state */
  private isInitialized = false;
  private isDisposing = false;

  /** Health check interval */
  private healthCheckInterval: NodeJS.Timeout | null = null;

  /** Performance monitoring interval */
  private performanceInterval: NodeJS.Timeout | null = null;

  /** Manager start time */
  private startTime = Date.now();

  /** Manager metrics */
  private metrics: ServiceManagerMetrics;

  /** Disposable resources */
  private disposables: vscode.Disposable[] = [];

  /** Service initialization promises */
  private initializationPromises = new Map<string, Promise<void>>();

  /** Inter-service event handlers */
  private eventHandlers = new Map<
    string,
    Map<string, (event: ServiceEvent) => void>
  >();

  /**
   * Private constructor for singleton pattern
   */
  private constructor() {
    super();
    this.configManager = getConfigManager();
    this.config = this.getDefaultConfig();
    this.metrics = this.initializeMetrics();

    // Set up error handling
    this.on("error", this.handleManagerError.bind(this));
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): ServiceManager {
    if (!ServiceManager.instance) {
      ServiceManager.instance = new ServiceManager();
    }
    return ServiceManager.instance;
  }

  /**
   * Initialize the service manager
   */
  public async initialize(context: vscode.ExtensionContext): Promise<void> {
    if (this.isInitialized) {
      throw new Error("ServiceManager is already initialized");
    }

    this.context = context;
    console.log("[ServiceManager] Initializing service manager...");

    try {
      // Load configuration
      await this.loadConfiguration();

      // Register all services
      this.registerServices();

      // Set up configuration change listeners
      this.setupConfigurationListeners();

      // Initialize required services
      await this.initializeRequiredServices();

      // Start health monitoring
      this.startHealthMonitoring();

      // Start performance monitoring if enabled
      if (this.config.enablePerformanceMonitoring) {
        this.startPerformanceMonitoring();
      }

      // Set up inter-service communication
      this.setupInterServiceCommunication();

      this.isInitialized = true;
      console.log("[ServiceManager] Service manager initialized successfully");

      // Emit initialization complete event
      this.emit("initialized", {
        totalServices: this.services.size,
        initializedServices: this.getServicesByState(ServiceState.ACTIVE)
          .length,
      });
    } catch (error) {
      console.error(
        "[ServiceManager] Failed to initialize service manager:",
        error,
      );
      throw error;
    }
  }

  /**
   * Get service instance with lazy loading
   */
  public async getService<T extends BaseService>(
    serviceName: string,
  ): Promise<T | null> {
    const registration = this.services.get(serviceName);
    if (!registration) {
      console.warn(`[ServiceManager] Service not found: ${serviceName}`);
      return null;
    }

    // Return existing instance if available
    if (registration.instance) {
      return registration.instance as T;
    }

    // Initialize service if not already initializing
    if (!this.initializationPromises.has(serviceName)) {
      this.initializationPromises.set(
        serviceName,
        this.initializeService(serviceName),
      );
    }

    // Wait for initialization to complete
    await this.initializationPromises.get(serviceName);
    return registration.instance ? (registration.instance as T) : null;
  }

  /**
   * Get all services by state
   */
  public getServicesByState(state: ServiceState): BaseService[] {
    return Array.from(this.services.values())
      .filter((reg) => reg.instance?.getState() === state)
      .map((reg) => reg.instance!)
      .filter(Boolean);
  }

  /**
   * Get all services by health status
   */
  public getServicesByHealth(health: ServiceHealth): BaseService[] {
    return Array.from(this.services.values())
      .filter((reg) => reg.health.status === health)
      .map((reg) => reg.instance!)
      .filter(Boolean);
  }

  /**
   * Get service health status
   */
  public getServiceHealth(serviceName: string): ServiceHealthCheck | null {
    const registration = this.services.get(serviceName);
    return registration ? registration.health : null;
  }

  /**
   * Get all service health statuses
   */
  public getAllServiceHealth(): ServiceHealthCheck[] {
    return Array.from(this.services.values()).map((reg) => reg.health);
  }

  /**
   * Restart a service
   */
  public async restartService(serviceName: string): Promise<boolean> {
    const registration = this.services.get(serviceName);
    if (!registration) {
      console.warn(
        `[ServiceManager] Cannot restart unknown service: ${serviceName}`,
      );
      return false;
    }

    if (registration.restartAttempts >= this.config.maxRestartAttempts) {
      console.error(
        `[ServiceManager] Max restart attempts reached for service: ${serviceName}`,
      );
      return false;
    }

    try {
      console.log(`[ServiceManager] Restarting service: ${serviceName}`);

      // Dispose existing instance
      if (registration.instance) {
        registration.instance.dispose();
        registration.instance = undefined;
      }

      // Clear initialization promise
      this.initializationPromises.delete(serviceName);

      // Wait for restart delay
      await new Promise((resolve) =>
        setTimeout(resolve, this.config.restartDelay),
      );

      // Increment restart attempts
      registration.restartAttempts++;
      registration.lastRestart = new Date();
      this.metrics.totalRestarts++;

      // Reinitialize service
      await this.initializeService(serviceName);

      console.log(
        `[ServiceManager] Service restarted successfully: ${serviceName}`,
      );
      this.emit("serviceRestarted", {
        serviceName,
        attempts: registration.restartAttempts,
      });

      return true;
    } catch (error) {
      console.error(
        `[ServiceManager] Failed to restart service ${serviceName}:`,
        error,
      );
      registration.health.status = ServiceHealth.UNHEALTHY;
      registration.health.details = {
        error: error instanceof Error ? error.message : String(error),
      };
      return false;
    }
  }

  /**
   * Get service manager metrics
   */
  public getMetrics(): Readonly<ServiceManagerMetrics> {
    this.updateMetrics();
    return { ...this.metrics };
  }

  /**
   * Dispose of all services and resources
   */
  public dispose(): void {
    if (this.isDisposing) {
      return;
    }

    this.isDisposing = true;
    console.log("[ServiceManager] Disposing service manager...");

    // Stop monitoring intervals
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.performanceInterval) {
      clearInterval(this.performanceInterval);
      this.performanceInterval = null;
    }

    // Dispose all services in reverse dependency order
    const disposalOrder = this.getServiceDisposalOrder();
    for (const serviceName of disposalOrder) {
      const registration = this.services.get(serviceName);
      if (registration?.instance) {
        try {
          registration.instance.dispose();
        } catch (error) {
          console.error(
            `[ServiceManager] Error disposing service ${serviceName}:`,
            error,
          );
        }
      }
    }

    // Dispose of disposable resources
    this.disposables.forEach((disposable) => {
      try {
        disposable.dispose();
      } catch (error) {
        console.error("[ServiceManager] Error disposing resource:", error);
      }
    });
    this.disposables = [];

    // Clear all maps and state
    this.services.clear();
    this.initializationPromises.clear();
    this.eventHandlers.clear();
    this.removeAllListeners();

    this.isInitialized = false;
    console.log("[ServiceManager] Service manager disposed");
  }

  /**
   * Register all available services
   */
  private registerServices(): void {
    const serviceDependencies: ServiceDependency[] = [
      {
        name: "LoggingService",
        dependencies: [],
        required: true,
        lazy: false,
        priority: 100,
      },
      {
        name: "FileService",
        dependencies: ["LoggingService"],
        required: true,
        lazy: false,
        priority: 90,
      },
      {
        name: "MCPService",
        dependencies: ["LoggingService", "FileService"],
        required: true,
        lazy: false,
        priority: 80,
      },
      {
        name: "AudioService",
        dependencies: ["LoggingService", "FileService"],
        required: false,
        lazy: true,
        priority: 60,
      },
      {
        name: "WebviewService",
        dependencies: ["LoggingService", "FileService", "AudioService"],
        required: true,
        lazy: false,
        priority: 70,
      },
      {
        name: "ReviewGateService",
        dependencies: [
          "LoggingService",
          "FileService",
          "MCPService",
          "WebviewService",
        ],
        required: true,
        lazy: false,
        priority: 50,
      },
    ];

    const serviceClasses = {
      LoggingService,
      FileService,
      MCPService,
      AudioService,
      WebviewService,
      ReviewGateService,
    };

    for (const dependency of serviceDependencies) {
      const serviceClass =
        serviceClasses[dependency.name as keyof typeof serviceClasses];
      if (!serviceClass) {
        console.warn(
          `[ServiceManager] Service class not found: ${dependency.name}`,
        );
        continue;
      }

      const registration: ServiceRegistration = {
        name: dependency.name,
        serviceClass,
        dependency,
        health: {
          service: dependency.name,
          status: ServiceHealth.UNKNOWN,
          timestamp: new Date(),
        },
        restartAttempts: 0,
      };

      this.services.set(dependency.name, registration);
    }

    console.log(`[ServiceManager] Registered ${this.services.size} services`);
  }

  /**
   * Initialize required services in dependency order
   */
  private async initializeRequiredServices(): Promise<void> {
    const requiredServices = Array.from(this.services.values())
      .filter((reg) => reg.dependency.required && !reg.dependency.lazy)
      .sort((a, b) => b.dependency.priority - a.dependency.priority);

    console.log(
      `[ServiceManager] Initializing ${requiredServices.length} required services...`,
    );

    for (const registration of requiredServices) {
      try {
        await this.initializeService(registration.name);
      } catch (error) {
        console.error(
          `[ServiceManager] Failed to initialize required service ${registration.name}:`,
          error,
        );
        throw error;
      }
    }
  }

  /**
   * Initialize a specific service
   */
  private async initializeService(serviceName: string): Promise<void> {
    const registration = this.services.get(serviceName);
    if (!registration) {
      throw new Error(`Service not registered: ${serviceName}`);
    }

    if (registration.instance) {
      return; // Already initialized
    }

    console.log(`[ServiceManager] Initializing service: ${serviceName}`);
    const startTime = Date.now();

    try {
      // Check dependencies
      await this.ensureDependencies(registration.dependency.dependencies);

      // Create service instance
      registration.instance = new registration.serviceClass();
      registration.createdAt = new Date();

      // Register with service registry
      const serviceRegistry = getServiceRegistry();
      serviceRegistry.register(registration.instance);

      // Set up service event listeners
      this.setupServiceEventListeners(registration.instance);

      // Initialize service with timeout
      const initPromise = registration.instance.initialize(this.context!);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(new Error(`Service initialization timeout: ${serviceName}`)),
          this.config.initializationTimeout,
        );
      });

      await Promise.race([initPromise, timeoutPromise]);

      // Update metrics
      registration.initDuration = Date.now() - startTime;
      registration.health.status = ServiceHealth.HEALTHY;
      registration.health.timestamp = new Date();

      console.log(
        `[ServiceManager] Service initialized: ${serviceName} (${registration.initDuration}ms)`,
      );

      // Emit service initialized event
      this.emit("serviceInitialized", {
        serviceName,
        duration: registration.initDuration,
      });
    } catch (error) {
      registration.health.status = ServiceHealth.UNHEALTHY;
      registration.health.details = {
        error: error instanceof Error ? error.message : String(error),
      };
      registration.health.timestamp = new Date();

      console.error(
        `[ServiceManager] Failed to initialize service ${serviceName}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Ensure service dependencies are initialized
   */
  private async ensureDependencies(dependencies: string[]): Promise<void> {
    for (const depName of dependencies) {
      const depRegistration = this.services.get(depName);
      if (!depRegistration) {
        throw new Error(`Dependency not found: ${depName}`);
      }

      if (!depRegistration.instance) {
        if (!this.initializationPromises.has(depName)) {
          this.initializationPromises.set(
            depName,
            this.initializeService(depName),
          );
        }
        await this.initializationPromises.get(depName);
      }
    }
  }

  /**
   * Set up service event listeners for inter-service communication
   */
  private setupServiceEventListeners(service: BaseService): void {
    const serviceName = service.getServiceName();

    service.on("serviceEvent", (event: ServiceEvent) => {
      this.handleServiceEvent(serviceName, event);
    });

    service.on(ServiceEventType.STATE_CHANGED, (event: ServiceEvent) => {
      this.handleServiceStateChange(serviceName, event);
    });

    service.on(ServiceEventType.ERROR_OCCURRED, (event: ServiceEvent) => {
      this.handleServiceError(serviceName, event);
    });

    service.on(ServiceEventType.PERFORMANCE_UPDATE, (event: ServiceEvent) => {
      this.handleServicePerformanceUpdate(serviceName, event);
    });
  }

  /**
   * Handle service events for inter-service communication
   */
  private handleServiceEvent(sourceName: string, event: ServiceEvent): void {
    // Route events to interested services
    const handlers = this.eventHandlers.get(event.type);
    if (handlers) {
      handlers.forEach((handler, targetService) => {
        if (targetService !== sourceName) {
          try {
            handler(event);
          } catch (error) {
            console.error(
              `[ServiceManager] Error in event handler for ${targetService}:`,
              error,
            );
          }
        }
      });
    }

    // Emit manager-level event
    this.emit("serviceEvent", { source: sourceName, event });
  }

  /**
   * Handle service state changes
   */
  private handleServiceStateChange(
    serviceName: string,
    event: ServiceEvent,
  ): void {
    const registration = this.services.get(serviceName);
    if (!registration) {
      return;
    }

    console.log(
      `[ServiceManager] Service state changed: ${serviceName} -> ${event.data?.currentState}`,
    );

    // Update health status based on state
    if (event.data?.currentState === ServiceState.ACTIVE) {
      registration.health.status = ServiceHealth.HEALTHY;
    } else if (event.data?.currentState === ServiceState.ERROR) {
      registration.health.status = ServiceHealth.UNHEALTHY;
    }

    registration.health.timestamp = new Date();
  }

  /**
   * Handle service errors
   */
  private handleServiceError(serviceName: string, event: ServiceEvent): void {
    const registration = this.services.get(serviceName);
    if (!registration) {
      return;
    }

    console.error(
      `[ServiceManager] Service error in ${serviceName}:`,
      event.error,
    );

    registration.health.status = ServiceHealth.UNHEALTHY;
    registration.health.details = {
      error: event.error?.message || "Unknown error",
    };
    registration.health.timestamp = new Date();

    // Consider restarting the service if it's critical
    if (
      registration.dependency.required &&
      registration.restartAttempts < this.config.maxRestartAttempts
    ) {
      setTimeout(() => {
        this.restartService(serviceName);
      }, this.config.restartDelay);
    }
  }

  /**
   * Handle service performance updates
   */
  private handleServicePerformanceUpdate(
    serviceName: string,
    event: ServiceEvent,
  ): void {
    const registration = this.services.get(serviceName);
    if (!registration) {
      return;
    }

    if (registration.health.details) {
      registration.health.details.metrics = event.data;
      registration.health.details.lastSuccess = new Date();
    }
  }

  /**
   * Set up inter-service communication
   */
  private setupInterServiceCommunication(): void {
    // Set up specific inter-service communication patterns

    // WebviewService -> AudioService communication
    this.addEventHandler("start_recording", "AudioService", async (event) => {
      const audioService = await this.getService<AudioService>("AudioService");
      if (audioService && event.data?.triggerId) {
        await audioService.startRecording(event.data.triggerId);
      }
    });

    this.addEventHandler("stop_recording", "AudioService", async (event) => {
      const audioService = await this.getService<AudioService>("AudioService");
      if (audioService && event.data?.triggerId) {
        // Find active session for trigger
        const sessions = audioService.getActiveSessions();
        const session = sessions.find(
          (s) => s.triggerId === event.data.triggerId,
        );
        if (session) {
          await audioService.stopRecording(session.id);
        }
      }
    });

    // MCPService -> ReviewGateService communication
    this.addEventHandler("tool_call", "ReviewGateService", async (event) => {
      const reviewGateService =
        await this.getService<ReviewGateService>("ReviewGateService");
      if (reviewGateService && event.data?.toolData) {
        // Process the tool call through ReviewGateService
        console.log(
          `[ServiceManager] Routing tool call from MCP to ReviewGate: ${event.data.toolData.tool}`,
        );
      }
    });

    console.log("[ServiceManager] Inter-service communication setup completed");
  }

  /**
   * Add event handler for inter-service communication
   */
  private addEventHandler(
    eventType: string,
    targetService: string,
    handler: (event: ServiceEvent) => void,
  ): void {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, new Map());
    }
    this.eventHandlers.get(eventType)!.set(targetService, handler);
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthChecks();
    }, this.config.healthCheckInterval);

    console.log(
      `[ServiceManager] Health monitoring started (interval: ${this.config.healthCheckInterval}ms)`,
    );
  }

  /**
   * Perform health checks on all services
   */
  private async performHealthChecks(): Promise<void> {
    for (const [serviceName, registration] of this.services.entries()) {
      if (!registration.instance) {
        continue;
      }

      try {
        const isActive = registration.instance.isActive();
        const metrics = registration.instance.getMetrics();

        registration.health.status = isActive
          ? ServiceHealth.HEALTHY
          : ServiceHealth.DEGRADED;
        registration.health.timestamp = new Date();
        registration.health.details = {
          metrics,
          lastSuccess: new Date(),
        };
      } catch (error) {
        registration.health.status = ServiceHealth.UNHEALTHY;
        registration.health.details = {
          error: error instanceof Error ? error.message : String(error),
        };
        registration.health.timestamp = new Date();
      }
    }

    this.metrics.lastHealthCheck = new Date();
  }

  /**
   * Start performance monitoring
   */
  private startPerformanceMonitoring(): void {
    this.performanceInterval = setInterval(() => {
      this.updateMetrics();
      this.emit("performanceUpdate", this.metrics);
    }, this.config.performanceMonitoringInterval);

    console.log(
      `[ServiceManager] Performance monitoring started (interval: ${this.config.performanceMonitoringInterval}ms)`,
    );
  }

  /**
   * Update manager metrics
   */
  private updateMetrics(): void {
    this.metrics.totalServices = this.services.size;
    this.metrics.uptime = Date.now() - this.startTime;

    // Count services by state
    this.metrics.servicesByState = {
      [ServiceState.UNINITIALIZED]: 0,
      [ServiceState.INITIALIZING]: 0,
      [ServiceState.ACTIVE]: 0,
      [ServiceState.DISPOSING]: 0,
      [ServiceState.DISPOSED]: 0,
      [ServiceState.ERROR]: 0,
    };

    // Count services by health
    this.metrics.servicesByHealth = {
      [ServiceHealth.HEALTHY]: 0,
      [ServiceHealth.DEGRADED]: 0,
      [ServiceHealth.UNHEALTHY]: 0,
      [ServiceHealth.UNKNOWN]: 0,
    };

    let totalInitTime = 0;
    let initCount = 0;

    for (const registration of this.services.values()) {
      if (registration.instance) {
        const state = registration.instance.getState();
        this.metrics.servicesByState[state]++;
      }

      this.metrics.servicesByHealth[registration.health.status]++;

      if (registration.initDuration) {
        totalInitTime += registration.initDuration;
        initCount++;
      }
    }

    this.metrics.averageInitTime =
      initCount > 0 ? totalInitTime / initCount : 0;
  }

  /**
   * Load configuration
   */
  private async loadConfiguration(): Promise<void> {
    // Load from extension configuration
    const loggingConfig = this.configManager.getSection("logging");
    const pollingConfig = this.configManager.getSection("polling");

    this.config = {
      ...this.config,
      healthCheckInterval: Math.max(pollingConfig.interval * 2, 5000),
      performanceMonitoringInterval: Math.max(
        pollingConfig.interval * 3,
        10000,
      ),
      enablePerformanceMonitoring: loggingConfig.level === "debug",
    };
  }

  /**
   * Set up configuration change listeners
   */
  private setupConfigurationListeners(): void {
    const disposable = this.configManager.onConfigurationChange(
      "*",
      (newConfig, oldConfig) => {
        this.handleConfigurationChange(newConfig, oldConfig);
      },
    );

    this.disposables.push(disposable);
  }

  /**
   * Handle configuration changes
   */
  private handleConfigurationChange(
    newConfig: ExtensionConfig,
    oldConfig: ExtensionConfig,
  ): void {
    console.log("[ServiceManager] Configuration changed, updating services...");

    // Update manager configuration
    this.loadConfiguration();

    // Notify all services of configuration changes
    for (const registration of this.services.values()) {
      if (registration.instance) {
        // Services will handle their own configuration changes through BaseService
        console.log(
          `[ServiceManager] Configuration change propagated to ${registration.name}`,
        );
      }
    }

    this.emit("configurationChanged", { newConfig, oldConfig });
  }

  /**
   * Get service disposal order (reverse of initialization order)
   */
  private getServiceDisposalOrder(): string[] {
    return Array.from(this.services.values())
      .sort((a, b) => a.dependency.priority - b.dependency.priority) // Reverse order
      .map((reg) => reg.name);
  }

  /**
   * Handle manager-level errors
   */
  private handleManagerError(error: Error): void {
    console.error("[ServiceManager] Manager error:", error);
  }

  /**
   * Get default configuration
   */
  private getDefaultConfig(): ServiceManagerConfig {
    return {
      healthCheckInterval: 30000, // 30 seconds
      maxRestartAttempts: 3,
      restartDelay: 5000, // 5 seconds
      enablePerformanceMonitoring: false,
      performanceMonitoringInterval: 60000, // 1 minute
      initializationTimeout: 30000, // 30 seconds
    };
  }

  /**
   * Initialize metrics
   */
  private initializeMetrics(): ServiceManagerMetrics {
    return {
      totalServices: 0,
      servicesByState: {
        [ServiceState.UNINITIALIZED]: 0,
        [ServiceState.INITIALIZING]: 0,
        [ServiceState.ACTIVE]: 0,
        [ServiceState.DISPOSING]: 0,
        [ServiceState.DISPOSED]: 0,
        [ServiceState.ERROR]: 0,
      },
      servicesByHealth: {
        [ServiceHealth.HEALTHY]: 0,
        [ServiceHealth.DEGRADED]: 0,
        [ServiceHealth.UNHEALTHY]: 0,
        [ServiceHealth.UNKNOWN]: 0,
      },
      totalRestarts: 0,
      averageInitTime: 0,
      uptime: 0,
      lastHealthCheck: new Date(),
    };
  }
}

/**
 * Convenience function to get the service manager instance
 */
export function getServiceManager(): ServiceManager {
  return ServiceManager.getInstance();
}
