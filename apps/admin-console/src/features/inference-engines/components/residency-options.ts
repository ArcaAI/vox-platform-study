/**
 * TASK-1005 §5.1/§8.1 L-UI — maps the drawer's `AiModelServingProfile` draft
 * down to what `POST admin/model-residency/load` can actually apply for
 * `service: 'lm-studio'`.
 *
 * The old endpoint (`admin/inference-engines/lm-studio/models/:key/load`)
 * accepted the full profile and is now GONE for this purpose (400 on
 * `{profile}`, and synchronous past Cloudflare's 100s edge timeout for a real
 * LLM load). The new one accepts exactly LM Studio REST v1's documented load
 * keys — `contextLength` and `flashAttention` out of everything this drawer
 * edits. `parallel`, the KV cache quantization and the GPU split are real
 * llama.cpp settings, but REST v1 has no field for them (ticket §2.3/§10.1):
 * they take effect only if the pod is restarted with them baked into the
 * model's own row, never through this reload. Silently dropping them would
 * tell the admin the value was applied when it was not (rule 11 §5); this
 * module is what keeps that claim honest by naming them.
 */

import type { AiModelServingProfile } from '@arcaai/types';
import type { LmStudioResidencyLoadOptions } from '@/shared/residency';

export interface ResidencyLoadMapping {
  /** Exactly the keys `service: 'lm-studio'` accepts — sparse, only stated values travel. */
  options: LmStudioResidencyLoadOptions;
  /** Drawer fields the admin set that this reload CANNOT apply — restart-only. */
  restartOnlyFields: string[];
}

export function toResidencyLoadOptions(profile: AiModelServingProfile): ResidencyLoadMapping {
  const options: LmStudioResidencyLoadOptions = {};
  if (profile.contextLength !== undefined) options.contextLength = profile.contextLength;
  if (profile.flashAttention !== undefined) options.flashAttention = profile.flashAttention;

  const restartOnlyFields: string[] = [];
  if (profile.parallel !== undefined) restartOnlyFields.push('Parallel slots');
  if (profile.kvCacheQuant?.k !== undefined || profile.kvCacheQuant?.v !== undefined) restartOnlyFields.push('KV cache quantization');
  if (profile.gpuSplit?.strategy !== undefined || (profile.gpuSplit?.disabledGpus?.length ?? 0) > 0) restartOnlyFields.push('GPU split');

  return { options, restartOnlyFields };
}
