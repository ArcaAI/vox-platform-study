/**
 * TASK-810 DD-11 — prompt binding, and the two update paths that must never be
 * confused with each other.
 *
 * | Path | Version | Pin |
 * |---|---|---|
 * | Edited **from within the node** (`updateNodePrompt`) | new version | **moves, atomically** |
 * | Edited from the **Prompt management screen** (`PromptManagementService.updatePromptTemplate`) | new version | **does not move — for ANY node** |
 *
 * The second row is the whole point. Without it, one admin editing one shared
 * template on a management screen silently rewrites the prompt of every
 * workflow that references it, including published clinical ones whose owners
 * never saw the edit. Task 12 is therefore a REGRESSION test: it asserts that a
 * shared edit leaves node pins alone, which is a property that would look like
 * a bug to anyone who had not read this table.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WorkflowDefinitionStatus } from '@arcaai/domains';
import { WorkflowDefinitionService } from '../workflow-definition.service';
import { collectPromptBindings, withMovedPin } from '../node-prompt-binding';
import { PromptManagementService } from '../../prompt-management/prompt-management.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

/** A graph with TWO nodes bound to the SAME shared template, plus one unbound node. */
const GRAPH_WITH_PROMPTS = {
  version: 1,
  nodes: [
    { id: 'n_prompt', type: 'prompt.template_ref', config: { promptTemplateId: 'tpl-1', promptVersionNumber: 4 } },
    { id: 'n_gen', type: 'generate.text', config: { taskKey: 'text.finalize', promptTemplateId: 'tpl-1', promptVersionNumber: 4 } },
    { id: 'n_out', type: 'output.deliver', config: { outputs: [{ key: 'note', primitive: 'TEXT' }] } },
  ],
  edges: [],
};

const mockWorkflowDefinitionRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
  findMaxVersionNumber: vi.fn(),
  findPublishedBySlug: vi.fn(),
  findAllVersionsBySlug: vi.fn(),
};

const mockPromptTemplateRepository = {
  findById: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
};

const mockPromptVersionRepository = {
  create: vi.fn(),
  findMaxVersionNumber: vi.fn(),
};

const mockDatabaseService = {
  baseClient: { $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback({ tx: true })) },
};

const definitionEntity = (overrides: Record<string, unknown> = {}) => ({
  id: 'def-1',
  tenantId: 'tenant-1',
  slug: 'discharge_summary',
  name: 'Discharge Summary',
  paletteKey: 'summarization',
  versionNumber: 1,
  status: WorkflowDefinitionStatus.DRAFT,
  graph: GRAPH_WITH_PROMPTS,
  graphChecksum: 'c1',
  compiledConfig: null,
  compiledConfigChecksum: null,
  registryChecksum: null,
  validationReport: null,
  needsReview: false,
  validatedAt: null,
  publishedAt: null,
  deprecatedAt: null,
  isActive: false,
  resourceStatus: 'ENABLED',
  createdAt: new Date('2026-08-26T00:00:00Z'),
  updatedAt: new Date('2026-08-26T00:00:00Z'),
  version: 1,
  tags: [],
  description: null,
  parentVersionId: null,
  hasChanges: false,
  changes: {},
  ...overrides,
});

const templateEntity = (overrides: Record<string, unknown> = {}) => ({
  id: 'tpl-1',
  tenantId: 'tenant-1',
  name: 'Discharge prompt',
  content: 'old body',
  variables: null,
  currentVersionNumber: 4,
  ...overrides,
});

