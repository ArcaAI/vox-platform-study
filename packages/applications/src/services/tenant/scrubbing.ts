import { GlobalSettingEntity, getSecretFields } from '@arcaai/domains';

/**
 * Phase 0 Item 4 (TASK-302 Stream A) — pure utility.
 *
 * Converts a GlobalSettingEntity to a plain object suitable for an
 * audit-log payload. If the entity has `locked === true`, every field
 * decorated with `@Secret` is replaced with '[REDACTED]'. Non-locked
 * rows are returned via the unmodified `entity.toObject()` shape.
 *
 * The decision is per-entity (not per-call) so a mixed batch
 * (one locked, one not) emits a partially-scrubbed array.
 */
export function scrubLockedForAudit(entity: GlobalSettingEntity): object {
  const plain = entity.toObject() as Record<string, unknown>;
  if (entity.locked !== true) return plain;

  const secrets = getSecretFields(Object.getPrototypeOf(entity));
  const scrubbed: Record<string, unknown> = { ...plain };
  for (const key of secrets) {
    if (key in scrubbed) scrubbed[key] = '[REDACTED]';
  }
  return Object.freeze(scrubbed);
}
