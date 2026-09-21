/**
 * TASK-999 (D-6(a)) — WHICH entry of a resolved ASR spec's chain ACTUALLY served.
 *
 * `resolvedSpec` is a snapshot of what COULD run: the primary spec itself plus
 * `fallback.chain`, an ordered list of engines the runtime may switch to. Nothing
 * recorded what DID run, and the engine name alone cannot answer it — a primary and
 * a fallback may name the same provider on two of the tenant's accounts, and the
 * fallback chain routinely holds another quantisation of the primary's own model.
 *
 * The one piece of evidence both completion paths already hold is the ENGINE id
 * (`transcribe.batch`'s `dto.engine`, `transcribe.stream`'s per-segment `engine`),
 * so this maps that back onto the chain and records what it can prove.
 */
import type { AsrSpecCore, ResolvedAsrSpec } from '@arcaai/types';

/**
 * TASK-999 §3.1 C-2 — the frozen wire shape. Persisted verbatim into
 * `TranscriptionJob.servedBy` and echoed on `TranscriptionJobResponse`.
 *
 * `chainIndex` is an index into `resolvedSpec.fallback.chain` and `-1` means
 * "not an element of that array". `source` says WHY it is `-1`:
 *   - `primary`  — the resolved spec itself served; the primary is not a member
 *                  of `fallback.chain`, so there is no index to give.
 *   - `fallback` with `chainIndex >= 0` — that chain entry served.
 *   - `fallback` with `chainIndex === -1` — the engine that served is provably
 *     NOT the primary (its identity does not match), but it matches no chain
 *     entry either, so which fallback it was is unknown. Recorded rather than
 *     guessed: the engine name is still more than `null`.
 */
export interface ServedBy {
  chainIndex: number;
  source: 'primary' | 'fallback';
  agentSlug: string | null;
  modelSlug: string | null;
  provider: string | null;
  engine: string | null;
}

/**
 * Fold the several spellings of one engine onto a single token.
 *
 * The ledger's engine vocabulary and `AiModel.libraryName` disagree on separators
 * for the same engine — `whisper_cpp` vs `whisper.cpp`, `faster_whisper` vs
 * `faster-whisper` — while the cloud four agree exactly (`sarvam`, `openai`,
 * `azure-speech`, `azure-foundry`). Comparing on a separator-insensitive token
 * matches both families without a hand-maintained alias table, which would be one
 * more place for a new engine to be forgotten.
 */
function engineToken(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.toLowerCase().replace(/[-._]/g, '');
}

/**
 * Every token that identifies the engine of ONE chain entry: the registry row's
 * `provider` (set for a vendor engine, `null` for a self-hosted one) and its
 * `libraryName` / `format`, which is what names a self-hosted engine.
 */
function chainEntryTokens(entry: AsrSpecCore | null | undefined): Set<string> {
  const asr = entry?.models?.asr;
  const tokens = new Set<string>();
  for (const candidate of [asr?.provider, asr?.libraryName, asr?.format]) {
    const token = engineToken(candidate);
    if (token) tokens.add(token);
  }
  return tokens;
}

function entryFacts(entry: AsrSpecCore | null | undefined, engine: string | null): Omit<ServedBy, 'chainIndex' | 'source'> {
  return {
    agentSlug: entry?.agent?.slug ?? null,
    modelSlug: entry?.models?.asr?.slug ?? null,
    provider: entry?.models?.asr?.provider ?? null,
    engine: engine ?? null,
  };
}

/**
 * Resolve the `servedBy` record for one completion.
 *
 * `spec` arrives as opaque JSON on both call sites (`TranscriptionJob.resolvedSpec`
 * is `JsonValue`), so the read is defensive in the same way `asrProviderFromSpec`
 * is. Returns `null` — "not recorded" — only when there is genuinely nothing to
 * say: no spec at all, or no engine to place in it.
 */
export function resolveServedBy(spec: unknown, engine: string | null | undefined): ServedBy | null {
  const engineName = typeof engine === 'string' && engine.length > 0 ? engine : null;
  if (!spec || typeof spec !== 'object' || !engineName) return null;

  const resolved = spec as unknown as ResolvedAsrSpec;
  const wanted = engineToken(engineName);

  if (wanted && chainEntryTokens(resolved).has(wanted)) {
    return { chainIndex: -1, source: 'primary', ...entryFacts(resolved, engineName) };
  }

  const chain = Array.isArray(resolved.fallback?.chain) ? resolved.fallback.chain : [];
  for (const [index, entry] of chain.entries()) {
    if (wanted && chainEntryTokens(entry).has(wanted)) {
      return { chainIndex: index, source: 'fallback', ...entryFacts(entry, engineName) };
    }
  }

  // Unmatched. `source: 'fallback'` is not a guess — the engine that served does
  // not identify as the primary, so the runtime had switched away from it — but
  // WHICH fallback it was is unknown, hence `chainIndex: -1` and no agent/model.
  // Guessing an entry here would put a wrong model on a billing-adjacent row.
  return { chainIndex: -1, source: 'fallback', agentSlug: null, modelSlug: null, provider: null, engine: engineName };
}
