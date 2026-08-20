import { PHI_CIPHERTEXT_FIELDS, PHI_MODEL_CIPHERTEXT } from '@arcaai/domains';

/**
 * PHI redaction for audit snapshots.
 *
 * An audit snapshot is a serialization of the mutated entity
 * (`entity.toObject()` / `entity.changes` / a captured `previousData`). For the
 * 14 PHI models the plaintext columns were DROPPED from the database and now
 * survive only as TRANSIENT entity properties, repopulated on every read by
 * `decryptPhiRows`. Nothing stripped those transients before the snapshot was
 * queued, so `AuditLog.data` ended up holding BOTH halves of the envelope:
 *
 *   data ->> 'encryptedContent' = {"type":"Buffer","data":[…]}   (ciphertext)
 *   data ->> 'content'          = "advance before stale approve" (PLAINTEXT)
 *
 * Those columns are envelope-encrypted precisely because the database alone is
 * not sufficient protection for PHI; copying the plaintext into the audit table
 * — which has its own retention profile and a CSV export endpoint — defeats
 * that for every audited clinical edit.
 *
 * BOTH halves are redacted:
 *  - the PLAINTEXT transient, because it is the disclosure;
 *  - the CIPHERTEXT buffer, because it is useless for forensics (undecryptable
 *    without its DEK context) and a serialized `Buffer` under an `encrypted*`
 *    key inside an opaque audit payload is exactly what made the PHI read path
 *    crash.
 *
 * Redaction is a MARKER, not a deletion: the key survives, so an auditor can
 * still see WHICH fields the mutation wrote — only the value is withheld.
 *
 * The field list is DERIVED from `PHI_CIPHERTEXT_FIELDS` (and the model-scoped
 * `PHI_MODEL_CIPHERTEXT`) in `@arcaai/domains`, never hand-maintained, so a new
 * PHI column cannot silently escape the scrub.
 */
export const PHI_PLAINTEXT_REDACTION = '[REDACTED:PHI]';
export const PHI_CIPHERTEXT_REDACTION = '[REDACTED:PHI-CIPHERTEXT]';

/** Bounded walk: audit snapshots are shallow entity serializations. */
const MAX_DEPTH = 6;

const CIPHERTEXT_KEYS = Object.keys(PHI_CIPHERTEXT_FIELDS);

/**
 * Redact the ciphertext column and its plaintext transient on ONE object, but
 * only where the key is actually present.
 */
function redactPair(node: Record<string, unknown>, cipherKey: string): void {
  const target = PHI_CIPHERTEXT_FIELDS[cipherKey];
  if (!target) return;
  if (Object.prototype.hasOwnProperty.call(node, cipherKey)) node[cipherKey] = PHI_CIPHERTEXT_REDACTION;
  if (Object.prototype.hasOwnProperty.call(node, target.plaintext)) node[target.plaintext] = PHI_PLAINTEXT_REDACTION;
}

/**
 * `forced` carries the ciphertext columns DECLARED by the payload's own model
 * (from `resourceType`). It exists for the one case the sibling rule below
 * cannot see: a write performed with encryption disabled (dev/test soft no-op)
 * carries the plaintext transient with NO ciphertext sibling.
 */
function walk(value: unknown, depth: number, forced?: readonly string[]): unknown {
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, forced));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = walk(item, depth + 1);
  }

  // Sibling rule — a PHI entity snapshot always carries the `encrypted*`
  // column next to its transient, so the presence of the ciphertext key is what
  // identifies the payload as PHI. Scoping to that pairing is what keeps
  // generic names (`metadata`, `details`, `notes`, `text`) on NON-PHI models
  // from being over-redacted. Also covers nested PHI rows pulled in via
  // `include` from a parent snapshot, which `resourceType` alone would miss.
  for (const cipherKey of CIPHERTEXT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, cipherKey)) redactPair(out, cipherKey);
  }
  for (const cipherKey of forced ?? []) redactPair(out, cipherKey);

  return out;
}

/**
 * Return a PHI-safe copy of an audit payload. The input is never mutated.
 *
 * @param payload - `data` / `previousData` from a SysEvent envelope.
 * @param resourceType - the event's resource type, used to look up the model's
 *                       declared ciphertext columns. Optional: without it the
 *                       sibling rule still covers every encrypted snapshot.
 */
export function scrubPhiForAudit<T>(payload: T, resourceType?: string | null): T {
  if (payload === null || typeof payload !== 'object') return payload;

  const delegate = resourceType ? resourceType.charAt(0).toLowerCase() + resourceType.slice(1) : undefined;
  const forced = delegate ? PHI_MODEL_CIPHERTEXT[delegate] : undefined;

  return walk(payload, 0, forced) as T;
}
