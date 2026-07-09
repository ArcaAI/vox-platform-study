import type { CreateNamedEntityProps } from '@arcaai/domains';

/**
 * The NLP `/classify/tokens` (token-classification) entity contract as emitted by
 * the NLP service — canonical shape `{ text, entity_type, confidence, position:
 * { start, end } }` (apps/nlp/src/nlp/schemas/common.py `Entity`).
 *
 * Legacy / alternate field names (`value`/`type`/`start`/`end` and the
 * NamedEntity-native `className`/`startOffset`/`endOffset`) are accepted ONLY as
 * defensive fallbacks — the real snake_case contract is always the PRIMARY source.
 * Reference mapper: apps/harness/src/harness/services/nlp_client.py `_to_entity`.
 */
export interface NlpNamedEntity {
  // Real NLP contract (primary)
  text?: string | null;
  entity_type?: string | null;
  confidence?: number | null;
  position?: { start?: number | null; end?: number | null } | null;
  // Legacy / alternate fallbacks (defence-in-depth against contract drift)
  value?: string | null;
  type?: string | null;
  className?: string | null;
  start?: number | null;
  end?: number | null;
  startOffset?: number | null;
  endOffset?: number | null;
}

/**
 * Map one NLP entity onto `NamedEntityFactory.CreateNamedEntity` props.
 *
 * Single source of truth for the NLP → NamedEntity field contract, shared by the
 * synchronous (summary.service `extractEntities`) and asynchronous (ner.processor)
 * durable persistence paths so the mapping cannot silently drift between them
 * again (TASK-463). `text`/`className` default to '' (both are required, non-null
 * NamedEntity columns); offsets/confidence stay undefined when absent so the
 * factory nulls them. `0` is preserved (nullish coalescing, never `||`).
 */
export function namedEntityPropsFromNlp(entity: NlpNamedEntity, ctx: { tenantId: string; contextItemId: string }): CreateNamedEntityProps {
  return {
    tenantId: ctx.tenantId,
    contextItemId: ctx.contextItemId,
    text: entity.text ?? entity.value ?? '',
    className: entity.entity_type ?? entity.type ?? entity.className ?? '',
    confidence: entity.confidence ?? undefined,
    startOffset: entity.position?.start ?? entity.start ?? entity.startOffset ?? undefined,
    endOffset: entity.position?.end ?? entity.end ?? entity.endOffset ?? undefined,
  };
}
