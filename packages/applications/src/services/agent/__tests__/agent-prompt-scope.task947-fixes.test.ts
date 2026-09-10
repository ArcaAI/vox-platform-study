/**
 * TASK-947 R1 #1 — the realtime lane was the one renderer that never applied the J3-5 `context`
 * unwrap: `buildAgentPromptScope` aliases `context` to `trigger` verbatim and every OTHER caller
 * unwrapped before passing `trigger`. The builder now takes the CONTEXT VIEW explicitly, so a
 * lane whose trigger is the run payload (`{ context: {...} }`) can publish `trigger` verbatim and
 * `context` unwrapped — exactly the durable lane's `_prompt_scope` shape.
 */
import { describe, expect, it } from 'vitest';
import { buildAgentPromptScope } from '../agent-prompt-scope';

const trigger = { context: { visit_type: 'revisit', safe_age: '41' }, consultationId: 'c-1' };

describe('buildAgentPromptScope — the explicit context view', () => {
  it('without `context`, `context` still aliases `trigger` (every pre-947 caller is unchanged)', () => {
    const scope = buildAgentPromptScope({ trigger, variables: {} });
    expect(scope.trigger).toBe(trigger);
    expect(scope.context).toBe(trigger);
  });

  it('with `context`, publishes `trigger` verbatim and `context` as the given view', () => {
    const scope = buildAgentPromptScope({ trigger, context: trigger.context, variables: {} });
    expect(scope.trigger).toBe(trigger);
    expect(scope.context).toBe(trigger.context);
  });

  it('a `{ path: "context.*" }` binding resolves against the VIEW, and a bare `trigger.context.*` still works', () => {
    const scope = buildAgentPromptScope({
      trigger,
      context: trigger.context,
      variables: { age: { path: 'context.safe_age' }, visit: { path: 'trigger.context.visit_type' } },
    });
    expect(scope.age).toBe('41');
    expect(scope.visit).toBe('revisit');
  });

  it('a `context` given without a `trigger` is published on its own (an invocation-shaped caller)', () => {
    const scope = buildAgentPromptScope({ context: trigger.context, variables: {} });
    expect(scope.context).toBe(trigger.context);
    expect(scope.trigger).toBeUndefined();
  });

  it('a non-object `context` is ignored and the alias stands', () => {
    const scope = buildAgentPromptScope({ trigger, context: null, variables: {} });
    expect(scope.context).toBe(trigger);
  });
});
