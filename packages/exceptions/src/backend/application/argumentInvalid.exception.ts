import { ARGUMENT_INVALID, BaseException } from '../../common';

/**
 * Used to indicate that an incorrect argument was provided to a method/function/class constructor
 *
 * @class ArgumentInvalidException
 * @extends {BaseException}
 */
export class ArgumentInvalidException extends BaseException {
  static readonly message = 'The provided argument(s) are invalid.';
  readonly code = ARGUMENT_INVALID;

  constructor(message = ArgumentInvalidException.message) {
    super(message);
  }
}
