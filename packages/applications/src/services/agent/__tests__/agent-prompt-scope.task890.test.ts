/**
 * TASK-890 §3.3 — the ONE render scope, and the binding form it resolves.
 *
 * Four renderers build this scope: the standalone invocation, the realtime `core.agent` lane,
 * the draft-agent bench, and (through the hand-written mirror `_prompt_scope`) the durable lane.
 * They must agree, because the whole value of the bench is that what an author sees there is
 * what production sends.
 *
 * They did not. `instruction.variables` is a map of BINDINGS (`{ value }` — a literal;
 * `{ path }` — a reference into the roots), and only the bench resolved them: the other three
 * passed the raw map through, so `{{tone}}` rendered `{"value":"formal"}` in production and
 * `formal` on the bench. Resolution now happens once, HERE, and the bench calls the same builder.
 */
import { describe, expect, it } from 'vitest';
import { PromptVariableUnresolvedError, renderTemplate } from '@arcaai/workflow-contract';
import { buildAgentPromptScope } from '../agent-prompt-scope';

describe('buildAgentPromptScope binds the roots', () => {
  it('publishes `context` as an ALIAS of `trigger`, so one prompt is portable between call shapes', () => {
    const scope = buildAgentPromptScope({ trigger: { patientAge: 41 } });

    expect(renderTemplate('{{trigger.patientAge}}/{{context.patientAge}}', scope)).toBe('41/41');
  });

  it('binds a root only when the caller HAS it — an absent trigger is not an empty object', () => {
    const scope = buildAgentPromptScope({ input: { text: 'x' } });

    expect('trigger' in scope).toBe(false);
    expect('context' in scope).toBe(false);
  });
});

describe('buildAgentPromptScope resolves the `instruction.variables` binding form', () => {
  it('resolves `{ value }` to its literal', () => {
    const scope = buildAgentPromptScope({ variables: { tone: { value: 'formal' } } });

    expect(renderTemplate('{{tone}}', scope)).toBe('formal');
  });

  it('resolves `{ path }` from the roots, so `{{age}}` and `{{context.patientAge}}` are one value', () => {
    const scope = buildAgentPromptScope({ trigger: { patientAge: 41 }, variables: { age: { path: 'context.patientAge' } } });

    expect(renderTemplate('{{age}}/{{context.patientAge}}', scope)).toBe('41/41');
  });

  it('resolves a binding BEFORE the bare-name overlay — a binding never sees another bare name', () => {
    const scope = buildAgentPromptScope({ trigger: { a: 'A' }, variables: { first: { value: 'literal' }, second: { path: 'context.a' } } });

    expect(renderTemplate('{{first}}{{second}}', scope)).toBe('literalA');
  });

  it('passes a plain value through — an `overrides.promptVariables` entry is not a binding', () => {
    const scope = buildAgentPromptScope({ variables: { tone: 'terse', count: 3 } });

    expect(renderTemplate('{{tone}}/{{count}}', scope)).toBe('terse/3');
  });

  it('exposes the RESOLVED map under `variables.*` too, so the two spellings cannot disagree', () => {
    const scope = buildAgentPromptScope({ variables: { tone: { value: 'formal' } } });

    expect(renderTemplate('{{variables.tone}}', scope)).toBe('formal');
  });

  it('raises NAMING THE PATH when a `{ path }` binding resolves to nothing — never silently empty', () => {
    expect(() => buildAgentPromptScope({ trigger: {}, variables: { age: { path: 'context.patientAge' } }, templateRef: 'agent:x' })).toThrow(
      PromptVariableUnresolvedError,
    );
  });
});
