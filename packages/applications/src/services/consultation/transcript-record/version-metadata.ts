import type { ContextItemVersionEntity } from '@arcaai/domains';

/**
 * Set `ContextItemVersion._metadata` (derived-version links, run keys, feedback ids) through the
 * entity's tracked setter, so both `create` and `update` persist it.
 */
export function setVersionMetaData(version: ContextItemVersionEntity, metaData: Record<string, unknown>): void {
  version.metaData = metaData;
}
