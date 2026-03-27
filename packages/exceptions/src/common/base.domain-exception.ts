import { BaseException, SerializedException } from './base.exception';

/**
 * Base class for all domain-related exceptions.
 *
 * @abstract
 * @class BaseDomainException
 * @extends {BaseException}
 */
export abstract class BaseDomainException extends BaseException {
  constructor(
    override readonly message: string,
    readonly code: string,
    override readonly cause?: Error,
    override readonly metadata?: unknown,
  ) {
    super(message, cause, metadata);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }

  public override toJSON(): SerializedException {
    return super.toJSON();
  }
}
