/**
 * TASK-893 Phase 4 — `GET /admin/workflow-nodes` must also serve the ACTION CATALOGUE.
 *
 * ## The defect this pins
 *
 * The Studio resolves a `core.action` instance's sockets by looking its `config.actionKey` up in
 * the SAME descriptor map it builds from this endpoint (`effectiveNodePorts`,
 * `apps/admin-console/src/features/workflow-studio/lib/core-ports.ts`). Until Phase 4 every action
 * was also a registered node type, so that lookup found the delegate for free. It is not any more:
 * `WORKFLOW_NODE_REGISTRY` holds eleven `core.*` types and the seventeen actions live in
 * `ACTION_CATALOGUE`.
 *
 * With the actions absent, the lookup MISSES and the canvas silently falls back to `core.action`'s
 * generic superset — it draws six sockets where the action declares one, and `isValidConnection`
 * accepts wires the delegate refuses. Nothing errors; the graph is simply wrong at publish time.
 * The console's own fixture (`workflow-studio/lib/__tests__/registry-fixture.ts`) already asserts
 * this exact payload shape, so this test is the gateway half of a contract that already had a
 * client half and no server half.
 */
import { ACTION_CATALOGUE, ACTION_CONFIG_SCHEMAS, ACTION_PORTS, WORKFLOW_NODE_REGISTRY } from '@arcaai/workflow-contract';
import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionDtoMapper } from '../workflow-definition.dto.mapper';

/** The projection under test, exercised through the mapper the service calls. */
const served = () =>
  new Map(
    [
      ...Object.values(WORKFLOW_NODE_REGISTRY).map((d) => WorkflowDefinitionDtoMapper.toNodeResponse(d)),
      ...Object.values(ACTION_CATALOGUE).map((d) => WorkflowDefinitionDtoMapper.toActionResponse(d)),
    ].map((n) => [n.type, n]),
  );

describe('TASK-893 — the workflow-node registry payload carries the action catalogue', () => {
  it('serves one entry per kept action key, keyed by the action key', () => {
    const nodes = served();
    for (const key of Object.keys(ACTION_CATALOGUE)) {
      expect(nodes.get(key), `action '${key}' is not served — every core.action instance naming it falls back to the generic superset`).toBeDefined();
    }
    expect(Object.keys(ACTION_CATALOGUE).length).toBe(17);
  });

  it('carries the DELEGATE’s ports, not core.action’s superset — the reason the payload exists', () => {
    const nodes = served();
    for (const [key, descriptor] of Object.entries(ACTION_CATALOGUE)) {
      const served = nodes.get(key)!;
      expect(served.inputs.map((p) => p.name)).toEqual(ACTION_PORTS[key].inputs.map((p) => p.name));
      expect(served.outputs.map((p) => p.name)).toEqual(ACTION_PORTS[key].outputs.map((p) => p.name));
      expect(served.activityName).toBe(descriptor.activityName);
      expect(served.lane).toBe(descriptor.lane);
      expect(served.configSchema).toEqual(ACTION_CONFIG_SCHEMAS[key]);
    }
    // The superset is genuinely wider — otherwise this contract would be vacuous.
    const generic = nodes.get('core.action')!;
    const oneAction = nodes.get('guard.phi')!;
    expect(generic.outputs.length).not.toBe(oneAction.outputs.length);
  });

  it('projects the safety flags and classes verbatim — a served action must never look safer than it is', () => {
    const nodes = served();
    for (const [key, descriptor] of Object.entries(ACTION_CATALOGUE)) {
      const served = nodes.get(key)!;
      expect(served.critical).toBe(descriptor.critical);
      expect(served.externalWrite).toBe(descriptor.externalWrite);
      expect(served.classes).toEqual([...descriptor.classes]);
      expect(served.entitlementKey).toBe(descriptor.entitlementKey ?? null);
      expect(served.defaultTimeoutSeconds).toBe(descriptor.defaultTimeoutSeconds);
      expect(served.defaultMaxAttempts).toBe(descriptor.defaultMaxAttempts);
    }
  });

  it('marks every action as live `core`-palette vocabulary — nothing here is deprecated', () => {
    const nodes = served();
    for (const key of Object.keys(ACTION_CATALOGUE)) {
      const served = nodes.get(key)!;
      expect(served.paletteKey).toBe('core');
      expect(served.deprecated).toBe(false);
      expect(served.replacedBy).toBeNull();
      expect(served.implemented).toBe(true);
    }
  });

  it('is labelled `action`, so the palette can serve it without offering it as a node type', () => {
    const nodes = served();
    for (const key of Object.keys(ACTION_CATALOGUE)) expect(nodes.get(key)!.kind).toBe('action');
    for (const key of Object.keys(WORKFLOW_NODE_REGISTRY)) expect(nodes.get(key)!.kind).toBe('node');
  });

  it('never collides with a node type — the two vocabularies share one keyspace', () => {
    for (const key of Object.keys(ACTION_CATALOGUE)) {
      expect(WORKFLOW_NODE_REGISTRY[key], `action key '${key}' is also a node type — one of the two would silently win`).toBeUndefined();
    }
  });
});
