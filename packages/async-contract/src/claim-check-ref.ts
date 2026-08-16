/**
 * `ClaimCheckRef` — the shape of an out-of-band blob reference, reused VERBATIM
 * from `apps/harness/src/harness/temporal/claim_check.py:64-80` (same six
 * fields, `contentType` is the camelCase wire spelling of `content_type`).
 *
 * Only the *shape* is shared here. The `BlobStore` implementation (S3, in
 * memory) is NOT lifted into this package — see
 * docs/architecture/agentic-workflow-platform/async-contract.md, Risk 3. A
 * TS producer that needs to offload has no store today.
 */
export interface ClaimCheckRef {
  /** Which BlobStore implementation wrote this ref, e.g. `s3`. */
  store: string;
  bucket: string;
  /** Content-addressed object key within the bucket. */
  key: string;
  /** Byte size of the referenced blob. */
  size: number;
  /** Lowercase hex SHA-256 of the referenced blob. */
  sha256: string;
  contentType: string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CLAIM_CHECK_KEYS: ReadonlySet<string> = new Set(['store', 'bucket', 'key', 'size', 'sha256', 'contentType']);

/**
 * Problems with a `payloadRef` value. Empty array = conforms. Never throws.
 */
export function claimCheckRefProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['payloadRef must be a JSON object'];
  }
  const obj = value as Record<string, unknown>;
  const problems: string[] = [];

  for (const key of Object.keys(obj)) {
    if (!CLAIM_CHECK_KEYS.has(key)) {
      problems.push(`payloadRef: unexpected property '${key}'`);
    }
  }

  if (typeof obj.store !== 'string' || obj.store.length === 0) {
    problems.push('payloadRef.store must be a non-empty string');
  }
  if (typeof obj.bucket !== 'string' || obj.bucket.length === 0) {
    problems.push('payloadRef.bucket must be a non-empty string');
  }
  if (typeof obj.key !== 'string' || obj.key.length === 0) {
    problems.push('payloadRef.key must be a non-empty string');
  }
  if (typeof obj.size !== 'number' || !Number.isInteger(obj.size) || obj.size < 0) {
    problems.push('payloadRef.size must be a non-negative integer');
  }
  if (typeof obj.sha256 !== 'string' || !SHA256_PATTERN.test(obj.sha256)) {
    problems.push('payloadRef.sha256 must be 64 lowercase hex characters');
  }
  if (typeof obj.contentType !== 'string' || obj.contentType.length === 0) {
    problems.push('payloadRef.contentType must be a non-empty string');
  }

  return problems;
}
