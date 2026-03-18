import { ARGUMENT_OUT_OF_RANGE, BaseException } from '../../common';

/**
 * Used to indicate that an argument is out of allowed range
 * (for example: incorrect string/array length, number not in allowed min/max range etc)
 *
 * @class ArgumentOutOfRangeException
 * @extends {BaseException}
 */
export class ArgumentOutOfRangeException extends BaseException {
    static readonly message = 'Argument is out of the expected range.';
    readonly code = ARGUMENT_OUT_OF_RANGE;

    constructor(message = ArgumentOutOfRangeException.message) {
        super(message);
    }
}
