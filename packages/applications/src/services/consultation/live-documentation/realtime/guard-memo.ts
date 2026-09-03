/**
 *  — guard memoization keyed on `(guard, config, inputHash)`.
 *
 * ## Why config is IN the key
 *
 * With one document per consultation, a guard ran once per flush and there was
 * nothing to memoize. With several documents generating concurrently, the SAME
 * guard runs several times per flush — often over identical input, because two
 * documents drawn from one transcript overlap heavily. Memoizing is what stops
 * that becoming N groundedness round-trips per turn.
 *
 * The trap is keying on input alone. Two generation nodes may run the SAME guard
 * at DIFFERENT thresholds — a discharge summary held to 0.9 and a running note to
 * 0.6 are two genuinely different verdicts on the same text. A cache keyed on
 * input would serve one node the other's answer, and a clinician would see a
 * document marked grounded under a threshold it was never checked against. So the
 * key is `sha256(guard || canonicalJson(config) || sha256(input))`, and
 * `canonicalJson` makes it insensitive to key ORDER but not to VALUES.
 *
 * ## Scope
 *
 * One memo per FLUSH, not per session. A guard verdict is a statement about a
 * specific text at a specific moment; carrying it across flushes would serve a
 * verdict computed against an older note. `LiveDocumentationService` constructs a
 * fresh {@link GuardMemo} per flush for exactly that reason.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@arcaai/workflow-contract';

/**
 * The memo key. Exported because it is the property under test: a change here is
 * a change to which verdicts are considered interchangeable.
 */
export function guardMemoKey(guardKey: string, config: unknown, input: string): string {
  const inputHash = createHash('sha256').update(input).digest('hex');
  // `canonicalJson` sorts keys, so `{a:1,b:2}` and `{b:2,a:1}` are ONE key —
  // while `{threshold:0.9}` and `{threshold:0.6}` remain two.
  return createHash('sha256')
    .update(`${guardKey}\0${canonicalJson(config ?? null)}\0${inputHash}`)
    .digest('hex');
}

export class GuardMemo {
  private readonly entries = new Map<string, Promise<unknown>>();
  private _hits = 0;
  private _misses = 0;

  /** Cache hits this flush — PHI-safe telemetry (a count, never the verdict). */
  get hits(): number {
    return this._hits;
  }

  get misses(): number {
    return this._misses;
  }

  /**
   * Run `exec` unless an identical `(guard, config, input)` already ran in this
   * flush. The PROMISE is memoized, not the value, so two nodes racing the same
   * guard share ONE in-flight call rather than issuing two and discarding one.
   *
   * A rejected guard is evicted: a transient outage must not pin a failure for
   * the rest of the flush when the caller's own retry might succeed.
   */
  async resolve<T>(guardKey: string, config: unknown, input: string, exec: () => Promise<T>): Promise<T> {
    const key = guardMemoKey(guardKey, config, input);
    const existing = this.entries.get(key);
    if (existing) {
      this._hits += 1;
      return existing as Promise<T>;
    }

    this._misses += 1;
    const pending = exec().catch((error) => {
      this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, pending);
    return pending;
  }
}
