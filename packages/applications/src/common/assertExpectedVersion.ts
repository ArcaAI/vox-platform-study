import { BaseEntity } from '@arcaai/domains';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';

/**
 * Evaluate the optimistic-concurrency precondition BEFORE any no-changes
 * short-circuit.
 *
 * ORDERING RULE (RFC 7232 §13.1, and the OCC contract this codebase exposes as
 * ETag/If-Match -> 428/412): the precondition is a property of the REQUEST
 * against the CURRENT resource state. It must be evaluated whether or not the
 * payload would change anything. A stale client must be told "you are stale,
 * refetch" (412) — never "fix your body" (400), and never a silent 200.
 *
 * Why this exists: the canonical service shape is
 *
 *   updateEntity(entity, changes)
 *   if (!entity.hasChanges) throw new ArgumentInvalidException(...)  // or `continue`
 *   repository.updateWithVersion(id, entity, expectedVersion)        // <- CAS lives HERE
 *
 * so the ONLY place the version was ever compared was inside the CAS, which
 * sits AFTER the guard. That stayed invisible for as long as `updateEntity`
 * stamped `updatedBy` unconditionally (which made `hasChanges` always true, so
 * every request reached the CAS); once that stamp became conditional, a no-op
 * payload carrying a stale version short-circuited before the precondition was
 * ever evaluated. Calling this immediately BEFORE the guard restores the order
 * regardless of what the payload contains.
 *
 * A `null`/`undefined` `expectedVersion` means "no precondition supplied" and is
 * a no-op — routes that REQUIRE one enforce that separately (`@RequiresIfMatch()`
 * -> 428 at the HTTP layer). The CAS still runs afterwards and remains the
 * authoritative check against writers racing between this comparison and the
 * write.
 *
 * Exported as a free function (rather than living only on `BaseService`) because
 * several services carrying this exact shape — `HarnessPolicyService`,
 * `PipelinePolicyService` — do not extend `BaseService`, and duplicating the
 * comparison is how the two halves drift apart.
 *
 * @param entity - the freshly-read entity whose `version` is the current state
 * @param expectedVersion - the client-supplied version, if any
 * @param model - model name for the error payload (Prometheus label + message)
 */
export function assertExpectedVersion(entity: BaseEntity, expectedVersion: number | null | undefined, model: string): void {
  if (expectedVersion === undefined || expectedVersion === null) {
    return;
  }
  if (expectedVersion !== entity.version) {
    throw new OptimisticConcurrencyException(model, entity.id, {
      expectedVersion,
      currentVersion: entity.version,
    });
  }
}
