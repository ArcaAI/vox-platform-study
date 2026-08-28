import type { DocumentTemplate } from '../api/types';

/**
 * WHICH template a generation node actually resolves right now — and, when the
 * answer is "none of yours", exactly why.
 *
 * This mirrors the server's resolution path (`document-template.service.ts`):
 * `findDefaultForTenant` picks the row with `isDefault: true` and NOTHING else,
 * then `isServable` demands a pin AND a PUBLISHED/APPROVED status. A template
 * failing either test is skipped and `resolveForGeneration` FAILS OPEN to the
 * platform SOAP shape.
 *
 * Failing open is right — a live consultation must not die because a template
 * could not be resolved — but it is also silent. Four quite different mistakes
 * (nothing authored, nothing marked default, never published, published but
 * left DRAFT) all present to the clinician as "SOAP came out again". Naming the
 * reason is the whole point of this function: the catalog can then say which
 * one it is, instead of leaving an admin to guess why their discharge summary
 * never appears.
 */

export type EffectiveTemplateReason =
  /** The tenant has authored no templates at all. */
  | 'NO_TEMPLATES'
  /** Templates exist, but none carries `isDefault` — resolution is by that flag alone. */
  | 'NO_DEFAULT'
  /** The default template has never been published, so it has no version to pin. */
  | 'NEVER_PUBLISHED'
  /** The default template IS pinned, but its status keeps it unservable. */
  | 'NOT_SERVABLE_STATUS';

export interface EffectiveTemplate {
  kind: 'SERVING' | 'PLATFORM_FALLBACK';
  /** The tenant's default template, when there is one — even when it is not servable. */
  template: DocumentTemplate | null;
  /** The pinned version being served. Only set when `kind === 'SERVING'`. */
  versionNumber: number | null;
  /** Why the platform fallback applies. Only set when `kind === 'PLATFORM_FALLBACK'`. */
  reason: EffectiveTemplateReason | null;
}

/** Copy of the server's `isServable`: published/approved AND carrying a pin. */
function isServable(template: DocumentTemplate): boolean {
  return template.pinnedVersionNumber != null && (template.status === 'PUBLISHED' || template.status === 'APPROVED');
}

export function effectiveTemplate(templates: DocumentTemplate[]): EffectiveTemplate {
  if (templates.length === 0) {
    return { kind: 'PLATFORM_FALLBACK', template: null, versionNumber: null, reason: 'NO_TEMPLATES' };
  }

  const preferred = templates.find((template) => template.isDefault) ?? null;
  if (!preferred) {
    return { kind: 'PLATFORM_FALLBACK', template: null, versionNumber: null, reason: 'NO_DEFAULT' };
  }

  if (isServable(preferred)) {
    return { kind: 'SERVING', template: preferred, versionNumber: preferred.pinnedVersionNumber, reason: null };
  }

  // Distinguish "never published" from "published but held back": the first is
  // unfinished work, the second is a governance decision that may well be
  // deliberate. An admin needs to know which one is in front of them.
  const reason: EffectiveTemplateReason = preferred.pinnedVersionNumber == null ? 'NEVER_PUBLISHED' : 'NOT_SERVABLE_STATUS';
  return { kind: 'PLATFORM_FALLBACK', template: preferred, versionNumber: null, reason };
}
