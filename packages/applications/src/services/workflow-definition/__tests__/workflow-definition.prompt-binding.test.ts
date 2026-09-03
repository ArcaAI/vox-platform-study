/**
 * prompt binding, and the two update paths that must never be
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
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
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
  findLatestVersion: vi.fn(),
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
    mockWorkflowDefinitionRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);
    mockPromptTemplateRepository.findById.mockResolvedValue(templateEntity());
    mockPromptTemplateRepository.update.mockImplementation(async (_id, entity) => entity);
    mockPromptVersionRepository.findMaxVersionNumber.mockResolvedValue(7);
    mockPromptVersionRepository.findLatestVersion.mockResolvedValue({ versionNumber: 7, content: 'old body', variables: null });
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
    // CAS, not a bare update: the route is `@RequiresIfMatch()`-gated, so the
    // definition write is a compare-and-set that also advances `_version` (and
    // therefore the ETag) — a graph rewrite that left the validator unchanged
    // would let a client blind-write the same ETag again.
    expect(mockWorkflowDefinitionRepository.updateWithVersion).toHaveBeenCalledWith('def-1', expect.anything(), 1, tx);
  });

  it('rolls the whole thing back when the pin move fails — no orphan version row', async () => {
    mockDatabaseService.baseClient.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      // Simulate a real interactive transaction: the callback throws, so
      // nothing it wrote is committed.
      await callback({ tx: true });
      throw new Error('unreachable');
    });
    mockWorkflowDefinitionRepository.updateWithVersion.mockRejectedValue(new Error('write conflict'));

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

/**
 * item 1 — ADOPTING AN UNCHANGED VERSION IS A PIN MOVE, NOT AN AUTHORING ACT.
 *
 * DD-11's PATH 2 deliberately leaves node pins where they are when a template is
 * edited out of band, so adoption is the COMMON path, not the rare one. Before
 * this guard every adoption minted a byte-identical version row — so the very
 * list an admin opens to understand what changed was the list this design filled
 * with noise.
 *
 * The comparison is against the template's LATEST version, deliberately:
 *   - the request carries only `content`; it never names a version, and the only
 *     version identity the server has is `max(versionNumber)`;
 *   - `PromptTemplate.content` (the shared head) tracks the latest version's
 *     content by invariant, and a pure pin move must NOT rewrite the head — so
 *     only "identical to latest" leaves head and pin in a state the mint path
 *     could also have produced. Pinning to an older matching row would either
 *     strand the head ahead of the pin or silently rewrite a SHARED template,
 *     which is precisely what DD-11 forbids;
 *   - both in-repo precedents compare against latest only
 *     (`ConsultationContextSchemaService.publish`, and `approve`'s
 *     `latestMatchesLiveContent` in `PromptManagementService`).
 *
 * The corollary is intended: submitting an OLDER version's body while the
 * template sits on a newer one is a REVERT — a new authorial decision about a
 * shared template — and still mints.
 */
