/**
 * @arcaai/room - ProcessorPipeline
 *
 * Allows chaining multiple processors together.
 * Each processor in the pipeline receives the output of the previous processor.
 */

import type {
  TrackProcessor,
  AudioProcessorOptions,
  ProcessorConfig,
} from '../processors/types.js';

/**
 * ProcessorPipeline allows chaining multiple audio processors.
 *
 * Processors are executed in priority order (lower priority = earlier in chain).
 * Each processor receives the processed track from the previous processor.
 *
 * @example
 * ```typescript
 * const pipeline = new ProcessorPipeline();
 *
 * // Add processors with priority
 * pipeline.add(vadProcessor, { priority: 10 });
 * pipeline.add(noiseFilterProcessor, { priority: 5 }); // Runs first
 * pipeline.add(transcriptionProcessor, { priority: 20 }); // Runs last
 *
 * // Attach to track
 * await audioTrack.setProcessor(pipeline);
 *
 * // Enable/disable individual processors
 * pipeline.setEnabled('vad-processor', false);
 * ```
 */
export class ProcessorPipeline implements TrackProcessor<AudioProcessorOptions> {
  readonly name = 'processor-pipeline';

  processedTrack?: MediaStreamTrack | undefined;

  private processors: ProcessorConfig[] = [];
  private initialized = false;
  private currentOptions: AudioProcessorOptions | null = null;

  /**
   * Create a new ProcessorPipeline.
   *
   * @param processors - Optional initial processors to add
   */
  constructor(
    processors?: Array<TrackProcessor | { processor: TrackProcessor; priority?: number }>
  ) {
    if (processors) {
      processors.forEach((p, index) => {
        if ('processor' in p) {
          this.add(p.processor, { priority: p.priority ?? index * 10 });
        } else {
          this.add(p, { priority: index * 10 });
        }
      });
    }
  }

  /**
   * Add a processor to the pipeline.
   *
   * @param processor - The processor to add
   * @param options - Options for the processor
   */
  add(
    processor: TrackProcessor,
    options: { priority?: number; enabled?: boolean } = {}
  ): void {
    const config: ProcessorConfig = {
      processor,
      enabled: options.enabled ?? true,
      priority: options.priority ?? this.processors.length * 10,
    };

    this.processors.push(config);
    this.sortProcessors();
  }

  /**
   * Remove a processor from the pipeline.
   *
   * @param processorOrName - The processor instance or name to remove
   */
  async remove(processorOrName: TrackProcessor | string): Promise<void> {
    const name =
      typeof processorOrName === 'string'
        ? processorOrName
        : processorOrName.name;

    const index = this.processors.findIndex((p) => p.processor.name === name);
    if (index === -1) return;

    const config = this.processors[index]!;
    this.processors.splice(index, 1);

    // Destroy the removed processor
    await config.processor.destroy();

    // Rebuild pipeline if initialized
    if (this.initialized && this.currentOptions) {
      await this.rebuildPipeline();
    }
  }

  /**
   * Enable or disable a processor in the pipeline.
   *
   * @param processorName - Name of the processor
   * @param enabled - Whether to enable or disable
   */
  async setEnabled(processorName: string, enabled: boolean): Promise<void> {
    const config = this.processors.find((p) => p.processor.name === processorName);
    if (!config || config.enabled === enabled) return;

    config.enabled = enabled;

    // Rebuild pipeline if initialized
    if (this.initialized && this.currentOptions) {
      await this.rebuildPipeline();
    }
  }

  /**
   * Check if a processor is enabled.
   */
  isProcessorEnabled(processorName: string): boolean {
    const config = this.processors.find((p) => p.processor.name === processorName);
    return config?.enabled ?? false;
  }

  /**
   * Get all processors in the pipeline.
   */
  getProcessors(): ReadonlyArray<ProcessorConfig> {
    return this.processors;
  }

  /**
   * Get enabled processors in execution order.
   */
  getEnabledProcessors(): TrackProcessor[] {
    return this.processors
      .filter((p) => p.enabled)
      .map((p) => p.processor);
  }

  /**
   * Initialize the pipeline.
   */
  async init(opts: AudioProcessorOptions): Promise<void> {
    this.currentOptions = opts;
    await this.buildPipeline(opts);
    this.initialized = true;
  }

  /**
   * Restart the pipeline with new options.
   */
  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroyAllProcessors();
    await this.init(opts);
  }

  /**
   * Destroy the pipeline and all processors.
   */
  async destroy(): Promise<void> {
    await this.destroyAllProcessors();
    this.processedTrack = undefined;
    this.initialized = false;
    this.currentOptions = null;
  }

  /**
   * Build the processor pipeline.
   */
  private async buildPipeline(opts: AudioProcessorOptions): Promise<void> {
    const enabledProcessors = this.getEnabledProcessors();

    if (enabledProcessors.length === 0) {
      // No processors, pass through the original track
      this.processedTrack = opts.track;
      return;
    }

    let currentTrack = opts.track;

    // Initialize each processor in order
    for (const processor of enabledProcessors) {
      const processorOpts: AudioProcessorOptions = {
        ...opts,
        track: currentTrack,
      };

      await processor.init(processorOpts);

      // Use the processor's output for the next processor
      if (processor.processedTrack) {
        currentTrack = processor.processedTrack;
      }
    }

    // The final processed track is the output of the last processor
    this.processedTrack = currentTrack;
  }

  /**
   * Rebuild the pipeline (used when processors are added/removed/enabled/disabled).
   */
  private async rebuildPipeline(): Promise<void> {
    if (!this.currentOptions) return;

    // Destroy all processors
    await this.destroyAllProcessors();

    // Rebuild with the original source track
    await this.buildPipeline(this.currentOptions);
  }

  /**
   * Destroy all processor instances.
   */
  private async destroyAllProcessors(): Promise<void> {
    for (const config of this.processors) {
      try {
        await config.processor.destroy();
      } catch (error) {
        console.warn(
          `Failed to destroy processor ${config.processor.name}:`,
          error
        );
      }
    }
  }

  /**
   * Sort processors by priority.
   */
  private sortProcessors(): void {
    this.processors.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Called when attached to a track.
   */
  async onAttach(): Promise<void> {
    for (const config of this.processors) {
      if (config.enabled && config.processor.onAttach) {
        await config.processor.onAttach();
      }
    }
  }

  /**
   * Called when detached from a track.
   */
  async onDetach(): Promise<void> {
    for (const config of this.processors) {
      if (config.processor.onDetach) {
        await config.processor.onDetach();
      }
    }
  }
}
