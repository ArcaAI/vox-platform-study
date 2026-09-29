import { CONFLICT, BaseException, ExceptionOptions } from '../../common';

/**
 * Used to indicate conflicting entities (usually in the database)
 *
 * @class ConflictException
 * @extends {BaseException}
 */
export class ConflictException extends BaseException {
  static readonly message = 'Conflict detected, operation cannot be completed.';
  readonly code = CONFLICT;

  constructor(message = ConflictException.message, options?: ExceptionOptions) {
    super(message, options?.cause, options?.metadata);
  }
}
