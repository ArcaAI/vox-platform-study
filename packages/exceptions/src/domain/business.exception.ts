import { BUSINESS, BaseDomainException } from '../common';

/**
 * Exception for handling domain errors.
 *
 * @class BusinessException
 * @extends {BaseDomainException}
 */
export class BusinessException extends BaseDomainException {
  static readonly code = BUSINESS;
  constructor(message: string, cause?: Error, metadata?: unknown) {
    super(message, BusinessException.code, cause, metadata);
  }
}
