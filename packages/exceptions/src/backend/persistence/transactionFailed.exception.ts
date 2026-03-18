import { TRANSACTION_FAILED, BasePersistenceException } from '../../common';

/**
 * Exception for handling transaction failures.
 * This is used when a database transaction cannot be completed successfully, such as in cases of rollback or deadlock.
 *
 * @class TransactionFailedException
 * @extends {BasePersistenceException}
 */
export class TransactionFailedException extends BasePersistenceException {
    static readonly message = 'Database transaction failed.';
    static readonly code = TRANSACTION_FAILED;
    constructor(
        message = TransactionFailedException.message,
        cause?: Error,
        metadata?: unknown,
    ) {
        super(message, TransactionFailedException.code, cause, metadata);
    }
}
