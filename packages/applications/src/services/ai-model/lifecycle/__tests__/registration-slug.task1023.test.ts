/**
 * Registration slugs (TASK-1023). Found in the live proof: `AiModel(tenantId, slug)` is unique over
 * EVERY row, soft-deleted (unregistered) and DISABLED ones included, but the pre-check only saw
 * ENABLED rows — so re-registering an unregistered repo died with a raw
 * PERSISTENCE.UNIQUE_CONSTRAINT_VIOLATION. A suggested slug now steps to the first free one; a slug the
 * admin named is a clean 409 SLUG_TAKEN.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { ResourceStatusType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { resolveRegistrationSlug } from '../registration-slug';

function repoHolding(rows: Array<{ slug: string; resourceStatus: ResourceStatusType }>) {
  return {
    findAll: vi.fn(async (props: { filters: { slug: { in: string[] } } }) => rows.filter((row) => props.filters.slug.in.includes(row.slug))),
  };
}

describe('resolveRegistrationSlug', () => {
  it('a free suggested slug is used as is, and the read covers every resource status', async () => {
    const repo = repoHolding([]);
    await expect(resolveRegistrationSlug(repo as never, undefined, 'tiny-gpt2')).resolves.toBe('tiny-gpt2');
    const filters = (repo.findAll.mock.calls[0][0] as { filters: Record<string, unknown> }).filters;
    expect(filters.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(filters.resourceStatus).toEqual({ in: Object.values(ResourceStatusType) });
  });

  it('a suggested slug held by an UNREGISTERED (deleted) row steps to the next free one', async () => {
    const repo = repoHolding([{ slug: 'tiny-gpt2', resourceStatus: ResourceStatusType.DELETED }]);
    await expect(resolveRegistrationSlug(repo as never, undefined, 'tiny-gpt2')).resolves.toBe('tiny-gpt2-2');
  });

  it('skips every held candidate, whatever its status', async () => {
    const repo = repoHolding([
      { slug: 'm', resourceStatus: ResourceStatusType.ENABLED },
      { slug: 'm-2', resourceStatus: ResourceStatusType.DISABLED },
      { slug: 'm-3', resourceStatus: ResourceStatusType.DELETED },
    ]);
    await expect(resolveRegistrationSlug(repo as never, undefined, 'm')).resolves.toBe('m-4');
  });

  it('a slug the admin NAMED that a live row holds → 409 SLUG_TAKEN', async () => {
    const repo = repoHolding([{ slug: 'mine', resourceStatus: ResourceStatusType.ENABLED }]);
    const error = await resolveRegistrationSlug(repo as never, 'mine', 'ignored').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'SLUG_TAKEN' });
  });

  it('a slug the admin NAMED that an unregistered row holds → 409 SLUG_TAKEN saying so', async () => {
    const repo = repoHolding([{ slug: 'old', resourceStatus: ResourceStatusType.DELETED }]);
    const error = (await resolveRegistrationSlug(repo as never, 'old', 'ignored').catch((e: unknown) => e)) as ConflictException;
    expect(error.getResponse()).toMatchObject({ code: 'SLUG_TAKEN', message: expect.stringMatching(/unregistered/i) });
  });
});
