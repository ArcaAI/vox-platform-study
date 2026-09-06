/**
 * Typed prompt variables are coerced before assembly (§3.6). The `date` case
 * used to run every value through `new Date(...).toISOString()`, so a calendar
 * date typed in the test bench reached the model as
 * `2026-09-06T00:00:00.000Z` — a midnight-UTC timestamp the clinician never
 * entered, in a prompt that asked for a date (TASK-890 black-box J2-10).
 */

import { describe, expect, it } from 'vitest';
import { coercePromptVariableValue } from '../prompt-management.service';

describe('coercePromptVariableValue', () => {
  it('keeps a calendar date a calendar date', () => {
    expect(coercePromptVariableValue('date', '2026-09-06')).toBe('2026-09-06');
  });

  it('still normalises a value that carries a time', () => {
    expect(coercePromptVariableValue('date', '2026-09-06T14:30:00Z')).toBe('2026-09-06T14:30:00.000Z');
  });

  it('leaves an unparseable date untouched rather than inventing one', () => {
    expect(coercePromptVariableValue('date', 'next tuesday')).toBe('next tuesday');
  });

  it('coerces the other declared types', () => {
    expect(coercePromptVariableValue('number', '42')).toBe(42);
    expect(coercePromptVariableValue('boolean', 'true')).toBe(true);
    expect(coercePromptVariableValue('boolean', 'false')).toBe(false);
    expect(coercePromptVariableValue('json', '{"a":1}')).toEqual({ a: 1 });
    expect(coercePromptVariableValue('string', 7)).toBe('7');
  });
});
