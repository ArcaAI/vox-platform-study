/**
 * The Prompt Inspector and composed-prompt routes.
 *
 *  - the harness's `POST internal/composed-prompts` payload — EXACTLY what the harness lane sends
 *    — passes the GLOBAL validation pipe (whitelist + forbidNonWhitelisted + forbidUnknownValues),
 *    with and without the optional ids, for every phase it sends;
 *  - the route answers 202 at once, names its tenant from `X-Tenant-Id`, and refuses none / a
 *    tenant-less marker;
 *  - the admin routes delegate, and their request DTOs are validated.
 */
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { describe, expect, it, vi } from 'vitest';
import { ListComposedPromptsQuery, PromptPreviewRequest, RecordComposedPromptRequest } from '@arcaai/applications';
import { createGlobalValidationPipe } from '../../../filters/validation-violations';
import { ComposedPromptInternalController } from '../../internal/composed-prompt-internal.controller';
import { ComposedPromptAdminController } from '../composed-prompt-admin.controller';
import { PromptPreviewController } from '../prompt-preview.controller';

async function validate<T>(metatype: new () => T, value: unknown, type: 'body' | 'query' = 'body'): Promise<T> {
  return createGlobalValidationPipe().transform(plainToInstance(metatype, value), { type, metatype } as never) as Promise<T>;
}

/** The harness lane's exact body (TASK-1035 wave B, HARNESS-COMPOSER). */
const HARNESS_BODY = {
  consultationId: '0199a1b2-0000-7000-8000-000000000001',
  agentSlug: 'casenote-finalization',
  phase: 'finalize',
  provider: 'lm-studio',
  locality: 'local',
  system: 'PLATFORM RULES…\n\nWrite the note.',
  user: '<<<EXTERNAL_DATA section="transcript">>>\n--- TRANSCRIPT ---\n…\n<<<END_EXTERNAL_DATA>>>',
};

describe('POST internal/composed-prompts — the harness payload passes the global pipe', () => {
  it.each(['live', 'finalize', 'workflow', 'test', 'pre-summary'])('phase `%s`, both ids present', async (phase) => {
    await expect(validate(RecordComposedPromptRequest, { ...HARNESS_BODY, phase })).resolves.toMatchObject({ phase });
  });

  it('with consultationId and agentSlug ABSENT', async () => {
    const { consultationId: _c, agentSlug: _a, ...bare } = HARNESS_BODY;
    await expect(validate(RecordComposedPromptRequest, { ...bare, locality: 'cloud' })).resolves.toMatchObject({ locality: 'cloud' });
  });

  it('refuses an unknown key, an unknown locality and a missing message', async () => {
    await expect(validate(RecordComposedPromptRequest, { ...HARNESS_BODY, smuggled: true })).rejects.toBeInstanceOf(BadRequestException);
    await expect(validate(RecordComposedPromptRequest, { ...HARNESS_BODY, locality: 'edge' })).rejects.toBeInstanceOf(BadRequestException);
    const { system: _s, ...withoutSystem } = HARNESS_BODY;
    await expect(validate(RecordComposedPromptRequest, withoutSystem)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers accepted at once and records under the header`s tenant', () => {
    const service = { acceptInternal: vi.fn(), list: vi.fn(), getDecrypted: vi.fn() };
    const controller = new ComposedPromptInternalController(service as never);

    expect(controller.record(HARNESS_BODY as never, ' tenant-a ')).toEqual({ accepted: true });
    expect(service.acceptInternal).toHaveBeenCalledWith(HARNESS_BODY, 'tenant-a');
  });

  it('refuses a missing tenant and a tenant-less marker', () => {
    const controller = new ComposedPromptInternalController({ acceptInternal: vi.fn() } as never);
    expect(() => controller.record(HARNESS_BODY as never, undefined)).toThrow();
    expect(() => controller.record(HARNESS_BODY as never, 'tenantless:job-queue')).toThrow();
  });
});

describe('the admin routes', () => {
  it('prompt-preview validates the phase and delegates', async () => {
    await expect(validate(PromptPreviewRequest, { phase: 'finalize', agentSlug: 'a' })).resolves.toMatchObject({ phase: 'finalize' });
    await expect(validate(PromptPreviewRequest, { phase: 'summary' })).rejects.toBeInstanceOf(BadRequestException);

    const previews = { preview: vi.fn(async () => ({ system: 's' })) };
    await expect(new PromptPreviewController(previews as never).preview('c-1', { phase: 'live' })).resolves.toEqual({ system: 's' });
    expect(previews.preview).toHaveBeenCalledWith('c-1', { phase: 'live' });
  });

  it('composed-prompts list validates its query and both reads delegate', async () => {
    await expect(validate(ListComposedPromptsQuery, { consultationId: 'c-1', page: '2', limit: '50' }, 'query')).resolves.toMatchObject({
      page: 2,
      limit: 50,
    });
    await expect(validate(ListComposedPromptsQuery, { limit: '500' }, 'query')).rejects.toBeInstanceOf(BadRequestException);

    const service = { list: vi.fn(async () => ({ data: [] })), getDecrypted: vi.fn(async () => ({ id: 'r-1' })), acceptInternal: vi.fn() };
    const controller = new ComposedPromptAdminController(service as never);
    await controller.list({ consultationId: 'c-1' });
    await controller.getById('r-1');
    expect(service.list).toHaveBeenCalledWith({ consultationId: 'c-1' });
    expect(service.getDecrypted).toHaveBeenCalledWith('r-1');
  });
});
