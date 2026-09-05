/**
 * TASK-882 — two node-config schema changes.
 *
 * 1. `llmBinding` is GONE. `withLlmBinding()` folded a per-node model selection onto every
 *    schema declaring `taskKey`; since TASK-876 the TEXT_GENERATION agent selects and no runtime
 *    reads the binding (`api_client.py:384`, `_llm_policy.py:134`), so the property was a
 *    configuration promise nothing kept.
 * 2. `carryForward` — the re-visit carry-forward decision lives on the assigned graph, not on
 *    the retired `agentic.revisit.carryForwardEnabled` key: the consultation palette's prompt
 *    composition node and the `core` vocabulary's agent node each declare it.
 */
import { describe, expect, it } from 'vitest';
import { NODE_CONFIG_SCHEMAS } from '../node-config-schemas';

type Props = Record<string, Record<string, unknown>>;
const propertiesOf = (key: string): Props => (NODE_CONFIG_SCHEMAS[key].properties ?? {}) as Props;

describe('TASK-882 — `llmBinding` is declared by no node type', () => {
  it('no schema carries an `llmBinding` property', () => {
    const carriers = Object.keys(NODE_CONFIG_SCHEMAS).filter((key) => Object.hasOwn(propertiesOf(key), 'llmBinding'));
    expect(carriers).toEqual([]);
  });
});

describe('TASK-882 — `carryForward` rides on the context/agent node', () => {
  it('`consultation.assemblePrompt` declares an optional boolean `carryForward`', () => {
    const property = propertiesOf('consultation.assemblePrompt').carryForward;
    expect(property).toMatchObject({ type: 'boolean' });
    expect(NODE_CONFIG_SCHEMAS['consultation.assemblePrompt'].required).not.toContain('carryForward');
  });

  it('`core.agent.overrides` declares an optional boolean `carryForward`', () => {
    const overrides = propertiesOf('core.agent').overrides as { properties?: Record<string, Record<string, unknown>> };
    expect(overrides.properties?.carryForward).toMatchObject({ type: 'boolean' });
  });
});
