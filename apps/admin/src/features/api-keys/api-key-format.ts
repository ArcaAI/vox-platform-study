/**
 * TASK-391 #23 (K5) — pure display helpers for the API Keys surface.
 *
 * Grounded in the real `ApiKey` shape (`apikey.prisma` / seed `02-apikey.ts`):
 * the secret is never returned after creation; the list exposes a `keyPrefix`
 * (12 chars, e.g. `hope_sk_a5c5`) + a `keyChecksum` (last 6) which the console
 * renders as a masked token. Scopes are a string list; the design shows a
 * `N scopes · <first>` summary rather than overflowing the column.
 */

/** Minimal shape needed to render a masked key token (SDK-normalized + raw fields). */
export interface MaskedKeyLike {
    prefix?: string | null;
    /** Raw API field (last-6 checksum); present via the `ApiKey` index signature. */
    keyChecksum?: string | null;
    checksum?: string | null;
}

/**
 * Masked key token, e.g. `hope_sk_a5c5••••3f9a`. When only the prefix is known
 * the tail is masked (`hope_sk_a5c5••••`); with no prefix at all, an em dash.
 */
export function maskedKey(key: MaskedKeyLike | null | undefined): string {
    const prefix = typeof key?.prefix === 'string' ? key.prefix.trim() : '';
    const checksum =
        typeof key?.keyChecksum === 'string' && key.keyChecksum.trim()
            ? key.keyChecksum.trim()
            : typeof key?.checksum === 'string' && key.checksum.trim()
              ? key.checksum.trim()
              : '';
    if (!prefix) return '—';
    return checksum ? `${prefix}••••${checksum}` : `${prefix}••••`;
}

/**
 * Compact scope summary, e.g. `8 scopes · stt:*` / `1 scope · *` / `No scopes`.
 * Blank/whitespace entries are ignored; the first surviving scope is shown.
 */
export function scopesSummary(scopes?: string[] | null): string {
    const list = Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : [];
    if (list.length === 0) return 'No scopes';
    const noun = list.length === 1 ? 'scope' : 'scopes';
    return `${list.length} ${noun} · ${list[0]}`;
}
