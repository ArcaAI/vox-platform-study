/**
 * promptUtils Unit Tests (TDD)
 *
 * Coverage for substitutePromptVariables, extractPromptVariables, validatePromptVariables.
 * Includes edge cases: empty input, nested braces, special characters, large inputs.
 */

import { describe, it, expect } from 'vitest';
import { substitutePromptVariables, extractPromptVariables, validatePromptVariables } from '../promptUtils';

// ============================================================================
// substitutePromptVariables
// ============================================================================

describe('substitutePromptVariables', () => {
  it('should substitute a single variable', () => {
    const result = substitutePromptVariables('Hello {patient_name}.', { patient_name: 'John' });
    expect(result).toBe('Hello John.');
  });

  it('should substitute multiple variables', () => {
    const result = substitutePromptVariables('{greeting} {patient_name}, your appointment is on {date}.', {
      greeting: 'Hello',
      patient_name: 'Jane',
      date: '2026-03-01',
    });
    expect(result).toBe('Hello Jane, your appointment is on 2026-03-01.');
  });

  it('should leave unmatched placeholders as-is by default', () => {
    const result = substitutePromptVariables('Hello {patient_name}. Dept: {department}.', { patient_name: 'John' });
    expect(result).toBe('Hello John. Dept: {department}.');
  });

  it('should throw in strict mode for unmatched placeholders', () => {
    expect(() => substitutePromptVariables('Hello {patient_name}.', {}, { strict: true })).toThrow(
      'Missing value for prompt variable: {patient_name}',
    );
  });

  it('should handle empty template', () => {
    const result = substitutePromptVariables('', { a: 'b' });
    expect(result).toBe('');
  });

  it('should handle template with no variables', () => {
    const result = substitutePromptVariables('No variables here.', { a: 'b' });
    expect(result).toBe('No variables here.');
  });

  it('should handle empty variables map', () => {
    const result = substitutePromptVariables('{name}', {});
    expect(result).toBe('{name}');
  });

  it('should handle variables with underscores', () => {
    const result = substitutePromptVariables('{style_DNA_doctor_department_surgery}', { style_DNA_doctor_department_surgery: 'Be concise' });
    expect(result).toBe('Be concise');
  });

  it('should handle variables with hyphens', () => {
    const result = substitutePromptVariables('{my-variable}', { 'my-variable': 'value' });
    expect(result).toBe('value');
  });

  it('should not substitute nested braces like {{name}}', () => {
    const result = substitutePromptVariables('{{name}}', { name: 'John' });
    expect(result).toBe('{John}');
  });

  it('should handle multiple occurrences of the same variable', () => {
    const result = substitutePromptVariables('{lang} is the language. Write in {lang}.', { lang: 'English' });
    expect(result).toBe('English is the language. Write in English.');
  });

  it('should substitute with empty string values', () => {
    const result = substitutePromptVariables('Before {filler} After', { filler: '' });
    expect(result).toBe('Before  After');
  });

  it('should handle large templates efficiently', () => {
    const largeTemplate = '{var}'.repeat(1000);
    const result = substitutePromptVariables(largeTemplate, { var: 'x' });
    expect(result).toBe('x'.repeat(1000));
  });

  it('should not substitute variables inside curly braces with spaces', () => {
    const result = substitutePromptVariables('{ not_a_var }', { not_a_var: 'should not match' });
    expect(result).toBe('{ not_a_var }');
  });
});

// ============================================================================
// extractPromptVariables
// ============================================================================

describe('extractPromptVariables', () => {
  it('should extract a single variable', () => {
    expect(extractPromptVariables('Hello {name}.')).toEqual(['name']);
  });

  it('should extract multiple unique variables', () => {
    const vars = extractPromptVariables('{greeting} {name}. Dept: {department}.');
    expect(vars).toContain('greeting');
    expect(vars).toContain('name');
    expect(vars).toContain('department');
    expect(vars).toHaveLength(3);
  });

  it('should deduplicate repeated variables', () => {
    const vars = extractPromptVariables('{lang} is {lang}.');
    expect(vars).toEqual(['lang']);
  });

  it('should return empty array for template with no variables', () => {
    expect(extractPromptVariables('No variables here.')).toEqual([]);
  });

  it('should return empty array for empty template', () => {
    expect(extractPromptVariables('')).toEqual([]);
  });

  it('should extract variables with underscores', () => {
    const vars = extractPromptVariables('{conversation_language} {style_DNA_doctor}');
    expect(vars).toContain('conversation_language');
    expect(vars).toContain('style_DNA_doctor');
  });

  it('should extract variables with hyphens', () => {
    const vars = extractPromptVariables('{my-var}');
    expect(vars).toContain('my-var');
  });

  it('should not extract variables with leading digits', () => {
    const vars = extractPromptVariables('{123abc}');
    expect(vars).toEqual([]);
  });
});

// ============================================================================
// validatePromptVariables
// ============================================================================

describe('validatePromptVariables', () => {
  it('should return empty array when all required variables are provided', () => {
    const result = validatePromptVariables(
      [
        { name: 'language', type: 'string', required: true },
        { name: 'style', type: 'string', required: true },
      ],
      { language: 'English', style: 'formal' },
    );
    expect(result).toEqual([]);
  });

  it('should return missing required variable names', () => {
    const result = validatePromptVariables(
      [
        { name: 'language', type: 'string', required: true },
        { name: 'style', type: 'string', required: true },
      ],
      { language: 'English' },
    );
    expect(result).toEqual(['style']);
  });

  it('should ignore optional variables', () => {
    const result = validatePromptVariables(
      [
        { name: 'language', type: 'string', required: true },
        { name: 'optional_field', type: 'string', required: false },
      ],
      { language: 'English' },
    );
    expect(result).toEqual([]);
  });

  it('should return all missing when no values provided', () => {
    const result = validatePromptVariables(
      [
        { name: 'a', type: 'string', required: true },
        { name: 'b', type: 'string', required: true },
      ],
      {},
    );
    expect(result).toEqual(['a', 'b']);
  });

  it('should return empty array for empty definitions', () => {
    expect(validatePromptVariables([], { a: 'b' })).toEqual([]);
  });

  it('should return empty array for all optional', () => {
    const result = validatePromptVariables(
      [
        { name: 'a', type: 'string', required: false },
        { name: 'b', type: 'string', required: false },
      ],
      {},
    );
    expect(result).toEqual([]);
  });
});
