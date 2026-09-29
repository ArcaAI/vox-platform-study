import { UNAUTHORIZED, BaseException, ExceptionOptions } from '../../common';

/**
 * Used to indicate that entity is not found
 *
 * @class UnauthorizedException
 * @extends {BaseException}
 */
export class UnauthorizedException extends BaseException {
  static readonly message = 'Unauthorized';

  constructor(message = UnauthorizedException.message, options?: ExceptionOptions) {
    super(message, options?.cause, options?.metadata);
  }

  readonly code = UNAUTHORIZED;
}
