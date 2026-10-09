/** Action-confirmation policy client (platform admin). Paths are gateway-relative. */

import { getJson, putJson } from '@/shared/api';
import type { ActionConfirmationRow, ActionConfirmationWrite, ActionConfirmationWriteResult } from './types';

const BASE = 'admin/settings/action-confirmations';

export function getActionConfirmations(): Promise<{ items: ActionConfirmationRow[] }> {
  return getJson(BASE);
}

/**
 * One batch. Each row is its own `GlobalSetting` with its own version, so the precondition travels
 * per cell; the gateway answers 200 with per-row `errors` so one drifted row cannot discard the rest.
 */
export function putActionConfirmations(cells: ActionConfirmationWrite[]): Promise<ActionConfirmationWriteResult> {
  return putJson(BASE, { cells });
}
