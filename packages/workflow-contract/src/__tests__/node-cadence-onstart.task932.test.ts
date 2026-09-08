/**
 * TASK-932 §3.7 / D-9 — `onStart`, the realtime WARM-START cadence.
 *
 * The pre-summary of the prior record is a step of the consultation graph, not a call the
 * console happens to make before recording. Expressing it needs a cadence that means "once,
 * when the live session opens, before the first turn" — `once` is the DURABLE run's start and
 * `perTurn` is every flush, so neither says it.
 *
 * Two things this file pins, because both are the kind of fact that rots silently:
 *
 *  1. `core.agent` and `core.action` declare the SAME cadence vocabulary. They are two literals
 *     in one module and nothing but this test makes them agree.
 *  2. `NODE_EXECUTION_CADENCES` — the exported vocabulary a runtime reads instead of re-typing
 *     the strings — is that same set. It cannot be spliced INTO the two schemas (both are
 *     module-eval literals declared above it, so referencing it would be a TDZ error), so the
 *     agreement is asserted rather than constructed.
 *
 * What is deliberately NOT here: a harness parity assertion. The cross-language mirror is
 * `NODE_REGISTRY` / `ACTION_CATALOGUE` (`node-registry.snapshot.json`), and neither carries a
 * config schema — the interpreter reads `execution.lane`, never `execution.cadence`
 * (`_configured_realtime`, `workflow.py`). Adding a cadence therefore changes
 * `registryChecksum()` (the descriptor carries `configSchema`) and nothing else on that side;
 * `apps/harness/.../test_realtime_onstart_skipped_task932.py` pins the skip behaviour itself.
 */
import { describe, expect, it } from 'vitest';

import { NODE_CONFIG_SCHEMAS, NODE_EXECUTION_CADENCES } from '../node-config-schemas';

function cadenceEnumOf(nodeType: string): readonly string[] {
  const schema = NODE_CONFIG_SCHEMAS[nodeType] as Record<string, unknown> | undefined;
  const properties = schema?.properties as Record<string, unknown> | undefined;
  const execution = properties?.execution as Record<string, unknown> | undefined;
  const executionProperties = execution?.properties as Record<string, unknown> | undefined;
  const cadence = executionProperties?.cadence as Record<string, unknown> | undefined;
  const values = cadence?.enum;
  if (!Array.isArray(values)) throw new Error(`${nodeType} declares no \`execution.cadence\` enum`);
  return values as readonly string[];
}

describe('TASK-932 — the `onStart` execution cadence', () => {
  it('is declared by `core.agent`', () => {
    expect(cadenceEnumOf('core.agent')).toContain('onStart');
  });

  it('is declared by `core.action`, so a delegated action can carry the same slot', () => {
    expect(cadenceEnumOf('core.action')).toContain('onStart');
  });

  it('the two node types declare exactly the same cadence vocabulary', () => {
    expect(cadenceEnumOf('core.action')).toEqual(cadenceEnumOf('core.agent'));
  });

  it('`NODE_EXECUTION_CADENCES` is that vocabulary, in the schemas` own order', () => {
    expect([...NODE_EXECUTION_CADENCES]).toEqual([...cadenceEnumOf('core.agent')]);
  });

  it('keeps every pre-existing cadence — `onStart` is ADDITIVE, so no published graph is invalidated', () => {
    expect([...NODE_EXECUTION_CADENCES]).toEqual(expect.arrayContaining(['once', 'perTurn', 'onEnd']));
  });

  it('`core.agent` still defaults to `once` — an unauthored cadence must not become the live slot', () => {
    const properties = (NODE_CONFIG_SCHEMAS['core.agent'] as Record<string, unknown>).properties as Record<string, unknown>;
    const execution = properties.execution as Record<string, unknown>;
    const cadence = (execution.properties as Record<string, unknown>).cadence as Record<string, unknown>;
    expect(cadence.default).toBe('once');
  });
});
