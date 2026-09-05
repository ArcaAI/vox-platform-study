/**
 * Tenant TTS-config client — the RESOLVED read, and nothing else.
 *
 * @deprecated TASK-862/879 — removed in R4 with `TenantTtsConfig` (replacement: the TEXT_TO_SPEECH
 * Agent + assignment). The row WRITE and the platform-catalog read went with the editor: the row
 * no longer reaches `apps/tts`, which resolves its voices from the bound `AiModel._metadata`. The
 * BYO credential hooks that used to sit here were DEAD and their gateway facade
 * (`admin/tts-config/credentials/**`) is gone; credentials are edited on `/ai-providers`.
 * Paths are gateway-relative; the shared core prepends the BFF proxy mount.
 */

import { getJson } from '@/shared/api';
import type { EffectiveTtsConfig } from './types';

const BASE = 'admin/tts-config';

/** Effective resolved/clamped config (tenant row over SYSTEM default). */
export function getTtsEffective(): Promise<EffectiveTtsConfig> {
  return getJson(BASE);
}
