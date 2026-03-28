/**
 * @arcaai/med-ner - Entity Utilities
 *
 * Utilities for processing and manipulating extracted medical entities.
 */

import type { EntitySpan } from '../types/index.js';
import { MedicalEntityType } from '../types/index.js';

/**
 * Filter entities by confidence threshold.
 *
 * @param entities - Array of entities to filter
 * @param threshold - Minimum confidence score (0-1)
 * @returns Filtered entities
 */
export function filterEntitiesByThreshold(entities: EntitySpan[], threshold: number): EntitySpan[] {
  return entities.filter((entity) => entity.score >= threshold);
}

/**
 * Filter entities by specific types.
 *
 * @param entities - Array of entities to filter
 * @param types - Array of allowed entity types
 * @returns Filtered entities
 */
export function filterEntitiesByType(entities: EntitySpan[], types: MedicalEntityType[]): EntitySpan[] {
  const typeSet = new Set(types);
  return entities.filter((entity) => typeSet.has(entity.type));
}

/**
 * Check if two entities are adjacent (for B-I-O tag merging).
 *
 * @param prev - Previous entity
 * @param curr - Current entity
 * @param maxGap - Maximum character gap between entities (default: 2)
 * @returns Whether entities are adjacent
 */
export function areEntitiesAdjacent(prev: EntitySpan, curr: EntitySpan, maxGap = 2): boolean {
  // Must be the same type
  if (prev.type !== curr.type) return false;

  // Check if current entity starts near where previous ended
  const gap = curr.start - prev.end;
  return gap >= 0 && gap <= maxGap;
}

/**
 * Merge adjacent entities of the same type.
 * This handles B-I-O tagging where entities are split into tokens.
 *
 * @param entities - Array of entities (sorted by position)
 * @param originalText - Original text for extracting merged text
 * @returns Merged entities
 */
export function mergeAdjacentEntities(entities: EntitySpan[], originalText: string): EntitySpan[] {
  if (entities.length === 0) return [];

  // Sort by start position
  const sorted = [...entities].sort((a, b) => a.start - b.start);
  const merged: EntitySpan[] = [];
  let current: EntitySpan | null = null;

  for (const entity of sorted) {
    if (!current) {
      current = { ...entity };
      continue;
    }

    // Check if this entity should be merged with current
    if (areEntitiesAdjacent(current, entity)) {
      // Extend current entity
      current.end = entity.end;
      current.text = originalText.slice(current.start, current.end);
      // Average the scores
      current.score = (current.score + entity.score) / 2;
      // Keep the first raw label
    } else {
      // Save current and start new
      merged.push(current);
      current = { ...entity };
    }
  }

  // Don't forget the last one
  if (current) {
    merged.push(current);
  }

  return merged;
}

/**
 * Check if two entities overlap.
 *
 * @param a - First entity
 * @param b - Second entity
 * @returns Whether entities overlap
 */
export function doEntitiesOverlap(a: EntitySpan, b: EntitySpan): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Merge overlapping entities, keeping the one with highest score.
 *
 * @param entities - Array of entities
 * @returns Entities with overlaps resolved
 */
export function mergeOverlappingEntities(entities: EntitySpan[]): EntitySpan[] {
  if (entities.length === 0) return [];

  // Sort by start position, then by length (longer first)
  const sorted = [...entities].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - b.start - (a.end - a.start);
  });

  const result: EntitySpan[] = [];

  for (const entity of sorted) {
    // Check if this entity overlaps with any in result
    let hasOverlap = false;
    for (let i = 0; i < result.length; i++) {
      if (doEntitiesOverlap(result[i], entity)) {
        hasOverlap = true;
        // Keep the one with higher score
        if (entity.score > result[i].score) {
          result[i] = entity;
        }
        break;
      }
    }

    if (!hasOverlap) {
      result.push(entity);
    }
  }

  // Re-sort by position
  return result.sort((a, b) => a.start - b.start);
}

/**
 * Group entities by type.
 *
 * @param entities - Array of entities
 * @returns Map of type to entities
 */
export function groupEntitiesByType(entities: EntitySpan[]): Map<MedicalEntityType, EntitySpan[]> {
  const groups = new Map<MedicalEntityType, EntitySpan[]>();

  for (const entity of entities) {
    const group = groups.get(entity.type) || [];
    group.push(entity);
    groups.set(entity.type, group);
  }

  return groups;
}

/**
 * Get unique entity texts by type.
 *
 * @param entities - Array of entities
 * @returns Map of type to unique texts
 */
