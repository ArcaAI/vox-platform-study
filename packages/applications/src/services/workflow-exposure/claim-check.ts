/**
 * The ONE bucket every compiled-config claim check is minted into. Exported so the two
 * dispatchers (the public exposure plane and consultation-open) cannot drift: they did.
 * hard-coded a second literal (`hope-workflow-config`) while its own comment
 * claimed it mirrored this value, so every consultation-open dispatch failed at runtime with
 * "The specified bucket does not exist" — silently, because dispatch is best-effort.
 */
export const CLAIM_CHECK_BUCKET = 'harness-claim-check';

import { createHash } from 'node:crypto';
import { canonicalJson } from '@arcaai/workflow-contract';
import { HarnessClaimCheckRef } from '../consultation/harness/harness-gateway.service';

/** Content-type the harness's own `claim_check.py` writes for every offloaded blob (`CONTENT_TYPE`). */
const CLAIM_CHECK_CONTENT_TYPE = 'text/plain; charset=utf-8';

/**
 * Mint a content-addressed `ClaimCheckRef` for a definition's `compiledConfig`
 * (closing the gap `POST /workflow-runs:start` requires — it
 * never accepts a raw compiled config, only a pre-minted ref;
 * `interpreter.py:StartWorkflowRunRequest`'s docstring).
 *
 * Mirrors `apps/harness/.../claim_check.py:store_blob` EXACTLY so the ref
 * round-trips: `key = sha256(utf8 bytes)`, `store = 's3'` (never `'memory'`
 * — this gateway is a DIFFERENT PROCESS from the harness worker, so the
 * worker's process-local in-memory fake can never see a ref this process
 * wrote; only the self-hosted MinIO backend is reachable cross-process).
 * `put` is the caller-supplied write (an `IS3Service.putFile` closure) so
 * this stays pure and unit-testable without a live MinIO.
 */
export async function mintCompiledConfigClaimCheckRef(
  compiledConfig: unknown,
  bucket: string,
  put: (bucket: string, key: string, data: Buffer, contentType: string) => Promise<void>,
): Promise<HarnessClaimCheckRef> {
  const canonical = canonicalJson(compiledConfig);
  const bytes = Buffer.from(canonical, 'utf-8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  await put(bucket, sha256, bytes, CLAIM_CHECK_CONTENT_TYPE);

  return {
    store: 's3',
    bucket,
    key: sha256,
    size: bytes.length,
    sha256,
    content_type: CLAIM_CHECK_CONTENT_TYPE,
  };
}
