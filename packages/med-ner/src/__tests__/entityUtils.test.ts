/**
 * @arcaai/med-ner - Entity Utilities Tests
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
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
} from '../utils/entityUtils.js';
import { MedicalEntityType, type EntitySpan } from '../types/index.js';

// Test fixtures
const createEntity = (
  text: string,
  type: MedicalEntityType,
  start: number,
  end: number,
  score: number
): EntitySpan => ({
  text,
  type,
  start,
  end,
  score,
  rawLabel: type,
});

const sampleEntities: EntitySpan[] = [
  createEntity('diabetes', MedicalEntityType.DISEASE, 0, 8, 0.95),
  createEntity('metformin', MedicalEntityType.MEDICATION, 20, 29, 0.88),
  createEntity('500mg', MedicalEntityType.DOSAGE, 30, 35, 0.72),
  createEntity('fever', MedicalEntityType.SYMPTOM, 50, 55, 0.45),
];

describe('Entity Utilities', () => {
  describe('filterEntitiesByThreshold', () => {
    it('should filter entities below threshold', () => {
      const result = filterEntitiesByThreshold(sampleEntities, 0.7);
      expect(result).toHaveLength(3);
      expect(result.map((e) => e.text)).toEqual(['diabetes', 'metformin', '500mg']);
    });

    it('should return empty array for high threshold', () => {
      const result = filterEntitiesByThreshold(sampleEntities, 0.99);
      expect(result).toHaveLength(0);
    });

    it('should return all entities for zero threshold', () => {
      const result = filterEntitiesByThreshold(sampleEntities, 0);
      expect(result).toHaveLength(4);
    });
  });

  describe('filterEntitiesByType', () => {
    it('should filter by single type', () => {
      const result = filterEntitiesByType(sampleEntities, [MedicalEntityType.DISEASE]);
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('diabetes');
    });

    it('should filter by multiple types', () => {
      const result = filterEntitiesByType(sampleEntities, [
        MedicalEntityType.DISEASE,
        MedicalEntityType.MEDICATION,
      ]);
      expect(result).toHaveLength(2);
    });

    it('should return empty array for non-matching types', () => {
      const result = filterEntitiesByType(sampleEntities, [MedicalEntityType.GENE]);
      expect(result).toHaveLength(0);
    });
  });

  describe('areEntitiesAdjacent', () => {
    it('should return true for adjacent entities of same type', () => {
      const e1 = createEntity('Type', MedicalEntityType.DISEASE, 0, 4, 0.9);
      const e2 = createEntity('2', MedicalEntityType.DISEASE, 5, 6, 0.9);
      expect(areEntitiesAdjacent(e1, e2)).toBe(true);
    });

    it('should return false for different types', () => {
      const e1 = createEntity('test', MedicalEntityType.DISEASE, 0, 4, 0.9);
      const e2 = createEntity('test', MedicalEntityType.MEDICATION, 5, 9, 0.9);
      expect(areEntitiesAdjacent(e1, e2)).toBe(false);
    });

    it('should return false for non-adjacent entities', () => {
      const e1 = createEntity('test', MedicalEntityType.DISEASE, 0, 4, 0.9);
      const e2 = createEntity('test', MedicalEntityType.DISEASE, 10, 14, 0.9);
      expect(areEntitiesAdjacent(e1, e2)).toBe(false);
    });
  });

  describe('mergeAdjacentEntities', () => {
    it('should merge adjacent entities of same type', () => {
      const entities = [
        createEntity('Type', MedicalEntityType.DISEASE, 0, 4, 0.9),
        createEntity('2', MedicalEntityType.DISEASE, 5, 6, 0.8),
        createEntity('Diabetes', MedicalEntityType.DISEASE, 7, 15, 0.95),
      ];
      const text = 'Type 2 Diabetes is a condition';
      const result = mergeAdjacentEntities(entities, text);

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('Type 2 Diabetes');
      expect(result[0].start).toBe(0);
      expect(result[0].end).toBe(15);
    });

    it('should not merge non-adjacent entities', () => {
      const result = mergeAdjacentEntities(sampleEntities, 'test text');
      expect(result).toHaveLength(4);
    });

    it('should handle empty array', () => {
      const result = mergeAdjacentEntities([], 'test');
      expect(result).toHaveLength(0);
    });
  });

  describe('doEntitiesOverlap', () => {
    it('should return true for overlapping entities', () => {
      const e1 = createEntity('test', MedicalEntityType.DISEASE, 0, 10, 0.9);
      const e2 = createEntity('test', MedicalEntityType.DISEASE, 5, 15, 0.9);
      expect(doEntitiesOverlap(e1, e2)).toBe(true);
    });

    it('should return false for non-overlapping entities', () => {
      const e1 = createEntity('test', MedicalEntityType.DISEASE, 0, 5, 0.9);
      const e2 = createEntity('test', MedicalEntityType.DISEASE, 10, 15, 0.9);
      expect(doEntitiesOverlap(e1, e2)).toBe(false);
    });

    it('should return false for adjacent but non-overlapping', () => {
      const e1 = createEntity('test', MedicalEntityType.DISEASE, 0, 5, 0.9);
      const e2 = createEntity('test', MedicalEntityType.DISEASE, 5, 10, 0.9);
      expect(doEntitiesOverlap(e1, e2)).toBe(false);
    });
  });

  describe('mergeOverlappingEntities', () => {
    it('should keep highest scoring overlapping entity', () => {
      const entities = [
        createEntity('test1', MedicalEntityType.DISEASE, 0, 10, 0.7),
        createEntity('test2', MedicalEntityType.MEDICATION, 5, 15, 0.9),
      ];
      const result = mergeOverlappingEntities(entities);

      expect(result).toHaveLength(1);
      expect(result[0].score).toBe(0.9);
    });

    it('should keep non-overlapping entities', () => {
      const result = mergeOverlappingEntities(sampleEntities);
      expect(result).toHaveLength(4);
    });
  });

  describe('groupEntitiesByType', () => {
    it('should group entities by type', () => {
      const groups = groupEntitiesByType(sampleEntities);

      expect(groups.get(MedicalEntityType.DISEASE)).toHaveLength(1);
      expect(groups.get(MedicalEntityType.MEDICATION)).toHaveLength(1);
      expect(groups.get(MedicalEntityType.DOSAGE)).toHaveLength(1);
      expect(groups.get(MedicalEntityType.SYMPTOM)).toHaveLength(1);
    });
  });

  describe('getUniqueEntitiesByType', () => {
    it('should return unique texts by type', () => {
      const entities = [
        ...sampleEntities,
        createEntity('diabetes', MedicalEntityType.DISEASE, 60, 68, 0.8),
      ];
      const unique = getUniqueEntitiesByType(entities);

      expect(unique.get(MedicalEntityType.DISEASE)).toHaveLength(1);
    });
  });

  describe('sortEntitiesByScore', () => {
    it('should sort by score descending', () => {
      const result = sortEntitiesByScore(sampleEntities);

      expect(result[0].score).toBe(0.95);
      expect(result[result.length - 1].score).toBe(0.45);
    });
  });

  describe('sortEntitiesByPosition', () => {
    it('should sort by position ascending', () => {
      const shuffled = [...sampleEntities].reverse();
      const result = sortEntitiesByPosition(shuffled);

      expect(result[0].start).toBe(0);
      expect(result[result.length - 1].start).toBe(50);
    });
  });

  describe('getTopEntities', () => {
    it('should return top N entities by score', () => {
      const result = getTopEntities(sampleEntities, 2);

      expect(result).toHaveLength(2);
      expect(result[0].score).toBe(0.95);
      expect(result[1].score).toBe(0.88);
    });

    it('should return all entities if N > count', () => {
      const result = getTopEntities(sampleEntities, 10);
      expect(result).toHaveLength(4);
    });
  });

  describe('highlightEntities', () => {
    it('should wrap entities in spans', () => {
      const text = 'Patient has diabetes and takes metformin';
      const entities = [
        createEntity('diabetes', MedicalEntityType.DISEASE, 12, 20, 0.9),
        createEntity('metformin', MedicalEntityType.MEDICATION, 31, 40, 0.9),
      ];

      const result = highlightEntities(text, entities);

      expect(result).toContain('<span class="ner-entity ner-entity--disease"');
      expect(result).toContain('<span class="ner-entity ner-entity--medication"');
      expect(result).toContain('data-entity-type="DISEASE"');
      expect(result).toContain('data-score="0.90"');
    });
  });

  describe('entitiesToJSON', () => {
    it('should convert entities to plain objects', () => {
      const result = entitiesToJSON(sampleEntities);

      expect(result).toHaveLength(4);
      expect(result[0]).toEqual({
        text: 'diabetes',
        type: 'DISEASE',
        start: 0,
        end: 8,
        score: 0.95,
      });
    });
  });

  describe('countEntitiesByType', () => {
    it('should count entities by type', () => {
      const counts = countEntitiesByType(sampleEntities);

      expect(counts[MedicalEntityType.DISEASE]).toBe(1);
      expect(counts[MedicalEntityType.MEDICATION]).toBe(1);
      expect(counts[MedicalEntityType.GENE]).toBe(0);
    });
  });

  describe('getAverageConfidence', () => {
    it('should calculate average confidence', () => {
      const result = getAverageConfidence(sampleEntities);
      expect(result).toBeCloseTo(0.75, 2);
    });

    it('should return 0 for empty array', () => {
      expect(getAverageConfidence([])).toBe(0);
    });
  });

  describe('findEntitiesContaining', () => {
    it('should find entities containing substring', () => {
      const result = findEntitiesContaining(sampleEntities, 'met');
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('metformin');
    });

    it('should be case-insensitive', () => {
      const result = findEntitiesContaining(sampleEntities, 'DIA');
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('diabetes');
    });
  });

  describe('deduplicateEntities', () => {
    it('should remove duplicates keeping highest score', () => {
      const entities = [
        createEntity('diabetes', MedicalEntityType.DISEASE, 0, 8, 0.7),
        createEntity('Diabetes', MedicalEntityType.DISEASE, 20, 28, 0.9),
      ];

      const result = deduplicateEntities(entities);

      expect(result).toHaveLength(1);
      expect(result[0].score).toBe(0.9);
    });

    it('should keep different types as separate', () => {
      const entities = [
        createEntity('test', MedicalEntityType.DISEASE, 0, 4, 0.9),
        createEntity('test', MedicalEntityType.MEDICATION, 10, 14, 0.8),
      ];

      const result = deduplicateEntities(entities);
      expect(result).toHaveLength(2);
    });
  });
});
