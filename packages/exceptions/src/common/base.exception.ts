import { ClsServiceManager } from 'nestjs-cls';

export interface SerializedException {
    message: string;
    code: string;
    correlationId: string;
    stack?: string;
    cause?: string;
    metadata?: unknown;
}

/**
 * Base class for custom exceptions.
 *
 * @abstract
 * @class ExceptionBase
 * @extends {Error}
 */
export abstract class BaseException extends Error {
    abstract code: string;

    public readonly correlationId: string;

    /**
     * @param {string} message
     * @param {ObjectLiteral} [metadata={}]
     */
    constructor(
        override readonly message: string,
        readonly cause?: Error,
        readonly metadata?: unknown,
    ) {
        super(message);
        Error.captureStackTrace(this, this.constructor);
        const cls = ClsServiceManager.getClsService();
        this.correlationId = cls.getId();
    }

    /**
     * By default in NodeJS Error objects are not
     * serialized properly when sending plain objects
     * to external processes. This method is a workaround.
     * Keep in mind not to return a stack trace to user when in production.
     * https://iaincollins.medium.com/error-handling-in-javascript-a6172ccdf9af
     */
    public toJSON(): SerializedException {
        return {
            message: this.message,
            code: this.code,
            correlationId: this.correlationId,
            stack:
                process.env['NODE_ENV'] === 'production'
                    ? undefined
                    : this.stack,
            cause: this.cause ? JSON.stringify(this.cause) : undefined,
            metadata: this.metadata,
        };
    }
}
