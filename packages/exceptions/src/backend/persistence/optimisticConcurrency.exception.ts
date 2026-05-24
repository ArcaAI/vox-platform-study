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
 * @see TASK-302 Stream D Phase B
 * @see https://www.rfc-editor.org/rfc/rfc7232.html#section-4.2
 */
export class OptimisticConcurrencyException extends BasePersistenceException {
  static readonly code = CONCURRENCY_CONFLICT;

  constructor(
    entity: string,
    entityId: string,
    metadata: OptimisticConcurrencyMetadata,
    cause?: Error,
  ) {
    super(
      `[DB] ${entity} with ID ${entityId} was modified concurrently ` +
        `(expectedVersion=${metadata.expectedVersion}, currentVersion=${metadata.currentVersion}).`,
      OptimisticConcurrencyException.code,
      cause,
      metadata,
    );
  }
}
