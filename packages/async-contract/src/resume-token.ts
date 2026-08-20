/**
 * Resume-token convention (§3.6 of
 * docs/programs/agentic-workflow-platform/async-contract.md).
 *
 * Opaque, transport-assigned, consumer-echoed: `base64url(JSON({v, t, c}))`.
 * A producer never invents the cursor `c`; the transport does (a Redis stream
 * message id, for example). The consumer echoes the token back — it never
 * parses it — which is what lets a transport repartition its cursor format
 * later without breaking every consumer that stored an old token.
 *
 * Implemented with `TextEncoder`/`TextDecoder` + `btoa`/`atob` rather than
 * Node's `Buffer`, so this stays usable from `@arcaai/vox-node`'s non-Node
 * targets (Bun/Deno/edge — WinterTC globals only per rule 08); all four
 * globals used here are standard Web Platform / WinterTC APIs, not Node
 * builtins.
 */

/** The well-known Redis "from the beginning" sentinel — also TEXT's `stream.py:35` default. */
export const RESUME_FROM_BEGINNING = '0-0';

interface ResumeTokenWire {
  v: 1;
  t: string;
  c: string;
}

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): string | null {
  try {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    const binary = atob(normalized + padding);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Wrap a transport-native cursor into an opaque resume token.
 *
 * Callers on a non-resumable transport (BullMQ, Temporal) MUST NOT call this
 * — §3.6 forbids a synthetic token where the transport cannot actually resume.
 */
export function encodeResumeToken(transport: string, cursor: string): string {
  const wire: ResumeTokenWire = { v: 1, t: transport, c: cursor };
  return base64UrlEncode(JSON.stringify(wire));
}

/**
 * Decode an opaque resume token. Returns `null` for any malformed, tampered,
 * or wrong-shape token — never throws — so a caller can reject it as a bad
 * request rather than crash.
 */
export function decodeResumeToken(token: string): { transport: string; cursor: string } | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  const json = base64UrlDecode(token);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const wire = parsed as Partial<ResumeTokenWire>;
  if (wire.v !== 1 || typeof wire.t !== 'string' || typeof wire.c !== 'string') return null;
  return { transport: wire.t, cursor: wire.c };
}
