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
  isMedNERSupported,
  getMedNERBrowserSupport,
  logBrowserSupport,
} from './browserSupport.js';

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
