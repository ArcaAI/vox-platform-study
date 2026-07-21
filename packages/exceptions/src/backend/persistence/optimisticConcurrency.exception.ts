import { CONCURRENCY_CONFLICT, BasePersistenceException } from '../../common';

export interface OptimisticConcurrencyMetadata {
  expectedVersion: number;
  currentVersion: number;
}

/**
 * Thrown when a Compare-And-Set (CAS) write fails because the entity's
 * `_version` column advanced between the caller's read and the caller's
 * write. The HTTP layer maps this to `412 Precondition Failed`.
 *
 * @class OptimisticConcurrencyException
 * @extends {BasePersistenceException}
 *
 * @see https://www.rfc-editor.org/rfc/rfc7232.html#section-4.2
 */
export class OptimisticConcurrencyException extends BasePersistenceException {
  static readonly code = CONCURRENCY_CONFLICT;

  /**
   * Domain model that raised the conflict (e.g. `'GlobalSetting'`,
   * `'Tenant'`). Surfaced as a separate field — not folded into
   * `metadata` — so it can be used as a Prometheus label without
   * affecting the JSON body shape the SDK / UI conflict-handler
   * already consumes.
   *
   * @see `optimistic_lock_conflict_total` — the Prometheus metric this label feeds
   */
  public readonly model: string;

  /**
   * Row id that raised the conflict. Public so the interceptor can
   * structured-log it (already in the message but parsing the message
   * is brittle).
   */
  public readonly entityId: string;

  constructor(entity: string, entityId: string, metadata: OptimisticConcurrencyMetadata, cause?: Error) {
    super(
      `[DB] ${entity} with ID ${entityId} was modified concurrently ` +
        `(expectedVersion=${metadata.expectedVersion}, currentVersion=${metadata.currentVersion}).`,
      OptimisticConcurrencyException.code,
      cause,
      metadata,
    );
    this.model = entity;
    this.entityId = entityId;
  }
}
