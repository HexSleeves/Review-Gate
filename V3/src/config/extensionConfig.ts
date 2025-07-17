/**
 * Configuration management for the Review Gate VS Code extension
 *
 * This module provides type-safe configuration handling with validation,
 * change listeners, and default value management for all extension settings.
 */

import * as vscode from "vscode";
import { ConfigChangeHandler, PartialConfig } from "../types";

/**
 * Interface defining the complete extension configuration schema
 */
export interface ExtensionConfig {
  /** File polling configuration */
  polling: {
    /** Polling interval in milliseconds */
    interval: number;
    /** Whether polling is enabled */
    enabled: boolean;
  };

  /** Temporary files configuration */
  tempFiles: {
    /** Location for temporary files */
    location: string;
    /** Whether to cleanup temp files on deactivation */
    cleanup: boolean;
  };

  /** Audio recording configuration */
  audio: {
    /** Sample rate in Hz */
    sampleRate: number;
    /** Bit depth for recording */
    bitDepth: number;
    /** Number of audio channels */
    channels: number;
    /** Output format */
    format: string;
    /** Maximum recording duration in seconds */
    maxDuration: number;
  };

  /** MCP server configuration */
  mcp: {
    /** Connection timeout in milliseconds */
    connectionTimeout: number;
    /** Number of retry attempts */
    retryAttempts: number;
  };

  /** Webview configuration */
  webview: {
    /** Theme preference */
    theme: "auto" | "light" | "dark";
    /** Enable developer tools */
    enableDevTools: boolean;
  };

  /** Logging configuration */
  logging: {
    /** Log level */
    level: "error" | "warn" | "info" | "debug";
    /** Enable file logging */
    enableFileLogging: boolean;
  };
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: ExtensionConfig = {
  polling: {
    interval: 1000,
    enabled: true,
  },
  tempFiles: {
    location: "${workspaceFolder}/.reviewgate/temp",
    cleanup: true,
  },
  audio: {
    sampleRate: 44100,
    bitDepth: 16,
    channels: 1,
    format: "wav",
    maxDuration: 300,
  },
  mcp: {
    connectionTimeout: 5000,
    retryAttempts: 3,
  },
  webview: {
    theme: "auto",
    enableDevTools: false,
  },
  logging: {
    level: "info",
    enableFileLogging: false,
  },
};

/**
 * Configuration validation rules
 */
const VALIDATION_RULES = {
  polling: {
    interval: { min: 100, max: 10000 },
  },
  audio: {
    sampleRate: { values: [8000, 16000, 22050, 44100, 48000] },
    bitDepth: { values: [8, 16, 24, 32] },
    channels: { values: [1, 2] },
    format: { values: ["wav", "mp3", "ogg"] },
    maxDuration: { min: 1, max: 3600 },
  },
  mcp: {
    connectionTimeout: { min: 1000, max: 30000 },
    retryAttempts: { min: 0, max: 10 },
  },
  webview: {
    theme: { values: ["auto", "light", "dark"] },
  },
  logging: {
    level: { values: ["error", "warn", "info", "debug"] },
  },
} as const;

/**
 * Configuration validation error
 */
export class ConfigValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly value: any,
    public readonly constraint: string,
  ) {
    super(
      `Configuration validation failed for '${field}': ${constraint}. Got: ${value}`,
    );
    this.name = "ConfigValidationError";
  }
}

/**
 * Main configuration manager class
 */
export class ExtensionConfigManager {
  private static instance: ExtensionConfigManager;
  private config: ExtensionConfig;
  private changeListeners: Map<string, ConfigChangeHandler[]> = new Map();
  private disposables: vscode.Disposable[] = [];

  private constructor() {
    this.config = this.loadConfiguration();
    this.setupConfigurationWatcher();
  }

  /**
   * Get the singleton instance of the configuration manager
   */
  public static getInstance(): ExtensionConfigManager {
    if (!ExtensionConfigManager.instance) {
      ExtensionConfigManager.instance = new ExtensionConfigManager();
    }
    return ExtensionConfigManager.instance;
  }

