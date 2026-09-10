/**
 * TASK-947 — R2 L-2: a map literal whose KEY evaluates to the string `__proto__` was assigned with
 * `out[key] = …`, which in JavaScript sets the object's [[Prototype]] instead of creating an own
 * property; every later read gates on `hasOwnProperty`, so the entry vanished. The Python mirror
 * stores it as an ordinary dict key. The key is a RUN-TIME value (`{context.k: 1}`), so a caller
 * who controls `context.k` chose which runtime selected which fragment. Own property, always.
 */
import { describe, expect, it } from 'vitest';
import { evaluateCondition, evaluateExpression } from '../expressions';

describe('map literal — a `__proto__` key is an own property, as in Python', () => {
  const context = { context: { k: '__proto__' } };

  it('is counted by size() and found by `in`', () => {
    expect(evaluateCondition('size({context.k: 1}) == 1', context)).toEqual({ taken: true });
    expect(evaluateCondition('context.k in {context.k: 1}', context)).toEqual({ taken: true });
  });

  it('is an own key, not a prototype swap: the literal is not equal to the empty map and pollutes nothing', () => {
    expect(evaluateCondition("{'__proto__': {'polluted': 1}} == {}", {})).toEqual({ taken: false });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const result = evaluateExpression("{'__proto__': 1}", {});
    expect('value' in result && result.value).toEqual({ ['__proto__']: 1 });
  });
});
