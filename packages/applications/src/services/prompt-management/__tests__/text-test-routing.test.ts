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
 *  1. (RETIRED by TASK-881) `text.test` is no longer a registered task key — the `AiTaskDefault`
 *     facade, its `models.text.test` descriptor and the SYSTEM election are gone; the absence is
 *     pinned in `ai-routing-policy/__tests__/task-key-vocabulary.test.ts`.
 *  2. Resolution goes through `TextAgentResolverService`; a MISS (no agent at any tier ⇒
 *     fail-closed 400) is distinguished from a lookup ERROR (rethrown), and a caller-supplied
 *     pair still wins outright.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PromptManagementService } from '../prompt-management.service';

// ─── TASK-876: the assigned TEXT_GENERATION agent resolves the bench's model ───

describe('prompt-test model resolution runs on the ASSIGNED agent', () => {
  const template = {
    id: 'tpl-1',
    tenantId: 'tenant-1',
    // No undeclared/unresolved `{{...}}` reference — these tests exercise
    // MODEL ROUTING, not variable rendering (renderTemplate errors on an
    // unresolved reference with no default, TASK-890 §3.2).
    content: 'Summarize the transcript',
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
