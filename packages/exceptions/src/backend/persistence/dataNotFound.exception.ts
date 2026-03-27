import { DATA_NOT_FOUND, BasePersistenceException } from '../../common';

/**
 * Exception for handling cases where expected data is not found in the database.
 * Useful for fetch operations where the absence of data needs to trigger specific error handling.
 *
 * @class DataNotFoundException
 * @extends {BasePersistenceException}
 */
export class DataNotFoundException extends BasePersistenceException {
  static readonly message = 'Required data was not found in the database.';
  static readonly code = DATA_NOT_FOUND;

  constructor(entity: string, entityId: string, cause?: Error, metadata?: unknown) {
    super(`[DB] ${entity} with ID ${entityId} could not be found.`, DataNotFoundException.code, cause, metadata);
  }
}
