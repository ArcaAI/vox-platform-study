'use client';

import { useQuery } from '@tanstack/react-query';
import { getTtsEffective } from './client';
import { ttsConfigKeys } from './keys';

/**
 * @deprecated TASK-862/879 — removed in R4 with `TenantTtsConfig`.
 *
 * Only the READ survives. `useTtsRow` / `useTtsCatalog` / `usePutTtsRow` went with the editor
 * (TASK-879): the row no longer reaches `apps/tts`, so a mutation hook would let an operator save
 * a value and hear no difference. The voice, format, speed, sample rate, provider order and voice
 * bindings are the TEXT_TO_SPEECH agent's now — `/agents?task=TEXT_TO_SPEECH`.
 */
export function useTtsEffective() {
  return useQuery({ queryKey: ttsConfigKeys.effective(), queryFn: getTtsEffective });
}
