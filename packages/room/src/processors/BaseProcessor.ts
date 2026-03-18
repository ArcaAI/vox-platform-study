/**
 * @arcaai/room - BaseProcessor
 *
 * Abstract base class for implementing audio processors.
 * Provides common functionality and a template for processor implementations.
 */

import { TypedEventEmitter } from '../events/EventEmitter.js';
import { ProcessorEvent, type ProcessorEventMap } from '../events/ProcessorEvents.js';
import { ProcessorStatus, type AudioProcessorOptions } from './types.js';

/**
 * Abstract base class for audio processors.
 *
 * Extend this class to create custom processors. It provides:
 * - Event emission capabilities
 * - Status tracking
 * - Common lifecycle methods
 *
 * @example
 * ```typescript
 * class MyProcessor extends BaseProcessor {
 *   constructor() {
 *     super('my-processor');
 *   }
 *
 *   protected async onInit(opts: AudioProcessorOptions): Promise<void> {
 *     // Set up audio processing
 *     // Create this.processedTrack using Web Audio API
 *   }
 *
 *   protected async onDestroy(): Promise<void> {
 *     // Cleanup resources
 *   }
 * }
 * ```
 */
export abstract class BaseProcessor extends TypedEventEmitter<ProcessorEventMap> {
  readonly name: string;
  processedTrack?: MediaStreamTrack | undefined;

  protected status: ProcessorStatus = ProcessorStatus.IDLE;
  protected audioContext: AudioContext | null = null;
  protected sourceTrack: MediaStreamTrack | null = null;
  protected _enabled = true;
  protected debugMode: boolean;

  constructor(name: string, debugMode?: boolean) {
    super();
    this.name = name;
    this.debugMode = debugMode ?? false;
  }

  /**
   * Get the current processor status.
   */
  getStatus(): ProcessorStatus {
    return this.status;
  }

  /**
   * Check if the processor is enabled.
   */
  isEnabled(): boolean {
    return this._enabled;
  }

  /**
   * Update the debug mode flag at runtime.
   */
  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
  }

  /**
   * Check if this processor is supported in the current browser.
   * Override in subclass to implement browser-specific checks.
   */
  isSupported(): boolean {
    return true;
  }

  /**
   * Initialize the processor.
   */
  async init(opts: AudioProcessorOptions): Promise<void> {
    if (this.status !== ProcessorStatus.IDLE && this.status !== ProcessorStatus.DESTROYED) {
      throw new Error(`Cannot initialize processor in state: ${this.status}`);
    }

    this.status = ProcessorStatus.INITIALIZING;
    this.audioContext = opts.audioContext;
    this.sourceTrack = opts.track;

    try {
      await this.onInit(opts);
      this.status = ProcessorStatus.READY;
      this.emit(ProcessorEvent.Ready);

      if (this._enabled) {
        this.status = ProcessorStatus.ENABLED;
        this.emit(ProcessorEvent.Enabled);
      }
    } catch (error) {
      this.status = ProcessorStatus.ERROR;
      this.emit(ProcessorEvent.Error, {
        error: error instanceof Error ? error : new Error(String(error)),
        recoverable: false,
      });
      throw error;
    }
  }

  /**
   * Restart the processor with new options.
   */
  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    this.status = ProcessorStatus.IDLE;
    await this.init(opts);
  }

  /**
   * Destroy the processor and release resources.
   */
  async destroy(): Promise<void> {
    if (this.status === ProcessorStatus.DESTROYED) {
      return;
    }

    try {
      await this.onDestroy();
    } finally {
      if (this.processedTrack) {
        this.processedTrack.stop();
        this.processedTrack = undefined;
      }

      this.audioContext = null;
      this.sourceTrack = null;
      this.status = ProcessorStatus.DESTROYED;
      this.emit(ProcessorEvent.Destroyed);
    }
  }

  /**
   * Enable the processor.
   */
  async enable(): Promise<void> {
    if (this._enabled) return;

    this._enabled = true;
    await this.onEnable();
    this.status = ProcessorStatus.ENABLED;
    this.emit(ProcessorEvent.Enabled);
  }

  /**
   * Disable the processor.
   */
  async disable(): Promise<void> {
    if (!this._enabled) return;

    this._enabled = false;
    await this.onDisable();
    this.status = ProcessorStatus.DISABLED;
    this.emit(ProcessorEvent.Disabled);
  }

  /**
   * Called when attached to a track.
   */
  async onAttach(): Promise<void> {
    // Override in subclass if needed
  }

  /**
   * Called when detached from a track.
   */
  async onDetach(): Promise<void> {
    // Override in subclass if needed
  }

  // =========================================================================
  // Abstract/Override Methods
  // =========================================================================

  /**
   * Initialize processor-specific resources.
   * Must be implemented by subclasses.
   *
   * @param opts - Initialization options
   */
  protected abstract onInit(opts: AudioProcessorOptions): Promise<void>;

  /**
   * Cleanup processor-specific resources.
   * Must be implemented by subclasses.
   */
  protected abstract onDestroy(): Promise<void>;

  /**
   * Called when the processor is enabled.
   * Override to implement enable behavior.
   */
  protected async onEnable(): Promise<void> {
    // Override in subclass
  }

  /**
   * Called when the processor is disabled.
   * Override to implement disable behavior.
   */
  protected async onDisable(): Promise<void> {
    // Override in subclass
  }

  // =========================================================================
  // Helper Methods
  // =========================================================================

  /**
   * Create a processed track from an audio node.
   *
   * @param audioNode - The audio node to create a track from
   * @returns MediaStreamTrack
   */
  protected createProcessedTrack(audioNode: AudioNode): MediaStreamTrack {
    if (!this.audioContext) {
      throw new Error('AudioContext not available');
    }

    const destination = this.audioContext.createMediaStreamDestination();
    audioNode.connect(destination);

    const track = destination.stream.getAudioTracks()[0];
    if (!track) {
      throw new Error('Failed to create processed track');
    }

    return track;
  }

  /**
   * Create a source node from the source track.
   *
   * @returns MediaStreamAudioSourceNode
   */
  protected createSourceNode(): MediaStreamAudioSourceNode {
    if (!this.audioContext || !this.sourceTrack) {
      throw new Error('AudioContext or source track not available');
    }

    const stream = new MediaStream([this.sourceTrack]);
    return this.audioContext.createMediaStreamSource(stream);
  }

  /**
   * Emit a data event with typed payload.
   *
   * @param type - The data type
   * @param data - The data payload
   */
  protected emitData<T>(type: string, data: T): void {
    this.emit(ProcessorEvent.Data, {
      type,
      data,
      timestamp: Date.now(),
    });
  }
}
