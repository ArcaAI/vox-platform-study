import { BadRequestException, ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { IRedisCacheService } from '../../baseServices/redis';

/** Where an `Idempotency-Key` is scoped: two operations, tenants or principals never collide. */
export interface IdempotencyScope {
  /** `summary`, `pre-summary`, `transcribe`, … */
  operation: string;
  tenantId: string;
  /** The acting principal (user id, or service-account id). */
  principalId: string;
  /** The caller's `Idempotency-Key`; absent ⇒ no idempotency (every call creates). */
  key: string | undefined | null;
}

interface IdempotencyRecord<T> {
  /** sha256 of the canonical request body. */
  fp: string;
  state: 'pending' | 'done';
  value?: T;
}

/** 24 h — the window the existing pre-summary dedupe already used. */
export const JOB_IDEMPOTENCY_TTL_SECONDS = 86_400;
const MAX_KEY_LENGTH = 255;
const KEY_PATTERN = /^[\x21-\x7e]+$/;

/** Atomic claim-or-read: SET NX EX, or answer the existing record. */
const CLAIM_LUA = [
  "local prior = redis.call('GET', KEYS[1])",
  'if prior then return prior end',
  "redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])",
  'return false',
].join('\n');

/**
 * TASK-1038 B3a (deliverable 6, R7) — `Idempotency-Key` on JOB starts: async summary,
 * pre-summary and the ASR transcription upload, matching what workflow runs already honour.
 *
 * - same key + same body ⇒ the same job (the first start's answer is replayed; nothing new runs);
 * - same key + a different body ⇒ 409 `IDEMPOTENCY_KEY_REUSED` (the key names ONE intent);
 * - same key while the first start is still in flight ⇒ 409 `IDEMPOTENCY_KEY_IN_FLIGHT` (retry
 *   shortly) — never a second, billed job;
 * - a start that FAILS releases the key, so the caller's retry may create.
 *
 * The claim is one atomic Redis script, so two concurrent duplicates cannot both create. Redis
 * being unreachable fails OPEN (the start proceeds un-deduplicated, as the pre-summary dedupe
 * always did): idempotency is a convenience on top of a durable start, never its gate.
 */
@Injectable()
export class JobIdempotencyService {
  private readonly logger = new Logger(JobIdempotencyService.name);

  constructor(@Inject(IRedisCacheService) private readonly cache: Pick<IRedisCacheService, 'get' | 'setex' | 'del' | 'eval'>) {}

  /** Canonical-JSON sha256 of whatever identifies the request (key order never matters). */
  fingerprint(input: unknown): string {
    return createHash('sha256').update(idempotencyCanonicalJson(input)).digest('hex');
  }

  redisKey(scope: IdempotencyScope): string {
    return `idempotency:${scope.operation}:${scope.tenantId}:${scope.principalId}:${scope.key}`;
  }

  /**
   * Run `create` at most once per (scope, body). `fromLegacy` maps a pre-TASK-1038 record (the
   * bare job id the pre-summary dedupe stored) to a replay value; without it such a record is
   * ignored and overwritten.
   */
  async run<T>(
    scope: IdempotencyScope,
    fingerprintInput: unknown,
    create: () => Promise<T>,
    fromLegacy?: (raw: string) => T,
  ): Promise<{ value: T; replayed: boolean }> {
    if (scope.key === undefined || scope.key === null || scope.key === '') return { value: await create(), replayed: false };
    if (scope.key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(scope.key)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_INVALID',
        message: `Idempotency-Key must be 1-${MAX_KEY_LENGTH} printable characters with no whitespace.`,
      });
    }
    const key = this.redisKey(scope);
    const fp = this.fingerprint(fingerprintInput);

    let prior: string | null;
    try {
      prior = (await this.cache.eval(CLAIM_LUA, 1, key, JSON.stringify({ fp, state: 'pending' } satisfies IdempotencyRecord<T>), JOB_IDEMPOTENCY_TTL_SECONDS)) as
        | string
        | null;
    } catch (err) {
      this.logger.warn({ message: 'Idempotency claim failed — starting without dedupe', operation: scope.operation, error: errorText(err) });
      return { value: await create(), replayed: false };
    }

    if (prior !== null && prior !== undefined) {
      const record = parseRecord<T>(prior);
      if (record === null) {
        if (fromLegacy) return { value: fromLegacy(prior), replayed: true };
      } else {
        if (record.fp !== fp) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'This Idempotency-Key was already used with a different request body.',
          });
        }
        if (record.state === 'done') return { value: record.value as T, replayed: true };
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_IN_FLIGHT',
          message: 'A request with this Idempotency-Key is still being processed. Retry shortly.',
        });
      }
      // An unreadable or legacy record with no mapper: take it over.
      await this.writeRecord(key, { fp, state: 'pending' });
    }

    let value: T;
    try {
      value = await create();
    } catch (err) {
      // swallow-ok: releasing the claim is best-effort; the claim expires on its own TTL.
      await this.cache.del(key).catch(() => undefined);
      throw err;
    }
    await this.writeRecord(key, { fp, state: 'done', value });
    return { value, replayed: false };
  }

  private async writeRecord<T>(key: string, record: IdempotencyRecord<T>): Promise<void> {
    try {
      await this.cache.setex(key, JOB_IDEMPOTENCY_TTL_SECONDS, JSON.stringify(record));
    } catch (err) {
      this.logger.warn({ message: 'Idempotency record could not be written — a retry may start a duplicate', error: errorText(err) });
    }
  }
}

function parseRecord<T>(raw: string): IdempotencyRecord<T> | null {
  try {
    const parsed = JSON.parse(raw) as IdempotencyRecord<T>;
    return parsed && typeof parsed === 'object' && typeof parsed.fp === 'string' && (parsed.state === 'pending' || parsed.state === 'done') ? parsed : null;
  } catch {
    return null;
  }
}

/** JSON with object keys sorted at every depth; `undefined` members are dropped, as JSON does. */
export function idempotencyCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : idempotencyCanonicalJson(item))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([name, member]) => `${JSON.stringify(name)}:${idempotencyCanonicalJson(member)}`).join(',')}}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
