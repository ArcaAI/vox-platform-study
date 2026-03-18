import { INTERNAL_SERVER_ERROR, BaseException } from '../../common';

/**
 * Used to indicate an internal server error that does not fall under all other errors
 *
 * @class InternalServerErrorException
 * @extends {BaseException}
 */
export class InternalServerErrorException extends BaseException {
    static readonly message =
        'An unexpected internal server error has occurred.';
    readonly code = INTERNAL_SERVER_ERROR;

    constructor(message = InternalServerErrorException.message) {
        super(message);
    }
}
