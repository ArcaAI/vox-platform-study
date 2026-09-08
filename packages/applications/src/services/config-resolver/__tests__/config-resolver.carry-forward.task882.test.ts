/**
 * TASK-882 — `ConfigResolver.resolveRevisitCarryForwardEnabled`.
 *
 * `agentic.revisit.carryForwardEnabled` (a `global-kv` key) is gone. The decision is now a
 * `carryForward` binding on the assigned consultation graph: the prompt-composition node
 * (`consultation.assemblePrompt`, or a `core.action` delegating to it) or a `core.agent`'s
 * `overrides.carryForward`. Fail-SAFE toward OFF in every degraded case — carrying a prior
 * visit's content on the back of a failed governance read is a clinical-safety regression.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConfigResolver } from '../config-resolver.service';

const TENANT = 'tenant-1';

function build(graph: unknown, opts: { assignmentThrows?: boolean; unwired?: boolean } = {}) {
  const workflowAssignments = {
    resolve: vi.fn(async () => {
      if (opts.assignmentThrows) throw new Error('assignment backend down');
      return { workflowDefinitionSlug: graph ? 'consultation-soap' : null };
    }),
  };
  const workflowDefinitionRepository = { findPublishedBySlug: vi.fn(async () => (graph ? { graph } : null)) };
  const resolver = opts.unwired ? new ConfigResolver() : new ConfigResolver(undefined, workflowAssignments as never, workflowDefinitionRepository as never);
  return { resolver, workflowAssignments };
}

const graphWith = (...nodes: Array<Record<string, unknown>>) => ({ version: 1, nodes, edges: [] });

describe('ConfigResolver.resolveRevisitCarryForwardEnabled (TASK-882)', () => {
  it('OFF when the workflow resolvers are unwired', async () => {
    const { resolver } = build(null, { unwired: true });
    await expect(resolver.resolveRevisitCarryForwardEnabled({ tenantId: TENANT })).resolves.toBe(false);
  });

  it('OFF when no consultation graph is assigned', async () => {
    const { resolver } = build(null);
    await expect(resolver.resolveRevisitCarryForwardEnabled({ tenantId: TENANT })).resolves.toBe(false);
  });

  it('OFF when the assigned graph declares no carryForward binding', async () => {
    const { resolver } = build(graphWith({ id: 'n1', type: 'consultation.assemblePrompt', config: { requiresFinalized: true } }));
    await expect(resolver.resolveRevisitCarryForwardEnabled({ tenantId: TENANT })).resolves.toBe(false);
  });

  it('ON when the prompt-composition node carries carryForward: true', async () => {
    const { resolver } = build(graphWith({ id: 'n1', type: 'consultation.assemblePrompt', config: { carryForward: true } }));
    await expect(resolver.resolveRevisitCarryForwardEnabled({ tenantId: TENANT })).resolves.toBe(true);
  });

  it('ON when a core.action delegating to the prompt-composition node carries it under `action`', async () => {
    const { resolver } = build(
      graphWith({ id: 'n1', type: 'core.action', config: { actionKey: 'consultation.assemblePrompt', action: { carryForward: true } } }),
    );
    await expect(resolver.resolveRevisitCarryForwardEnabled({ tenantId: TENANT })).resolves.toBe(true);
  });

  it('ON when a core.agent carries overrides.carryForward: true', async () => {
    const { resolver } = build(graphWith({ id: 'n1', type: 'core.agent', config: { agentRef: { slug: 'soap' }, overrides: { carryForward: true } } }));
    await expect(resolver.resolveRevisitCarryForwardEnabled({ tenantId: TENANT })).resolves.toBe(true);
  });

  it('a DISABLED carrying node does not carry (the node toggle wins)', async () => {
    const { resolver } = build(graphWith({ id: 'n1', type: 'consultation.assemblePrompt', config: { carryForward: true, enabled: false } }));
    await expect(resolver.resolveRevisitCarryForwardEnabled({ tenantId: TENANT })).resolves.toBe(false);
  });

  it('resolves the assignment for the consultation`s department', async () => {
    const { resolver, workflowAssignments } = build(graphWith({ id: 'n1', type: 'consultation.assemblePrompt', config: { carryForward: true } }));
    await resolver.resolveRevisitCarryForwardEnabled({ tenantId: TENANT, departmentId: 'dept-1' });
    expect(workflowAssignments.resolve).toHaveBeenCalledWith(TENANT, 'core', 'dept-1');
  });

  it('OFF (never a throw) when the lookup fails', async () => {
    const { resolver } = build(graphWith({ id: 'n1', type: 'consultation.assemblePrompt', config: { carryForward: true } }), { assignmentThrows: true });
    await expect(resolver.resolveRevisitCarryForwardEnabled({ tenantId: TENANT })).resolves.toBe(false);
  });
});
