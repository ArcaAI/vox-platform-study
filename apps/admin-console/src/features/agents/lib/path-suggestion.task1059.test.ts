import { describe, expect, it } from 'vitest';
import { withPathSuggestions } from './path-suggestion';

const finding = (code: string, message: string) => ({ severity: 'ERROR' as const, code, path: 'instruction', message });
const paths = [{ path: 'context.intake.chief_complaint' }, { path: 'context.intake.age' }, { path: 'trigger.intake.chief_complaint' }];

describe('withPathSuggestions', () => {
  it('suggests the schema path with the same leaf', () => {
    const [out] = withPathSuggestions([finding('PROMPT_VARIABLE_UNDECLARED', 'instruction.systemPrompt: `{{context.chief_complaint}}` is undeclared')], paths);
    expect(out.message).toContain('Did you mean {{context.intake.chief_complaint}}?');
    expect(out.message).not.toContain('trigger.');
  });
  it('leaves other codes and unmatched references alone', () => {
    const other = finding('MODEL_NOT_READY', 'x {{context.chief_complaint}}');
    const unmatched = finding('PROMPT_VARIABLE_UNDECLARED', '`{{context.nothing}}` is undeclared');
    expect(withPathSuggestions([other, unmatched], paths)).toEqual([other, unmatched]);
  });
});
