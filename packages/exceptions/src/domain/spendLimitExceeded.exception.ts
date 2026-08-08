import { SPEND_LIMIT_EXCEEDED, BaseDomainException } from '../common';

/**
 * Structured detail carried by a {@link SpendLimitExceededException} so the API
 * gateway can render a precise 402 body and the console can show the tenant how
 * far over its self-set cap it is. All money is integer micros as a string
 * (bigint never rides a JSON double).
 */
export interface SpendLimitExceededMetadata {
  /** The tenant the block applied to. */
  tenantId: string;
  /** UTC calendar-month period the limit applies to (e.g. `2026-08`). */
  period: string;
  /** The tenant's self-set monthly spend limit, in micros. */
  spendLimitMicros: string;
  /** SELL-rated overage spend accrued so far this period, in micros. */
  overageSpendMicros: string;
}

/**
 * Thrown when a tenant that has set an optional monthly spend limit (D12) has
 * already reached it and a further paid (overage) action is attempted. Only ever
 * thrown when the enforcement kill-switch is on AND the tenant actually set a
 * limit (an unset limit is "unlimited", never a block). The plan fee and usage
 * within allowances are unaffected — this gates NEW overage spend only, and maps
 * to HTTP 402 Payment Required at the gateway.
 */
export class SpendLimitExceededException extends BaseDomainException {
  static readonly code = SPEND_LIMIT_EXCEEDED;
  constructor(message: string, metadata?: SpendLimitExceededMetadata, cause?: Error) {
    super(message, SpendLimitExceededException.code, cause, metadata);
  }
}