  /**
   * Get the current configuration
   */
  public getConfig(): Readonly<ExtensionConfig> {
    return { ...this.config };
  }

  /**
   * Get a specific configuration section
   */
  public getSection<K extends keyof ExtensionConfig>(
    section: K,
  ): Readonly<ExtensionConfig[K]> {
    return { ...this.config[section] };
  }

  /**
   * Get a specific configuration value with type safety
   */
  public getValue<
    K extends keyof ExtensionConfig,
    P extends keyof ExtensionConfig[K],
  >(section: K, property: P): ExtensionConfig[K][P] {
    return this.config[section][property];
  }

  /**
   * Update configuration with validation
   */
  public async updateConfig(
    updates: PartialConfig<ExtensionConfig>,
  ): Promise<void> {
    const newConfig = this.mergeConfig(this.config, updates);
    this.validateConfiguration(newConfig);

    const oldConfig = { ...this.config };
    this.config = newConfig;

    // Persist to VS Code settings
    await this.persistConfiguration(updates);

    // Notify listeners
    this.notifyConfigurationChange(newConfig, oldConfig);
  }

  /**
   * Update a specific configuration section
   */
  public async updateSection<K extends keyof ExtensionConfig>(
    section: K,
    updates: Partial<ExtensionConfig[K]>,
  ): Promise<void> {
    await this.updateConfig({
      [section]: updates,
    } as PartialConfig<ExtensionConfig>);
  }

  /**
   * Reset configuration to defaults
   */
  public async resetToDefaults(): Promise<void> {
    await this.updateConfig(DEFAULT_CONFIG);
  }

  /**
   * Add a configuration change listener
   */
  public onConfigurationChange(
    section: keyof ExtensionConfig | "*",
    handler: ConfigChangeHandler,
  ): vscode.Disposable {
    const key = section.toString();
    if (!this.changeListeners.has(key)) {
      this.changeListeners.set(key, []);
    }
    this.changeListeners.get(key)!.push(handler);

    return new vscode.Disposable(() => {
      const handlers = this.changeListeners.get(key);
      if (handlers) {
        const index = handlers.indexOf(handler);
        if (index !== -1) {
          handlers.splice(index, 1);
        }
      }
    });
  }

  /**
   * Validate the entire configuration
   */
  public validateConfiguration(config: ExtensionConfig): void {
    this.validatePollingConfig(config.polling);
    this.validateAudioConfig(config.audio);
    this.validateMcpConfig(config.mcp);
    this.validateWebviewConfig(config.webview);
    this.validateLoggingConfig(config.logging);
  }

