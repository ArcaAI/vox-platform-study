import { ClsStore } from 'nestjs-cls';
import type { AppAbility } from '../authorization';
import { UserSession } from '../services';
import type { IServiceAccountPrincipal } from './IServiceAccountPrincipal';
import type { RunApiKeyIdentity, RunReader } from '../services/workflow-run/run-principal-access';

export interface IActiveUserContext extends ClsStore {
  user: UserSession;
  /**
   * the MACHINE principal, on its own key. Never overloaded onto
   * `user`: every `requestUser?.id` read in the codebase would otherwise
   * attribute a machine action to a person.
   */
  serviceAccount?: IServiceAccountPrincipal;
  /**
   * TASK-1038 OD-35 — the API key that authenticated this request (its id and scopes), published
   * by `UnifiedAuthGuard`. `user` carries only the key's BOUND HUMAN, which is not the principal a
   * run started with that key is bound to.
   */
  apiKey?: RunApiKeyIdentity;
  /**
   * TASK-1038 OD-35 — the run reader a redeemed run stream ticket was minted under (restored by the
   * ticket path). Read by `RunPrincipalAccessService` in preference to the restored `user`.
   */
  runReader?: RunReader;
  correlationId: string;
  requestIp: string;
  tenantId?: string;
  tenantCode?: string;
  userAbility: AppAbility;
}
