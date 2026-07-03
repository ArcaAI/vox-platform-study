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

/**
 * TASK-395 P1-5 (§5.2) — per-key column helpers.
 *
 * `rateLimit` / `environment` / `allowedIps` are REAL `ApiKey` fields
 * (`apikey.prisma`; exposed by `ApiKeyResponse` and forwarded by the SDK's
 * `create()`), reachable on the SDK `ApiKey` via its index signature. These
 * pure helpers coerce the raw (`unknown`) values into the display strings the
 * keys table + create dialog use, so the rendering stays type-safe without
 * asserting the shape.
 */

/** Requests-per-minute label, e.g. `1,000/min`; em dash when unset/invalid. */
export function rateLimitLabel(rateLimit: unknown): string {
  const n = typeof rateLimit === 'number' ? rateLimit : typeof rateLimit === 'string' && rateLimit.trim() !== '' ? Number(rateLimit) : NaN;
  if (!Number.isFinite(n) || n < 0) return '—';
  return `${Math.round(n).toLocaleString('en-US')}/min`;
}

/** Environment label (`development` / `staging` / `production`); em dash when unset. */
export function environmentLabel(environment: unknown): string {
  return typeof environment === 'string' && environment.trim() ? environment.trim() : '—';
}

/** Normalize an IP/CIDR allowlist (`unknown`) to a clean string array (blanks dropped). */
export function normalizeIpList(allowedIps: unknown): string[] {
  return Array.isArray(allowedIps)
    ? allowedIps.filter((ip): ip is string => typeof ip === 'string' && ip.trim().length > 0).map((ip) => ip.trim())
    : [];
}

/**
 * Compact IP-allowlist summary. An empty allowlist means "no restriction", so
 * it renders `Any IP`; a single entry shows the CIDR; more show `N IPs`.
 */
export function ipAllowlistSummary(allowedIps: unknown): string {
  const list = normalizeIpList(allowedIps);
  if (list.length === 0) return 'Any IP';
  if (list.length === 1) return list[0];
  return `${list.length} IPs`;
}

/**
 * Parse the create-dialog IP-allowlist input (comma / whitespace / newline
 * separated) into a clean CIDR string array. Empty input → `[]` (no restriction).
 */
export function parseIpInput(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((ip) => ip.trim())
    .filter(Boolean);
}
