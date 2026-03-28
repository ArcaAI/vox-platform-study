import { DATABASE_CONNECTION_FAILED, BasePersistenceException } from '../../common';

/**
 * Exception for handling database connection failures.
 * This includes scenarios where the connection to the database cannot be established.
 *
 * @class DatabaseConnectionException
 * @extends {BasePersistenceException}
 */
export class DatabaseConnectionException extends BasePersistenceException {
  static readonly message = 'Failed to connect to the database.';
  static readonly code = DATABASE_CONNECTION_FAILED;
  constructor(message = DatabaseConnectionException.message, cause?: Error, metadata?: unknown) {
    super(message, DatabaseConnectionException.code, cause, metadata);
  }
}
