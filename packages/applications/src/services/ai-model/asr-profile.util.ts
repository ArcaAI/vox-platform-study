import { AiModelEntity, ModelTaskType } from '@arcaai/domains';
import { parseAiModelAsrProfile, type AiModelAsrProfile } from '@arcaai/types';

/**
 * The READ side of TASK-934 G-1/G-4: `AiModel._metadata.asr` parsed through
 * `parseAiModelAsrProfile` — the SAME validator the gateway resolver
 * (`buildResolvedAsrSpec`) reads with — so a projection never shows an admin a
 * value the runtime would silently drop. `null` covers both "not an ASR row"
 * (the profile is meaningless there) and "an ASR row that carries none" — the
 * two response types that read this (`ModelResponse`, `CatalogueModelResponse`)
 * do not need to tell those apart.
 *
 * Shared by `AiModelDtoMapper` (the admin surface) and `toCatalogueModel` (the
 * tenant picker the agent editor's effective-value hint reads) so the two
 * projections can never parse the stored JSON two different ways.
 */
export function asrProfileOf(entity: Pick<AiModelEntity, 'taskType' | 'metaData'>): AiModelAsrProfile | null {
  if (entity.taskType !== ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION) return null;
  const meta = entity.metaData;
  const raw = meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>).asr : undefined;
  const { profile } = parseAiModelAsrProfile(raw);
  return Object.keys(profile).length > 0 ? profile : null;
}
