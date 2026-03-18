import { QUERY_FAILED, BasePersistenceException } from '../../common';

/**
 * Exception for handling query execution failures.
 * This is used when a database query fails due to syntax errors, constraints violation, or other issues.
 *
 * @class QueryFailedException
 * @extends {BasePersistenceException}
 */
export class QueryFailedException extends BasePersistenceException {
    static readonly message = 'Database query failed to execute.';
    static readonly code = QUERY_FAILED;

    constructor(
        message = QueryFailedException.message,
        cause?: Error,
        metadata?: unknown,
    ) {
        super(message, QueryFailedException.code, cause, metadata);
    }
}