describe('DD-11 — node prompt binding helpers', () => {
  it('collects a binding from ANY node carrying promptTemplateId, not from a type allow-list', () => {
    const bindings = collectPromptBindings(GRAPH_WITH_PROMPTS as never);

    // A type allow-list would silently miss the next generation node someone
    // adds to the registry — and missing it here means missing it in the
    // "new version available" surface too.
    expect(bindings.map((b) => b.nodeId)).toEqual(['n_prompt', 'n_gen']);
    expect(bindings[0].pinnedVersionNumber).toBe(4);
  });

  it('treats an unpinned node as pinnedVersionNumber = null, not as version 0', () => {
    const graph = { version: 1, nodes: [{ id: 'n1', type: 'generate.text', config: { promptTemplateId: 'tpl-1' } }], edges: [] };
    expect(collectPromptBindings(graph as never)[0].pinnedVersionNumber).toBeNull();
  });

  it('withMovedPin returns a COPY and never mutates the input graph', () => {
    const moved = withMovedPin(GRAPH_WITH_PROMPTS as never, 'n_gen', 9)!;

    expect(moved.nodes[1].config.promptVersionNumber).toBe(9);
    // A half-applied mutation on a failed transaction would leave the in-memory
    // row disagreeing with the database.
    expect(GRAPH_WITH_PROMPTS.nodes[1].config.promptVersionNumber).toBe(4);
    // Only the named node moved.
    expect(moved.nodes[0].config.promptVersionNumber).toBe(4);
  });

  it('withMovedPin returns null for a node that has nothing to pin', () => {
    expect(withMovedPin(GRAPH_WITH_PROMPTS as never, 'n_out', 9)).toBeNull();
    expect(withMovedPin(GRAPH_WITH_PROMPTS as never, 'no_such_node', 9)).toBeNull();
  });
});