export function getUniqueEntitiesByType(entities: EntitySpan[]): Map<MedicalEntityType, string[]> {
  const grouped = groupEntitiesByType(entities);
  const unique = new Map<MedicalEntityType, string[]>();

  for (const [type, typeEntities] of grouped) {
    const texts = [...new Set(typeEntities.map((e) => e.text.toLowerCase()))];
    unique.set(type, texts);
  }

  return unique;
}

/**
 * Sort entities by confidence score (descending).
 *
 * @param entities - Array of entities
 * @returns Sorted entities
 */
export function sortEntitiesByScore(entities: EntitySpan[]): EntitySpan[] {
  return [...entities].sort((a, b) => b.score - a.score);
}

/**
 * Sort entities by position in text.
 *
 * @param entities - Array of entities
 * @returns Sorted entities
 */
export function sortEntitiesByPosition(entities: EntitySpan[]): EntitySpan[] {
  return [...entities].sort((a, b) => a.start - b.start);
}

/**
 * Get the top N entities by confidence.
 *
 * @param entities - Array of entities
 * @param n - Number of entities to return
 * @returns Top N entities
 */
export function getTopEntities(entities: EntitySpan[], n: number): EntitySpan[] {
  return sortEntitiesByScore(entities).slice(0, n);
}

/**
 * Highlight entities in text using HTML spans.
 *
 * @param text - Original text
 * @param entities - Array of entities to highlight
 * @param classPrefix - CSS class prefix for highlighting
 * @returns HTML string with highlighted entities
 */
export function highlightEntities(text: string, entities: EntitySpan[], classPrefix = 'ner-entity'): string {
  // Sort by position (descending) so we can insert from end
  const sorted = sortEntitiesByPosition(entities).reverse();
  let result = text;

  for (const entity of sorted) {
    const typeClass = `${classPrefix}--${entity.type.toLowerCase()}`;
    const before = result.slice(0, entity.start);
    const entityText = result.slice(entity.start, entity.end);
    const after = result.slice(entity.end);

    result = `${before}<span class="${classPrefix} ${typeClass}" data-entity-type="${entity.type}" data-score="${entity.score.toFixed(2)}">${entityText}</span>${after}`;
  }

  return result;
}

/**
 * Convert entities to a simple object format for serialization.
 *
 * @param entities - Array of entities
 * @returns Array of plain objects
 */
export function entitiesToJSON(entities: EntitySpan[]): object[] {
  return entities.map((entity) => ({
    text: entity.text,
    type: entity.type,
    start: entity.start,
    end: entity.end,
    score: Math.round(entity.score * 1000) / 1000, // Round to 3 decimal places
  }));
}

/**
 * Count entities by type.
 *
 * @param entities - Array of entities
 * @returns Record of type to count
 */
export function countEntitiesByType(entities: EntitySpan[]): Record<MedicalEntityType, number> {
  const counts: Record<MedicalEntityType, number> = {} as Record<MedicalEntityType, number>;

  // Initialize all types with 0
  Object.values(MedicalEntityType).forEach((type) => {
    counts[type] = 0;
  });

  // Count entities
  for (const entity of entities) {
    counts[entity.type] = (counts[entity.type] || 0) + 1;
  }

  return counts;
}

/**
 * Calculate average confidence score across entities.
 *
 * @param entities - Array of entities
 * @returns Average confidence score (0-1)
 */
export function getAverageConfidence(entities: EntitySpan[]): number {
  if (entities.length === 0) return 0;

  const sum = entities.reduce((acc, entity) => acc + entity.score, 0);
  return sum / entities.length;
}

/**
 * Find entities containing a specific substring.
 *
 * @param entities - Array of entities
 * @param substring - Substring to search for (case-insensitive)
 * @returns Matching entities
 */
export function findEntitiesContaining(entities: EntitySpan[], substring: string): EntitySpan[] {
  const lower = substring.toLowerCase();
  return entities.filter((entity) => entity.text.toLowerCase().includes(lower));
}

/**
 * Deduplicate entities by text (case-insensitive), keeping highest score.
 *
 * @param entities - Array of entities
 * @returns Deduplicated entities
 */
export function deduplicateEntities(entities: EntitySpan[]): EntitySpan[] {
  const seen = new Map<string, EntitySpan>();

  for (const entity of entities) {
    const key = `${entity.type}:${entity.text.toLowerCase()}`;
    const existing = seen.get(key);

    if (!existing || entity.score > existing.score) {
      seen.set(key, entity);
    }
  }

  return Array.from(seen.values());
}
