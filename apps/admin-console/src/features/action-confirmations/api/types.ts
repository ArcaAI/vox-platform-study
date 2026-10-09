import type { ActionConfirmationSpec, ConfirmationMode } from '@arcaai/types';

/** `system` = a platform row is stored; `default` = no row, the catalogue default applies; `locked` = fixed on. */
export type ActionConfirmationSource = 'system' | 'default' | 'locked';

export interface ActionConfirmationRow extends ActionConfirmationSpec {
  mode: ConfirmationMode;
  source: ActionConfirmationSource;
  /** `0` = no stored row, so there is nothing to precondition a first write against. */
  version: number;
}

export interface ActionConfirmationWrite {
  actionId: string;
  /** `null` resets the row to its catalogue default. */
  mode: ConfirmationMode | null;
  expectedVersion?: number;
}

export interface ActionConfirmationWriteError {
  actionId: string;
  status: number;
  message: string;
}

export interface ActionConfirmationWriteResult {
  rows: ActionConfirmationRow[];
  errors: ActionConfirmationWriteError[];
}
