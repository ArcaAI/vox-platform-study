/**
 * @arcaai/med-ner - Utility Exports
 */

// Browser Support
export {
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
} from './browserSupport.js';

// HTML escape (XSS protection for entity rendering)
export { escapeHtml } from './htmlEscape.js';

// Token-aware chunking (TASK-272 / C-2)
export {
  chunkByTokens,
  segmentSentences,
  mergeChunkEntities,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STRIDE,
  type Tokenizer,
  type ChunkByTokensOptions,
  type TokenChunk,
  type ChunkEntities,
} from './chunking.js';

// Entity Utilities
export {
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
} from './entityUtils.js';
