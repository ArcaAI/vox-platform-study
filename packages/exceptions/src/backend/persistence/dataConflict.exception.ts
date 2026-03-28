import { DATA_CONFLICT, BasePersistenceException } from '../../common';

/**
 * Exception for handling data conflicts in the database.
 * This typically occurs during operations like insert or update when unique constraints are violated.
 *
 * @class DataConflictException
 * @extends {BasePersistenceException}
 */
export class DataConflictException extends BasePersistenceException {
  static readonly message = 'Data conflict occurred in the database.';
  static readonly code = DATA_CONFLICT;
  constructor(message = DataConflictException.message, cause?: Error, metadata?: unknown) {
    super(message, DataConflictException.code, cause, metadata);
  }
}
