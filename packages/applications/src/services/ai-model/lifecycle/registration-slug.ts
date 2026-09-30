import { ConflictException } from '@nestjs/common';
import { AiModelRepository, ResourceStatusType, SYSTEM_TENANT_ID } from '@arcaai/domains';

/** How far a suggested slug steps (`<slug>-2` … `<slug>-<n>`) before registration gives up. */
const MAX_SUGGESTED_SLUG_STEPS = 50;

/**
 * The slug a new registry row takes. `AiModel(tenantId, slug)` is unique over EVERY row — an
 * unregistered (soft-deleted) or DISABLED model still holds its slug — so the check reads all
 * statuses, not just the live rows `findBySlug` sees.
 *
 * A slug the admin named is used exactly or refused (409 `SLUG_TAKEN`). A SUGGESTED slug steps to
 * the first free `<slug>-<n>`, so registering by repo id alone never needs a slug from the admin —
 * re-registering an unregistered repo included.
 */
export async function resolveRegistrationSlug(
  repository: Pick<AiModelRepository, 'findAll'>,
  requested: string | undefined,
  suggested: string,
): Promise<string> {
  const candidates = requested
    ? [requested]
    : [suggested, ...Array.from({ length: MAX_SUGGESTED_SLUG_STEPS - 1 }, (_, i) => `${suggested}-${i + 2}`)];
  const held = await repository.findAll({
    filters: { tenantId: SYSTEM_TENANT_ID, slug: { in: candidates }, resourceStatus: { in: Object.values(ResourceStatusType) } },
  } as never);
  const holders = new Map(held.map((row) => [row.slug, row.resourceStatus]));

  const free = candidates.find((slug) => !holders.has(slug));
  if (free) return free;

  const slug = requested ?? suggested;
  const unregistered = holders.get(slug) === ResourceStatusType.DELETED;
  throw new ConflictException({
    code: 'SLUG_TAKEN',
    message: unregistered
      ? `The slug '${slug}' belongs to an unregistered model; choose another slug.`
      : `A model with slug '${slug}' is already registered.`,
  });
}
