/**
 * `text.test` routing tier for the prompt-template test bench.
 *
 * Two halves:
 *  1. The additive registration points the bench depends on outside the service
 *     itself — the AiTaskDefault task key + its model-task-type mapping (+
 *     tenant-write eligibility), and the `models.text.test` settings-registry
 *     descriptor.
 *  2. BUG-018 — model resolution reads `IAiTaskDefaultService.getEffective`
 *     DIRECTLY. The harness policy service is not injected and never consulted,
 *     there is no `text.finalize` fallback, and a MISS (fail-closed 400) is
 *     distinguished from a lookup ERROR (rethrown).
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
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

// ─── BUG-018: AiTaskDefault-only resolution ───────────────────────────

describe('prompt-test model resolution (BUG-018 harness decoupling)', () => {
  const template = {
    id: 'tpl-1',
    tenantId: 'tenant-1',
    content: 'Summarize {{topic}}',
    category: 'SYSTEM',
    variables: null,
    version: 1,
  };

  const buildService = (opts: {
    getEffective: ReturnType<typeof vi.fn>;
    post?: ReturnType<typeof vi.fn>;
  }) => {
    const post = opts.post ?? vi.fn().mockResolvedValue({ data: { task_id: 'task-1', stream_url: '/api/v1/tasks/task-1/stream' } });
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
      { get: vi.fn().mockReturnValue('http://smr.local:8862') } as never,
      undefined, // secretsService
      { getEffective: opts.getEffective } as never, // IAiTaskDefaultService
    );
    return { svc, post };
  };

  it('resolves {provider, model} from getEffective("text.test", tenantId) and never touches harness policy', async () => {
    const getEffective = vi.fn().mockResolvedValue({
      taskKey: 'text.test',
      model: { provider: 'lm-studio', sourceUri: 'medgemma-27b' },
    });
    const { svc, post } = buildService({ getEffective });

    const ack = await svc.startPromptTemplateTest('tpl-1', {} as never);

    expect(getEffective).toHaveBeenCalledWith('text.test', 'tenant-1');
    // No second lookup — the text.finalize hop is gone.
    expect(getEffective).toHaveBeenCalledTimes(1);
    expect(ack.provider).toBe('lm-studio');
    expect(ack.model).toBe('medgemma-27b');
    const [, payload] = post.mock.calls[0];
    expect((payload as { provider?: string }).provider).toBe('lm-studio');
    expect((payload as { model?: string }).model).toBe('medgemma-27b');
  });

  it("maps the registry provider 'azure' onto SMR's 'azure-openai'", async () => {
    const getEffective = vi.fn().mockResolvedValue({ model: { provider: 'azure', sourceUri: 'gpt-4o' } });
    const { svc } = buildService({ getEffective });

    const ack = await svc.startPromptTemplateTest('tpl-1', {} as never);

    expect(ack.provider).toBe('azure-openai');
    expect(ack.model).toBe('gpt-4o');
  });

  it('MISS: text.test resolves to nothing → BadRequestException naming the key, no SMR call', async () => {
    const getEffective = vi.fn().mockResolvedValue({ taskKey: 'text.test', modelSlug: null, source: null, model: null });
    const { svc, post } = buildService({ getEffective });

    await expect(svc.startPromptTemplateTest('tpl-1', {} as never)).rejects.toThrow(/text\.test/);
    await expect(svc.startPromptTemplateTest('tpl-1', {} as never)).rejects.toThrow(BadRequestException);
    expect(post).not.toHaveBeenCalled();
  });

  it('ERROR: a lookup failure propagates as itself — never disguised as a miss', async () => {
    const boom = new Error('AiTaskDefault lookup exploded');
    const getEffective = vi.fn().mockRejectedValue(boom);
    const { svc, post } = buildService({ getEffective });

    await expect(svc.startPromptTemplateTest('tpl-1', {} as never)).rejects.toThrow(boom);
    expect(post).not.toHaveBeenCalled();
  });

  it('an explicit caller {provider, model} pair wins and skips the task-default lookup entirely', async () => {
    const getEffective = vi.fn();
    const { svc, post } = buildService({ getEffective });

    const ack = await svc.startPromptTemplateTest('tpl-1', { provider: 'bedrock', model: 'claude' } as never);

    expect(getEffective).not.toHaveBeenCalled();
    expect(ack.provider).toBe('bedrock');
    expect(post).toHaveBeenCalledTimes(1);
  });
});
