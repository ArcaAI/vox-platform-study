/**
 * TASK-998 OD-4 — read the ASR provider out of a gateway-resolved ASR spec.
 *
 * Both enforcement sites (batch-job create, streaming-session open) receive the
 * spec as an opaque JSON payload — `CreateJobRequest.resolvedSpec` is
 * `Record<string, unknown>` and the streaming DTO carries a `ResolvedAsrSpec` —
 * so the read is written once, defensively, rather than twice with two shapes.
 *
 * The field is `models.asr.provider` (`packages/types/src/asr-spec.ts`), which
 * is `AiModel.provider` for the row the gateway resolved. It is `null` for a
 * self-hosted engine, and that is the correct answer: there is no vendor account
 * behind a local model, so there is nothing to bound and the capacity guard is a
 * no-op.
 */
export function asrProviderFromSpec(spec: unknown): string | null {
  if (!spec || typeof spec !== 'object') return null;
  const models = (spec as Record<string, unknown>).models;
  if (!models || typeof models !== 'object') return null;
  const asr = (models as Record<string, unknown>).asr;
  if (!asr || typeof asr !== 'object') return null;
  const provider = (asr as Record<string, unknown>).provider;
  return typeof provider === 'string' && provider.length > 0 ? provider : null;
}
