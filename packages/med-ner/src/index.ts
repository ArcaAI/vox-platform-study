/**
 * @arcaai/med-ner
 *
 * Medical Named Entity Recognition plugin using Transformers.js.
 * Extracts medical entities from text including diseases, medications,
 * procedures, anatomy, lab values, and symptoms.
 *
 * @example
 * ```tsx
 * import { createMedNER, useMedNER, MedicalEntityType } from '@arcaai/med-ner';
 *
 * // Using the processor directly
 * const ner = createMedNER({
 *   model: 'biomedical',
 *   threshold: 0.6,
 * });
 *
 * await ner.init();
 * const result = await ner.extract(
 *   'Patient diagnosed with Type 2 Diabetes, prescribed Metformin 500mg twice daily.'
 * );
 *
 * console.log(result.entities);
 * // [
 * //   { text: 'Type 2 Diabetes', type: 'DISEASE', score: 0.95 },
 * //   { text: 'Metformin', type: 'MEDICATION', score: 0.92 },
 * //   { text: '500mg', type: 'DOSAGE', score: 0.88 },
 * // ]
 *
 * // Using the React hook
 * function MedicalAnalyzer() {
 *   const { isReady, entities, extract } = useMedNER({
 *     model: 'biomedical',
 *     autoInit: true,
 *   });
 *
 *   return (
 *     <button
 *       onClick={() => extract('Patient has hypertension and takes Lisinopril.')}
 *       disabled={!isReady}
 *     >
 *       Analyze
 *     </button>
 *   );
 * }
 * ```
 *
 * @packageDocumentation
 */

// ============================================================================
// Types
// ============================================================================

export {
  // Medical Entity Types
  MedicalEntityType,
  LABEL_TO_ENTITY_TYPE,

  // Entity Span
  type EntitySpan,
  type RawTokenResult,

  // Model Types
  type MedNERModel,
  type ModelReference,
  type MedNERDevice,
  MODEL_MAP,

  // Options
  type MedNEROptions,
  type MedNEROptionsWithCallbacks,
  DEFAULT_MED_NER_OPTIONS,

  // Results
  type MedNERResult,
  type ModelLoadProgress,

  // Statistics
  type MedNERStats,

  // Event Payloads
  type NERExtractionPayload,
  type NERStatsPayload,
  type NERProgressPayload,
  type NERDataEventType,

  // Browser Support
  type MedNERBrowserSupport,

  // Errors
  MedNERErrorCode,
  MedNERError,

  // Callbacks
  type OnEntitiesExtractedCallback,
  type OnNERErrorCallback,
  type OnProgressCallback,
} from './types/index.js';

// ============================================================================
// Processors
// ============================================================================

export { MedNERProcessor, createMedNER } from './processors/index.js';

// ============================================================================
// React Hooks
// ============================================================================

export { useMedNER, type UseMedNEROptions, type UseMedNERReturn } from './hooks/index.js';

// ============================================================================
// Worker (off-main-thread inference)
// ============================================================================

export {
  MedNERWorkerClient,
  type WorkerLike,
  type MedNERWorkerInitPayload,
  type MedNERWorkerExtractPayload,
  type MedNERWorkerInitResult,
  type MedNERWorkerExtractResult,
} from './workers/index.js';

// ============================================================================
// Utilities
// ============================================================================

export {
  // Browser Support
  isBrowser,
  isWebAssemblySupported,
  isIndexedDBSupported,
  isFetchSupported,
  isSafari,
  getSafariVersion,
  isIOS,
  getDeviceMemory,
  getHardwareConcurrency,
  getRecommendedDtype,
  isWebGPUSupported,
  getRecommendedDevice,
  isMedNERSupported,
  getMedNERBrowserSupport,
  logBrowserSupport,

  // HTML escape (XSS protection)
  escapeHtml,

  // Token-aware chunking
  chunkByTokens,
  segmentSentences,
  mergeChunkEntities,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STRIDE,
  type Tokenizer,
  type ChunkByTokensOptions,
  type TokenChunk,
  type ChunkEntities,

  // Entity Utilities
  filterEntitiesByThreshold,
  filterEntitiesByType,
  areEntitiesAdjacent,
  mergeAdjacentEntities,
  doEntitiesOverlap,
  mergeOverlappingEntities,
  groupEntitiesByType,
  getUniqueEntitiesByType,
  sortEntitiesByScore,
  sortEntitiesByPosition,
  getTopEntities,
  highlightEntities,
  entitiesToJSON,
  countEntitiesByType,
  getAverageConfidence,
  findEntitiesContaining,
  deduplicateEntities,
} from './utils/index.js';
