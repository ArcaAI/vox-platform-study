/**
 * toPromptTestMetricScores tests
 */

import { describe, it, expect } from 'vitest';
import { toPromptTestMetricScores } from '../promptMetrics';
import type { PromptTestMetrics } from '../../types/prompt';

const base: PromptTestMetrics = {
  wordCount: 100,
  nonEmpty: true,
  lengthScore: 0.8,
  jsonExpected: false,
  jsonValid: null,
  variablesDeclared: 0,
  variableCoverage: null,
};

describe('toPromptTestMetricScores', () => {
  it('returns undefined when the breakdown is missing', () => {
    expect(toPromptTestMetricScores(undefined)).toBeUndefined();
    expect(toPromptTestMetricScores(null)).toBeUndefined();
  });

  it('always includes length + nonEmpty (projected to 0/1)', () => {
    expect(toPromptTestMetricScores({ ...base, nonEmpty: false })).toEqual({ length: 0.8, nonEmpty: 0 });
    expect(toPromptTestMetricScores({ ...base, nonEmpty: true, lengthScore: 0.5 })).toEqual({ length: 0.5, nonEmpty: 1 });
  });

  it('includes jsonValidity ONLY when JSON is expected', () => {
    expect(toPromptTestMetricScores({ ...base, jsonExpected: true, jsonValid: true })!.jsonValidity).toBe(1);
    expect(toPromptTestMetricScores({ ...base, jsonExpected: true, jsonValid: false })!.jsonValidity).toBe(0);
    // not expected → omitted even if a stray jsonValid is present
    expect(toPromptTestMetricScores({ ...base, jsonExpected: false, jsonValid: true })!.jsonValidity).toBeUndefined();
  });

  it('includes variableCoverage ONLY when the template declares variables', () => {
    expect(toPromptTestMetricScores({ ...base, variablesDeclared: 2, variableCoverage: 0.5 })!.variableCoverage).toBe(0.5);
    expect(toPromptTestMetricScores({ ...base, variableCoverage: null })!.variableCoverage).toBeUndefined();
  });

  it('excludes the count dimensions (wordCount, variablesDeclared) from the display map', () => {
    const scores = toPromptTestMetricScores({ ...base, wordCount: 999, variablesDeclared: 7, variableCoverage: 1 })!;
    expect(scores.wordCount).toBeUndefined();
    expect(scores.variablesDeclared).toBeUndefined();
  });
});
