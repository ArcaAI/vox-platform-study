/** TASK-1057 — `documentTemplate.update` (the version-producing publish) consults the reason policy. */
import { describe, expect, it, vi } from 'vitest';
import { ActionConfirmationService } from '../../settings-registry/action-confirmation.service';
import { DocumentTemplateService } from '../document-template.service';

const SHAPE = { schemaVersion: '1.0', title: 'T', sections: [{ key: 'a1', title: 'A', form: 'PROSE' }] };

function build(mode: 'required' | 'not-required') {
  const entity = { id: 't1', tenantId: 'tenant-1', status: 'DRAFT', pinnedVersionNumber: null, version: 1, toObject() { return { ...this }; } };
  const templates = { findById: vi.fn(async () => entity), update: vi.fn(async (_i: string, e: unknown) => e) };
  const versions = { findLatestForTemplate: vi.fn(async () => null), create: vi.fn(async (v: { versionNumber: number }) => ({ id: 'v1', ...v })) };
  const emit = vi.fn();
  const cls = { get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: ['TENANT_ADMIN'] } : k === 'tenantId' ? 'tenant-1' : undefined)) };
  const confirmations = new ActionConfirmationService({ resolve: vi.fn(() => ({ value: mode })) } as never);
  const service = new DocumentTemplateService(templates as never, versions as never, { emit } as never, cls as never, confirmations);
  return { service, versions, templates, emit };
}

describe('DocumentTemplateService.publish — action confirmation (TASK-1057)', () => {
  it('passes without a changeReason by default and stamps the sys-event', async () => {
    const { service, versions, emit } = build('not-required');
    await service.publish('t1', { shape: SHAPE });
    expect(versions.create).toHaveBeenCalled();
    expect(JSON.stringify(emit.mock.calls)).toContain('reason not required');
  });

  it('refuses 400 CONFIRMATION_REQUIRED before any write when required and missing', async () => {
    const { service, versions, templates } = build('required');
    await expect(service.publish('t1', { shape: SHAPE })).rejects.toMatchObject({
      response: { code: 'CONFIRMATION_REQUIRED', actionId: 'documentTemplate.update' },
    });
    expect(versions.create).not.toHaveBeenCalled();
    expect(templates.update).not.toHaveBeenCalled();
  });
});
