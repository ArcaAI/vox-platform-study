/**
 * @arcaai/room - useProcessors Hook
 *
 * Hook for managing track processors.
 */

import { useState, useCallback, useEffect } from 'react';
import { AudioTrack } from '../core/AudioTrack.js';
import { ProcessorPipeline } from '../core/ProcessorPipeline.js';
import { TrackEvent } from '../events/TrackEvents.js';
import type { TrackProcessor, ProcessorConfig } from '../processors/types.js';

/**
 * Options for useProcessors hook.
 */
export interface UseProcessorsOptions {
  /** The track to manage processors for */
  track: AudioTrack | null;
  /** Initial processors to add */
  initialProcessors?: TrackProcessor[];
  /** Whether to use a pipeline (allows multiple processors) */
  usePipeline?: boolean;
}

/**
 * Return value of useProcessors hook.
 */
export interface UseProcessorsReturn {
  /** Current processor or pipeline */
  processor: TrackProcessor | ProcessorPipeline | null;
  /** All processors (from pipeline if using pipeline mode) */
  processors: ReadonlyArray<ProcessorConfig>;
  /** Whether any processor is attached */
  hasProcessor: boolean;
  /** Add a processor */
  addProcessor: (processor: TrackProcessor, options?: { priority?: number; enabled?: boolean }) => Promise<void>;
  /** Remove a processor */
  removeProcessor: (processorOrName: TrackProcessor | string) => Promise<void>;
  /** Set processor enabled state */
  setProcessorEnabled: (name: string, enabled: boolean) => Promise<void>;
  /** Clear all processors */
  clearProcessors: () => Promise<void>;
}

/**
 * Hook for managing track processors.
 *
 * Supports both single processor mode and pipeline mode for multiple processors.
 *
 * @example
 * ```tsx
 * function AudioProcessor() {
 *   const { track } = useAudioTrack({ autoStart: true });
 *   const {
 *     processors,
 *     addProcessor,
 *     removeProcessor,
 *     setProcessorEnabled,
 *   } = useProcessors({ track, usePipeline: true });
 *
 *   const handleAddVAD = async () => {
 *     const vadProcessor = createVADProcessor();
 *     await addProcessor(vadProcessor, { priority: 10 });
 *   };
 *
 *   return (
 *     <div>
 *       <button onClick={handleAddVAD}>Add VAD</button>
 *       <ul>
 *         {processors.map((p) => (
 *           <li key={p.processor.name}>
 *             {p.processor.name} - {p.enabled ? 'enabled' : 'disabled'}
 *           </li>
 *         ))}
 *       </ul>
 *     </div>
 *   );
 * }
 * ```
 */
export function useProcessors(options: UseProcessorsOptions): UseProcessorsReturn {
  const { track, initialProcessors, usePipeline = false } = options;

  const [processor, setProcessor] = useState<TrackProcessor | ProcessorPipeline | null>(null);
  const [processors, setProcessors] = useState<ReadonlyArray<ProcessorConfig>>([]);

  // Initialize pipeline if needed
  useEffect(() => {
    if (usePipeline && track && !processor) {
      const pipeline = new ProcessorPipeline(initialProcessors);
      setProcessor(pipeline);
    }
  }, [usePipeline, track, processor, initialProcessors]);

  // Sync processor state with track
  useEffect(() => {
    if (!track) return;

    const updateProcessor = () => {
      const currentProcessor = track.getProcessor();
      if (currentProcessor !== processor) {
        setProcessor(currentProcessor);
      }

      if (currentProcessor instanceof ProcessorPipeline) {
        setProcessors(currentProcessor.getProcessors());
      } else if (currentProcessor) {
        setProcessors([{ processor: currentProcessor, enabled: true, priority: 0 }]);
      } else {
        setProcessors([]);
      }
    };

    track.on(TrackEvent.ProcessorUpdate, updateProcessor);
    updateProcessor();

    return () => {
      track.off(TrackEvent.ProcessorUpdate, updateProcessor);
    };
  }, [track, processor]);

  // Add processor
  const addProcessor = useCallback(
    async (newProcessor: TrackProcessor, processorOptions?: { priority?: number; enabled?: boolean }) => {
      if (!track) return;

      if (usePipeline) {
        // Get or create pipeline
        let pipeline = processor as ProcessorPipeline | null;
        if (!pipeline) {
          pipeline = new ProcessorPipeline();
          setProcessor(pipeline);
        }

        pipeline.add(newProcessor, processorOptions);

        // Attach pipeline to track if not already attached
        if (track.getProcessor() !== pipeline) {
          await track.setProcessor(pipeline);
        }

        setProcessors(pipeline.getProcessors());
      } else {
        // Single processor mode - replace existing
        await track.setProcessor(newProcessor);
        setProcessor(newProcessor);
        setProcessors([{ processor: newProcessor, enabled: true, priority: 0 }]);
      }
    },
    [track, processor, usePipeline],
  );

  // Remove processor
  const removeProcessor = useCallback(
    async (processorOrName: TrackProcessor | string) => {
      if (!track) return;

      if (usePipeline && processor instanceof ProcessorPipeline) {
        await processor.remove(processorOrName);
        setProcessors(processor.getProcessors());
      } else {
        await track.stopProcessor();
        setProcessor(null);
        setProcessors([]);
      }
    },
    [track, processor, usePipeline],
  );

  // Set processor enabled
  const setProcessorEnabled = useCallback(
    async (name: string, enabled: boolean) => {
      if (processor instanceof ProcessorPipeline) {
        await processor.setEnabled(name, enabled);
        setProcessors(processor.getProcessors());
      }
    },
    [processor],
  );

  // Clear all processors
  const clearProcessors = useCallback(async () => {
    if (!track) return;

    await track.stopProcessor();
    setProcessor(null);
    setProcessors([]);
  }, [track]);

  return {
    processor,
    processors,
    hasProcessor: processor !== null,
    addProcessor,
    removeProcessor,
    setProcessorEnabled,
    clearProcessors,
  };
}
