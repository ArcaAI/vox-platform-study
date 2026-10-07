import { type CatalogueRefFields, type RuntimeKeyMatchStrength, refFor } from './model-residency.types';

/**
 * TASK-1051 F1 — one place that decides whether a key a service REPORTS names a
 * catalogue row.
 *
 * LM Studio reports `models[].key`, which carries the quantisation variant and,
 * for a second instance, an instance suffix (`gemma-4-e2b-it-qat@q4_0`,
 * `granite-guardian-4.1-8b:2`), while the catalogue holds the bare
 * `AiModel.wireModelId`. stt and nlp report exactly the key they were loaded
 * under, so for them this stays an exact compare.
 *
 * Operator-confirmed keys (`POST admin/model-residency/links`) live in
 * `AiModel._metadata.residency.runtimeKeys` and match EXACTLY — they are the
 * escape hatch for an engine key normalisation cannot reconcile.
 */

/** The comparable form of a reported key: LM Studio drops `@<quant>` and `:<n>` and is case-folded; others are unchanged. */
export function normalizeRuntimeKey(service: string, key: string): string {
  if (service !== 'lm-studio') return key;
  return key
    .replace(/:\d+$/, '')
    .replace(/@[^@/]+$/, '')
    .toLowerCase();
}

/** Operator-confirmed engine keys from `_metadata.residency.runtimeKeys`; anything malformed reads as none. */
function confirmedKeys(metaData: unknown): string[] {
  const residency = (metaData as { residency?: unknown } | null | undefined)?.residency;
  const keys = (residency as { runtimeKeys?: unknown } | null | undefined)?.runtimeKeys;
  return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string' && k.length > 0) : [];
}

/** Every key this row may be reported under: its catalogue ref first, then the confirmed keys, de-duplicated. */
export function runtimeKeysFor(service: string, model: CatalogueRefFields): string[] {
  const ref = refFor(service, model);
  return [...new Set([...(ref ? [ref] : []), ...confirmedKeys(model.metaData)])];
}

/** Does `reportedKey` name this catalogue row? Confirmed keys match exactly; the catalogue ref through `normalizeRuntimeKey`. */
export function matchesRuntimeKey(service: string, model: CatalogueRefFields, reportedKey: string): boolean {
  if (confirmedKeys(model.metaData).includes(reportedKey)) return true;
  const ref = refFor(service, model);
  if (!ref) return false;
  return normalizeRuntimeKey(service, ref) === normalizeRuntimeKey(service, reportedKey);
}

export interface RuntimeKeyCandidate {
  aiModelId: string;
  name: string;
  slug: string;
  strength: RuntimeKeyMatchStrength;
  reason: string;
}

const tokens = (key: string): string[] => key.split(/[-_/.\s]+/).filter(Boolean);

/**
 * Catalogue rows an UNMATCHED reported key could be, best first: `strong` when
 * the keys agree once suffixes are stripped, `weak` when they share the family
 * (the first two name tokens). Unrelated rows are dropped.
 */
export function rankRuntimeKeyCandidates<T extends CatalogueRefFields & { id: string; name: string }>(
  service: string,
  reportedKey: string,
  rows: readonly T[],
): RuntimeKeyCandidate[] {
  const wanted = normalizeRuntimeKey(service, reportedKey);
  const family = tokens(wanted).slice(0, 2).join('-');
  const out: RuntimeKeyCandidate[] = [];
  for (const row of rows) {
    const ref = refFor(service, row);
    if (!ref) continue;
    const have = normalizeRuntimeKey(service, ref);
    if (have === wanted) {
      out.push({
        aiModelId: row.id,
        name: row.name,
        slug: row.slug,
        strength: 'strong',
        reason: 'Same key once the quantisation/instance suffix is removed',
      });
    } else if (family && tokens(have).slice(0, 2).join('-') === family) {
      out.push({ aiModelId: row.id, name: row.name, slug: row.slug, strength: 'weak', reason: 'Same model family, different variant' });
    }
  }
  return out.sort((a, b) => (a.strength === b.strength ? a.name.localeCompare(b.name) : a.strength === 'strong' ? -1 : 1));
}
