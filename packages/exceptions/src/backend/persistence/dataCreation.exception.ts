import { DATA_CREATION_FAILED, BasePersistenceException } from '../../common';

/**
 * Exception for handling errors specifically arising during the creation of data, such as insert operations that fail.
 *
 * @class DataCreationException
 * @extends {BasePersistenceException}
 */
export class DataCreationException extends BasePersistenceException {
    static readonly message = 'Failed to create data in the database.';
    static readonly code = DATA_CREATION_FAILED;

    constructor(entity: string, cause?: Error, metadata?: unknown) {
        super(
            `[DB] Could not create ${entity}`,
            DataCreationException.code,
            cause,
            metadata,
        );
    }
}
