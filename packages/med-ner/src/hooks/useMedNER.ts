/**
 * @arcaai/med-ner - useMedNER Hook
 *
 * React hook for Medical Named Entity Recognition.
 */

import { useState, useCallback, useEffect, useRef } from 'react';

import { MedNERProcessor } from '../processors/MedNERProcessor.js';
import type {
  MedNEROptions,
  MedNERResult,
  MedNERStats,
  EntitySpan,
  ModelLoadProgress,
  MedNERError,
} from '../types/index.js';

/**
 * Options for useMedNER hook.
 */
export interface UseMedNEROptions extends MedNEROptions {
  /** Whether to auto-initialize on mount */
  autoInit?: boolean;

  /** Callback when entities are extracted */
  onEntitiesExtracted?: (result: MedNERResult) => void;

  /** Callback when an error occurs */
  onError?: (error: MedNERError) => void;

  /** Callback for model loading progress */
  onProgress?: (progress: ModelLoadProgress) => void;
}

/**
 * Return value of useMedNER hook.
 */
export interface UseMedNERReturn {
  /** Whether the processor is ready */
  isReady: boolean;

  /** Whether the processor is currently processing */
  isProcessing: boolean;

  /** Whether the model is loading */
  isLoading: boolean;

  /** Model loading progress */
  loadProgress: ModelLoadProgress | null;

  /** Last extracted entities */
  entities: EntitySpan[];

  /** Last extraction result */
  result: MedNERResult | null;

  /** Processing statistics */
  stats: MedNERStats | null;

  /** Error if any occurred */
  error: Error | null;

  /** The processor instance */
  processor: MedNERProcessor | null;

  /** Initialize the processor (call if autoInit is false) */
  init: () => Promise<void>;

  /** Extract entities from text */
  extract: (text: string) => Promise<MedNERResult>;

  /** Extract entities from multiple texts */
  extractBatch: (texts: string[]) => Promise<MedNERResult[]>;

  /** Clear the last result and entities */
  clear: () => void;

  /** Reset statistics */
  resetStats: () => void;

  /** Update options */
  updateOptions: (options: Partial<MedNEROptions>) => void;

  /** Destroy the processor */
  destroy: () => Promise<void>;
}

/**
 * React hook for Medical Named Entity Recognition.
 *
 * Provides a simple interface for extracting medical entities from text.
 *
 * @example
 * ```tsx
 * import { useMedNER } from '@arcaai/med-ner';
 *
 * function MedicalTextAnalyzer() {
 *   const {
 *     isReady,
 *     isProcessing,
 *     entities,
 *     extract,
 *     error,
 *   } = useMedNER({
 *     model: 'biomedical',
 *     threshold: 0.6,
 *     autoInit: true,
 *     onEntitiesExtracted: (result) => {
 *       console.log('Extracted:', result.entities.length, 'entities');
 *     },
 *   });
 *
 *   const [text, setText] = useState('');
 *
 *   const handleAnalyze = async () => {
 *     if (text.trim()) {
 *       await extract(text);
 *     }
 *   };
 *
 *   return (
 *     <div>
 *       <textarea
 *         value={text}
 *         onChange={(e) => setText(e.target.value)}
 *         placeholder="Enter medical text to analyze..."
 *       />
 *       <button onClick={handleAnalyze} disabled={!isReady || isProcessing}>
 *         {isProcessing ? 'Analyzing...' : 'Analyze'}
 *       </button>
 *
 *       {error && <div className="error">{error.message}</div>}
 *
 *       {entities.length > 0 && (
 *         <ul>
 *           {entities.map((entity, i) => (
 *             <li key={i}>
 *               <strong>{entity.text}</strong> ({entity.type}) - {(entity.score * 100).toFixed(1)}%
 *             </li>
 *           ))}
 *         </ul>
 *       )}
 *     </div>
 *   );
 * }
 * ```
 */
