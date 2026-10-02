/**
 * `buildPromptScope` — the ONE render scope (moved from `@arcaai/applications`), plus the
 * `trigger` ↔ `context` alias: whichever of the two a caller supplies, both roots resolve.
 */
import { describe, expect, it } from 'vitest';
import { PromptVariableUnresolvedError, buildPromptScope } from '../index';

describe('buildPromptScope', () => {
  it('aliases context to trigger when only trigger is supplied', () => {
    const trigger = { age: 40 };
    const scope = buildPromptScope({ trigger });
    expect(scope.trigger).toBe(trigger);
    expect(scope.context).toBe(trigger);
  });

  it('aliases trigger to context when only context is supplied', () => {
    const context = { age: 40 };
    const scope = buildPromptScope({ context });
    expect(scope.context).toBe(context);
    expect(scope.trigger).toBe(context);
  });

  it('keeps both as given when both are supplied', () => {
    const trigger = { context: { age: 40 } };
    const context = { age: 40 };
    const scope = buildPromptScope({ trigger, context });
    expect(scope.trigger).toBe(trigger);
    expect(scope.context).toBe(context);
  });

  it('binds no root the caller does not have', () => {
    expect(buildPromptScope({})).toEqual({ variables: {} });
  });

  it('binds input, vars and nodes when present', () => {
    const scope = buildPromptScope({ input: { a: 1 }, vars: { b: 2 }, nodes: { n: { c: 3 } } });
    expect(scope.input).toEqual({ a: 1 });
    expect(scope.vars).toEqual({ b: 2 });
    expect(scope.nodes).toEqual({ n: { c: 3 } });
  });

  it('resolves { value } and { path } bindings before assigning bare names, and mirrors them under `variables`', () => {
    const scope = buildPromptScope({
      context: { patientAge: 61 },
      variables: { tone: { value: 'concise' }, age: { path: 'context.patientAge' }, raw: 'plain', other: { neither: true } },
    });
    expect(scope.tone).toBe('concise');
    expect(scope.age).toBe('61');
    expect(scope.raw).toBe('plain');
    expect(scope.other).toEqual({ neither: true });
    expect(scope.variables).toEqual({ tone: 'concise', age: '61', raw: 'plain', other: { neither: true } });
  });

  it('resolves a { path } binding through the alias root too', () => {
    expect(buildPromptScope({ context: { x: 'y' }, variables: { v: { path: 'trigger.x' } } }).v).toBe('y');
  });

  it('a declared variable named `context` wins its own name', () => {
    expect(buildPromptScope({ trigger: { a: 1 }, variables: { context: { value: 'mine' } } }).context).toBe('mine');
  });

  it('names an unresolved { path } binding', () => {
    expect(() => buildPromptScope({ context: {}, variables: { age: { path: 'context.missing' } } })).toThrow(PromptVariableUnresolvedError);
  });
});
