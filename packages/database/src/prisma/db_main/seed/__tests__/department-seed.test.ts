import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_DEPARTMENTS, DEFAULT_TENANT_ID, seedDepartment } from '../04-department';

describe('Department seed persistence key', () => {
  it('upserts by tenant and code without changing an existing department ID', async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const client = { department: { upsert } } as never;

    await seedDepartment(client);

    const firstCall = upsert.mock.calls[0]?.[0];
    const firstDepartment = DEFAULT_DEPARTMENTS[0];
    if (!firstCall || !firstDepartment) throw new Error('Department seed did not call upsert');

    expect(firstCall).toMatchObject({
      where: {
        tenantId_code: {
          tenantId: DEFAULT_TENANT_ID,
          code: 'GEN',
        },
      },
      create: expect.objectContaining({ id: firstDepartment.id }),
    });
    expect(firstCall.update).not.toHaveProperty('id');
  });
});
