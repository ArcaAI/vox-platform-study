/**
 * One write gate for the model registry: every AiModelService write and every
 * platform registry read requires a platform admin — SUPER_ADMIN in a tenant-LESS
 * context — exactly like the registry operations (`assertPlatformRegistryAdmin`).
 * A super admin who has selected a working tenant is refused (403), and so is a
 * tenant admin, before any row is read.
 */
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { AiTaskKind } from '@arcaai/domains';
import { AiModelService } from '../aiModel.service';

const TENANT_A = '11111111-1111-1111-1111-111111111111';

function build(roles: string[], tenantId: string | null) {
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'user') return { id: 'u-1', roles };
      if (key === 'tenantId') return tenantId;
      return null;
    }),
    set: vi.fn(),
  };
  const repo = new Proxy({}, { get: () => vi.fn().mockResolvedValue(null) });
  const svc = new AiModelService(repo as never, { baseClient: {} } as never, { emit: vi.fn() } as never, cls as never);
  return { svc, repo };
}

const CALLS: Array<[string, (svc: AiModelService) => Promise<unknown>]> = [
  ['create', (s) => s.create({ name: 'x', slug: 'x' } as never)],
  ['update', (s) => s.update('m-1', { name: 'y' } as never)],
  ['delete', (s) => s.delete('m-1')],
  ['setPlatformDefaultFor', (s) => s.setPlatformDefaultFor('m-1', { tasks: [AiTaskKind.SPEECH_TO_TEXT] })],
  ['getById', (s) => s.getById('m-1')],
  ['getBySlug', (s) => s.getBySlug('x')],
  ['getAllForAdmin', (s) => s.getAllForAdmin()],
  ['list', (s) => s.list({})],
];

const CALLERS: Array<[string, string[], string | null]> = [
  ['super admin WITH a working tenant', ['SUPER_ADMIN'], TENANT_A],
  ['tenant admin', ['TENANT_ADMIN'], TENANT_A],
];

describe('AiModelService — the tenantless platform-admin gate', () => {
  for (const [who, roles, tenantId] of CALLERS) {
    for (const [name, call] of CALLS) {
      it(`${name}: 403 for a ${who}`, async () => {
        const { svc } = build(roles, tenantId);
        await expect(call(svc)).rejects.toBeInstanceOf(ForbiddenException);
      });
    }
  }

  it('a tenantless super admin passes the gate (reads reach the repository)', async () => {
    const { svc } = build(['SUPER_ADMIN'], null);
    await expect(svc.getById('m-1')).resolves.toBeNull();
  });
});
