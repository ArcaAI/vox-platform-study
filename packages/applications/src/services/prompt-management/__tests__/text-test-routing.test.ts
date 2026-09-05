/**
 * Model routing for the prompt-template test bench.
 *
 * TASK-876 — the bench resolves through the tenant's ASSIGNED TEXT_GENERATION agent, exactly as
 * every real generation does. It used to select through the `text.test` `AiTaskDefault` key,
 * which is a RETIRED selection surface: a template tested against a model no consultation would
 * ever run is a test of nothing. The task key no longer participates in selection at all
 * (`AgentAssignment`'s key carries no role dimension), so there is no `text.test` tier left to
 * read — only the assigned agent's primary.
 *
 * Two halves:
 *  1. The registration points the bench depends on outside the service itself. (`text.test` is
 *     still a registered AiTaskDefault key with a tenant-editable descriptor — retiring the ROW
 *     is orchestrator-owned, and the descriptor lives in another lane's file — but nothing in
 *     this service reads it any more.)
 *  2. Resolution goes through `TextAgentResolverService`; a MISS (no agent at any tier ⇒
 *     fail-closed 400) is distinguished from a lookup ERROR (rethrown), and a caller-supplied
 *     pair still wins outright.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ModelTaskType } from '@arcaai/domains';
import { AI_TASK_KEYS, AI_TASK_MODEL_TASK_TYPES, isSuperAdminOnlyTaskKey } from '../../ai-task-default/constants';
import { MODEL_DEFAULT_SETTINGS } from '../../settings-registry/descriptors/model-defaults.descriptors';
import { PromptManagementService } from '../prompt-management.service';

describe('text.test routing tier', () => {
  it('registers text.test as an AiTaskDefault task key mapped to TEXT_GENERATION', () => {
    expect(AI_TASK_KEYS).toContain('text.test');
    expect(AI_TASK_MODEL_TASK_TYPES['text.test']).toBe(ModelTaskType.TEXT_GENERATION);
  });

  it('keeps text.test tenant-writable (NOT under SUPER_ADMIN_ONLY_TASK_PREFIXES)', () => {
    expect(isSuperAdminOnlyTaskKey('text.test')).toBe(false);
  });

  it('registers the models.text.test descriptor as tenant-editable db-config, fail-closed', () => {
    const descriptor = MODEL_DEFAULT_SETTINGS.find((d) => d.key === 'models.text.test');
    expect(descriptor).toBeDefined();
    expect(descriptor).toMatchObject({
      tier: 'db-config',
      dataType: 'string',
      sensitivity: 'internal',
      maxScope: 'tenant',
      editableBy: 'AiTaskDefault',
      failMode: 'closed',
      category: 'Models',
    });
    expect(descriptor?.globalOnly).toBeUndefined();
  });
});

// ─── TASK-876: the assigned TEXT_GENERATION agent resolves the bench's model ───

describe('prompt-test model resolution runs on the ASSIGNED agent', () => {
  const template = {
    id: 'tpl-1',
    tenantId: 'tenant-1',
    content: 'Summarize {{topic}}',
    category: 'SYSTEM',
    variables: null,
    version: 1,
  };

  const buildService = (opts: {
    resolve: ReturnType<typeof vi.fn>;
    post?: ReturnType<typeof vi.fn>;
  }) => {
    // stream: `POST /generate` with `stream:true` now answers 200 +
    // text/event-stream, not a 202 ack. `readGenerationId` reads the id off the first
    // frame, so the mock must be a real stream — a plain object fails on `stream.on`.
    // Mirrors `streamingGenerateAck` in prompt-management.service.test.ts.
    const streamingGenerateAck = (generationId: string) => {
      const stream = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
      stream.destroy = vi.fn();
      stream.on('newListener', (event) => {
        if (event !== 'data') return;
        setImmediate(() =>
          stream.emit('data', Buffer.from(`event: meta\ndata: {"generation_id":"${generationId}"}\nid: ${generationId}:0\n\n`)),
        );
      });
      return stream;
    };
    const post = opts.post ?? vi.fn().mockImplementation(async () => ({ data: streamingGenerateAck('task-1') }));
    const clsService = {
      get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : key === 'userAbility' ? { can: () => true } : null)),
      set: vi.fn(),
    };
    const svc = new PromptManagementService(
      { findById: vi.fn().mockResolvedValue(template), encryptFieldsIntoEntity: vi.fn(), updateWithVersion: vi.fn() } as never,
      { findByVersionNumber: vi.fn() } as never,
      {} as never,
      {} as never,
      { emit: vi.fn() } as never,
      clsService as never,
      {} as never,
      { axiosRef: { post, get: vi.fn() } } as never,
      { get: vi.fn().mockReturnValue('http://text.local:8862') } as never,
      undefined, // secretsService
      undefined, // userProfileService
      undefined, // entitlements
      undefined, // promotionGate
      undefined, // aiModelRepository
      undefined, // goldenCaseRepository
      undefined, // textRequestEnrichment
      { resolve: opts.resolve } as never, // TextAgentResolverService
    );
    return { svc, post };
  };

  /** A resolved spec whose primary is already wire-shaped (`azure` → `azure-openai`, sourceUri). */
  const spec = (provider: string, model: string) => ({ primary: { provider, model } });

  it('resolves {provider, model} from the tenant`s assigned TEXT_GENERATION agent', async () => {
    const resolve = vi.fn().mockResolvedValue(spec('lm-studio', 'medgemma-27b'));
    const { svc, post } = buildService({ resolve });

    const ack = await svc.startPromptTemplateTest('tpl-1', {} as never);

    expect(resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(ack.provider).toBe('lm-studio');
    expect(ack.model).toBe('medgemma-27b');
    const [, payload] = post.mock.calls[0];
    expect((payload as { provider?: string }).provider).toBe('lm-studio');
    expect((payload as { model?: string }).model).toBe('medgemma-27b');
  });

  it('takes the candidate`s wire provider verbatim — the azure→azure-openai alias is the resolver`s job, not re-done here', async () => {
    const resolve = vi.fn().mockResolvedValue(spec('azure-openai', 'gpt-4o'));
    const { svc } = buildService({ resolve });

    const ack = await svc.startPromptTemplateTest('tpl-1', {} as never);

    expect(ack.provider).toBe('azure-openai');
    expect(ack.model).toBe('gpt-4o');
  });

  it('MISS: no agent assigned at any tier → fail-closed BadRequestException, no TEXT call', async () => {
    const resolve = vi.fn().mockRejectedValue(new NotFoundException('nothing assigned'));
    const { svc, post } = buildService({ resolve });

    await expect(svc.startPromptTemplateTest('tpl-1', {} as never)).rejects.toThrow(/TEXT_GENERATION agent/);
    await expect(svc.startPromptTemplateTest('tpl-1', {} as never)).rejects.toThrow(BadRequestException);
    expect(post).not.toHaveBeenCalled();
  });

  it('ERROR: a lookup failure propagates as itself — never disguised as a miss', async () => {
    const boom = new Error('agent resolution exploded');
    const resolve = vi.fn().mockRejectedValue(boom);
    const { svc, post } = buildService({ resolve });

    await expect(svc.startPromptTemplateTest('tpl-1', {} as never)).rejects.toThrow(boom);
    expect(post).not.toHaveBeenCalled();
  });

  it('an explicit caller {provider, model} pair wins and skips the agent resolution entirely', async () => {
    const resolve = vi.fn();
    const { svc, post } = buildService({ resolve });

    const ack = await svc.startPromptTemplateTest('tpl-1', { provider: 'bedrock', model: 'claude' } as never);

    expect(resolve).not.toHaveBeenCalled();
    expect(ack.provider).toBe('bedrock');
    expect(post).toHaveBeenCalledTimes(1);
  });
});