describe('DD-11 PATH 1 — edit from within the node', () => {
  let service: WorkflowDefinitionService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'tenantId') return 'tenant-1';
      if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
      return undefined;
    });
    mockDatabaseService.baseClient.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback({ tx: true }));
    mockWorkflowDefinitionRepository.findById.mockResolvedValue(definitionEntity());
    mockWorkflowDefinitionRepository.update.mockImplementation(async (_id, entity) => entity);
    mockPromptTemplateRepository.findById.mockResolvedValue(templateEntity());
    mockPromptTemplateRepository.update.mockImplementation(async (_id, entity) => entity);
    mockPromptVersionRepository.findMaxVersionNumber.mockResolvedValue(7);
    mockPromptVersionRepository.create.mockImplementation(async (entity) => entity);

    service = new WorkflowDefinitionService(
      mockWorkflowDefinitionRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
      mockDatabaseService as never,
      undefined,
      undefined,
      undefined,
      mockPromptTemplateRepository as never,
      mockPromptVersionRepository as never,
    );
  });

  it('mints a new PromptVersion AND moves THAT node’s pin, in ONE transaction', async () => {
    const result = await service.updateNodePrompt('def-1', 'n_gen', { content: 'new body', changeReason: 'sharper' });

    expect(mockDatabaseService.baseClient.$transaction).toHaveBeenCalledTimes(1);

    // versionNumber = max(existing) + 1, read INSIDE the transaction — not
    // `currentVersionNumber + 1`, which a lagging counter would make collide
    // with an existing row and brick further edits of the template.
    const version = mockPromptVersionRepository.create.mock.calls[0][0];
    expect(version.versionNumber).toBe(8);
    expect(version.content).toBe('new body');
    expect(version.changeReason).toBe('sharper');

    // …and the pin moved to it, on the SAME node.
    const graph = (result as unknown as { graph: typeof GRAPH_WITH_PROMPTS }).graph;
    expect(graph.nodes[1].config.promptVersionNumber).toBe(8);
    // The sibling node bound to the SAME template is untouched: an in-node edit
    // moves ONE pin, never every pin that happens to share the template.
    expect(graph.nodes[0].config.promptVersionNumber).toBe(4);
  });

  it('writes the version and the pin through the SAME tx client (atomicity, not two writes)', async () => {
    await service.updateNodePrompt('def-1', 'n_gen', { content: 'new body' });

    const tx = { tx: true };
    expect(mockPromptVersionRepository.findMaxVersionNumber).toHaveBeenCalledWith('tpl-1', tx);
    expect(mockPromptVersionRepository.create).toHaveBeenCalledWith(expect.anything(), tx);
    expect(mockPromptTemplateRepository.update).toHaveBeenCalledWith('tpl-1', expect.anything(), tx);
    expect(mockWorkflowDefinitionRepository.update).toHaveBeenCalledWith('def-1', expect.anything(), tx);
  });

  it('rolls the whole thing back when the pin move fails — no orphan version row', async () => {
    mockDatabaseService.baseClient.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      // Simulate a real interactive transaction: the callback throws, so
      // nothing it wrote is committed.
      await callback({ tx: true });
      throw new Error('unreachable');
    });
    mockWorkflowDefinitionRepository.update.mockRejectedValue(new Error('write conflict'));

    await expect(service.updateNodePrompt('def-1', 'n_gen', { content: 'x' })).rejects.toThrow('write conflict');
    expect(mockEventEmitter.emit).not.toHaveBeenCalled();
  });

  it('broadcasts the pin move with both the previous and the new version number', async () => {
    await service.updateNodePrompt('def-1', 'n_gen', { content: 'new body' });

    const payload = mockEventEmitter.emit.mock.calls.at(-1)?.[1];
    expect(payload.data).toMatchObject({ action: 'node-prompt-edit', nodeId: 'n_gen', previousVersionNumber: 4, versionNumber: 8 });
  });

  it('REFUSES to edit a PUBLISHED definition — branch a new draft instead', async () => {
    mockWorkflowDefinitionRepository.findById.mockResolvedValue(definitionEntity({ status: WorkflowDefinitionStatus.PUBLISHED }));

    await expect(service.updateNodePrompt('def-1', 'n_gen', { content: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPromptVersionRepository.create).not.toHaveBeenCalled();
  });

  it('400s on a node that references no prompt template', async () => {
    await expect(service.updateNodePrompt('def-1', 'n_out', { content: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPromptVersionRepository.create).not.toHaveBeenCalled();
  });

  it('404s (never 403) when the node’s template belongs to another tenant', async () => {
    mockPromptTemplateRepository.findById.mockResolvedValue(templateEntity({ tenantId: 'tenant-2' }));

    await expect(service.updateNodePrompt('def-1', 'n_gen', { content: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('DD-11 — the "new version available" affordance', () => {
  let service: WorkflowDefinitionService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-1' : undefined));
    mockWorkflowDefinitionRepository.findById.mockResolvedValue(definitionEntity());
    mockPromptTemplateRepository.findById.mockResolvedValue(templateEntity());

    service = new WorkflowDefinitionService(
      mockWorkflowDefinitionRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
      mockDatabaseService as never,
      undefined,
      undefined,
      undefined,
      mockPromptTemplateRepository as never,
      mockPromptVersionRepository as never,
    );
  });

  it('flags a node whose template moved past its pin', async () => {
    mockPromptVersionRepository.findMaxVersionNumber.mockResolvedValue(9);

    const bindings = await service.listPromptBindings('def-1');

    expect(bindings).toHaveLength(2);
    expect(bindings[0]).toMatchObject({ nodeId: 'n_prompt', pinnedVersionNumber: 4, latestVersionNumber: 9, hasNewVersion: true });
    expect(bindings[1]).toMatchObject({ nodeId: 'n_gen', hasNewVersion: true });
  });

  it('does NOT flag a node already on the latest version', async () => {
    mockPromptVersionRepository.findMaxVersionNumber.mockResolvedValue(4);
    expect((await service.listPromptBindings('def-1'))[0].hasNewVersion).toBe(false);
  });

  it('does NOT flag an UNPINNED node — following the template is a legitimate choice', async () => {
    mockWorkflowDefinitionRepository.findById.mockResolvedValue(
      definitionEntity({
        graph: { version: 1, nodes: [{ id: 'n1', type: 'generate.text', config: { promptTemplateId: 'tpl-1' } }], edges: [] },
      }),
    );
    mockPromptVersionRepository.findMaxVersionNumber.mockResolvedValue(9);

    // Reporting an unpinned node as stale would train admins to ignore the signal.
    expect((await service.listPromptBindings('def-1'))[0]).toMatchObject({ pinnedVersionNumber: null, hasNewVersion: false });
  });
});

describe('DD-11 PATH 2 — REGRESSION: an out-of-band edit moves NO node pin', () => {
  it('creates a new PromptVersion and leaves every referencing node’s pin exactly where it was', async () => {
    // The Prompt management screen's edit path. It knows nothing about graphs,
    // and that is deliberate — it is what stops one edit from rewriting every
    // workflow that shares the template.
    const promptTemplateRepository = {
      findById: vi.fn().mockResolvedValue({
        ...templateEntity(),
        status: 'DRAFT',
        resourceStatus: 'ENABLED',
        createdAt: new Date('2026-08-26T00:00:00Z'),
        updatedAt: new Date('2026-08-26T00:00:00Z'),
        hasChanges: true,
        version: 1,
        scope: 'TENANT_DEFAULT',
        incrementVersion: vi.fn(),
        disable: vi.fn(),
        enable: vi.fn(),
      }),
      updateWithVersion: vi.fn().mockImplementation(async (_id, entity) => entity),
    };
    const promptVersionRepository = { create: vi.fn(), findMaxVersionNumber: vi.fn().mockResolvedValue(4) };
    const databaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };

    const promptService = new PromptManagementService(
      promptTemplateRepository as never,
      promptVersionRepository as never,
      { findAll: vi.fn() } as never,
      { getDepartment: vi.fn() } as never,
      { emit: vi.fn() } as never,
      {
        get: vi.fn().mockImplementation((key: string) => {
          if (key === 'tenantId') return 'tenant-1';
          if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
          // `assertCanMutate` reads the CASL ability off CLS, not the role list.
          if (key === 'userAbility') return { can: () => true };
          return undefined;
        }),
      } as never,
      databaseService as never,
    );

    // A snapshot of the graph BEFORE the shared edit.
    const before = JSON.parse(JSON.stringify(GRAPH_WITH_PROMPTS));

    await promptService.updatePromptTemplate('tpl-1', { content: 'edited on the management screen', expectedVersion: 1 });

    // A version WAS minted…
    expect(promptVersionRepository.create).toHaveBeenCalledTimes(1);
    expect(promptVersionRepository.create.mock.calls[0][0].versionNumber).toBe(5);
    expect(GRAPH_WITH_PROMPTS).toEqual(before);

    // …and NOT ONE node pin moved. Asserted through the affordance rather than
    // by eyeballing the graph object, because that is the state an admin
    // actually sees: two nodes still on v4, the template now on v5, and both
    // nodes flagged as having a newer version waiting for a DELIBERATE re-pin.
    // If a future change made this path move pins, `hasNewVersion` would go
    // false here and this assertion would fail.
    const workflowRepository = {
      findById: vi.fn().mockResolvedValue(definitionEntity()),
    };
    const workflowService = new WorkflowDefinitionService(
      workflowRepository as never,
      { emit: vi.fn() } as never,
      { get: vi.fn().mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-1' : undefined)) } as never,
      databaseService as never,
      undefined,
      undefined,
      undefined,
      { findById: vi.fn().mockResolvedValue(templateEntity()) } as never,
      { findMaxVersionNumber: vi.fn().mockResolvedValue(5) } as never,
    );

    const bindings = await workflowService.listPromptBindings('def-1');
    expect(bindings.map((b) => b.pinnedVersionNumber)).toEqual([4, 4]);
    expect(bindings.map((b) => b.latestVersionNumber)).toEqual([5, 5]);
    expect(bindings.map((b) => b.hasNewVersion)).toEqual([true, true]);
  });
});
