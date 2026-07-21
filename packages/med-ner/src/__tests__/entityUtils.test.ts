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

    // ------------------------------------------------------------------
    // Count-aware weighted-average score on merge.
    //
    // Previously, mergeAdjacentEntities averaged scores via
    // `current.score = (current.score + entity.score) / 2`, which is a
    // biased running average for N > 2 and ignores per-token weight for
    // any N. These four tests pin the new behaviour:
    //
    //     mergedScore = Σ(score_i × weight_i) / Σ(weight_i)
    //
    // where `weight_i = max(end_i − start_i, 1)`. The character span is
    // used because EntitySpan does not carry a token count directly and
    // the original 06-med-ner review proposed character span as the
    // safe fallback weight.
    // ------------------------------------------------------------------

    it('H-2: two equal-weight adjacent entities → simple arithmetic mean', () => {
      // Both entities have an identical 4-char span ("abcd" and "efgh"),
      // so weight is equal on both sides; the weighted mean MUST equal
      // the simple mean. This locks regression safety: switching to a
      // count-aware weighted average must not change the equal-weight
      // case.
      const text = 'abcd efghijklmnop';
      const entities = [
        createEntity('abcd', MedicalEntityType.DISEASE, 0, 4, 0.9),
        createEntity('efgh', MedicalEntityType.DISEASE, 5, 9, 0.7),
      ];

      const result = mergeAdjacentEntities(entities, text);

      expect(result).toHaveLength(1);
      expect(result[0].score).toBeCloseTo(0.8, 10); // (0.9 + 0.7) / 2
    });

    it('H-2: heavier-left adjacent entities → merged score skews left', () => {
      // e1 spans 10 chars (weight 10) with score 0.9.
      // e2 spans  2 chars (weight  2) with score 0.5.
      // Weighted mean = (0.9*10 + 0.5*2) / 12 = 10.0 / 12 ≈ 0.8333…
      // Old buggy impl returned the simple mean 0.7 regardless of span.
      const text = 'abcdefghij kl extra trailing';
      const entities = [
        createEntity('abcdefghij', MedicalEntityType.DISEASE, 0, 10, 0.9),
        createEntity('kl', MedicalEntityType.DISEASE, 11, 13, 0.5),
      ];

      const result = mergeAdjacentEntities(entities, text);

      expect(result).toHaveLength(1);
      expect(result[0].score).toBeCloseTo((0.9 * 10 + 0.5 * 2) / 12, 10);
      // Sanity: the new score is strictly greater than the simple mean
      // (it must skew toward the heavier-left high-score contribution).
      expect(result[0].score).toBeGreaterThan(0.7);
      // And strictly less than the left score itself (still a mean).
      expect(result[0].score).toBeLessThan(0.9);
    });

    it('H-2: heavier-right adjacent entities → merged score skews right', () => {
      // e1 spans  2 chars (weight  2) with score 0.9.
      // e2 spans 10 chars (weight 10) with score 0.5.
      // Weighted mean = (0.9*2 + 0.5*10) / 12 = 6.8 / 12 ≈ 0.5667.
      // Old buggy impl returned the simple mean 0.7.
      const text = 'ab cdefghijkl trailing context';
      const entities = [
        createEntity('ab', MedicalEntityType.DISEASE, 0, 2, 0.9),
        createEntity('cdefghijkl', MedicalEntityType.DISEASE, 3, 13, 0.5),
      ];

      const result = mergeAdjacentEntities(entities, text);

      expect(result).toHaveLength(1);
      expect(result[0].score).toBeCloseTo((0.9 * 2 + 0.5 * 10) / 12, 10);
      // The new score is strictly less than the simple mean — it skews
      // toward the heavier-right low-score contribution.
      expect(result[0].score).toBeLessThan(0.7);
      // And strictly greater than the right score itself (still a mean).
      expect(result[0].score).toBeGreaterThan(0.5);
    });

    it('H-2: three equal-weight adjacent entities reduce correctly (not the broken running-average)', () => {
      // Classic 06-med-ner H-2 example: [B:0.95, I:0.90, I:0.85].
      // Each contribution has identical 4-char weight, so weighted mean
      // collapses to the plain mean (0.95 + 0.90 + 0.85) / 3 = 0.9.
      // Old buggy impl computed ((0.95 + 0.90)/2 + 0.85)/2 = 0.8875.
      const text = 'abcd efgh ijkl trailing context';
      const entities = [
        createEntity('abcd', MedicalEntityType.DISEASE, 0, 4, 0.95),
        createEntity('efgh', MedicalEntityType.DISEASE, 5, 9, 0.9),
        createEntity('ijkl', MedicalEntityType.DISEASE, 10, 14, 0.85),
      ];

      const result = mergeAdjacentEntities(entities, text);

      expect(result).toHaveLength(1);
      expect(result[0].score).toBeCloseTo(0.9, 10);
      // Guard against any future regression to the running-average bug.
      expect(result[0].score).not.toBeCloseTo(0.8875, 6);
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

    it('should HTML-escape malicious literal text outside entity spans (M-3)', () => {
      const text = 'Note: <script>alert("xss")</script> diabetes';
      const entities = [createEntity('diabetes', MedicalEntityType.DISEASE, 36, 44, 0.9)];

      const result = highlightEntities(text, entities);

      // The script tag literal must not survive as a real tag.
      expect(result).not.toContain('<script>');
      expect(result).not.toContain('</script>');
      expect(result).toContain('&lt;script&gt;');
      expect(result).toContain('&lt;/script&gt;');
      // The DISEASE wrapper for the actual entity is the ONLY <span> emitted.
      const spanCount = result.match(/<span /g)?.length ?? 0;
      expect(spanCount).toBe(1);
    });

    it('should HTML-escape malicious entity body text (M-3)', () => {
      // A clinical note where the entity text itself contains HTML-unsafe chars
      const text = 'Result: pH<7';
      const entities = [createEntity('pH<7', MedicalEntityType.LAB_VALUE, 8, 12, 0.9)];

      const result = highlightEntities(text, entities);

      expect(result).toContain('pH&lt;7');
      expect(result).not.toMatch(/pH<7<\/span>/);
    });

    it('should escape clinical text with comparison operators commonly found in EHR (M-3)', () => {
      const text = 'T<38.5°C & SpO2>92%';
      const entities = [createEntity('T<38.5°C', MedicalEntityType.LAB_VALUE, 0, 8, 0.9)];

      const result = highlightEntities(text, entities);

      expect(result).toContain('T&lt;38.5°C');
      expect(result).toContain('&amp;');
      expect(result).toContain('SpO2&gt;92%');
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