describe('DD-11 §7b — an unchanged adopt must not mint a new version', () => {
  let service: WorkflowDefinitionService;

  /** The template's latest immutable snapshot: v9, which the node (pinned at v4) is behind. */
  const LATEST = { versionNumber: 9, content: 'the current template text', variables: { tone: 'clinical' } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'tenantId') return 'tenant-1';
      if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
      return undefined;
    });
    mockDatabaseService.baseClient.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback({ tx: true }));
    // A FRESH entity per read, as a real repository hands back: this block calls
    // `updateNodePrompt` twice in one test, and the pin move writes onto the
    // entity it was given.
    mockWorkflowDefinitionRepository.findById.mockImplementation(async () => definitionEntity());
    mockWorkflowDefinitionRepository.update.mockImplementation(async (_id, entity) => entity);
    mockWorkflowDefinitionRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);
    // The head tracks the latest snapshot — the invariant every mint path keeps.
    mockPromptTemplateRepository.findById.mockResolvedValue(templateEntity({ content: LATEST.content, variables: LATEST.variables }));
    mockPromptTemplateRepository.update.mockImplementation(async (_id, entity) => entity);
    mockPromptVersionRepository.findMaxVersionNumber.mockResolvedValue(LATEST.versionNumber);
    mockPromptVersionRepository.findLatestVersion.mockResolvedValue(LATEST);
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

  it('mints NOTHING and moves the pin to the version that already carries that content', async () => {
    const result = await service.updateNodePrompt('def-1', 'n_gen', { content: LATEST.content, expectedVersion: 1 });

    expect(mockPromptVersionRepository.create).not.toHaveBeenCalled();
    // The SHARED template head is not rewritten either — a pin move must not be
    // a back-door edit of a template every other node also reads.
    expect(mockPromptTemplateRepository.update).not.toHaveBeenCalled();

    const graph = (result as unknown as { graph: typeof GRAPH_WITH_PROMPTS }).graph;
    expect(graph.nodes[1].config.promptVersionNumber).toBe(9);
    // The sibling node on the same template is still on its own pin.
    expect(graph.nodes[0].config.promptVersionNumber).toBe(4);
  });

  it('reports minted:false so a caller can tell "adopted" from "new version created"', async () => {
    const adopted = await service.updateNodePrompt('def-1', 'n_gen', { content: LATEST.content, expectedVersion: 1 });
    expect(adopted).toMatchObject({ promptVersionMinted: false, promptVersionNumber: 9, previousPromptVersionNumber: 4 });

    const minted = await service.updateNodePrompt('def-1', 'n_gen', { content: 'an edited variant', expectedVersion: 1 });
    expect(minted).toMatchObject({ promptVersionMinted: true, promptVersionNumber: 10, previousPromptVersionNumber: 4 });
  });

  it('records the adopt as a pin move in the audit stream, not as an edit', async () => {
    await service.updateNodePrompt('def-1', 'n_gen', { content: LATEST.content, expectedVersion: 1 });

    const payload = mockEventEmitter.emit.mock.calls.at(-1)?.[1];
    expect(payload.data).toMatchObject({ action: 'node-prompt-adopt', nodeId: 'n_gen', previousVersionNumber: 4, versionNumber: 9, minted: false });
  });

  it('writes NOTHING AT ALL when the node is already pinned to that version — idempotent', async () => {
    mockWorkflowDefinitionRepository.findById.mockResolvedValue(
      definitionEntity({
        graph: { version: 1, nodes: [{ id: 'n_gen', type: 'generate.text', config: { promptTemplateId: 'tpl-1', promptVersionNumber: 9 } }], edges: [] },
      }),
    );

    const result = await service.updateNodePrompt('def-1', 'n_gen', { content: LATEST.content, expectedVersion: 1 });

    expect(mockPromptVersionRepository.create).not.toHaveBeenCalled();
    expect(mockWorkflowDefinitionRepository.update).not.toHaveBeenCalled();
    expect(mockWorkflowDefinitionRepository.updateWithVersion).not.toHaveBeenCalled();
    // No write happened, so no ResourceUpdated: a phantom audit row per repeated
    // save is exactly the noise this ticket is removing from the version list.
    expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    expect(result).toMatchObject({ promptVersionMinted: false, promptVersionNumber: 9, previousPromptVersionNumber: 9 });
  });

  it('does NOT need a transaction for the no-mint path — there is only one write to be atomic with', async () => {
    await service.updateNodePrompt('def-1', 'n_gen', { content: LATEST.content, expectedVersion: 1 });
    expect(mockDatabaseService.baseClient.$transaction).not.toHaveBeenCalled();
  });

  it('treats a VARIABLES-only change as a change and still mints', async () => {
    await service.updateNodePrompt('def-1', 'n_gen', { content: LATEST.content, variables: { tone: 'plain' }, expectedVersion: 1 });

    expect(mockPromptVersionRepository.create).toHaveBeenCalledTimes(1);
    expect(mockPromptVersionRepository.create.mock.calls[0][0].versionNumber).toBe(10);
  });

  it('is insensitive to VARIABLE KEY ORDER — canonical bytes, not JSON.stringify order', async () => {
    mockPromptVersionRepository.findLatestVersion.mockResolvedValue({ ...LATEST, variables: { a: 1, b: 2 } });

    await service.updateNodePrompt('def-1', 'n_gen', { content: LATEST.content, variables: { b: 2, a: 1 }, expectedVersion: 1 });

    expect(mockPromptVersionRepository.create).not.toHaveBeenCalled();
  });

  it('still MINTS a revert — submitting an older body while the template is ahead is an authorial act', async () => {
    await service.updateNodePrompt('def-1', 'n_gen', { content: 'the body v4 had', expectedVersion: 1 });

    expect(mockPromptVersionRepository.create).toHaveBeenCalledTimes(1);
    expect(mockPromptVersionRepository.create.mock.calls[0][0].content).toBe('the body v4 had');
  });

  it('mints when the template has NO version history at all', async () => {
    mockPromptVersionRepository.findLatestVersion.mockResolvedValue(null);
    mockPromptVersionRepository.findMaxVersionNumber.mockResolvedValue(0);

    await service.updateNodePrompt('def-1', 'n_gen', { content: LATEST.content, expectedVersion: 1 });

    expect(mockPromptVersionRepository.create).toHaveBeenCalledTimes(1);
    expect(mockPromptVersionRepository.create.mock.calls[0][0].versionNumber).toBe(1);
  });

  it('412s on a STALE If-Match even though the content is identical — never a silent 200', async () => {
    // RFC 7232 §13.1: the precondition is a property of the REQUEST against the
    // CURRENT state, evaluated whether or not the payload would change anything.
    // Without this, the no-mint short-circuit would hand a stale client a 200
    // and quietly move a pin it never saw.
    await expect(service.updateNodePrompt('def-1', 'n_gen', { content: LATEST.content, expectedVersion: 99 })).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );

    expect(mockWorkflowDefinitionRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(mockPromptVersionRepository.create).not.toHaveBeenCalled();
  });

  it('412s on a stale If-Match on the MINT path too — both branches share one precondition', async () => {
    await expect(service.updateNodePrompt('def-1', 'n_gen', { content: 'an edited variant', expectedVersion: 99 })).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );

    expect(mockPromptVersionRepository.create).not.toHaveBeenCalled();
  });

  it('still 404s cross-tenant BEFORE the checksum is ever computed', async () => {
    mockPromptTemplateRepository.findById.mockResolvedValue(templateEntity({ tenantId: 'tenant-2', content: LATEST.content }));

    await expect(service.updateNodePrompt('def-1', 'n_gen', { content: LATEST.content, expectedVersion: 1 })).rejects.toBeInstanceOf(NotFoundException);
    expect(mockPromptVersionRepository.findLatestVersion).not.toHaveBeenCalled();
  });
});
