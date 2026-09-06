/**
 * TASK-890 §3.14 (OD-R clause 3) — the guardrail opt-out's ONE precedence function.
 *
 * Three places may express an opinion about whether platform guardrail screens a call: the
 * `core.agent` NODE, the WORKFLOW (its `core.trigger`), and the AGENT itself. `false` is a
 * tenant opt-out; ABSENT is inherit; and the floor is `true` — guardrail is platform-managed and
 * screening is what a tenant opts OUT of, never in.
 *
 * The function also names WHICH level decided, because "this consultation ran without screening"
 * has to be answerable from a record rather than reconstructed from three JSON columns. That is
 * what the ledger attribute and the `GUARDRAIL_OPTED_OUT` publish WARNING both carry.
 *
 * The Python mirror (`harness.temporal.interpreter.guardrail_optout`) is held to the same
 * committed fixture by `tests/contracts/guardrail-optout-parity.contract.test.ts` and
 * `test_guardrail_optout_parity.py` — the durable lane must not screen a call the realtime lane
 * skipped, or vice versa.
 */
import { describe, expect, it } from 'vitest';
import { GUARDRAIL_DECISION_SOURCES, resolveGuardrailDecision } from '../guardrail-optout';

describe('resolveGuardrailDecision — node > workflow > agent > true', () => {
  it('defaults to ON when nobody has an opinion', () => {
    expect(resolveGuardrailDecision({})).toEqual({ enabled: true, source: 'default' });
    expect(resolveGuardrailDecision({ node: null, workflow: null, agent: null })).toEqual({ enabled: true, source: 'default' });
  });

  it('lets the NODE beat the workflow and the agent', () => {
    expect(resolveGuardrailDecision({ node: false, workflow: true, agent: true })).toEqual({ enabled: false, source: 'node' });
    expect(resolveGuardrailDecision({ node: true, workflow: false, agent: false })).toEqual({ enabled: true, source: 'node' });
  });

  it('lets the WORKFLOW beat the agent when the node is silent', () => {
    expect(resolveGuardrailDecision({ workflow: false, agent: true })).toEqual({ enabled: false, source: 'workflow' });
    expect(resolveGuardrailDecision({ workflow: true, agent: false })).toEqual({ enabled: true, source: 'workflow' });
  });

  it('falls through to the AGENT when neither the node nor the workflow speaks', () => {
    expect(resolveGuardrailDecision({ agent: false })).toEqual({ enabled: false, source: 'agent' });
    expect(resolveGuardrailDecision({ agent: true })).toEqual({ enabled: true, source: 'agent' });
  });

  it('treats a non-boolean as NO OPINION rather than as `false`', () => {
    // A malformed value must never be read as an opt-out: publish refuses it (the node schema),
    // and a runtime that saw one anyway screens the call.
    expect(resolveGuardrailDecision({ node: 'no' as unknown as boolean, agent: true })).toEqual({ enabled: true, source: 'agent' });
    expect(resolveGuardrailDecision({ node: undefined, workflow: undefined, agent: undefined })).toEqual({ enabled: true, source: 'default' });
  });

  it('names every source it can return', () => {
    const sources = new Set(
      [
        resolveGuardrailDecision({ node: false }),
        resolveGuardrailDecision({ workflow: false }),
        resolveGuardrailDecision({ agent: false }),
        resolveGuardrailDecision({}),
      ].map((decision) => decision.source),
    );
    expect([...sources].sort()).toEqual([...GUARDRAIL_DECISION_SOURCES].sort());
  });
});
