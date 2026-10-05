/**
 * TASK-1036 contract freeze — `registryChecksum()` hashes the registry's SEMANTIC surface only.
 *
 * A published definition stamps the checksum and is flagged NEEDS_REVIEW when it drifts, so the
 * checksum must move exactly when something a published graph depends on moves: a node key, its
 * classes, activity, ports, `implemented`, its default budget, a REQUIRED config key, or a
 * code-owned dispatch / safety property. A purely additive OPTIONAL config property (`label`,
 * `inputs`, a new knob) or a reworded description must NOT move it — before this change every
 * such edit flagged every published workflow in every tenant for review.
 */
import { describe, expect, it } from 'vitest';
import { WORKFLOW_NODE_REGISTRY, registryChecksum, type WorkflowNodeDescriptor } from '../node-registry';

type Registry = Record<string, WorkflowNodeDescriptor>;

/** A deep, mutable copy of the live registry. */
function copy(): Registry {
  return JSON.parse(JSON.stringify(WORKFLOW_NODE_REGISTRY)) as Registry;
}

function schemaOf(registry: Registry, key: string): Record<string, any> {
  return (registry[key] as unknown as { configSchema: Record<string, any> }).configSchema;
}

describe('registryChecksum — the semantic surface', () => {
  const live = registryChecksum();

  it('is PINNED: the semantic surface has not moved since the pre-TASK-1036 base (45ce54bc6)', () => {
    // Computed over BOTH this registry and the 45ce54bc6 registry — they agree, because wave A and
    // the contract freeze added only OPTIONAL config properties. The value differs from the old
    // whole-descriptor hash (`69527f06…`) because the projection changed, not the registry: a
    // published row stamped with either old value is flagged NEEDS_REVIEW ONCE on upgrade. Moving
    // this pin means a published graph's dependencies moved: regenerate the workflow seeds
    // (`REGISTRY_CHECKSUM` in `28-workflow-library.generated.ts` / `29-arcaai-agents-and-workflows.generated.ts`).
    expect(live).toBe('52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1');
  });

  it('is a sha256 hex digest, and the default argument is the live registry', () => {
    expect(live).toMatch(/^[0-9a-f]{64}$/);
    expect(registryChecksum(copy())).toBe(live);
  });

  it('does NOT move when an OPTIONAL config property is added, or a description is reworded', () => {
    const optional = copy();
    schemaOf(optional, 'core.agent').properties.someNewKnob = { type: 'string', description: 'An additive optional knob.' };
    expect(registryChecksum(optional)).toBe(live);

    const reworded = copy();
    schemaOf(reworded, 'core.agent').description = 'Reworded.';
    for (const property of Object.values(schemaOf(reworded, 'core.trigger').properties as Record<string, any>)) property.description = 'x';
    expect(registryChecksum(reworded)).toBe(live);
  });

  it('does NOT move with the wave-A authoring keys (`label`, `inputs`): the semantic surface is the pre-TASK-1036 one', () => {
    const stripped = copy();
    for (const descriptor of Object.values(stripped)) {
      const properties = (descriptor as unknown as { configSchema?: { properties?: Record<string, unknown> } }).configSchema?.properties;
      if (properties !== undefined) {
        delete properties.label;
        delete properties.inputs;
      }
    }
    expect(registryChecksum(stripped)).toBe(live);
  });

  it('does NOT move when descriptors are reordered', () => {
    const reversed = Object.fromEntries(Object.entries(copy()).reverse()) as Registry;
    expect(registryChecksum(reversed)).toBe(live);
  });

  it.each<[string, (registry: Registry) => void]>([
    ['a REQUIRED config key is added', (r) => schemaOf(r, 'core.agent').required.push('someNewKnob')],
    [
      'a port is added',
      (r) => (r['core.agent'] as any).outputs.push({ name: 'extra', primitive: 'text', required: false, multiple: true, outputKey: 'extra' }),
    ],
    ['a port changes type', (r) => ((r['core.agent'] as any).inputs[0].primitive = 'object')],
    ['classes change', (r) => ((r['core.agent'] as any).classes = ['agent', 'gate'])],
    ['the activity changes', (r) => ((r['core.agent'] as any).activityName = 'interpreter.other')],
    ['implemented changes', (r) => ((r['core.note'] as any).implemented = !(r['core.note'] as any).implemented)],
    ['the default budget changes', (r) => ((r['core.agent'] as any).defaultTimeoutSeconds += 1)],
    ['a node type is added', (r) => (r['core.extra'] = { ...(r['core.note'] as any), key: 'core.extra' })],
    ['the lane changes', (r) => ((r['core.agent'] as any).lane = 'realtime')],
    ['a guard requirement is added', (r) => ((r['core.agent'] as any).requires = ['core.action'])],
  ])('MOVES when %s', (_what, mutate) => {
    const changed = copy();
    mutate(changed);
    expect(registryChecksum(changed)).not.toBe(live);
  });
});