  /**
   * Dispose of all resources
   */
  public dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.changeListeners.clear();
  }

  /**
   * Load configuration from VS Code settings
   */
  private loadConfiguration(): ExtensionConfig {
    const vsConfig = vscode.workspace.getConfiguration("reviewgate");

    const config: ExtensionConfig = {
      polling: {
        interval: vsConfig.get(
          "polling.interval",
          DEFAULT_CONFIG.polling.interval,
        ),
        enabled: vsConfig.get(
          "polling.enabled",
          DEFAULT_CONFIG.polling.enabled,
        ),
      },
      tempFiles: {
        location: vsConfig.get(
          "tempFiles.location",
          DEFAULT_CONFIG.tempFiles.location,
        ),
        cleanup: vsConfig.get(
          "tempFiles.cleanup",
          DEFAULT_CONFIG.tempFiles.cleanup,
        ),
      },
      audio: {
        sampleRate: vsConfig.get(
          "audio.sampleRate",
          DEFAULT_CONFIG.audio.sampleRate,
        ),
        bitDepth: vsConfig.get("audio.bitDepth", DEFAULT_CONFIG.audio.bitDepth),
        channels: vsConfig.get("audio.channels", DEFAULT_CONFIG.audio.channels),
        format: vsConfig.get("audio.format", DEFAULT_CONFIG.audio.format),
        maxDuration: vsConfig.get(
          "audio.maxDuration",
          DEFAULT_CONFIG.audio.maxDuration,
        ),
      },
      mcp: {
        connectionTimeout: vsConfig.get(
          "mcp.connectionTimeout",
          DEFAULT_CONFIG.mcp.connectionTimeout,
        ),
        retryAttempts: vsConfig.get(
          "mcp.retryAttempts",
          DEFAULT_CONFIG.mcp.retryAttempts,
        ),
      },
      webview: {
        theme: vsConfig.get("webview.theme", DEFAULT_CONFIG.webview.theme),
        enableDevTools: vsConfig.get(
          "webview.enableDevTools",
          DEFAULT_CONFIG.webview.enableDevTools,
        ),
      },
      logging: {
        level: vsConfig.get("logging.level", DEFAULT_CONFIG.logging.level),
        enableFileLogging: vsConfig.get(
          "logging.enableFileLogging",
          DEFAULT_CONFIG.logging.enableFileLogging,
        ),
      },
    };

    this.validateConfiguration(config);
    return config;
  }

  /**
   * Setup VS Code configuration change watcher
   */
  private setupConfigurationWatcher(): void {
    const disposable = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("reviewgate")) {
        const oldConfig = { ...this.config };
        this.config = this.loadConfiguration();
        this.notifyConfigurationChange(this.config, oldConfig);
      }
    });

    this.disposables.push(disposable);
  }

  /**
   * Persist configuration changes to VS Code settings
   */
  private async persistConfiguration(
    updates: PartialConfig<ExtensionConfig>,
  ): Promise<void> {
    const vsConfig = vscode.workspace.getConfiguration("reviewgate");

    for (const [section, sectionUpdates] of Object.entries(updates)) {
      if (sectionUpdates && typeof sectionUpdates === "object") {
        for (const [key, value] of Object.entries(sectionUpdates)) {
          await vsConfig.update(
            `${section}.${key}`,
            value,
            vscode.ConfigurationTarget.Global,
          );
        }
      }
    }
  }

  /**
   * Merge configuration objects deeply
   */
  private mergeConfig(
    base: ExtensionConfig,
    updates: PartialConfig<ExtensionConfig>,
  ): ExtensionConfig {
    const result = { ...base };

    for (const [key, value] of Object.entries(updates)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        result[key as keyof ExtensionConfig] = {
          ...result[key as keyof ExtensionConfig],
          ...value,
        } as any;
      } else if (value !== undefined) {
        (result as any)[key] = value;
      }
    }

    return result;
  }

  /**
   * Notify configuration change listeners
   */
  private notifyConfigurationChange(
    newConfig: ExtensionConfig,
    oldConfig: ExtensionConfig,
  ): void {
    // Notify global listeners
    const globalListeners = this.changeListeners.get("*") || [];
    globalListeners.forEach((handler) => {
      try {
        handler(newConfig, oldConfig);
      } catch (error) {
        console.error("Error in configuration change handler:", error);
      }
    });

    // Notify section-specific listeners
    for (const section of Object.keys(newConfig) as Array<
      keyof ExtensionConfig
    >) {
      if (
        JSON.stringify(newConfig[section]) !==
        JSON.stringify(oldConfig[section])
      ) {
        const sectionListeners = this.changeListeners.get(section) || [];
        sectionListeners.forEach((handler) => {
          try {
            handler(newConfig[section], oldConfig[section]);
          } catch (error) {
            console.error(
              `Error in ${section} configuration change handler:`,
              error,
            );
          }
        });
      }
    }
  }

  /**
   * Validate polling configuration
   */
  private validatePollingConfig(config: ExtensionConfig["polling"]): void {
    const { interval } = config;
    const rules = VALIDATION_RULES.polling;

    if (interval < rules.interval.min || interval > rules.interval.max) {
      throw new ConfigValidationError(
        "polling.interval",
        interval,
        `must be between ${rules.interval.min} and ${rules.interval.max}`,
      );
    }
  }

  /**
   * Validate audio configuration
   */
  private validateAudioConfig(config: ExtensionConfig["audio"]): void {
    const rules = VALIDATION_RULES.audio;

    if (
      !(rules.sampleRate.values as readonly number[]).includes(
        config.sampleRate,
      )
    ) {
      throw new ConfigValidationError(
        "audio.sampleRate",
        config.sampleRate,
        `must be one of: ${rules.sampleRate.values.join(", ")}`,
      );
    }

    if (
      !(rules.bitDepth.values as readonly number[]).includes(config.bitDepth)
    ) {
      throw new ConfigValidationError(
        "audio.bitDepth",
        config.bitDepth,
        `must be one of: ${rules.bitDepth.values.join(", ")}`,
      );
    }

    if (
      !(rules.channels.values as readonly number[]).includes(config.channels)
    ) {
      throw new ConfigValidationError(
        "audio.channels",
        config.channels,
        `must be one of: ${rules.channels.values.join(", ")}`,
      );
    }

    if (!(rules.format.values as readonly string[]).includes(config.format)) {
      throw new ConfigValidationError(
        "audio.format",
        config.format,
        `must be one of: ${rules.format.values.join(", ")}`,
      );
    }

    if (
      config.maxDuration < rules.maxDuration.min ||
      config.maxDuration > rules.maxDuration.max
    ) {
      throw new ConfigValidationError(
        "audio.maxDuration",
        config.maxDuration,
        `must be between ${rules.maxDuration.min} and ${rules.maxDuration.max}`,
      );
    }
  }

  /**
   * Validate MCP configuration
   */
  private validateMcpConfig(config: ExtensionConfig["mcp"]): void {
    const rules = VALIDATION_RULES.mcp;

    if (
      config.connectionTimeout < rules.connectionTimeout.min ||
      config.connectionTimeout > rules.connectionTimeout.max
    ) {
      throw new ConfigValidationError(
        "mcp.connectionTimeout",
        config.connectionTimeout,
        `must be between ${rules.connectionTimeout.min} and ${rules.connectionTimeout.max}`,
      );
    }

    if (
      config.retryAttempts < rules.retryAttempts.min ||
      config.retryAttempts > rules.retryAttempts.max
    ) {
      throw new ConfigValidationError(
        "mcp.retryAttempts",
        config.retryAttempts,
        `must be between ${rules.retryAttempts.min} and ${rules.retryAttempts.max}`,
      );
    }
  }

  /**
   * Validate webview configuration
   */
  private validateWebviewConfig(config: ExtensionConfig["webview"]): void {
    const rules = VALIDATION_RULES.webview;

    if (!(rules.theme.values as readonly string[]).includes(config.theme)) {
      throw new ConfigValidationError(
        "webview.theme",
        config.theme,
        `must be one of: ${rules.theme.values.join(", ")}`,
      );
    }
  }

  /**
   * Validate logging configuration
   */
  private validateLoggingConfig(config: ExtensionConfig["logging"]): void {
    const rules = VALIDATION_RULES.logging;

    if (!(rules.level.values as readonly string[]).includes(config.level)) {
      throw new ConfigValidationError(
        "logging.level",
        config.level,
        `must be one of: ${rules.level.values.join(", ")}`,
      );
    }
  }
}

/**
 * Convenience function to get the configuration manager instance
 */
export function getConfigManager(): ExtensionConfigManager {
  return ExtensionConfigManager.getInstance();
}

/**
 * Convenience function to get the current configuration
 */
export function getConfig(): Readonly<ExtensionConfig> {
  return getConfigManager().getConfig();
}

/**
 * Convenience function to get a configuration section
 */
export function getConfigSection<K extends keyof ExtensionConfig>(
  section: K,
): Readonly<ExtensionConfig[K]> {
  return getConfigManager().getSection(section);
}

/**
 * Convenience function to update configuration
 */
export function updateConfig(
  updates: PartialConfig<ExtensionConfig>,
): Promise<void> {
  return getConfigManager().updateConfig(updates);
}
