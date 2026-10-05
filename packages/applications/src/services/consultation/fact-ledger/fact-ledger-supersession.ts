import type { FactLedgerV1, LedgerFact } from './fact-ledger.schema';

function normaliseKey(key: string): string {
  return key.trim().toLowerCase();
}

/**
 * Supersession for one encounter's facts, already in transcript order.
 *
 * - Within the encounter, a later fact with the same key supersedes the earlier one
 *   (`supersedes` / `supersededBy` on both).
 * - Across encounters, the encounter's ACTIVE fact for a key supersedes the latest active fact
 *   for that key in the earlier ledgers (latest encounter wins). Earlier ledgers are never
 *   rewritten — the link is recorded only on the new fact.
 *
 * Pure: returns new fact objects; neither argument is mutated.
 */
export function applySupersession(facts: ReadonlyArray<LedgerFact>, earlierLedgers: ReadonlyArray<FactLedgerV1>): LedgerFact[] {
  const out: LedgerFact[] = facts.map((fact) => ({ ...fact, supersedes: undefined, supersededBy: undefined }));

  const activeByKey = new Map<string, LedgerFact>();
  for (const fact of out) {
    const key = normaliseKey(fact.key);
    const previous = activeByKey.get(key);
    if (previous) {
      previous.supersededBy = fact.factId;
      fact.supersedes = [previous.factId];
    }
    activeByKey.set(key, fact);
  }

  const earlierActive = latestActiveByKey(earlierLedgers);
  for (const [key, fact] of activeByKey) {
    const earlier = earlierActive.get(key);
    if (earlier) fact.supersedes = [...(fact.supersedes ?? []), earlier];
  }

  return out.map((fact) => {
    const { supersedes, supersededBy, ...rest } = fact;
    return {
      ...rest,
      ...(supersedes && supersedes.length > 0 ? { supersedes } : {}),
      ...(supersededBy ? { supersededBy } : {}),
    };
  });
}

/** Key → the fact id still active for it after walking the earlier ledgers in encounter order. */
function latestActiveByKey(ledgers: ReadonlyArray<FactLedgerV1>): Map<string, string> {
  const active = new Map<string, string>();
  for (const ledger of [...ledgers].sort((a, b) => a.encounterSeq - b.encounterSeq)) {
    for (const fact of ledger.facts) {
      if (fact.supersededBy) continue;
      active.set(normaliseKey(fact.key), fact.factId);
    }
  }
  return active;
}
