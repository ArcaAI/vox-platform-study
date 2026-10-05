import type { ContextItemVersionEntity } from '@arcaai/domains';

/**
 * Set `ContextItemVersion._metadata` (derived-version links, run keys, feedback ids). The column
 * exists and the mapper persists the value, but the entity declares no typed accessor for it yet.
 */
export function setVersionMetaData(version: ContextItemVersionEntity, metaData: Record<string, unknown>): void {
  (version as unknown as { metaData?: Record<string, unknown> }).metaData = metaData;
}
