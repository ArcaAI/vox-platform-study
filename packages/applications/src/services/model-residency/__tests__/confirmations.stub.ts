import { ActionConfirmationService } from '../../settings-registry/action-confirmation.service';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';

/**
 * TASK-1057 — a real `ActionConfirmationService` over a stub SYSTEM tier: every row resolves to its
 * catalogue default unless `modes` names it (`{ 'modelResidency.unload': 'not-required' }`).
 */
export function confirmationsStub(modes: Record<string, string> = {}): ActionConfirmationService {
  return new ActionConfirmationService({
    resolve: (key: string) => {
      const actionId = key.slice('confirmation.'.length);
      return { key, value: actionId in modes ? modes[actionId] : HOPE_SETTINGS_REGISTRY.getOrThrow(key).default };
    },
  } as never, {} as never, {} as never, {} as never);
}
