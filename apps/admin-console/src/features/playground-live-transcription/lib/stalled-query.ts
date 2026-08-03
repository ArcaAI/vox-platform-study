/**
 * BUG-014 — TanStack Query v5 collapses three very different conditions onto
 * `status: 'pending'`: fetching for the first time (`fetchStatus: 'fetching'`),
 * never started (`'idle'` — disabled, or a subtree whose effects never ran) and
 * offline-paused (`'paused'`). A `<Skeleton />` is only correct for the first
 * (`.claude/rules/10-skeleton-loading.md`); the other two never resolve on their
 * own, so they must render a terminal, retryable state instead
 * (`.claude/rules/11-ux-ui-principles.md` §4).
 *
 * Check this BEFORE `isPending` — a stalled query satisfies both.
 */
export function isStalledQuery(query: { isPending: boolean; fetchStatus: 'fetching' | 'paused' | 'idle' }): boolean {
  return query.isPending && query.fetchStatus !== 'fetching';
}
