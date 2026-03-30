import { ARGUMENT_NOT_PROVIDED, BaseException } from '../../common';

/**
 * Used to indicate that an argument was not provided (is empty object/array, null of undefined).
 *
 * @class ArgumentNotProvidedException
 * @extends {BaseException}
 */
export class ArgumentNotProvidedException extends BaseException {
  static readonly message = 'Expected argument not provided.';
  readonly code = ARGUMENT_NOT_PROVIDED;

  constructor(message = ArgumentNotProvidedException.message) {
    super(message);
  }
}
