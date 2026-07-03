import { describe, expect, it } from 'vitest';
import { categoryLabel, parseVariableNames, promptStatusLabel, promptStatusRole, toPromptVariables, toUpdatePromptInput } from '../instruction-draft';

describe('instruction-draft — editor draft → Update input + variable parsing', () => {
  describe('parseVariableNames', () => {
    it('extracts unique {{variables}} in first-seen order', () => {
      expect(parseVariableNames('Patient {{patient_age}} with {{chief_complaint}}; recheck {{patient_age}}.')).toEqual([
        'patient_age',
        'chief_complaint',
      ]);
    });

    it('trims surrounding whitespace and ignores empty / malformed braces', () => {
      expect(parseVariableNames('{{ spaced }} and {{}} and {{   }} and {{ok}}')).toEqual(['spaced', 'ok']);
    });

    it('returns [] when there are no variables', () => {
      expect(parseVariableNames('A plain prompt with no placeholders.')).toEqual([]);
    });
  });

  describe('toPromptVariables', () => {
    it('maps names to required string PromptVariables', () => {
      expect(toPromptVariables(['a', 'b'])).toEqual([
        { name: 'a', type: 'string', required: true },
        { name: 'b', type: 'string', required: true },
      ]);
    });
  });

  describe('toUpdatePromptInput', () => {
    it('trims content, derives variables from it, and carries status/changeReason/expectedVersion', () => {
      expect(toUpdatePromptInput({ content: '  Summarize {{transcript}}.  ', status: 'PUBLISHED', changeReason: '  tightened rules  ' }, 7)).toEqual({
        content: 'Summarize {{transcript}}.',
        status: 'PUBLISHED',
        changeReason: 'tightened rules',
        variables: [{ name: 'transcript', type: 'string', required: true }],
        expectedVersion: 7,
      });
    });

    it('omits an empty changeReason and an absent expectedVersion', () => {
      const input = toUpdatePromptInput({ content: 'x', status: 'DRAFT', changeReason: '   ' });
      expect(input.changeReason).toBeUndefined();
      expect(input.expectedVersion).toBeUndefined();
    });
  });

  describe('promptStatusRole / promptStatusLabel', () => {
    it('tones PUBLISHED success and DRAFT warning (semantic, never color-only)', () => {
      expect(promptStatusRole('PUBLISHED')).toBe('success');
      expect(promptStatusRole('DRAFT')).toBe('warning');
      expect(promptStatusRole(undefined)).toBe('neutral');
    });
    it('labels with title case, defaulting to Draft', () => {
      expect(promptStatusLabel('PUBLISHED')).toBe('Published');
      expect(promptStatusLabel(undefined)).toBe('Draft');
    });
  });

  describe('categoryLabel', () => {
    it('humanizes the PromptTemplate category enum', () => {
      expect(categoryLabel('SUMMARY')).toBe('Summary');
      expect(categoryLabel('DNA_ANALYSIS')).toBe('DNA analysis');
      expect(categoryLabel('CUSTOM')).toBe('Custom');
    });
  });
});
