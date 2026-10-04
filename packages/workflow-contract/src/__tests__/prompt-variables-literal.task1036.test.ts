/**
 * TASK-1036 C0a item 9 confirmed the defect; lane B6b fixes the TypeScript side.
 *
 * The node schema promises interpolation — `overrides.promptVariables`' description reads
 * "`{{vars.key}}` / `{{nodes.id.key}}` / `{{trigger.key}}` interpolate from the run context"
 * (`node-config-schemas.ts`) — and publish cross-checks those templates as if they will
 * (`publish-findings.ts`). Until B6b the TS render scope merged an override as a PLAIN value, so
 * `"{{trigger.x}}"` reached the model as those characters.
 *
 * Now an override handed to `buildPromptScope` as `overrides` is RENDERED against the run scope
 * (`trigger` / `context`, `input`, `vars`, `nodes`, `consultation`, `run`) when it contains `{{`,
 * then layered over the agent's own `variables` (node wins) — the behaviour the harness ships for
 * the durable lane (`_agent_prompt_scope`, lane B1). An unresolved path raises
 * `PromptVariableUnresolvedError` naming it.
 */
import { describe, expect, it } from 'vitest';
import { buildPromptScope } from '../prompt-scope';
import { PromptVariableUnresolvedError, renderTemplate } from '../template';

describe('overrides.promptVariables: "{{trigger.x}}" — rendered against the run scope before binding', () => {
  const trigger = { x: 'forty-two' };

  it('renders the override string: the bare variable holds the run value', () => {
    const scope = buildPromptScope({ trigger, overrides: { age: '{{trigger.x}}' } });
    expect(scope.age).toBe('forty-two');
    expect((scope.variables as Record<string, unknown>).age).toBe('forty-two');
  });

  it('so an instruction that reads `{{age}}` renders the run value, not the placeholder text', () => {
    const scope = buildPromptScope({ trigger, overrides: { age: '{{trigger.x}}' } });
    expect(renderTemplate('Patient age: {{age}}', scope)).toBe('Patient age: forty-two');
  });

  it('the override wins over the agent’s own binding of the same name (node wins)', () => {
    const scope = buildPromptScope({ trigger, variables: { age: { value: 'agent' } }, overrides: { age: 'Age {{context.x}}' } });
    expect(scope.age).toBe('Age forty-two');
  });

  it('resolves every run-scope root: vars, nodes (both spellings), consultation and run', () => {
    const scope = buildPromptScope({
      trigger,
      vars: { tone: 'brief' },
      nodes: { n_asr: { text: 'flat', outputs: { text: 'nodeio' } } },
      consultation: { patient: { age: 61 } },
      run: { id: 'run-1' },
      overrides: {
        a: '{{vars.tone}}',
        b: '{{nodes.n_asr.text}}',
        c: '{{nodes.n_asr.outputs.text}}',
        d: '{{consultation.patient.age}}',
        e: '{{run.id}}',
      },
    });
    expect([scope.a, scope.b, scope.c, scope.d, scope.e]).toEqual(['brief', 'flat', 'nodeio', '61', 'run-1']);
    expect(scope.consultation).toEqual({ patient: { age: 61 } });
    expect(scope.run).toEqual({ id: 'run-1' });
  });

  it('an unresolved path raises PromptVariableUnresolvedError naming the path and the override', () => {
    let caught: unknown;
    try {
      buildPromptScope({ trigger, overrides: { age: '{{trigger.missing}}' } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PromptVariableUnresolvedError);
    expect((caught as PromptVariableUnresolvedError).path).toBe('trigger.missing');
    expect((caught as PromptVariableUnresolvedError).templateRef).toBe('overrides.promptVariables.age');
  });

  it('an override without `{{` and a non-string override stay verbatim', () => {
    const scope = buildPromptScope({ trigger, overrides: { plain: 'no braces', n: 3 } });
    expect(scope.plain).toBe('no braces');
    expect(scope.n).toBe(3);
  });

  it('a `variables` entry is NOT rendered — only overrides are (the agent’s `{ value }` literal stays literal)', () => {
    const scope = buildPromptScope({ trigger, variables: { lit: { value: '{{trigger.x}}' } } });
    expect(scope.lit).toBe('{{trigger.x}}');
  });

  it('the `{ path }` binding shape still resolves against the roots', () => {
    const scope = buildPromptScope({ trigger, variables: { age: { path: 'trigger.x' } } });
    expect(renderTemplate('Patient age: {{age}}', scope)).toBe('Patient age: forty-two');
  });
});
