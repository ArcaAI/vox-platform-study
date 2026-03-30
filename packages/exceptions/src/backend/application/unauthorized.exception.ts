import { UNAUTHORIZED, BaseException } from '../../common';

/**
 * Used to indicate that entity is not found
 *
 * @class UnauthorizedException
 * @extends {BaseException}
 */
export class UnauthorizedException extends BaseException {
  static readonly message = 'Unauthorized';

  constructor(message = UnauthorizedException.message) {
    super(message);
  }

  readonly code = UNAUTHORIZED;
}
