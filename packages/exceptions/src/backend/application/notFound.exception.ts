import { NOT_FOUND, BaseException } from '../../common';

/**
 * Used to indicate that entity is not found
 *
 * @class NotFoundException
 * @extends {BaseException}
 */
export class NotFoundException extends BaseException {
    static readonly message = 'The requested resource was not found.';
    readonly code = NOT_FOUND;

    constructor(message = NotFoundException.message) {
        super(message);
    }
}