export function useMedNER(options: UseMedNEROptions = {}): UseMedNERReturn {
  const {
    autoInit = true,
    onEntitiesExtracted,
    onError,
    onProgress,
    ...nerOptions
  } = options;

  // State
  const [isReady, setIsReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState<ModelLoadProgress | null>(null);
  const [entities, setEntities] = useState<EntitySpan[]>([]);
  const [result, setResult] = useState<MedNERResult | null>(null);
  const [stats, setStats] = useState<MedNERStats | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Refs
  const processorRef = useRef<MedNERProcessor | null>(null);
  const mountedRef = useRef(true);

  // Store callbacks in refs to avoid re-creating processor
  const callbacksRef = useRef({
    onEntitiesExtracted,
    onError,
    onProgress,
  });

  // Update callback refs
  useEffect(() => {
    callbacksRef.current = {
      onEntitiesExtracted,
      onError,
      onProgress,
    };
  }, [onEntitiesExtracted, onError, onProgress]);

  // Create processor instance
  useEffect(() => {
    if (!processorRef.current) {
      processorRef.current = new MedNERProcessor({
        ...nerOptions,
        onEntitiesExtracted: (res) => {
          if (mountedRef.current) {
            setEntities(res.entities);
            setResult(res);
            callbacksRef.current.onEntitiesExtracted?.(res);
          }
        },
        onError: (err) => {
          if (mountedRef.current) {
            setError(err);
            callbacksRef.current.onError?.(err);
          }
        },
        onProgress: (progress) => {
          if (mountedRef.current) {
            setLoadProgress(progress);
            callbacksRef.current.onProgress?.(progress);
          }
        },
      });
    }

    return () => {
      mountedRef.current = false;
      if (processorRef.current) {
        processorRef.current.destroy().catch(console.error);
        processorRef.current = null;
      }
    };
    // Only create processor once with initial options
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle data events from processor
  useEffect(() => {
    const processor = processorRef.current;
    if (!processor) return;

    const handleData = (payload: unknown) => {
      const data = payload as { type: string; data: unknown };

      if (data.type === 'ner-stats') {
        setStats(data.data as MedNERStats);
      } else if (data.type === 'ner-progress') {
        const progress = data.data as ModelLoadProgress;
        setLoadProgress(progress);
        setIsLoading(progress.status === 'downloading' || progress.status === 'loading');
        if (progress.status === 'ready') {
          setIsReady(true);
          setIsLoading(false);
        }
      }
    };

    processor.on('data', handleData);

    return () => {
      processor.off('data', handleData);
    };
  }, []);

  // Initialize processor
  const init = useCallback(async () => {
    const processor = processorRef.current;
    if (!processor || processor.isInitialized()) return;

    setIsLoading(true);
    setError(null);

    try {
      await processor.init();
      if (mountedRef.current) {
        setIsReady(true);
        setIsLoading(false);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err as Error);
        setIsLoading(false);
      }
      throw err;
    }
  }, []);

  // Auto-init on mount if enabled
  useEffect(() => {
    if (autoInit && !isReady && !isLoading) {
      init().catch(console.error);
    }
  }, [autoInit, isReady, isLoading, init]);

  // Extract entities from text
  const extract = useCallback(async (text: string): Promise<MedNERResult> => {
    const processor = processorRef.current;
    if (!processor) {
      throw new Error('Processor not available');
    }

    if (!processor.isInitialized()) {
      await init();
    }

    setIsProcessing(true);
    setError(null);

    try {
      const extractResult = await processor.extract(text);
      if (mountedRef.current) {
        setEntities(extractResult.entities);
        setResult(extractResult);
        setIsProcessing(false);
      }
      return extractResult;
    } catch (err) {
      if (mountedRef.current) {
        setError(err as Error);
        setIsProcessing(false);
      }
      throw err;
    }
  }, [init]);

  // Extract entities from multiple texts
  const extractBatch = useCallback(async (texts: string[]): Promise<MedNERResult[]> => {
    const results: MedNERResult[] = [];
    for (const text of texts) {
      results.push(await extract(text));
    }
    return results;
  }, [extract]);

  // Clear results
  const clear = useCallback(() => {
    setEntities([]);
    setResult(null);
    setError(null);
  }, []);

  // Reset stats
  const resetStats = useCallback(() => {
    processorRef.current?.resetStats();
  }, []);

  // Update options
  const updateOptions = useCallback((newOptions: Partial<MedNEROptions>) => {
    processorRef.current?.updateOptions(newOptions);
  }, []);

  // Destroy processor
  const destroy = useCallback(async () => {
    if (processorRef.current) {
      await processorRef.current.destroy();
      setIsReady(false);
    }
  }, []);

  return {
    isReady,
    isProcessing,
    isLoading,
    loadProgress,
    entities,
    result,
    stats,
    error,
    processor: processorRef.current,
    init,
    extract,
    extractBatch,
    clear,
    resetStats,
    updateOptions,
    destroy,
  };
}
