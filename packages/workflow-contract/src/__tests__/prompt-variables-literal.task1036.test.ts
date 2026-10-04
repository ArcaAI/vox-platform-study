/**
 * TASK-1036 C0a item 9 — VERIFY (report only; lane C0b owns `prompt-scope.ts`): does a `core.agent`
 * `overrides.promptVariables` value like `"{{trigger.x}}"` bind LITERALLY?
 *
 * The node schema promises interpolation — `overrides.promptVariables`' description reads
 * "`{{vars.key}}` / `{{nodes.id.key}}` / `{{trigger.key}}` interpolate from the run context"
 * (`node-config-schemas.ts`) — and publish cross-checks those templates as if they will
 * (`publish-findings.ts`). The TS render scope merges an override as a PLAIN value:
 * `resolveBinding` (`prompt-scope.ts`) returns any non-`{ value }`/`{ path }` entry verbatim, and
 * `renderTemplate` is single-pass. These tests pin what actually happens today.
 */
import { describe, expect, it } from 'vitest';
import { buildPromptScope } from '../prompt-scope';
import { renderTemplate } from '../template';

describe('overrides.promptVariables: "{{trigger.x}}" — what the shared render scope does with it', () => {
  const trigger = { x: 'forty-two' };

  it('binds the override string LITERALLY: the bare variable holds the unrendered template text', () => {
    const scope = buildPromptScope({ trigger, variables: { age: '{{trigger.x}}' } });
    expect(scope.age).toBe('{{trigger.x}}');
  });

  it('so an instruction that reads `{{age}}` renders the literal placeholder text, not the run value', () => {
    const scope = buildPromptScope({ trigger, variables: { age: '{{trigger.x}}' } });
    expect(renderTemplate('Patient age: {{age}}', scope)).toBe('Patient age: {{trigger.x}}');
  });

  it('whereas the `{ path }` binding shape DOES resolve against the roots (the shape the override never produces)', () => {
    const scope = buildPromptScope({ trigger, variables: { age: { path: 'trigger.x' } } });
    expect(renderTemplate('Patient age: {{age}}', scope)).toBe('Patient age: forty-two');
  });
});
